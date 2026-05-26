'use strict';

const fs = require('fs/promises');
const path = require('path');
const { dbPool, ensureDbEnabled } = require('../infra/db.js');
const { logError } = require('../infra/logger.js');
const { HARD_CODED_BUILDING_STATS, POPULATION_MILESTONES, SERVICE_LEVEL_CONFIG } = require('../config/constants.js');
const { getMansionStats } = require('../config/mansionStats.js');
const {
  toJsonValue,
  toFiniteNumber,
  metaValue,
  jsonEquals,
  normalizeRoomCode,
} = require('../shared/helpers.js');

const ECONOMY_LOG_FILE = path.join(__dirname, '..', 'logs', 'economy.log');


async function appendEconomyLog(entry) {
  try {
    await fs.mkdir(path.dirname(ECONOMY_LOG_FILE), { recursive: true });
    const line = `${new Date().toISOString()} ${JSON.stringify(entry)}\n`;
    await fs.appendFile(ECONOMY_LOG_FILE, line, 'utf8');
  } catch (_) {
    // Logging darf den Simulations-Loop nie blockieren.
  }
}

async function recomputeAuthoritativePopulationAndJobs(municipalityId, roomCode, sharedRows, extraContext = {}) {
  const { getRoomItemRows, loadRoomStats, saveRoomStats, buildServerTimePayload, toItemsStatsShape, getMunicipalityMoney, getMunicipalityFinance, setMunicipalityTreasury, saveMunicipalityStats } = require('./rooms.js');
  const { inferCategoryFromTool, isNonEconomicTool, estimateBuildingBaseStats, fetchItemDetails } = require('./building.js');
  const { createNotificationForAllMembers } = require('./notifications.js');
  const { computeCreditLimit } = require('./bank.js');

  const safeRoomCode = normalizeRoomCode(roomCode);
  const rows = sharedRows || await getRoomItemRows(municipalityId, safeRoomCode);
  const rawStats = (await loadRoomStats(municipalityId, safeRoomCode)) || {};
  const detailsList = await fetchItemDetails();
  const detailsByTool = new Map((Array.isArray(detailsList) ? detailsList : []).map((d) => [String(d.tool || '').toLowerCase(), d]));
  const serverTime = buildServerTimePayload();
  const gameMapData =
    rawStats.game_map_data && typeof rawStats.game_map_data === 'object' ? rawStats.game_map_data : null;
  const mapSettings = gameMapData && typeof gameMapData.settings === 'object' ? gameMapData.settings : null;
  const budgetData = gameMapData && gameMapData.budget && typeof gameMapData.budget === 'object' ? gameMapData.budget : null;
  const taxRate = toFiniteNumber(rawStats.tax_rate ?? rawStats.taxRate, 10);
  // effectiveTaxRate immer vom Slider ableiten – kein stales effective_tax_rate-Feld mehr
  const effectiveTaxRate = Math.max(0, Math.min(100, taxRate));
  // Zufriedenheit des letzten Ticks – wird fuer Leerstand-Berechnung genutzt (verhindert zirkulaere Abhaengigkeit)
  const prevHappiness = Math.max(0, Math.min(100, toFiniteNumber(rawStats.happiness, 100)));
  // Crime-Count vom letzten Tick (via intervals.js übergeben)
  const prevCrimeCount = typeof extraContext.crimeCount === 'number' ? extraContext.crimeCount : 0;
  // Wetter-Daten aus serverTime
  const currentWeather = serverTime?.weather || null;

  // Jahreszeit – wird in der Building-Loop (Solar/Wind) UND später für Kosten benötigt
  const currentMonth = serverTime?.month ?? 1;
  const isWinter = currentMonth === 12 || currentMonth <= 2;
  const isSummer = currentMonth >= 6 && currentMonth <= 8;

  // Werkhof-NPC-Anzahl vorab laden (beeinflusst Gebäude-Condition-Erholung im Building-Loop)
  let _werkhofNpcCount = 0;
  try {
    const [_werkhofNpcRows] = await dbPool.query(
      `SELECT COUNT(nb.id) AS npc_count
       FROM companies c
       JOIN company_types ct ON ct.id = c.company_type_id
       LEFT JOIN npc_bots nb ON nb.company_id = c.id AND nb.status != 'fired' AND nb.patrol_mode = 1
       WHERE c.municipality_id = ? AND ct.code = 'werkhof' AND c.is_active = 1`,
      [municipalityId]
    );
    _werkhofNpcCount = Number(_werkhofNpcRows[0]?.npc_count || 0);
  } catch (_) {}

  let population = 0;
  let jobs = 0;
  let maxPopulation = 0;
  let buildingsTotal = 0;
  let buildingsResidential = 0;
  let buildingsCommercial = 0;
  let buildingsIndustrial = 0;
  let buildingsInfrastructure = 0;
  let buildingsDecoration = 0;
  let zonesResidential = 0;
  let zonesCommercial = 0;
  let zonesIndustrial = 0;
  let powerProduction = 0;
  let powerConsumption = 0;
  let solarProduction = 0;
  let waterProduction = 0;
  let waterConsumption = 0;
  let waterStorageCapacity = 0;
  let maxTileX = 0;
  let maxTileY = 0;
  const serviceBuildings = [];
  let treeCount = 0;
  let waterTileCount = 0;
  let parkCount = 0;
  let railTileCount = 0;
  let railStationCount = 0;
  let busStopCount = 0;
  let subwayTileCount = 0;
  let subwayStationCount = 0;
  let policeStationCount = 0;
  let fireStationCount = 0;
  let hospitalCount = 0;
  let schoolCount = 0;
  let universityCount = 0;
  let werkhofCount = 0;
  const conditionUpdates = []; // { id, newCondition } fuer Batch-UPDATE
  const werkhofRepairQueue = []; // { x, y, condition, tool } fuer Werkhof-Dispatch
  // Level-Summen fuer Level-skalierte Berechnungen (Kapazitaet, Budget, etc.)
  let policeLevelSum = 0;
  let fireLevelSum = 0;
  let hospitalLevelSum = 0;
  let schoolLevelSum = 0;
  let universityLevelSum = 0;
  let stadiumCount = 0;
  let museumCount = 0;
  let hasAirport = false;
  let hasCityHall = false;
  let hasSpaceProgram = false;
  let hasAmusementPark = false;
  let totalPollution = 0;
  let rawPollution = 0; // einfache Quellsumme (vor Spreading) — für Environment-Berechnung
  const pollutionSources = []; // { x, y, pollution } fuer raeumliche Berechnung
  const landValueSources = []; // { x, y, landValue } fuer raeumliche Bodenwert-Berechnung
  let totalBuildingDailyIncome = 0;

  for (const row of rows) {
    if (Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y))) {
      maxTileX = Math.max(maxTileX, Math.round(Number(row.x)));
      maxTileY = Math.max(maxTileY, Math.round(Number(row.y)));
    }
    const meta = toJsonValue(row.metadata) || {};
    if (row.action_type === 'zone') {
      const z = String(row.zone_type || '').toLowerCase();
      if (z === 'residential') zonesResidential += 1;
      if (z === 'commercial') zonesCommercial += 1;
      if (z === 'industrial') zonesIndustrial += 1;
    }
    if (row.action_type !== 'place' && row.action_type !== 'zone') continue;

    const effectiveTool =
      row.action_type === 'place' ? row.tool : metaValue(meta, 'buildingType', 'building_type');
    const tool = String(effectiveTool || '').toLowerCase();
    // LandValue fuer non-economic Tools (Baeume, Buesche etc.) VOR dem Skip sammeln
    if (tool && isNonEconomicTool(tool)) {
      const nonEconStats = HARD_CODED_BUILDING_STATS.get(tool);
      const nonEconLV = nonEconStats ? (nonEconStats.landValue || 0) : 0;
      if (nonEconLV !== 0 && Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y))) {
        landValueSources.push({ x: Math.round(Number(row.x)), y: Math.round(Number(row.y)), landValue: nonEconLV });
      }
      // Pollution auch fuer non-economic Tools (Baeume haben negative Pollution = gut)
      const nonEconPoll = nonEconStats ? (nonEconStats.pollution || 0) : 0;
      if (nonEconPoll !== 0 && Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y))) {
        pollutionSources.push({ x: Math.round(Number(row.x)), y: Math.round(Number(row.y)), pollution: nonEconPoll });
      }
      totalPollution += nonEconPoll;
      rawPollution   += nonEconPoll;
      // Baeume/Dekorationen zaehlen fuer greenBonus (sonst wuerde continue davor erreicht)
      if (tool === 'tree' || tool.startsWith('tree_')) treeCount += 1;
      if (tool === 'water') waterTileCount += 1;
      if (tool.startsWith('bush_') || tool.startsWith('topiary_') || tool.startsWith('flower_')) parkCount += 1;
      continue;
    }
    if (!tool) continue;
    const isConstructed =
      Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 100) >= 100 ||
      meta.constructed === true;
    const level = Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1))));
    // Kraftwerke im Upgrade: offline (kein Strom), aber Baustelle braucht Strom
    if (!isConstructed) {
      const isPowerBuilding = tool.includes('power_plant') || tool.includes('solar_panel') || tool.includes('wind_turbine');
      if (isPowerBuilding) {
        const _consDet = detailsByTool.get(tool);
        const _consBase = _consDet?.power_consumption_base || HARD_CODED_BUILDING_STATS.get(tool)?.powerConsumptionBase || 5;
        powerConsumption += Math.round(_consBase * level * 2);
      }
      continue;
    }
    if (meta.abandoned === true) continue;
    if (metaValue(meta, 'mapPersistent', 'map_persistent') === true) continue;

    const detail = detailsByTool.get(tool) || null;
    const footprintWidth = Math.max(
      1,
      Math.round(Number(metaValue(meta, 'footprintWidth', 'footprint_width') ?? detail?.footprint_width ?? 1))
    );
    const footprintHeight = Math.max(
      1,
      Math.round(Number(metaValue(meta, 'footprintHeight', 'footprint_height') ?? detail?.footprint_height ?? 1))
    );
    const footprintArea = footprintWidth * footprintHeight;
    const category = inferCategoryFromTool(tool, detail?.category || 'general');
    // level: bereits oben nach isConstructed definiert
    const metaPopulation = Number(meta.population ?? meta.residents ?? meta.capacity_population);
    const metaJobs = Number(meta.jobs ?? meta.workers ?? meta.capacity_jobs);
    const hasMetaPopulation = Number.isFinite(metaPopulation) && metaPopulation > 0;
    const hasMetaJobs = Number.isFinite(metaJobs) && metaJobs > 0;
    // DB-Werte bevorzugen (nach Migration 069 + Seed), Fallback auf HARD_CODED_BUILDING_STATS
    const _hcs = HARD_CODED_BUILDING_STATS.get(tool);
    const hardcodedStats = {
      maxPop: detail?.max_pop || _hcs?.maxPop || 0,
      maxJobs: detail?.max_jobs || _hcs?.maxJobs || 0,
      powerConsumptionBase: detail?.power_consumption_base || _hcs?.powerConsumptionBase || 0,
      powerProduction: detail?.power_production || _hcs?.powerProduction || 0,
      landValue: detail?.land_value || _hcs?.landValue || 0,
    };

    const base = estimateBuildingBaseStats({ category, footprintArea });
    const pop = hasMetaPopulation
      ? Math.max(0, Math.round(metaPopulation))
      : hardcodedStats
        ? Math.round(Math.max(0, Number(hardcodedStats.maxPop || 0)) * level * 0.8)
        : Math.round(base.pop * level);
    const job = hasMetaJobs
      ? Math.max(0, Math.round(metaJobs))
      : hardcodedStats
        ? Math.round(Math.max(0, Number(hardcodedStats.maxJobs || 0)) * level * 0.8)
        : Math.round(base.jobs * level);
    const metaPowerProd = Number(meta.powerProduction ?? meta.power_production);
    const metaPowerCons = Number(meta.powerConsumption ?? meta.power_consumption);
    const metaWaterProd = Number(meta.waterProduction ?? meta.water_production);
    const metaWaterCons = Number(meta.waterConsumption ?? meta.water_consumption);
    const metaPollution = Number(meta.pollution ?? meta.pollutionLevel ?? detail?.pollution ?? 0);

    population += pop;
    jobs += job;
    maxPopulation += Math.round(base.pop * level);
    buildingsTotal += 1;

    if (category === 'residential') buildingsResidential += 1;
    else if (category === 'commercial') buildingsCommercial += 1;
    else if (category === 'industrial') buildingsIndustrial += 1;
    else if (category === 'decoration') buildingsDecoration += 1;
    else buildingsInfrastructure += 1;

    if (tool === 'tree' || tool.startsWith('tree_')) treeCount += 1;
    if (tool.startsWith('bush_') || tool.startsWith('topiary_') || tool.startsWith('flower_')) parkCount += 1;
    if (tool === 'water') waterTileCount += 1;
    if (tool === 'park' || tool === 'park_large' || tool === 'tennis') parkCount += 1;
    if (tool === 'rail') railTileCount += 1;
    if (tool === 'rail_station') railStationCount += 1;
    if (tool === 'bus_stop') busStopCount += 1;
    if (tool === 'subway') subwayTileCount += 1;
    if (tool === 'subway_station') subwayStationCount += 1;
    if (tool === 'police_station') { policeStationCount += 1; policeLevelSum += level; }
    if (tool === 'fire_station') { fireStationCount += 1; fireLevelSum += level; }
    if (tool === 'hospital') { hospitalCount += 1; hospitalLevelSum += level; }
    if (tool === 'school') { schoolCount += 1; schoolLevelSum += level; }
    if (tool === 'university') { universityCount += 1; universityLevelSum += level; }
    if (tool === 'stadium') stadiumCount += 1;
    if (tool === 'museum') museumCount += 1;
    if (tool === 'airport') hasAirport = true;
    if (tool === 'city_hall') hasCityHall = true;
    if (tool === 'space_program') hasSpaceProgram = true;
    if (tool === 'amusement_park') hasAmusementPark = true;
    if (tool === 'werkhof') werkhofCount += 1;

    // === Gebäudezustand-Verfall + Werkhof-Erholung (nur Wohn- und Gewerbegebäude) ===
    if ((category === 'residential' || category === 'commercial') && row.id) {
      const condition = Number(meta.condition ?? 100);
      // Verfall: -0.002/tick. Werkhof-NPCs bremsen/kehren um: +0.001/NPC/tick
      // 0 NPCs: -0.002 (voller Verfall)
      // 2 NPCs: +/- 0 (stabil)
      // 3+ NPCs: langsame Erholung
      const _condDelta = (_werkhofNpcCount * 0.001) - 0.002;
      const newCondition = Math.min(100, Math.max(0, condition + _condDelta));
      conditionUpdates.push({ id: row.id, newCondition: Math.round(newCondition * 1000) / 1000 });
      if (newCondition < 90 && newCondition > 5) {
        werkhofRepairQueue.push({
          x: Math.round(Number(row.x)),
          y: Math.round(Number(row.y)),
          condition: Math.round(newCondition),
          tool,
        });
      }
    }
    const pollVal = Number.isFinite(metaPollution) ? Math.round(metaPollution) : 0;
    if (pollVal !== 0 && Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y))) {
      pollutionSources.push({ x: Math.round(Number(row.x)), y: Math.round(Number(row.y)), pollution: pollVal });
    }
    totalPollution += pollVal;
    rawPollution   += pollVal;
    const lvVal = hardcodedStats ? (hardcodedStats.landValue || 0) : 0;
    if (lvVal !== 0 && Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y))) {
      landValueSources.push({ x: Math.round(Number(row.x)), y: Math.round(Number(row.y)), landValue: lvVal });
    }
    const buildingDailyIncome = detail ? Math.max(0, Math.round(toFiniteNumber(detail.daily_income, 0))) * level : 0;
    totalBuildingDailyIncome += buildingDailyIncome;
    if (
      tool === 'police_station' ||
      tool === 'fire_station' ||
      tool === 'hospital' ||
      tool === 'school' ||
      tool === 'university'
    ) {
      serviceBuildings.push({
        x: Math.max(0, Math.round(Number(row.x || 0))),
        y: Math.max(0, Math.round(Number(row.y || 0))),
        tool,
        level: Math.max(1, Math.min(5, level)),
      });
    }

    // Tag/Nacht + Temperatur einmal pro Loop-Iteration (für Produktion UND Verbrauch)
    const _isDay = currentWeather?.isDay ?? ((serverTime?.hour ?? 12) >= 6 && (serverTime?.hour ?? 12) < 20);
    const _wTemp = Number(currentWeather?.temperature ?? 10);

    // Fallback auf hardcodedStats wenn Metadata keinen powerProduction-Wert hat
    // Solar/Wind haben eigene Basis-Werte falls DB-Eintrag noch 0 ist
    const _baseRenewable = tool.includes('solar_panel') ? 2 : tool.includes('wind_turbine') ? 3 : 0;
    const effectivePowerProd = (Number.isFinite(metaPowerProd) && metaPowerProd > 0)
      ? metaPowerProd
      : (hardcodedStats?.powerProduction || _baseRenewable);
    if (effectivePowerProd > 0) {
      // Dynamischer Faktor für Solar und Wind
      let dynFactor = 1.0;
      const _wt = currentWeather?.type || 'clear';
      if (tool.includes('solar_panel')) {
        // Solar: Tagesverlauf, Bewölkung, Jahreszeit
        const _hour = serverTime?.hour ?? 12;
        // Saisonale Tagesgrenzen (Sonnenaufgang/Untergang)
        const _nightStart   = isWinter ? 17 : isSummer ? 21 : 20;
        const _morningStart = isWinter ? 8  : isSummer ? 5  : 6;
        const _solarTimeFactor =
          (_hour < _morningStart || _hour >= _nightStart)        ? 0.0  // Nacht
          : (_hour < _morningStart+2 || _hour >= _nightStart-2)  ? 0.25 // Dämmerung
          : (_hour < _morningStart+4 || _hour >= _nightStart-4)  ? 0.65 // Morgen/Nachmittag
          : 1.0;                                                          // Mittagsspitze
        if (_solarTimeFactor === 0.0) {
          dynFactor = 0.0;
        } else {
          dynFactor = _wt === 'clear' ? 1.5
            : _wt === 'fog' ? 0.5
            : ['drizzle', 'rain'].includes(_wt) ? 0.3
            : ['snow', 'blizzard', 'storm', 'thunderstorm'].includes(_wt) ? 0.1
            : 1.0;
          dynFactor *= _solarTimeFactor;
          if (isWinter)      dynFactor *= 0.65; // Weniger Sonnenstunden
          else if (isSummer) dynFactor *= 1.20; // Mehr Sonnenstunden
        }
      } else if (tool.includes('wind_turbine')) {
        // Wind: Windgeschwindigkeit als Hauptfaktor
        const _ws = typeof currentWeather?.windspeed === 'number' ? currentWeather.windspeed : 15;
        dynFactor = _ws < 5  ? 0.15  // Windstille
          : _ws < 15 ? 0.60          // Leichte Brise
          : _ws < 30 ? 1.00          // Normaler Wind
          : _ws < 50 ? 1.50          // Starker Wind
          : 1.80;                    // Sturm
        if (['storm', 'blizzard', 'thunderstorm'].includes(_wt)) dynFactor = Math.max(dynFactor, 1.80);
        if (isWinter) dynFactor *= 1.10; // Im Winter oft mehr Wind
      }
      const _rawProd = Math.round(effectivePowerProd * level * dynFactor);
      const _maxPerUnit = tool.includes('solar_panel') ? 3 : tool.includes('wind_turbine') ? 8 : _rawProd;
      const _contrib = Math.min(_rawProd, _maxPerUnit);
      powerProduction += _contrib;
      if (tool.includes('solar_panel')) solarProduction += _contrib;
    } else if (tool.includes('power_plant')) {
      // Skalierend: Ausbau lohnt sich deutlich mehr als Neubau
      const POWER_PLANT_OUTPUT = [0, 80, 180, 350, 620, 1000];
      powerProduction += POWER_PLANT_OUTPUT[Math.max(1, Math.min(5, level))] || 100;
    }
    if (Number.isFinite(metaWaterProd) && metaWaterProd > 0) {
      waterProduction += Math.round(metaWaterProd);
    } else if (tool.includes('water_tower')) {
      waterProduction += 80 * level;
    } else if (tool.includes('water_reservoir')) {
      waterStorageCapacity += 2000; // Fest 2000 m³ pro Speicher, kein Level-Scaling
    }
    // Tag/Nacht-Faktor pro Kategorie
    let _dayNightFactor = 1.0;
    if (!_isDay) {
      if (category === 'residential')       _dayNightFactor = 1.20; // +20% Beleuchtung + Heizlicht
      else if (category === 'commercial')   _dayNightFactor = 0.65; // -35% Büros/Läden geschlossen
      else if (category === 'industrial')   _dayNightFactor = 0.70; // -30% Fabrikbetrieb reduziert
      else                                  _dayNightFactor = 0.90; // Service: leicht weniger
    }
    // Wetter/Temperatur-Faktor für beheizbare/klimatisierte Gebäude
    let _weatherFactor = 1.0;
    if (category === 'residential' || category === 'commercial') {
      if (_wTemp < -5)       _weatherFactor = 1.25; // Extreme Kälte: starke Heizung
      else if (_wTemp < 5)   _weatherFactor = 1.15; // Kälte: Heizung
      else if (_wTemp > 30)  _weatherFactor = 1.20; // Extreme Hitze: starke Klimaanlage
      else if (_wTemp > 25)  _weatherFactor = 1.12; // Hitze: Klimaanlage
    }
    if (Number.isFinite(metaPowerCons) && metaPowerCons > 0) {
      powerConsumption += Math.round(metaPowerCons * _dayNightFactor * _weatherFactor);
    } else if (category === 'residential') {
      const lvlFactor = 1 + (level - 1) * 0.15;
      // Mansion: per-Variante Grundlast aus mansionStats
      const mansionPowerBase = tool === 'mansion' ? getMansionStats(meta.mansion_tier, meta.mansion_variant_col).powerBase : 0;
      powerConsumption += Math.max(1, Math.round((pop * 0.002 + mansionPowerBase) * lvlFactor * _dayNightFactor * _weatherFactor));
    } else if (category === 'commercial') {
      const lvlFactor = 1 + (level - 1) * 0.15;
      powerConsumption += Math.max(1, Math.round(job * 0.004 * lvlFactor * _dayNightFactor * _weatherFactor));
    } else if (category === 'industrial') {
      const lvlFactor = 1 + (level - 1) * 0.15;
      powerConsumption += Math.max(1, Math.round(job * 0.008 * lvlFactor * _dayNightFactor));
    } else if (hardcodedStats?.powerConsumptionBase > 0) {
      powerConsumption += Math.round(hardcodedStats.powerConsumptionBase * level * _dayNightFactor);
    } else {
      // Universeller Fallback: kein Gebäude bleibt bei 0 MW
      if (pop > 0) {
        powerConsumption += Math.max(1, Math.round(pop * 0.002 * _dayNightFactor * _weatherFactor));
      } else if (job > 0) {
        powerConsumption += Math.max(1, Math.round(job * 0.004 * _dayNightFactor));
      } else {
        powerConsumption += Math.max(1, Math.round(footprintArea * 0.3 * _dayNightFactor));
      }
    }
    // Wasser-Verbrauch: realistische Formel nach Gebäudetyp

    // === Tagesgang: kontinuierliche Echtzeit-Stunden (0–24, Dezimalstellen) ===
    // Damit ändert sich der Sinus jede Sekunde gleitend, nicht erst stündlich
    const _waterHourFrac = (() => {
      const _msElapsed = Math.max(0, Date.now() - Date.UTC(2026, 0, 1, 0, 0, 0, 0));
      return (_msElapsed / 3600000) % 24; // kontinuierliche Spielstunde 0.0–24.0
    })();

    // Zwei Peaks (7h + 19h), Tiefpunkt ~1h — cos mit Periode 12h
    const _waterTimeFactor = 0.80 + 0.20 * (0.5 - 0.5 * Math.cos((_waterHourFrac - 1) * Math.PI / 6));
    // Ergebnis: 0.80 (Tiefpunkt ~1h Nacht) bis 1.00 (Basis) bis ~1.20 (7h+19h Peaks)

    // === Temperatur: gleitend, kein Stufen ===
    // <0°C: -5% (alles gefroren, wenig Aussenverbrauch)
    // 0-15°C: normal
    // 15-25°C: bis +8% (gärten, mehr duschen)
    // 25-35°C: bis +18% (hitze, pools, bewässerung)
    // >35°C: +25% (extremhitze)
    const _waterTempFactor = _wTemp < 0
      ? 0.95
      : _wTemp <= 15 ? 1.0
      : _wTemp <= 25 ? 1.0 + (_wTemp - 15) / 10 * 0.08   // linear 1.0 → 1.08
      : _wTemp <= 35 ? 1.08 + (_wTemp - 25) / 10 * 0.10  // linear 1.08 → 1.18
      : 1.25; // >35°C Extremhitze

    // === Jahreszeit: Sommer +15%, Frühling/Herbst +5%, Winter -10% ===
    const _waterMonth = serverTime?.month ?? 6;
    const _waterSeasonFactor =
      (_waterMonth >= 6 && _waterMonth <= 8)  ? 1.15  // Sommer: Garten, Freibad, Bewässerung
      : (_waterMonth >= 9 && _waterMonth <= 11) ? 1.05  // Herbst: normal
      : (_waterMonth >= 3 && _waterMonth <= 5)  ? 1.05  // Frühling: normal
      : 0.90; // Winter (Dez-Feb): weniger Aussenverbrauch

    // === Wetterzustand ===
    // Regen/Sturm: weniger Gartenbewässerung  (-10% / -15%)
    // Schnee/Eis: fast kein Aussenverbrauch (-15%)
    // Hitzewelle (weatherType = 'heat'): extra +10%
    const _weatherType = String(currentWeather?.weatherType || currentWeather?.type || 'clear').toLowerCase();
    const _waterWeatherFactor =
      _weatherType.includes('snow') || _weatherType.includes('blizzard') ? 0.85
      : _weatherType.includes('storm') || _weatherType.includes('thunder')  ? 0.88
      : _weatherType.includes('rain') || _weatherType.includes('drizzle')   ? 0.92
      : _weatherType.includes('heat')                                        ? 1.10
      : 1.0;

    // Gesamtfaktor: Zeit × Temp × Jahreszeit × Wetter
    const _wf = _waterTimeFactor * _waterTempFactor * _waterSeasonFactor * _waterWeatherFactor;
    if (Number.isFinite(metaWaterCons) && metaWaterCons > 0) {
      waterConsumption += metaWaterCons * _wf;
    } else if (category === 'residential') {
      // Einwohnerverbrauch + Gebäudeaufschlag je Typ
      // Mansion: per-Variante Wasserverbrauch aus mansionStats
      const mansionWaterFlat = tool === 'mansion' ? getMansionStats(meta.mansion_tier, meta.mansion_variant_col).waterFlat : null;
      const buildingFlat = mansionWaterFlat !== null ? mansionWaterFlat
        : tool === 'apartment_high' ? 0.45
        : tool === 'apartment_low' ? 0.20
        : 0.08; // house_small, house_medium, sonstige Wohn
      waterConsumption += (pop * 0.006 + buildingFlat) * _wf;
    } else if (category === 'commercial') {
      // Büro/Office weniger, Retail/Gastronomie mehr
      const jobRate = (tool.includes('office') || tool.includes('city_hall') || tool.includes('bank'))
        ? 0.003 : 0.008;
      waterConsumption += job * jobRate * _wf;
    } else if (category === 'industrial') {
      waterConsumption += job * 0.030 * _wf;
    } else if (category === 'service' || category === 'general') {
      // Spezialgebäude: Pauschalwerte
      const serviceFlat = {
        hospital: 8.0, school: 2.0, university: 4.0,
        police_station: 0.8, fire_station: 0.8,
        city_hall: 0.6, stadium: 3.0, museum: 0.5,
        park: 0.5, park_large: 1.5,
      }[tool];
      if (serviceFlat) waterConsumption += serviceFlat * _wf;
    }
  }

  // === Werkhof: Gebäudezustand Batch-UPDATE ===
  if (conditionUpdates.length > 0) {
    try {
      const cases = conditionUpdates.map(() => 'WHEN id = ? THEN ?').join(' ');
      const ids = conditionUpdates.map(() => '?').join(',');
      const vals = conditionUpdates.flatMap(u => [u.id, u.newCondition]);
      const idVals = conditionUpdates.map(u => u.id);
      await dbPool.query(
        `UPDATE game_items SET metadata = JSON_SET(metadata, '$.condition', CASE ${cases} END) WHERE id IN (${ids})`,
        [...vals, ...idVals]
      );
    } catch (_) { /* Zustand-Update darf den Simulations-Loop nie blockieren */ }
  }

  // === Leerstand bei dauerhaft niedriger Zufriedenheit ===
  // Einwohner verlassen die Stadt, Betriebe schliessen – basiert auf prevHappiness (letzter Tick).
  // prevHappiness < 15:  60–65 % Belegung (35–40 % Leerstand)
  // prevHappiness 15-40: 65–95 % Belegung (5–35 % Leerstand)
  // prevHappiness >= 40: 100 % Belegung
  let vacancyFactor = 1.0;
  if (prevHappiness < 15) {
    vacancyFactor = 0.60 + (prevHappiness / 15) * 0.05; // 0.60 → 0.65
  } else if (prevHappiness < 40) {
    vacancyFactor = 0.65 + ((prevHappiness - 15) / 25) * 0.30; // 0.65 → 0.95
  }
  if (vacancyFactor < 1.0) {
    // Betriebe schliessen schneller als Einwohner fliehen → steigende Arbeitslosigkeit
    // Jobs-Faktor ist 15% staerker als Einwohner-Faktor (min. 45% Belegung)
    const jobsVacancyFactor = Math.max(0.45, vacancyFactor - 0.15);
    population = Math.round(population * vacancyFactor);
    jobs = Math.round(jobs * jobsVacancyFactor);
    maxPopulation = Math.round(maxPopulation * vacancyFactor);
  }

  // === Realistische Bevoelkerungs-Demographie ===
  // Nicht jeder Einwohner ist arbeitsfaehig (Kinder, Senioren, Studenten)
  const CHILD_RATE = 0.16;           // 16% Kinder (0-15) — brauchen Schulen
  const SENIOR_RATE = 0.18;          // 18% Senioren (65+) — Rente
  const SLC = SERVICE_LEVEL_CONFIG;

  const children = Math.round(population * CHILD_RATE);
  const seniors = Math.round(population * SENIOR_RATE);
  // Schulen/Unis binden junge Leute (arbeiten nicht, lernen stattdessen)
  // Level-skaliert: capacity = base × (count × 0.5 + levelSum × 0.5)
  const schoolCapacity = Math.round(SLC.schoolCapacityBase * (schoolCount * SLC.capacityScaleBase + schoolLevelSum * SLC.capacityScalePerLevel));
  const uniCapacity = Math.round(SLC.uniCapacityBase * (universityCount * SLC.capacityScaleBase + universityLevelSum * SLC.capacityScalePerLevel));
  // Potenzielle Studenten: max 12% der Bevoelkerung koennen studieren
  const maxStudents = Math.round(population * 0.12);
  const students = Math.min(maxStudents, schoolCapacity + uniCapacity);
  // Erwerbsfaehige = Population minus Kinder, Senioren, Studenten
  const workforcePopulation = Math.max(0, population - children - seniors - students);
  // Natürliche Arbeitslosigkeit: auch bei Überschuss an Jobs gibt es Friktionelle/Strukturelle AL
  const rawUnemployed = Math.max(0, workforcePopulation - jobs);
  const naturalUnemployed = Math.round(workforcePopulation * SLC.naturalUnemploymentRate / 100);
  const unemployed = workforcePopulation > 0 ? Math.max(rawUnemployed, naturalUnemployed) : 0;
  const employed = workforcePopulation - unemployed;
  const unemploymentRate = workforcePopulation > 0
    ? Math.round((unemployed / workforcePopulation) * 10000) / 100
    : 0;
  // Erwerbsquote (fuer UI-Anzeige)
  const workforceRate = population > 0
    ? Math.round((workforcePopulation / population) * 10000) / 100
    : 0;

  // Wasserwerte runden — ganzzahlig (m³/h braucht keine Nachkommastellen)
  waterProduction = Math.round(waterProduction);
  waterConsumption = Math.round(waterConsumption);

  let powerBalance = powerProduction - powerConsumption;
  const waterRawBalance = waterProduction - waterConsumption;

  // === Wasserspeicher: Füllstand verwalten ===
  let waterStorageLevel = 0;
  try {
    const [wsRows] = await dbPool.query(
      `SELECT water_storage_level FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
      [municipalityId]
    );
    waterStorageLevel = Math.max(0, Number(wsRows[0]?.water_storage_level ?? 0));
  } catch (_) {}

  // Pro Tick 3s = 3/3600 h. Fülle/leere Speicher entsprechend
  const tickHours = 3 / 3600;
  let waterStorageDraw = 0;
  if (waterRawBalance >= 0) {
    // Überschuss → Speicher füllen (max bis Kapazität)
    const fill = Math.min(waterRawBalance * tickHours, waterStorageCapacity - waterStorageLevel);
    waterStorageLevel = Math.min(waterStorageCapacity, waterStorageLevel + fill);
  } else {
    // Defizit → aus Speicher ziehen
    const need = Math.abs(waterRawBalance) * tickHours;
    waterStorageDraw = Math.min(need, waterStorageLevel);
    waterStorageLevel = Math.max(0, waterStorageLevel - waterStorageDraw);
  }
  // Effektive Balance: wenn Speicher das Defizit deckt → kein Ausfall
  const waterStorageDrainRate = waterStorageDraw / tickHours; // m³/h äquivalent
  const waterBalance = waterRawBalance + waterStorageDrainRate; // ≥0 wenn Speicher reicht
  const waterNetDeficit = Math.max(0, -waterBalance); // nur echter Ausfall

  // Speicherstand separat schreiben — eigener UPDATE damit ein Fehler in anderen Feldern ihn nicht blockiert
  try {
    await dbPool.query(
      `UPDATE municipality_stats SET water_storage_level = ? WHERE municipality_id = ?`,
      [Math.round(waterStorageLevel * 1000) / 1000, municipalityId]
    );
  } catch (e) {
    logError('STATS', 'water_storage_level UPDATE fehlgeschlagen', { error: e?.message, municipalityId });
  }

  // Produktions-/Verbrauchswerte zurück in DB schreiben (für Idle-Fill-Job)
  try {
    await dbPool.query(
      `UPDATE municipality_stats
       SET water_production = ?, water_consumption = ?, water_storage_capacity = ?,
           power_production = ?, power_consumption = ?, solar_production = ?,
           income = ?, expenses = ?
       WHERE municipality_id = ?`,
      [
        Math.round(waterProduction),
        Math.round(waterConsumption),
        Math.round(waterStorageCapacity),
        Math.round(powerProduction),
        Math.round(powerConsumption),
        Math.round(solarProduction),
        Math.round(income),
        Math.round(expenses),
        municipalityId,
      ]
    );
  } catch (_) {}

  const homeless = Math.max(0, population - maxPopulation);
  // Wachstum: basiert auf Arbeitsplaetze vs. Erwerbsfaehige (nicht Gesamtpopulation)
  let populationGrowth = Math.max(0, Math.round((jobs - workforcePopulation) * 0.02));

  const roadCount = rows.filter((r) => String(r.tool || '').toLowerCase() === 'road' && r.action_type === 'place').length;

  // === Active bus lines congestion bonus ===
  let activeBusLineReduction = 0;
  try {
    const [busLineRows] = await dbPool.query(
      `SELECT COUNT(*) AS line_count, COALESCE(SUM(sub.stop_count), 0) AS total_stops
       FROM bus_lines bl
       JOIN (SELECT bus_line_id, COUNT(*) AS stop_count FROM bus_line_stops GROUP BY bus_line_id) sub ON sub.bus_line_id = bl.id
       WHERE bl.municipality_id = ? AND bl.status = 'active'`,
      [municipalityId]
    );
    if (busLineRows[0]) {
      // Each active line reduces congestion by 30, plus 5 per stop
      activeBusLineReduction = (busLineRows[0].line_count || 0) * 30 + (busLineRows[0].total_stops || 0) * 5;
    }
  } catch (_) { /* table might not exist yet */ }

  // === Traffic Congestion ===
  const ROAD_CAPACITY_PER_TILE = 12;
  const totalRoadCapacity = Math.max(1, roadCount * ROAD_CAPACITY_PER_TILE);
  const trafficDemand = population * 0.6 + employed * 0.4;
  const busReduction = busStopCount * 20 + activeBusLineReduction;
  const subwayReduction = subwayStationCount * 40 + subwayTileCount * 2;
  const railReduction = (railStationCount || 0) * 25 + (railTileCount || 0) * 1;
  const transitReduction = busReduction + subwayReduction + railReduction;
  const effectiveTrafficDemand = Math.max(0, trafficDemand - transitReduction);
  const rawCongestion = (effectiveTrafficDemand / totalRoadCapacity) * 100;
  const trafficCongestion = Math.max(0, Math.min(100, Math.round(rawCongestion)));

  // Budget-Kosten level-skaliert: cost = baseCost × (count × 0.6 + levelSum × 0.4)
  const bBase = SLC.budgetCostScaleBase;
  const bPer = SLC.budgetCostScalePerLevel;
  const serverBudgetCosts = {
    police: Math.round(220 * (policeStationCount * bBase + policeLevelSum * bPer)),
    fire: Math.round(210 * (fireStationCount * bBase + fireLevelSum * bPer)),
    health: Math.round(420 * (hospitalCount * bBase + hospitalLevelSum * bPer)),
    education: Math.round(150 * (schoolCount * bBase + schoolLevelSum * bPer)) + Math.round(420 * (universityCount * bBase + universityLevelSum * bPer)),
    transportation: roadCount * 8 + subwayTileCount * 12 + subwayStationCount * 120 + busStopCount * 25,
    parks: parkCount * 28,
    power: rows.filter((r) => String(r.tool || '').toLowerCase() === 'power_plant' && r.action_type === 'place').length * 500,
    water: rows.filter((r) => String(r.tool || '').toLowerCase() === 'water_tower' && r.action_type === 'place').length * 280,
  };

  const budgetKeys = ['police', 'fire', 'health', 'education', 'transportation', 'parks', 'power', 'water'];
  let budgetExpenses = 0;
  const updatedBudget = {};
  for (const key of budgetKeys) {
    const node = budgetData && budgetData[key] && typeof budgetData[key] === 'object' ? budgetData[key] : null;
    const funding = node ? toFiniteNumber(node.funding, 100) : 100;
    const serverCost = serverBudgetCosts[key] || 0;
    updatedBudget[key] = {
      name: node?.name || key.charAt(0).toUpperCase() + key.slice(1),
      funding: Math.max(0, Math.min(100, Math.round(funding))),
      cost: serverCost,
    };
    budgetExpenses += Math.round(serverCost * (funding / 100));
  }
  if (gameMapData) {
    gameMapData.budget = updatedBudget;
  }
  const maintenanceExpenses =
    buildingsResidential * 12 +
    buildingsCommercial * 34 +
    buildingsIndustrial * 52 +
    buildingsInfrastructure * 28 +
    buildingsDecoration * 5;
  // Laufende Verwaltungskosten wachsen mit Stadtgröße.
  const civicOverheadExpenses = Math.max(0, Math.round(population * 1.05 + jobs * 0.7));
  // Produktions-/Verteilkosten für Strom und Wasser.
  const utilityOverheadExpenses = Math.max(
    0,
    Math.round(powerConsumption * 0.16 + waterConsumption * 0.12)
  );
  // Verwaltungskosten skalieren mit Gemeindegrösse (Minimum 0 bei leerer Gemeinde)
  const totalCitizens = population + jobs;
  const administrationBaseExpenses = totalCitizens > 0
    ? Math.max(0, Math.round(500 + totalCitizens * 2.5))
    : 0;
  // isWinter / isSummer / currentMonth: bereits oben nach serverTime definiert
  const winterHeatingSurcharge = isWinter ? Math.round((utilityOverheadExpenses + maintenanceExpenses) * 0.20) : 0;
  // Tourismus-Bonus wird weiter unten auf income angewendet
  const summerTourismBonus = isSummer ? 0.08 : 0; // +8% auf Tax-Einkommen im Sommer
  // Jahreszeit-Bonus auf Zufriedenheit: Sommer leicht positiv, Winter leicht negativ
  const seasonHappinessBonus = isSummer ? 3 : isWinter ? -3 : 0;

  // ── Dynamischer Strombedarf: Jahreszeit + Wetter + Temperatur ──────────────
  // Bäume, Parks, Dekorationen verbrauchen keinen Strom (category='decoration' bereits ausgelassen)
  const _wType = currentWeather?.type || 'clear';
  const _wTemp = currentWeather?.temperature ?? null;
  let _powerDemandMult = 1.0;
  if (isWinter)      _powerDemandMult += 0.25;  // +25% Heizung im Winter
  else if (isSummer) _powerDemandMult += 0.15;  // +15% Klimaanlage im Sommer
  if (_wTemp !== null) {
    if (_wTemp < -5) _powerDemandMult += 0.10;  // Kältewelle
    if (_wTemp > 28) _powerDemandMult += 0.10;  // Hitzewelle
  }
  if (['rain', 'snow', 'blizzard', 'storm', 'thunderstorm'].includes(_wType)) {
    _powerDemandMult += 0.05; // Schlechtwetter: mehr Beleuchtung + Heizung
  }
  // Industrie ist wetterstabiler → nur 70% des Saisoneffekts auf Gesamtverbrauch
  const powerSeasonMultiplier = Math.round((1 + (_powerDemandMult - 1) * 0.70) * 100) / 100;
  powerConsumption = Math.round(powerConsumption * powerSeasonMultiplier);
  // Leichte Verbrauchsschwankungen: ±7% Sinus (Tagesrhythmus, Lastspitzen)
  const _fluctOffset = (municipalityId || 1) * 0.37 + (serverTime?.hour ?? 12) * 0.26;
  const _fluctFactor = 1.0 + 0.07 * Math.sin(Date.now() / 22000 + _fluctOffset);
  powerConsumption = Math.round(powerConsumption * _fluctFactor);
  powerBalance = powerProduction - powerConsumption;

  // ── Auto-Import: bei Defizit Strom zukaufen ───────────────────────────────
  // Mit Partner-Gemeinde (game_partnerships) 20% günstiger
  const powerImportUnits = powerBalance < 0 ? Math.abs(powerBalance) : 0;
  let powerImportPricePerUnit = 2.0; // Fr. pro Einheit (Normaltarif)
  if (powerImportUnits > 0) {
    try {
      const [partnerRows] = await dbPool.query(
        `SELECT id FROM game_partnerships WHERE municipality_id = ? AND status = 'connected' LIMIT 1`,
        [municipalityId]
      );
      if (partnerRows.length > 0) {
        powerImportPricePerUnit = 1.6; // 20% Rabatt mit Partner
      }
    } catch (_) { /* kein Partner = Normaltarif */ }
  }
  const powerImportCost = Math.round(powerImportUnits * powerImportPricePerUnit);

  // ── Strom-Handel: verkaufte MW abziehen, gekaufte MW addieren ─────────────
  let powerSoldMw = 0;
  let powerBoughtMw = 0;
  let powerBufferPct = 10;
  try {
    const [msRows] = await dbPool.query(
      `SELECT energy_sold_mw, energy_bought_mw, power_buffer_pct FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
      [municipalityId]
    );
    powerSoldMw    = Math.max(0, Number(msRows[0]?.energy_sold_mw    ?? 0));
    powerBoughtMw  = Math.max(0, Number(msRows[0]?.energy_bought_mw  ?? 0));
    powerBufferPct = Math.max(1, Math.min(25, Number(msRows[0]?.power_buffer_pct ?? 10)));
  } catch (_) {}
  // Gekaufte MW zur Produktion addieren
  powerProduction += powerBoughtMw;
  // Effektive Produktion nach Abzug verkaufter MW
  const powerProductionEffective = Math.max(0, powerProduction - powerSoldMw);
  const powerBalanceEffective = powerProductionEffective - powerConsumption;
  // Überschuss und verkaufbarer Anteil (10% Puffer immer halten)
  const powerSurplusPct = powerConsumption > 0
    ? Math.round(((powerProductionEffective - powerConsumption) / powerConsumption) * 100)
    : (powerProductionEffective > 0 ? 100 : 0);
  const powerBufferMw = Math.round(powerConsumption * powerBufferPct / 100);
  const powerAvailableToSell = Math.max(0, powerProductionEffective - powerConsumption - powerBufferMw);

  let expenses = Math.max(
    0,
    Math.round(
      budgetExpenses +
      maintenanceExpenses +
      civicOverheadExpenses +
      utilityOverheadExpenses +
      administrationBaseExpenses +
      winterHeatingSurcharge +
      powerImportCost
    )
  );

  // Steuer-System v1.2: balancierte Splits + realistischere Quellenanteile
  const TAX_SHARE_POPULATION = 0.48;
  const TAX_SHARE_BUSINESS = 0.32;
  const TAX_SHARE_PROPERTY = 0.20;
  const POP_TAX_COEFF = 2.8;
  const PROPERTY_WEIGHT_RESIDENTIAL = 4.5;
  const PROPERTY_WEIGHT_COMMERCIAL = 8.5;
  const PROPERTY_WEIGHT_INDUSTRIAL = 12.5;
  const PROPERTY_WEIGHT_INFRASTRUCTURE = 6.0;
  const PROPERTY_WEIGHT_DECORATION = 1.4;
  const PROPERTY_TAX_SCALE = 22;
  const BUILDING_INCOME_FACTOR = 0.52;
  const BUSINESS_TAX_CAP_RATIO = 0.8;
  const BUSINESS_FALLBACK_COMMERCIAL_WEIGHT = 65;
  const BUSINESS_FALLBACK_INDUSTRIAL_WEIGHT = 95;
  const BUSINESS_FALLBACK_WORKFORCE_WEIGHT = 0.22;
  const BUSINESS_FALLBACK_UTILIZATION = 0.45;
  const BUSINESS_FALLBACK_BASE_RATIO = 0.2;
  const INFRA_FACTOR_MIN = 0.90;
  const INFRA_FACTOR_MAX = 1.10;
  const ATTR_FACTOR_MIN = 0.90;
  const ATTR_FACTOR_MAX = 1.10;

  const populationTaxRate = Math.max(0, taxRate * TAX_SHARE_POPULATION);
  const businessTaxRate = Math.max(0, taxRate * TAX_SHARE_BUSINESS);
  const propertyTaxRate = Math.max(0, taxRate * TAX_SHARE_PROPERTY);

  const populationTaxIncomeBase = Math.max(0, Math.round((population * POP_TAX_COEFF) * (populationTaxRate / 10)));
  const propertyTaxableScore =
    buildingsResidential * PROPERTY_WEIGHT_RESIDENTIAL +
    buildingsCommercial * PROPERTY_WEIGHT_COMMERCIAL +
    buildingsIndustrial * PROPERTY_WEIGHT_INDUSTRIAL +
    buildingsInfrastructure * PROPERTY_WEIGHT_INFRASTRUCTURE +
    buildingsDecoration * PROPERTY_WEIGHT_DECORATION;
  const propertyTaxIncomeBase = Math.max(
    0,
    Math.round(propertyTaxableScore * PROPERTY_TAX_SCALE * (propertyTaxRate / 10))
  );

  let income = Math.max(0, populationTaxIncomeBase + propertyTaxIncomeBase + totalBuildingDailyIncome);

  const clamp100 = (value) => Math.max(0, Math.min(100, Math.round(value)));
  const gridSize = Math.max(10, Math.max(maxTileX + 1, maxTileY + 1, 50));
  const createCoverageGrid = () => Array.from({ length: gridSize }, () => Array(gridSize).fill(0));
  const policeCoverage = createCoverageGrid();
  const fireCoverage = createCoverageGrid();
  const healthCoverage = createCoverageGrid();
  const educationCoverage = createCoverageGrid();
  const serviceBaseRange = {
    police_station: 13,
    fire_station: 18,
    hospital: 24,
    school: 11,
    university: 19,
  };
  for (const svc of serviceBuildings) {
    const baseRange = serviceBaseRange[svc.tool];
    if (!baseRange) continue;
    const range = Math.max(1, Math.floor(baseRange * (1 + (svc.level - 1) * 0.2)));
    const rangeSquared = range * range;
    const minY = Math.max(0, svc.y - range);
    const maxY = Math.min(gridSize - 1, svc.y + range);
    const minX = Math.max(0, svc.x - range);
    const maxX = Math.min(gridSize - 1, svc.x + range);
    let target = policeCoverage;
    let serviceFunding = Number(updatedBudget?.police?.funding ?? 100);
    if (svc.tool === 'fire_station') target = fireCoverage;
    else if (svc.tool === 'hospital') target = healthCoverage;
    else if (svc.tool === 'school' || svc.tool === 'university') target = educationCoverage;
    if (svc.tool === 'fire_station') serviceFunding = Number(updatedBudget?.fire?.funding ?? 100);
    else if (svc.tool === 'hospital') serviceFunding = Number(updatedBudget?.health?.funding ?? 100);
    else if (svc.tool === 'school' || svc.tool === 'university') serviceFunding = Number(updatedBudget?.education?.funding ?? 100);
    const serviceEfficiency = Math.max(0.05, Math.min(1.2, serviceFunding / 100));
    // Level-Bonus auf Coverage-Stärke: L1=1.0x, L5=1.6x
    const levelStrength = 1 + (svc.level - 1) * SLC.coverageStrengthPerLevel;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - svc.x;
        const dy = y - svc.y;
        const distSquared = dx * dx + dy * dy;
        if (distSquared > rangeSquared) continue;
        const distance = Math.sqrt(distSquared);
        const coverage = Math.max(0, (1 - distance / range) * 100) * serviceEfficiency * levelStrength;
        target[y][x] = Math.min(100, Number(target[y][x] || 0) + coverage);
      }
    }
  }
  const avgCoverage = (matrix) => {
    let total = 0;
    let count = 0;
    for (const row of matrix) {
      for (const value of row) {
        total += Number(value || 0);
        count += 1;
      }
    }
    return count > 0 ? total / count : 0;
  };
  const avgPoliceCoverage = avgCoverage(policeCoverage);
  const avgFireCoverage = avgCoverage(fireCoverage);
  const avgHealthCoverage = avgCoverage(healthCoverage);
  const avgEducationCoverage = avgCoverage(educationCoverage);

  // === Gesundheits-Kapazitaet (Level-skaliert) ===
  const healthCapacity = Math.round(SLC.healthCapacityBase * (hospitalCount * SLC.capacityScaleBase + hospitalLevelSum * SLC.capacityScalePerLevel));
  // Senioren belasten das Gesundheitssystem 3x mehr
  const healthDemand = seniors * SLC.healthSeniorWeight + Math.max(0, population - seniors);
  const healthAdequacy = healthDemand > 0
    ? Math.min(1, healthCapacity / healthDemand)
    : (hospitalCount > 0 ? 1 : 0);

  // === Bildungs-Overcrowding ===
  const educationDemand = children + students;
  const educationCapacityTotal = schoolCapacity + uniCapacity;
  const educationOvercrowding = educationDemand > 0
    ? Math.min(1, educationCapacityTotal / educationDemand)
    : (schoolCount + universityCount > 0 ? 1 : 0);

  let muniStatBonus = { security: 0, attractiveness: 0, cleanliness: 0, infrastructure: 0, transparency: 0 };
  let muniStatRaw = { security: 50, attractiveness: 50, cleanliness: 50, infrastructure: 50, transparency: 50 };
  let socialFund = 0;
  let socialContributionRate = 5; // Default 5%
  let welfarePerUnemployed = 8;  // Default 8 CHF/Tag
  try {
    const [muniRows] = await dbPool.query(
      `SELECT security, attractiveness, cleanliness, infrastructure, transparency,
              social_fund, social_contribution_rate, welfare_per_unemployed
       FROM municipality_stats WHERE municipality_id = ?`,
      [municipalityId]
    );
    if (muniRows.length > 0) {
      const ms = muniRows[0];
      muniStatRaw.security = Math.max(0, Math.min(100, Number(ms.security ?? 50)));
      muniStatRaw.attractiveness = Math.max(0, Math.min(100, Number(ms.attractiveness ?? 50)));
      muniStatRaw.cleanliness = Math.max(0, Math.min(100, Number(ms.cleanliness ?? 50)));
      muniStatRaw.infrastructure = Math.max(0, Math.min(100, Number(ms.infrastructure ?? 50)));
      muniStatRaw.transparency = Math.max(0, Math.min(100, Number(ms.transparency ?? 50)));
      muniStatBonus.security = ((ms.security || 50) - 50) * 0.3;
      muniStatBonus.attractiveness = ((ms.attractiveness || 50) - 50) * 0.3;
      muniStatBonus.cleanliness = ((ms.cleanliness || 50) - 50) * 0.3;
      muniStatBonus.infrastructure = ((ms.infrastructure || 50) - 50) * 0.3;
      muniStatBonus.transparency = ((ms.transparency || 50) - 50) * 0.3;
      socialFund = Number(ms.social_fund ?? 0);
      socialContributionRate = Math.max(0, Math.min(15, Number(ms.social_contribution_rate ?? 5)));
      welfarePerUnemployed = Math.max(0, Math.min(50, Number(ms.welfare_per_unemployed ?? 8)));
    }
  } catch (_) {}

  // Slider-Werte aus game_stats-Blob überschreiben municipality_stats (sind aktueller)
  if (typeof rawStats.social_contribution_rate !== 'undefined') {
    socialContributionRate = Math.max(0, Math.min(15, Number(rawStats.social_contribution_rate)));
  }
  if (typeof rawStats.welfare_per_unemployed !== 'undefined') {
    welfarePerUnemployed = Math.max(0, Math.min(50, Number(rawStats.welfare_per_unemployed)));
  }

  // Raeumliche Pollution-Berechnung: gleicher Algorithmus wie Client (calculatePollutionInfluence)
  // Jede Quelle beeinflusst umliegende Tiles innerhalb eines Radius mit Falloff.
  // Baeume/Parks neben Fabriken reduzieren deren Verschmutzung raeumlich.
  const pollutionInfluenceMap = new Map(); // key = "x,y" -> accumulated pollution influence
  if (pollutionSources.length > 0) {
    for (const src of pollutionSources) {
      const key = `${src.x},${src.y}`;
      pollutionInfluenceMap.set(key, (pollutionInfluenceMap.get(key) || 0) + src.pollution);
      const radius = Math.min(6, Math.max(2, Math.ceil(Math.abs(src.pollution) / 10)));
      const radiusSq = radius * radius;
      for (let ny = src.y - radius; ny <= src.y + radius; ny++) {
        for (let nx = src.x - radius; nx <= src.x + radius; nx++) {
          if (ny === src.y && nx === src.x) continue;
          if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) continue;
          const dx = nx - src.x;
          const dy = ny - src.y;
          const distSq = dx * dx + dy * dy;
          if (distSq > radiusSq) continue;
          const dist = Math.sqrt(distSq);
          const falloff = 1 - dist / (radius + 1);
          const nKey = `${nx},${ny}`;
          pollutionInfluenceMap.set(nKey, (pollutionInfluenceMap.get(nKey) || 0) + src.pollution * falloff * 0.4);
        }
      }
    }
    totalPollution = 0;
    for (const val of pollutionInfluenceMap.values()) {
      totalPollution += val;
    }
    totalPollution = Math.round(totalPollution);
  }

  // === Raeumliche Bodenwert-Berechnung ===
  // Gleicher Spreading-Algorithmus wie Pollution, aber mit landValue-Werten.
  // Parks, Baeume, Civic-Buildings erhoehen, Fabriken senken den Bodenwert.
  const landValueGrid = Array.from({ length: gridSize }, () => new Float32Array(gridSize).fill(50));
  if (landValueSources.length > 0) {
    for (const src of landValueSources) {
      // Self-Tile bekommt vollen Wert
      if (src.x >= 0 && src.x < gridSize && src.y >= 0 && src.y < gridSize) {
        landValueGrid[src.y][src.x] += src.landValue;
      }
      // Nachbar-Spreading mit Radius und Falloff
      const radius = Math.min(8, Math.max(2, Math.ceil(Math.abs(src.landValue) / 8)));
      const radiusSq = radius * radius;
      for (let ny = src.y - radius; ny <= src.y + radius; ny++) {
        for (let nx = src.x - radius; nx <= src.x + radius; nx++) {
          if (ny === src.y && nx === src.x) continue;
          if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) continue;
          const dx = nx - src.x;
          const dy = ny - src.y;
          const distSq = dx * dx + dy * dy;
          if (distSq > radiusSq) continue;
          const dist = Math.sqrt(distSq);
          const falloff = 1 - dist / (radius + 1);
          landValueGrid[ny][nx] += src.landValue * falloff * 0.35;
        }
      }
    }
  }
  // === Mansion Prestige-Spreading ===
  // Fertiggebaute Mansions (place + zone) strahlen starken Bodenwert-Boost auf Nachbarn aus
  const MANSION_PRESTIGE_RADIUS = 10;
  for (const row of rows) {
    if (row.action_type !== 'place' && row.action_type !== 'zone') continue;
    const rMeta = toJsonValue(row.metadata) || {};
    const rTool = row.action_type === 'place' ? String(row.tool || '') : String(metaValue(rMeta, 'buildingType', 'building_type') || '');
    if (rTool.toLowerCase() !== 'mansion') continue;
    const isBuilt = Number(metaValue(rMeta, 'constructionProgress', 'construction_progress') ?? 100) >= 100;
    if (!isBuilt) continue;
    const mx = Math.round(Number(row.x));
    const my = Math.round(Number(row.y));
    if (mx < 0 || my < 0 || mx >= gridSize || my >= gridSize) continue;
    for (let ny = my - MANSION_PRESTIGE_RADIUS; ny <= my + MANSION_PRESTIGE_RADIUS; ny++) {
      for (let nx = mx - MANSION_PRESTIGE_RADIUS; nx <= mx + MANSION_PRESTIGE_RADIUS; nx++) {
        if (nx === mx && ny === my) continue;
        if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) continue;
        const dist = Math.sqrt((nx - mx) ** 2 + (ny - my) ** 2);
        if (dist > MANSION_PRESTIGE_RADIUS) continue;
        const falloff = 1 - dist / (MANSION_PRESTIGE_RADIUS + 1);
        landValueGrid[ny][nx] = Math.min(200, landValueGrid[ny][nx] + Math.round(50 * falloff));
      }
    }
  }

  // === Kostenlose Parkplätze: LandValue-Boost + Gewerbe-Attraktivitäts-Bonus ===
  // Radius 5 Tiles: +10 LandValue-Punkte pro freiem Parkfeld (max +25 pro Tile)
  // Gewerbe-Multiplikator: für jede 10 abgedeckte Tiles +0.5% auf Gebäude-Einkommen
  const FREE_PARKING_RADIUS = 5;
  const freeParkingGrid = Array.from({ length: gridSize }, () => new Uint8Array(gridSize)); // 1 = free parking
  let freeParkingCommercialBonus = 1.0;
  try {
    const [freeParkRows] = await dbPool.query(
      `SELECT tile_x, tile_y FROM parking_config WHERE municipality_id = ? AND is_free = 1`,
      [municipalityId]
    );
    if (freeParkRows.length > 0) {
      // Grid markieren + Spreading für LandValue
      for (const fp of freeParkRows) {
        const fx = Math.round(fp.tile_x);
        const fy = Math.round(fp.tile_y);
        if (fx < 0 || fy < 0 || fx >= gridSize || fy >= gridSize) continue;
        freeParkingGrid[fy][fx] = 1;
        // Boost im Radius um das Parkfeld
        for (let ny = fy - FREE_PARKING_RADIUS; ny <= fy + FREE_PARKING_RADIUS; ny++) {
          for (let nx = fx - FREE_PARKING_RADIUS; nx <= fx + FREE_PARKING_RADIUS; nx++) {
            if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) continue;
            const dist = Math.sqrt((nx - fx) ** 2 + (ny - fy) ** 2);
            if (dist > FREE_PARKING_RADIUS) continue;
            const falloff = 1 - dist / (FREE_PARKING_RADIUS + 1);
            landValueGrid[ny][nx] = Math.min(200, landValueGrid[ny][nx] + Math.round(10 * falloff));
          }
        }
      }
      // Gewerbe-Bonus: wie viele kommerzielle Tiles haben Gratis-Parken in der Nähe?
      let coveredCommercialTiles = 0;
      let totalCommercialTiles = 0;
      for (const row of rows) {
        if (row.zone_type !== 'commercial') continue;
        totalCommercialTiles++;
        const cx = Math.round(Number(row.x));
        const cy = Math.round(Number(row.y));
        const hasNearby = freeParkRows.some(fp => {
          const d = Math.sqrt((cx - fp.tile_x) ** 2 + (cy - fp.tile_y) ** 2);
          return d <= FREE_PARKING_RADIUS;
        });
        if (hasNearby) coveredCommercialTiles++;
      }
      if (totalCommercialTiles > 0) {
        const coverage = coveredCommercialTiles / totalCommercialTiles; // 0..1
        freeParkingCommercialBonus = 1 + coverage * 0.12; // max +12% auf Gewerbe-Einkommen
      }
    }
  } catch (_fpErr) { /* non-critical */ }

  // Modifier: Service-Coverage erhoeht, Pollution senkt den Bodenwert
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const avgSvc = (
        (policeCoverage[y]?.[x] || 0) +
        (fireCoverage[y]?.[x] || 0) +
        (healthCoverage[y]?.[x] || 0) +
        (educationCoverage[y]?.[x] || 0)
      ) / 4;
      landValueGrid[y][x] += avgSvc * 0.3;
      // Direct police coverage bonus on land value
      const policeCov = policeCoverage[y]?.[x] || 0;
      const policeDirectBonus = policeCov > 30 ? (policeCov - 30) * 0.15 : -(30 - policeCov) * 0.1;
      landValueGrid[y][x] += policeDirectBonus;
      const pollKey = `${x},${y}`;
      const pollInf = pollutionInfluenceMap.get(pollKey) || 0;
      if (pollInf > 0) {
        landValueGrid[y][x] -= pollInf * 0.5;
      }
      landValueGrid[y][x] = Math.max(0, Math.min(200, Math.round(landValueGrid[y][x])));
    }
  }

  // totalPollution can be negative (more trees than factories) - clamp to 0 for ratio calculations
  const effectivePollution = Math.max(0, totalPollution);
  const safety = clamp100(avgPoliceCoverage * 0.7 + avgFireCoverage * 0.3 + muniStatBonus.security);
  // Health-Score: 60% Coverage + 15% Umwelt + 25% Kapazitaets-Deckung
  const health = clamp100(
    avgHealthCoverage * SLC.healthScoreWeightCoverage +
      (100 - effectivePollution / Math.max(1, gridSize * gridSize)) * SLC.healthScoreWeightPollution +
      healthAdequacy * 100 * SLC.healthScoreWeightAdequacy +
      muniStatBonus.cleanliness
  );
  // Education-Score: 70% Coverage + 30% Kapazitaets-Deckung
  const education = clamp100(
    avgEducationCoverage * SLC.educationScoreWeightCoverage +
      educationOvercrowding * 100 * SLC.educationScoreWeightCapacity +
      muniStatBonus.transparency
  );
  // Umwelt: Basis 70% (naturbelassene Gemeinde), Baeume/Parks verbessern, Industrie verschlechtert
  const totalBuildings = rows.filter(r => r.action_type === 'place' || r.action_type === 'zone').length;
  const greenCount = treeCount + waterTileCount + parkCount;
  // Gruen-Bonus: jeder Baum/Park bringt bis zu +0.5 Punkte (gedeckelt bei +20)
  const greenBonus = Math.min(20, greenCount * 0.5);
  // Pollution-Malus: rawPollution (Quellsumme, NICHT spatial) pro Gebäude
  // Verhindert, dass Spreading die Zahl künstlich aufbläht
  const effectiveRaw = Math.max(0, rawPollution);
  const pollutionPerBuilding = totalBuildings > 0 ? effectiveRaw / totalBuildings : 0;
  const pollutionMalus = Math.min(50, pollutionPerBuilding * 2);
  const environment = clamp100(70 + greenBonus - pollutionMalus + muniStatBonus.cleanliness);
  const jobSatisfaction = jobs >= population ? 100 : (jobs / (population || 1)) * 100;

  const muniHappinessBonus = (muniStatBonus.attractiveness + muniStatBonus.transparency) / 2;
  const congestionPenalty = trafficCongestion > 30 ? -((trafficCongestion - 30) / 70) * 12 : 0;
  // Gesundheitsversorgung-Penalty: unter 80% Deckung → Happiness-Malus
  const healthcarePenalty = healthAdequacy < SLC.healthPenaltyThreshold
    ? -(((SLC.healthPenaltyThreshold - healthAdequacy) / SLC.healthPenaltyThreshold) * SLC.healthPenaltyMax)
    : 0;
  // Arbeitslosigkeit senkt Happiness: hohe Quote = starker Malus
  const unemploymentPenalty = unemploymentRate > 5
    ? -((unemploymentRate - 5) / 95) * 15
    : 0;
  // Wetter-Penalty: schlechtes Wetter senkt Zufriedenheit
  const WEATHER_SEVERITY = { clear: 0, fog: 1, drizzle: 2, rain: 3, snow: 4, storm: 5, blizzard: 6, thunderstorm: 7 };
  const weatherType = currentWeather?.type || 'clear';
  const weatherIntensity = typeof currentWeather?.intensity === 'number' ? currentWeather.intensity : 0;
  const weatherSeverity = WEATHER_SEVERITY[weatherType] || 0;
  // Max -12 bei Blizzard/Thunderstorm mit voller Intensitaet
  const weatherPenalty = -(weatherSeverity * 1.5 * weatherIntensity);
  // Kriminalitaets-Penalty: aktive Kriminelle senken Zufriedenheit
  // 0 = kein Malus, 1-2 = -4, 3-5 = -8, 6+ = -12
  const crimePenalty = prevCrimeCount === 0 ? 0 : -Math.min(12, prevCrimeCount * 2.5);
  const happinessOverall = clamp100(
    safety * 0.15 +
      health * 0.2 +
      education * 0.15 +
      environment * 0.15 +
      jobSatisfaction * 0.2 +
      (100 - effectiveTaxRate * 3) * 0.15 +
      muniHappinessBonus +
      congestionPenalty +
      unemploymentPenalty +
      healthcarePenalty +
      weatherPenalty +
      crimePenalty +
      seasonHappinessBonus
  );
  const happinessResidential = clamp100(happinessOverall + (waterBalance >= 0 ? 4 : -8));
  const happinessCommercial = clamp100(happinessOverall + (powerBalance >= 0 ? 3 : -6));
  const happinessIndustrial = clamp100(happinessOverall - 3);

  // === Tax-Compliance-Faktor: Steuerflucht bei niedriger Zufriedenheit ===
  // Einwohner/Betriebe weichen Steuern aus oder verlassen die Stadt → weniger Steuereinnahmen.
  // happiness   0-20:  20–40 % Compliance (60–80 % Einnahmen-Verlust)
  // happiness  20-60:  40–90 % Compliance (10–60 % Einnahmen-Verlust)
  // happiness  60-100: 90–100 % Compliance
  let taxComplianceFactor;
  if (happinessOverall <= 20) {
    taxComplianceFactor = 0.20 + (happinessOverall / 20) * 0.20; // 0.20 → 0.40
  } else if (happinessOverall <= 60) {
    taxComplianceFactor = 0.40 + ((happinessOverall - 20) / 40) * 0.50; // 0.40 → 0.90
  } else {
    taxComplianceFactor = 0.90 + ((happinessOverall - 60) / 40) * 0.10; // 0.90 → 1.00
  }

  const infraMultiplier = Math.max(
    INFRA_FACTOR_MIN,
    Math.min(INFRA_FACTOR_MAX, 1 + (muniStatRaw.infrastructure - 50) * 0.004)
  );
  const attractMultiplier = Math.max(
    ATTR_FACTOR_MIN,
    Math.min(ATTR_FACTOR_MAX, 1 + (muniStatRaw.attractiveness - 50) * 0.004)
  );
  // Sommer-Tourismus: +8% auf alle Steuer-/Gebäude-Einnahmen
  const seasonIncomeMultiplier = 1 + summerTourismBonus;
  const adjustedPopulationTaxIncome = Math.max(0, Math.round(populationTaxIncomeBase * infraMultiplier * seasonIncomeMultiplier * taxComplianceFactor));
  const adjustedPropertyTaxIncome = Math.max(0, Math.round(propertyTaxIncomeBase * attractMultiplier * seasonIncomeMultiplier * taxComplianceFactor));
  const adjustedBuildingIncome = Math.max(
    0,
    Math.round(totalBuildingDailyIncome * BUILDING_INCOME_FACTOR * attractMultiplier * seasonIncomeMultiplier * freeParkingCommercialBonus)
  );

  let businessTaxIncome = 0;
  try {
    const [[ctRow]] = await dbPool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM municipality_ledger
       WHERE municipality_id = ? AND type = 'company_tax' AND ts >= DATE_SUB(NOW(), INTERVAL 1 DAY)`,
      [municipalityId]
    );
    businessTaxIncome = Math.max(0, Math.round(Number(ctRow?.total) || 0));
  } catch (_) {}

  // Firmensteuer: reale Buchungen + serverseitiger Baseline-Fallback für stabile 10-25% im Normalzustand.
  const businessFallbackActivity =
    buildingsCommercial * BUSINESS_FALLBACK_COMMERCIAL_WEIGHT +
    buildingsIndustrial * BUSINESS_FALLBACK_INDUSTRIAL_WEIGHT +
    Math.min(jobs, population) * BUSINESS_FALLBACK_WORKFORCE_WEIGHT;
  const businessTaxFallback = Math.max(
    0,
    Math.round(businessFallbackActivity * (businessTaxRate / 10) * BUSINESS_FALLBACK_UTILIZATION)
  );
  const businessTaxBaseline = Math.max(
    0,
    Math.round((populationTaxIncomeBase + propertyTaxIncomeBase) * BUSINESS_FALLBACK_BASE_RATIO)
  );
  const normalizedBusinessTaxIncome = Math.max(businessTaxIncome, businessTaxFallback, businessTaxBaseline);

  // Anti-Spike-Cap: verhindert extreme Ausreisser bei einzelnen Tagen.
  const businessTaxCap = Math.max(
    0,
    Math.round((populationTaxIncomeBase + propertyTaxIncomeBase) * BUSINESS_TAX_CAP_RATIO)
  );
  const adjustedBusinessTaxIncome = Math.round(Math.min(normalizedBusinessTaxIncome, businessTaxCap) * taxComplianceFactor);
  const adjustedTaxIncome = Math.max(0, adjustedPopulationTaxIncome + adjustedPropertyTaxIncome + adjustedBusinessTaxIncome);
  const companyTaxIncome = adjustedBusinessTaxIncome;
  income = Math.max(0, adjustedTaxIncome + adjustedBuildingIncome);

  // === Sozialkasse (ALV-Style Social Fund) ===
  // Einzahlungen: % von Steuereinkommen (Arbeitnehmer + Firmen zahlen Sozialabgabe)
  const socialContribFromIncome = Math.round(income * (socialContributionRate / 100));
  // Auszahlungen: Sozialhilfe pro Arbeitslosem
  const socialWelfarePayouts = Math.round(unemployed * welfarePerUnemployed);
  // Wird die Kasse bedient? (nur auszahlen wenn genug drin)
  const actualWelfarePaid = Math.min(socialWelfarePayouts, socialFund + socialContribFromIncome);
  const socialFundDelta = socialContribFromIncome - actualWelfarePaid;
  const newSocialFund = Math.max(0, Math.round((socialFund + socialFundDelta) * 100) / 100);
  // Welfare-Deckungsgrad: wie viel % der benoetigten Sozialhilfe gedeckt sind
  const welfareCoverage = socialWelfarePayouts > 0
    ? Math.min(100, Math.round((actualWelfarePaid / socialWelfarePayouts) * 100))
    : 100;
  // Nur das Defizit belastet die Stadtkasse (Einzahlungen decken Auszahlungen, Rest aus Reserven)
  const socialExpenses = Math.max(0, actualWelfarePaid - socialContribFromIncome);
  expenses += socialExpenses;

  let economyRelief = 0;
  if (income > 0 && expenses > income) {
    const targetExpenses = Math.max(0, Math.round(income * 0.96));
    economyRelief = Math.max(0, expenses - targetExpenses);
    expenses = targetExpenses;
  }
  const netDaily = income - expenses;

  // Auto-Tuning-Log: bei jeder Stats-Neuberechnung (immer sichtbarer Snapshot).
  const currentIngameDay = Math.max(0, Math.round(Number(serverTime?.total_days ?? 0)));
  const currentTickForTaxLog = Math.max(0, Math.round(Number(serverTime?.tick ?? rawStats.tick ?? 0)));
  const pct = (value, base) => (base > 0 ? Math.round((value / base) * 1000) / 10 : 0);
  const economySnapshot = {
    municipalityId,
    roomCode: safeRoomCode,
    ingameDay: currentIngameDay,
    tick: currentTickForTaxLog,
    taxRate,
    incomeTotal: income,
    expensesTotal: expenses,
    netTotal: netDaily,
    incomePopulationTax: adjustedPopulationTaxIncome,
    incomeBusinessTax: adjustedBusinessTaxIncome,
    incomePropertyTax: adjustedPropertyTaxIncome,
    incomeBuildings: adjustedBuildingIncome,
    sharePopulationTaxPct: pct(adjustedPopulationTaxIncome, income),
    shareBusinessTaxPct: pct(adjustedBusinessTaxIncome, income),
    sharePropertyTaxPct: pct(adjustedPropertyTaxIncome, income),
    shareBuildingsPct: pct(adjustedBuildingIncome, income),
    shareTaxTotalPct: pct(adjustedTaxIncome, income),
    netMarginPct: pct(netDaily, income),
    economyRelief,
  };
  await appendEconomyLog(economySnapshot);

  if (happinessOverall < 40 && populationGrowth > 0) {
    populationGrowth = Math.max(0, Math.round(populationGrowth * (happinessOverall / 60)));
  } else if (happinessOverall > 60 && populationGrowth > 0) {
    populationGrowth = Math.round(populationGrowth * (1 + (happinessOverall - 60) / 80));
  }

  // Hohe Arbeitslosigkeit bremst Wachstum
  if (unemploymentRate > 15 && populationGrowth > 0) {
    populationGrowth = Math.max(0, Math.round(populationGrowth * (1 - (unemploymentRate - 15) / 100)));
  }

  // Safety directly affects growth
  if (safety < 25 && populationGrowth > 0) {
    populationGrowth = Math.max(0, Math.round(populationGrowth * 0.5));
  } else if (safety > 70 && populationGrowth > 0) {
    populationGrowth = Math.round(populationGrowth * (1 + (safety - 70) / 100));
  }

  const tick = Math.max(0, Math.round(Number(serverTime.tick || rawStats.tick || 0)));
  const gameSpeed = Math.max(0, Math.min(3, Math.round(toFiniteNumber(rawStats.game_speed ?? rawStats.gameSpeed, 1))));
  const secondsPerTick =
    Number(serverTime?.config?.seconds_per_day || 300) / Number(serverTime?.config?.ticks_per_day || 24);
  const playTimeSeconds = Math.max(
    0,
    Math.round(
      Number(rawStats.play_time_seconds ?? 0) > 0
        ? Number(rawStats.play_time_seconds)
        : tick * secondsPerTick
    )
  );
  const currentMoney = await getMunicipalityMoney(municipalityId);
  const totalTaxCollected = Math.max(0, Math.round(toFiniteNumber(rawStats.total_tax_collected, 0)));
  const totalSpent = Math.max(0, Math.round(toFiniteNumber(rawStats.total_spent, 0)));

  // === Periodische Einnahmen werden vom Hintergrund-Job in intervals.js verwaltet ===
  // runIncomeSchedulerTick() läuft alle 5 Minuten für ALLE Gemeinden (online & offline).
  // Gutschrift erfolgt alle 60 Minuten, basierend auf municipality_stats.last_income_at.
  // Stats.js schreibt daily_income / daily_expenses → der Job liest diese Werte.

  const todayStr = new Date().toISOString().slice(0, 10);

  // treasury wird NICHT hier gesetzt – nur applyMunicipalityTransaction darf treasury ändern
  // (mit FOR UPDATE Lock, verhindert Race Conditions bei gleichzeitigen Milestone/Daily-Income Gutschriften)
  await saveMunicipalityStats(municipalityId, {
    daily_income: income,
    daily_expenses: expenses,
    last_finance_day: todayStr,
    tax_rate: taxRate,
    population,
    max_population: Math.max(population, maxPopulation),
    jobs,
    total_tax_collected: totalTaxCollected,
    total_spent: totalSpent,
    social_fund: newSocialFund,
    social_contribution_rate: socialContributionRate,
    welfare_per_unemployed: welfarePerUnemployed,
  });

  // === Krisen-Notification bei kritischer Zufriedenheit ===
  // Throttled: max 1x pro Tag, nur wenn Steuern hoch UND Zufriedenheit kritisch
  const lastCrisisDay = String(rawStats.last_crisis_notification_day || '');
  if (happinessOverall < 25 && taxRate > 40 && lastCrisisDay !== todayStr) {
    const vacancyPct = Math.round((1 - vacancyFactor) * 100);
    const compliancePct = Math.round(taxComplianceFactor * 100);
    createNotificationForAllMembers(municipalityId, {
      type: 'tax_crisis',
      title: 'Wirtschaftskrise!',
      message: `Zufriedenheit ${happinessOverall}%: Einwohner fliehen (${vacancyPct}% Leerstand), Steuern werden nur zu ${compliancePct}% bezahlt. Senke die Steuern um die Stadt zu stabilisieren!`,
      icon: 'warning',
    });
  }

  // Treasury aus DB lesen (nach daily_income + idle_earnings via applyMunicipalityTransaction)
  const newTreasury = await getMunicipalityMoney(municipalityId);

  // === Server-authoritative Demand-Berechnung ===
  // Gleiche Formel wie Client (simulation.ts calculateStats)
  const subwayBonus = subwayStationCount > 0 ? Math.min(15, subwayStationCount * 3 + subwayTileCount * 0.2) : 0;
  const subwayResidentialBonus = subwayStationCount > 0 ? Math.min(8, subwayStationCount * 2) : 0;
  const railBonus = railStationCount > 0 ? Math.min(8, railStationCount * 2 + railTileCount * 0.1) : 0;
  let baseResidentialDemand = (jobs - population * 0.7) / 18 + subwayResidentialBonus * 0.3;
  let baseCommercialDemand = (population * 0.3 - jobs * 0.3) / 4 + subwayBonus * 0.3;
  let baseIndustrialDemand = (population * 0.35 - jobs * 0.3) / 2.0;
  // Spezialgebaeude-Boni
  if (hasAirport) { baseCommercialDemand += 12; baseIndustrialDemand += 8; }
  if (hasCityHall) { baseResidentialDemand += 5; baseCommercialDemand += 3; }
  if (hasSpaceProgram) { baseIndustrialDemand += 15; baseCommercialDemand += 5; }
  if (stadiumCount > 0) { baseCommercialDemand += Math.min(10, stadiumCount * 5); }
  if (museumCount > 0) { baseCommercialDemand += Math.min(6, museumCount * 3); }
  if (hasAmusementPark) { baseCommercialDemand += 8; baseResidentialDemand += 4; }
  baseCommercialDemand += railBonus * 0.4;
  baseIndustrialDemand += railBonus * 0.6;
  // Safety modifier: safe areas attract more residents
  const safetyDemandModifier = Math.max(-6, Math.min(8, (avgPoliceCoverage - 50) * 0.16));
  baseResidentialDemand += safetyDemandModifier;
  const taxMultiplier = Math.max(0, 1 - (effectiveTaxRate - 9) / 91);
  const taxAdditiveModifier = (9 - effectiveTaxRate) * 2;
  const demandResidential = Math.round((baseResidentialDemand * taxMultiplier + taxAdditiveModifier) * 10) / 10;
  const demandCommercial = Math.round((baseCommercialDemand * taxMultiplier + taxAdditiveModifier) * 10) / 10;
  const demandIndustrial = Math.round((baseIndustrialDemand * taxMultiplier + taxAdditiveModifier) * 10) / 10;

  let bankDebt = 0;
  let bankCreditLimit = computeCreditLimit(population);
  let bankInterestRate = 0.0005;
  try {
    const fin = await getMunicipalityFinance(municipalityId);
    bankDebt = fin.debt;
    bankCreditLimit = computeCreditLimit(population);
    bankInterestRate = fin.interest_rate;
  } catch (_) {}

  const next = {
    ...(rawStats || {}),
    money: newTreasury,
    debt: bankDebt,
    credit_limit: bankCreditLimit,
    interest_rate: bankInterestRate,
    income,
    expenses,
    tax_income: adjustedTaxIncome,
    tax_income_population: adjustedPopulationTaxIncome,
    tax_income_business: adjustedBusinessTaxIncome,
    tax_income_property: adjustedPropertyTaxIncome,
    building_income: adjustedBuildingIncome,
    company_tax_income: companyTaxIncome,
    budget_expenses: budgetExpenses,
    budget_cost_police: Math.max(0, Math.round(Number(updatedBudget?.police?.cost || 0))),
    budget_cost_fire: Math.max(0, Math.round(Number(updatedBudget?.fire?.cost || 0))),
    budget_cost_health: Math.max(0, Math.round(Number(updatedBudget?.health?.cost || 0))),
    budget_cost_education: Math.max(0, Math.round(Number(updatedBudget?.education?.cost || 0))),
    budget_cost_transportation: Math.max(0, Math.round(Number(updatedBudget?.transportation?.cost || 0))),
    budget_cost_parks: Math.max(0, Math.round(Number(updatedBudget?.parks?.cost || 0))),
    budget_cost_power: Math.max(0, Math.round(Number(updatedBudget?.power?.cost || 0))),
    budget_cost_water: Math.max(0, Math.round(Number(updatedBudget?.water?.cost || 0))),
    maintenance_expenses: maintenanceExpenses,
    administration_base_expenses: administrationBaseExpenses,
    civic_overhead_expenses: civicOverheadExpenses,
    utility_overhead_expenses: utilityOverheadExpenses,
    economy_relief: economyRelief,
    tax_rate: taxRate,
    taxRate,
    total_tax_collected: totalTaxCollected,
    total_spent: totalSpent,
    population,
    max_population: Math.max(population, maxPopulation),
    population_growth: populationGrowth,
    homeless,
    jobs,
    employed,
    unemployed,
    unemployment_rate: unemploymentRate,
    workforce: workforcePopulation,
    workforce_rate: workforceRate,
    children,
    seniors,
    students,
    social_fund: newSocialFund,
    social_contribution_rate: socialContributionRate,
    welfare_per_unemployed: welfarePerUnemployed,
    social_fund_income: socialContribFromIncome,
    social_fund_expenses: actualWelfarePaid,
    social_expenses: socialExpenses,
    welfare_coverage: welfareCoverage,
    school_capacity: schoolCapacity,
    uni_capacity: uniCapacity,
    education_overcrowding: Math.round(educationOvercrowding * 10000) / 100,
    health_capacity: healthCapacity,
    health_demand: healthDemand,
    health_adequacy: Math.round(healthAdequacy * 10000) / 100,
    happiness: happinessOverall,
    happiness_residential: happinessResidential,
    happiness_commercial: happinessCommercial,
    happiness_industrial: happinessIndustrial,
    happiness_safety: Math.round(safety),
    happiness_health: Math.round(health),
    happiness_education: Math.round(education),
    happiness_environment: Math.round(environment),
    happiness_job_satisfaction: Math.round(jobSatisfaction),
    happiness_tax_component: Math.round((100 - effectiveTaxRate * 3) * 0.15),
    happiness_weather_penalty: Math.round(weatherPenalty),
    happiness_crime_penalty: Math.round(crimePenalty),
    happiness_unemployment_penalty: Math.round(unemploymentPenalty),
    power_production: Math.max(0, Math.round(powerProduction)),
    power_consumption: Math.max(0, Math.round(powerConsumption)),
    power_season_multiplier: powerSeasonMultiplier,
    power_import_units: powerImportUnits,
    power_import_cost: powerImportCost,
    power_import_price_per_unit: powerImportPricePerUnit,
    power_sold_mw: powerSoldMw,
    power_bought_mw: powerBoughtMw,
    power_production_effective: powerProductionEffective,
    power_balance_effective: powerBalanceEffective,
    power_surplus_pct: powerSurplusPct,
    power_available_to_sell: powerAvailableToSell,
    power_buffer_mw: powerBufferMw,
    power_buffer_pct: powerBufferPct,
    water_production: Math.max(0, waterProduction),
    water_consumption: Math.max(0, waterConsumption),
    water_balance: Math.round(waterBalance * 10) / 10,
    water_net_deficit: Math.round(waterNetDeficit * 10) / 10,
    water_storage_level: Math.round(waterStorageLevel * 1000) / 1000,
    water_storage_capacity: Math.round(waterStorageCapacity),
    buildings_total: buildingsTotal,
    buildings_residential: buildingsResidential,
    buildings_commercial: buildingsCommercial,
    buildings_industrial: buildingsIndustrial,
    buildings_infrastructure: buildingsInfrastructure,
    buildings_decoration: buildingsDecoration,
    zones_residential: zonesResidential,
    zones_commercial: zonesCommercial,
    zones_industrial: zonesIndustrial,
    demand_residential: demandResidential,
    demand_commercial: demandCommercial,
    demand_industrial: demandIndustrial,
    traffic_congestion: trafficCongestion,
    bus_stop_count: busStopCount,
    tick,
    year: Math.max(2026, Math.round(Number(rawStats.year ?? serverTime.year ?? 2026))),
    month: Math.max(1, Math.min(12, Math.round(Number(rawStats.month ?? serverTime.month ?? 1)))),
    weather_type: currentWeather?.type || 'clear',
    weather_intensity: typeof currentWeather?.intensity === 'number' ? currentWeather.intensity : 0,
    weather_temperature: typeof currentWeather?.temperature === 'number' ? Math.round(currentWeather.temperature) : null,
    season: isWinter ? 'winter' : isSummer ? 'summer' : currentMonth <= 5 ? 'spring' : 'autumn',
    season_happiness_bonus: seasonHappinessBonus,
    winter_heating_surcharge: winterHeatingSurcharge,
    game_speed: gameSpeed,
    gameSpeed,
    play_time_seconds: playTimeSeconds,
    game_map_data: gameMapData,
    _tax_mix_logged_day: currentIngameDay,
    _tax_mix_last_tick_logged: currentTickForTaxLog,
    tax_compliance_factor: Math.round(taxComplianceFactor * 100),
    vacancy_factor: Math.round(vacancyFactor * 100),
    last_crisis_notification_day: (happinessOverall < 25 && taxRate > 40) ? todayStr : (rawStats.last_crisis_notification_day || ''),
  };

  // Transiente Daten fuer intervals.js (werden nicht in DB gespeichert)
  next._landValueGrid = landValueGrid;
  next._serviceCoverageGrids = {
    police: policeCoverage,
    fire: fireCoverage,
    health: healthCoverage,
    education: educationCoverage,
  };

  delete next._db_updated_at;
  if (!jsonEquals(rawStats, next)) {
    const toSave = { ...next };
    delete toSave._idle_earnings;
    delete toSave._idle_days;
    delete toSave._db_updated_at;
    delete toSave._landValueGrid;
    delete toSave._serviceCoverageGrids;
    delete toSave._werkhofStatus;
    await saveRoomStats(municipalityId, safeRoomCode, toSave);
  }

  const milestones = await checkAndAwardMilestones(municipalityId, safeRoomCode, population);
  if (milestones.length > 0) {
    next._milestones_awarded = milestones;
    // Treasury nach Milestone-Gutschrift neu lesen, damit Broadcast den aktuellen Wert enthält
    const updatedTreasury = await getMunicipalityMoney(municipalityId);
    next.money = updatedTreasury;
  }

  // === Werkhof: has_werkhof aktualisieren (NPC-Count bereits oben geladen) ===
  const hasWerkhofNpc = _werkhofNpcCount > 0;
  try {
    await dbPool.query(
      `UPDATE municipality_stats SET has_werkhof = ? WHERE municipality_id = ?`,
      [werkhofCount > 0 ? 1 : 0, municipalityId]
    );
  } catch (_) {}

  // Werkhof-Status als transientes Feld anhängen (wird von intervals.js per Socket broadcastet)
  next._werkhofStatus = {
    repairQueue: hasWerkhofNpc ? werkhofRepairQueue.slice(0, 10) : [],
    hasWerkhof: werkhofCount > 0,
    hasWerkhofNpc,
    garbageDue: false,
  };

  try {
    const today = new Date().toISOString().slice(0, 10);
    const snapshotMoney = await getMunicipalityMoney(municipalityId);
    await dbPool.query(
      `INSERT IGNORE INTO municipality_stats_history
         (municipality_id, room_code, snapshot_date, population, jobs, money, income, expenses, happiness,
          power_production, power_consumption, water_production, water_consumption, solar_production)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [municipalityId, safeRoomCode, today, population, jobs, snapshotMoney, income, expenses, happinessOverall,
       Math.round(powerProduction), Math.round(powerConsumption),
       Math.round(waterProduction), Math.round(waterConsumption),
       Math.round(solarProduction)]
    );
  } catch (snapshotErr) {
    console.error('[StatsHistory] Snapshot fehlgeschlagen:', snapshotErr.message);
  }

  return next;
}

async function checkAndAwardMilestones(municipalityId, roomCode, population) {
  if (!dbPool || !municipalityId || population <= 0) return [];
  const { applyMunicipalityTransaction } = require('./bank.js');
  const { createNotificationForAllMembers } = require('./notifications.js');

  const awarded = [];
  try {
    for (const milestone of POPULATION_MILESTONES) {
      if (population < milestone.threshold) break;
      const [result] = await dbPool.query(
        `INSERT IGNORE INTO municipality_milestones (municipality_id, milestone_code, bonus_amount) VALUES (?, ?, ?)`,
        [municipalityId, milestone.code, milestone.bonus]
      );
      if (!result || result.affectedRows === 0) continue;
      await applyMunicipalityTransaction(municipalityId, {
        amount: milestone.bonus,
        type: 'milestone',
        meta: { milestoneCode: milestone.code, threshold: milestone.threshold },
        source: 'system',
      });
      awarded.push({ code: milestone.code, threshold: milestone.threshold, bonus: milestone.bonus });
      await createNotificationForAllMembers(municipalityId, {
        type: 'milestone',
        title: `Meilenstein: ${milestone.threshold.toLocaleString()} Einwohner!`,
        message: `Bonus: +$${milestone.bonus.toLocaleString()} für die Gemeindekasse`,
        icon: 'money',
        amount: milestone.bonus,
      });
    }
  } catch (err) {
    logError('MILESTONE', `Fehler bei Meilenstein-Prüfung: ${err.message}`, { municipalityId });
  }
  return awarded;
}

/**
 * Berechnet Power/Water/Solar für eine Gemeinde ohne aktive Spieler.
 * Liest Tiles aus der DB, nutzt dieselbe Logik wie die aktive Tick-Loop.
 * Schreibt das Ergebnis in municipality_stats.
 */
async function recomputeIdleInfraStats(municipalityId, roomCode) {
  const { getRoomItemRows, buildServerTimePayload } = require('./rooms.js');
  const { inferCategoryFromTool, fetchItemDetails } = require('./building.js');
  const safeRoomCode = String(roomCode || 'MAIN');

  const rows = await getRoomItemRows(municipalityId, safeRoomCode);
  if (!rows || rows.length === 0) return;

  const detailsList = await fetchItemDetails();
  const detailsByTool = new Map((Array.isArray(detailsList) ? detailsList : []).map(d => [String(d.tool || '').toLowerCase(), d]));
  const serverTime = buildServerTimePayload();
  const currentWeather = serverTime?.weather || null;
  const currentMonth = serverTime?.month ?? 1;
  const isWinter = currentMonth === 12 || currentMonth <= 2;
  const isSummer = currentMonth >= 6 && currentMonth <= 8;

  let powerProduction = 0;
  let powerConsumption = 0;
  let solarProduction = 0;
  let waterProduction = 0;
  let waterConsumption = 0;
  let waterStorageCapacity = 0;

  for (const row of rows) {
    if (row.action_type !== 'place') continue;
    const tool = String(row.tool || '').toLowerCase();
    if (!tool || tool === 'road' || tool === 'zone' || tool === 'tree' || tool.startsWith('tree_') || tool === 'water') continue;

    let meta = {};
    try { meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}); } catch (_) {}

    const isConstructed = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 100) >= 100 || meta.constructed === true;
    const level = Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1))));

    if (!isConstructed) {
      const isPowerBuilding = tool.includes('power_plant') || tool.includes('solar_panel') || tool.includes('wind_turbine');
      if (isPowerBuilding) {
        const _cd = detailsByTool.get(tool);
        powerConsumption += Math.round((_cd?.power_consumption_base || HARD_CODED_BUILDING_STATS.get(tool)?.powerConsumptionBase || 5) * level * 2);
      }
      continue;
    }
    if (meta.abandoned === true) continue;
    if (metaValue(meta, 'mapPersistent', 'map_persistent') === true) continue;

    const detail = detailsByTool.get(tool) || null;
    const _hcs = HARD_CODED_BUILDING_STATS.get(tool);
    const category = inferCategoryFromTool(tool, detail?.category || 'general');
    const metaPowerProd = Number(meta.powerProduction ?? meta.power_production);
    const metaPowerCons = Number(meta.powerConsumption ?? meta.power_consumption);
    const metaWaterProd = Number(meta.waterProduction ?? meta.water_production);
    const metaWaterCons = Number(meta.waterConsumption ?? meta.water_consumption);
    const metaPopulation = Number(meta.population ?? meta.residents ?? meta.capacity_population);
    const metaJobs = Number(meta.jobs ?? meta.workers ?? meta.capacity_jobs);
    const pop = (Number.isFinite(metaPopulation) && metaPopulation > 0) ? Math.round(metaPopulation)
      : Math.round(Math.max(0, Number(_hcs?.maxPop || detail?.max_pop || 0)) * level * 0.8);
    const job = (Number.isFinite(metaJobs) && metaJobs > 0) ? Math.round(metaJobs)
      : Math.round(Math.max(0, Number(_hcs?.maxJobs || detail?.max_jobs || 0)) * level * 0.8);

    // Power production (Solar / Wind / PowerPlant)
    const _baseRenewable = tool.includes('solar_panel') ? 2 : tool.includes('wind_turbine') ? 3 : 0;
    const effectivePowerProd = (Number.isFinite(metaPowerProd) && metaPowerProd > 0) ? metaPowerProd : (_hcs?.powerProduction || detail?.power_production || _baseRenewable);
    if (effectivePowerProd > 0) {
      let dynFactor = 1.0;
      const _wt = currentWeather?.type || 'clear';
      if (tool.includes('solar_panel')) {
        const _hour = serverTime?.hour ?? 12;
        const _nightStart   = isWinter ? 17 : isSummer ? 21 : 20;
        const _morningStart = isWinter ? 8  : isSummer ? 5  : 6;
        const _solarTimeFactor =
          (_hour < _morningStart || _hour >= _nightStart)       ? 0.0
          : (_hour < _morningStart+2 || _hour >= _nightStart-2) ? 0.25
          : (_hour < _morningStart+4 || _hour >= _nightStart-4) ? 0.65
          : 1.0;
        if (_solarTimeFactor === 0.0) {
          dynFactor = 0.0;
        } else {
          dynFactor = _wt === 'clear' ? 1.5 : _wt === 'fog' ? 0.5 : ['drizzle','rain'].includes(_wt) ? 0.3 : ['snow','blizzard','storm','thunderstorm'].includes(_wt) ? 0.1 : 1.0;
          dynFactor *= _solarTimeFactor;
          if (isWinter) dynFactor *= 0.65; else if (isSummer) dynFactor *= 1.20;
        }
      } else if (tool.includes('wind_turbine')) {
        const _ws = typeof currentWeather?.windspeed === 'number' ? currentWeather.windspeed : 15;
        dynFactor = _ws < 5 ? 0.15 : _ws < 15 ? 0.60 : _ws < 30 ? 1.00 : _ws < 50 ? 1.50 : 1.80;
        if (['storm','blizzard','thunderstorm'].includes(_wt)) dynFactor = Math.max(dynFactor, 1.80);
        if (isWinter) dynFactor *= 1.10;
      }
      const _contrib = Math.min(Math.round(effectivePowerProd * level * dynFactor), tool.includes('solar_panel') ? 3 : tool.includes('wind_turbine') ? 8 : 9999);
      powerProduction += _contrib;
      if (tool.includes('solar_panel')) solarProduction += _contrib;
    } else if (tool.includes('power_plant')) {
      const POWER_PLANT_OUTPUT = [0, 80, 180, 350, 620, 1000];
      powerProduction += POWER_PLANT_OUTPUT[Math.max(1, Math.min(5, level))] || 100;
    }

    // Water
    if (Number.isFinite(metaWaterProd) && metaWaterProd > 0) {
      waterProduction += Math.round(metaWaterProd);
    } else if (tool.includes('water_tower')) {
      waterProduction += 80 * level;
    } else if (tool.includes('water_reservoir')) {
      waterStorageCapacity += 2000;
    }

    // Power consumption
    const _isDay = currentWeather?.isDay ?? ((serverTime?.hour ?? 12) >= 6 && (serverTime?.hour ?? 12) < 20);
    const _wTemp = Number(currentWeather?.temperature ?? 10);
    let _dayNightFactor = 1.0;
    if (!_isDay) {
      if (category === 'residential') _dayNightFactor = 1.20;
      else if (category === 'commercial') _dayNightFactor = 0.65;
      else if (category === 'industrial') _dayNightFactor = 0.70;
      else _dayNightFactor = 0.90;
    }
    let _weatherFactor = 1.0;
    if (category === 'residential' || category === 'commercial') {
      if (_wTemp < -5) _weatherFactor = 1.25;
      else if (_wTemp < 5) _weatherFactor = 1.15;
      else if (_wTemp > 30) _weatherFactor = 1.20;
      else if (_wTemp > 25) _weatherFactor = 1.12;
    }
    if (Number.isFinite(metaPowerCons) && metaPowerCons > 0) {
      powerConsumption += Math.round(metaPowerCons * _dayNightFactor * _weatherFactor);
    } else if (category === 'residential') {
      powerConsumption += Math.max(1, Math.round(pop * 0.002 * (1 + (level-1)*0.15) * _dayNightFactor * _weatherFactor));
    } else if (category === 'commercial') {
      powerConsumption += Math.max(1, Math.round(job * 0.004 * (1 + (level-1)*0.15) * _dayNightFactor * _weatherFactor));
    } else if (category === 'industrial') {
      powerConsumption += Math.max(1, Math.round(job * 0.008 * (1 + (level-1)*0.15) * _dayNightFactor));
    } else if (_hcs?.powerConsumptionBase > 0) {
      powerConsumption += Math.round(_hcs.powerConsumptionBase * level * _dayNightFactor);
    }

    // Water consumption
    const _waterHourFrac = (() => { const _ms = Math.max(0, Date.now() - Date.UTC(2026,0,1,0,0,0,0)); return (_ms / 3600000) % 24; })();
    const _waterTimeFactor = 0.80 + 0.20 * (0.5 - 0.5 * Math.cos((_waterHourFrac - 1) * Math.PI / 6));
    const _waterTempFactor = _wTemp < 0 ? 0.95 : _wTemp <= 15 ? 1.0 : _wTemp <= 25 ? 1.0 + (_wTemp-15)/10*0.08 : _wTemp <= 35 ? 1.08 + (_wTemp-25)/10*0.10 : 1.25;
    const _waterWeatherFactor = (() => { const wt2 = String(currentWeather?.type||'').toLowerCase(); return wt2.includes('snow')||wt2.includes('blizzard') ? 0.85 : wt2.includes('storm')||wt2.includes('thunder') ? 0.88 : wt2.includes('rain')||wt2.includes('drizzle') ? 0.92 : wt2.includes('heat') ? 1.10 : 1.0; })();
    const _waterSeasonFactor = (currentMonth>=6&&currentMonth<=8) ? 1.15 : (currentMonth>=9&&currentMonth<=11||(currentMonth>=3&&currentMonth<=5)) ? 1.05 : 0.90;
    if (Number.isFinite(metaWaterCons) && metaWaterCons > 0) {
      waterConsumption += Math.round(metaWaterCons * _waterTimeFactor * _waterTempFactor * _waterSeasonFactor * _waterWeatherFactor);
    } else if (category === 'residential' && pop > 0) {
      waterConsumption += Math.round(pop * 0.02 * _waterTimeFactor * _waterTempFactor * _waterSeasonFactor * _waterWeatherFactor);
    }
  }

  await dbPool.query(
    `UPDATE municipality_stats
     SET power_production = ?, power_consumption = ?, solar_production = ?,
         water_production = ?, water_consumption = ?,
         water_storage_capacity = GREATEST(water_storage_capacity, ?)
     WHERE municipality_id = ?`,
    [Math.round(powerProduction), Math.round(powerConsumption), Math.round(solarProduction),
     Math.round(waterProduction), Math.round(waterConsumption),
     Math.round(waterStorageCapacity), municipalityId]
  );
}

module.exports = {
  recomputeAuthoritativePopulationAndJobs,
  recomputeIdleInfraStats,
  checkAndAwardMilestones,
};
