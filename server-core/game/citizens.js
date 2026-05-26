'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db.js');
const { logError } = require('../infra/logger.js');
const { HARD_CODED_BUILDING_STATS } = require('../config/constants.js');

// ─── Nationalitäten-Verteilung (realistisch Schweiz) ──────────────────────
// Kumulierte Schwellenwerte für schnelles Lookup (0–99)
const NATIONALITY_THRESHOLDS = [
  { id: 0, upTo: 44 },  // CH-Deutsch     45%
  { id: 1, upTo: 54 },  // CH-Französisch 10%
  { id: 2, upTo: 63 },  // Italienisch     9%
  { id: 3, upTo: 70 },  // Deutsch         7%
  { id: 4, upTo: 76 },  // Portugiesisch   6%
  { id: 5, upTo: 81 },  // Serbisch/HR     5%
  { id: 6, upTo: 85 },  // Türkisch        4%
  { id: 7, upTo: 88 },  // Spanisch        3%
  { id: 8, upTo: 91 },  // Albanisch       3%
  { id: 9, upTo: 94 },  // Französisch     3%
  { id: 10, upTo: 99 }, // Andere          5%
];

// ─── Start-Happiness nach Gebäudetyp ─────────────────────────────────────
const START_HAPPINESS_BY_BUILDING = {
  // Luxus
  mansion:    85,
  villa:      80,
  penthouse:  80,
  loft:       75,
  condo:      75,
  // Einfamilienhaus
  house:      70,
  bungalow:   70,
  duplex:     70,
  // Standard Mehrfamilienhaus
  apartment:  65,
  apartment_high: 70,
  mehrfamilienhaus: 65,
  flat:       65,
  // Günstige Blöcke / Low-End
  apartment_low: 58,
  apartment_block: 55,
  wohnblock:  55,
};

// ─── Education-Verteilung nach Gebäudetyp ─────────────────────────────────
// Kumulierte Schwellenwerte: [edu=0, edu=1, edu=2, edu=3]
const EDUCATION_BY_BUILDING = {
  // Günstige Wohnblöcke
  apartment_block:     [60, 90, 99, 100],
  wohnblock:           [60, 90, 99, 100],
  apartment_low:       [40, 80, 97, 100],  // günstige Wohnungen
  // Standard Mehrfamilienhäuser
  apartment:           [20, 60, 90, 100],
  apartment_high:      [10, 40, 80, 100],  // gehobene Wohnungen
  mehrfamilienhaus:    [20, 60, 90, 100],
  flat:                [20, 60, 90, 100],
  // Einfamilienhäuser
  house:               [5,  30, 75, 100],
  bungalow:            [5,  30, 75, 100],
  duplex:              [5,  30, 75, 100],
  // Gehoben
  mansion:             [0,   5, 25, 100],
  villa:               [0,  10, 40, 100],
  penthouse:           [0,  10, 40, 100],
  loft:                [0,  15, 50, 100],
  condo:               [0,  10, 40, 100],
  // Hochhäuser / gemischt
  tower:               [15, 50, 85, 100],
  skyscraper:          [10, 40, 80, 100],
  highrise:            [15, 50, 85, 100],
  // Fallback für unbekannte Wohngebäude
  _default_residential:[20, 55, 85, 100],
};

// Welche education-Level in einem Gebäudetyp arbeiten können
const JOBS_BY_BUILDING = {
  // Industrie (edu 0-1)
  factory:    [0, 1],
  warehouse:  [0, 1],
  // Detailhandel (edu 0-2)
  shop:       [0, 1, 2],
  mall:       [0, 1, 2],
  market:     [0, 1, 2],
  restaurant: [0, 1, 2],
  // Büro / Dienstleistung (edu 1-3)
  office:     [1, 2, 3],
  bank_house: [2, 3],
  // Öffentlicher Dienst (edu 1-3)
  hospital:   [1, 2, 3],
  school:     [2, 3],
  university: [2, 3],
  police:     [1, 2],
  fire_station:[1, 2],
  city_hall:  [2, 3],
  museum:     [1, 2, 3],
  // Energie / Infrastruktur (edu 1-2)
  power_plant:[1, 2],
  // Fallback
  _default_commercial:  [0, 1, 2],
  _default_industrial:  [0, 1],
  _default_infrastructure:[1, 2],
};

// ─── Schneller seeded PRNG (mulberry32) ───────────────────────────────────
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickNationality(rng) {
  const roll = Math.floor(rng() * 100);
  for (const { id, upTo } of NATIONALITY_THRESHOLDS) {
    if (roll <= upTo) return id;
  }
  return 10;
}

function pickEducation(tool, rng) {
  const thresholds = EDUCATION_BY_BUILDING[tool] || EDUCATION_BY_BUILDING._default_residential;
  const roll = Math.floor(rng() * 100);
  for (let edu = 0; edu < thresholds.length; edu++) {
    if (roll < thresholds[edu]) return edu;
  }
  return 0;
}

function pickAge(rng) {
  const roll = rng();
  if (roll < 0.25) return 18 + Math.floor(rng() * 13);  // 18–30
  if (roll < 0.65) return 31 + Math.floor(rng() * 20);  // 31–50
  if (roll < 0.90) return 51 + Math.floor(rng() * 15);  // 51–65
  return 66 + Math.floor(rng() * 15);                    // 66–80
}

function getAllowedEducations(tool, category) {
  if (JOBS_BY_BUILDING[tool]) return JOBS_BY_BUILDING[tool];
  const key = `_default_${category}`;
  return JOBS_BY_BUILDING[key] || [0, 1, 2];
}

// ─── Bürger für ein Wohngebäude generieren ────────────────────────────────

async function generateCitizensForBuilding(buildingId, tool, municipalityId, maxPop) {
  ensureDbEnabled();
  if (!maxPop || maxPop <= 0) return;

  // Prüfen ob bereits Bürger vorhanden (kein Doppel-Spawn)
  const [existing] = await dbPool.query(
    'SELECT COUNT(*) AS cnt FROM citizens WHERE home_building_id = ?',
    [buildingId]
  );
  if (existing[0].cnt > 0) return;

  const capacity = Math.min(maxPop, 50); // Sicherheitsgrenze pro Gebäude
  let citizensToCreate = [];
  let familiesToCreate = [];
  let remaining = capacity;
  let seed = (municipalityId * 1000003 + buildingId * 7919) >>> 0;
  const rng = mulberry32(seed);

  while (remaining > 0) {
    // Familiengrösse bestimmen (1–4 Personen)
    let familySize = 1;
    const roll = rng();
    if (roll < 0.30) familySize = 1;       // Einzelperson 30%
    else if (roll < 0.60) familySize = 2;  // Pärchen      30%
    else if (roll < 0.85) familySize = 3;  // Familie      25%
    else familySize = Math.min(4, remaining); // Grossfamilie 15%

    familySize = Math.min(familySize, remaining);
    const surname_seed = Math.floor(rng() * 2147483647) + 1;

    familiesToCreate.push({ surname_seed, size: familySize, municipalityId });

    for (let i = 0; i < familySize; i++) {
      const name_seed = Math.floor(rng() * 2147483647) + 1;
      const nationality_id = pickNationality(rng);
      const education = pickEducation(tool, rng);
      const age = pickAge(rng);
      const gender = rng() < 0.5 ? 0 : 1;
      // Kinder/Jugendliche keine Ausbildung
      const finalEducation = age < 18 ? 0 : education;
      // Auto-Wahrscheinlichkeit nach Education: 0→5%, 1→25%, 2→55%, 3→80%
      const carChances = [0.05, 0.25, 0.55, 0.80];
      const has_car = (age >= 18 && rng() < (carChances[finalEducation] ?? 0.05)) ? 1 : 0;

      citizensToCreate.push({
        name_seed,
        age,
        gender,
        nationality_id,
        education: finalEducation,
        has_car,
        familyIndex: familiesToCreate.length - 1,
      });
    }
    remaining -= familySize;
  }

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    // Familien einfügen und IDs sammeln
    const familyIds = [];
    for (const fam of familiesToCreate) {
      const [res] = await conn.query(
        'INSERT INTO families (municipality_id, surname_seed, size) VALUES (?, ?, ?)',
        [fam.municipalityId, fam.surname_seed, fam.size]
      );
      familyIds.push(res.insertId);
    }

    // Bürger batch-einfügen
    if (citizensToCreate.length > 0) {
      const values = citizensToCreate.map(c => [
        municipalityId,
        familyIds[c.familyIndex],
        c.name_seed,
        c.age,
        c.gender,
        c.nationality_id,
        c.education,
        buildingId,
        null,       // workplace_id: wird via assignJobsToCitizens gesetzt
        (START_HAPPINESS_BY_BUILDING[tool] ?? 70), // happiness nach Gebäudetyp
        c.has_car,
        municipalityId, // origin = aktuelle Gemeinde
        null,
      ]);
      await conn.query(
        `INSERT INTO citizens
          (municipality_id, family_id, name_seed, age, gender, nationality_id,
           education, home_building_id, workplace_id, happiness, has_car,
           origin_municipality_id, previous_municipality_id)
         VALUES ?`,
        [values]
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    logError('citizens.generateCitizensForBuilding', err);
  } finally {
    conn.release();
  }
}

// ─── Jobs zuweisen ────────────────────────────────────────────────────────
// Verknüpft arbeitslose Bürger mit freien Arbeitsstellen in der Gemeinde.
// Prüft education-Match pro Gebäudetyp.

async function assignJobsToCitizens(municipalityId) {
  ensureDbEnabled();
  try {
    // Alle Gebäude mit Jobs holen (commercial + industrial + infrastructure)
    const [jobBuildings] = await dbPool.query(
      `SELECT gi.id AS building_id, gi.tool, gid.category, gid.max_jobs
       FROM game_items gi
       JOIN game_item_details gid ON gi.tool = gid.tool
       WHERE gi.municipality_id = ?
         AND gi.action_type = 'place'
         AND gid.max_jobs > 0
         AND gid.category IN ('commercial','industrial','infrastructure')`,
      [municipalityId]
    );
    if (!jobBuildings.length) return;

    for (const building of jobBuildings) {
      // Wie viele Stellen sind schon belegt?
      const [occupied] = await dbPool.query(
        'SELECT COUNT(*) AS cnt FROM citizens WHERE workplace_id = ?',
        [building.building_id]
      );
      const freeSlots = building.max_jobs - occupied[0].cnt;
      if (freeSlots <= 0) continue;

      const allowedEdu = getAllowedEducations(building.tool, building.category);
      const eduPlaceholders = allowedEdu.map(() => '?').join(',');

      // Arbeitslose Bürger mit passender Education holen
      const [candidates] = await dbPool.query(
        `SELECT id FROM citizens
         WHERE municipality_id = ?
           AND workplace_id IS NULL
           AND education IN (${eduPlaceholders})
         LIMIT ?`,
        [municipalityId, ...allowedEdu, freeSlots]
      );
      if (!candidates.length) continue;

      const ids = candidates.map(c => c.id);
      await dbPool.query(
        `UPDATE citizens SET workplace_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
        [building.building_id, ...ids]
      );
    }
  } catch (err) {
    logError('citizens.assignJobsToCitizens', err);
  }
}

// ─── Happiness-Tick (Batch, alle 5 Minuten) ───────────────────────────────

async function runCitizenHappinessTick(municipalityId, crimeRate = 0) {
  ensureDbEnabled();
  try {
    // Arbeitslose: -3 Happiness (CAST verhindert UNSIGNED-Overflow bei 0)
    await dbPool.query(
      `UPDATE citizens
       SET happiness = GREATEST(0, CAST(happiness AS SIGNED) - 3)
       WHERE municipality_id = ? AND workplace_id IS NULL`,
      [municipalityId]
    );

    // Hohe Kriminalität (>50%): -2 Happiness
    if (crimeRate > 0.5) {
      await dbPool.query(
        `UPDATE citizens
         SET happiness = GREATEST(0, CAST(happiness AS SIGNED) - 2)
         WHERE municipality_id = ?`,
        [municipalityId]
      );
    }

    // Alle mit Job und niedriger Kriminalität: +1 Happiness (bis max 100)
    if (crimeRate < 0.3) {
      await dbPool.query(
        `UPDATE citizens
         SET happiness = LEAST(100, CAST(happiness AS SIGNED) + 1)
         WHERE municipality_id = ? AND workplace_id IS NOT NULL`,
        [municipalityId]
      );
    }
  } catch (err) {
    logError('citizens.runCitizenHappinessTick', err);
  }
}

// ─── Migrations-Check: Unglückliche Bürger ziehen aus ─────────────────────

async function runCitizenMigrationCheck(municipalityId) {
  ensureDbEnabled();
  try {
    const [unhappy] = await dbPool.query(
      `SELECT id, workplace_id, happiness FROM citizens
       WHERE municipality_id = ? AND happiness < 20
       LIMIT 20`,
      [municipalityId]
    );
    if (!unhappy.length) return;

    for (const citizen of unhappy) {
      const reason = citizen.workplace_id === null ? 'no_job' : 'low_happiness';
      await dbPool.query(
        `INSERT INTO citizen_migrations (citizen_id, from_municipality_id, to_municipality_id, reason_code)
         VALUES (?, ?, 0, ?)`,
        [citizen.id, municipalityId, reason]
      );
      // Bürger aus Gemeinde entfernen (home + workplace freigeben)
      await dbPool.query(
        `UPDATE citizens SET home_building_id = NULL, workplace_id = NULL, municipality_id = 0
         WHERE id = ?`,
        [citizen.id]
      );
      // Nur letzte 3 Migrations-Einträge behalten
      await dbPool.query(
        `DELETE FROM citizen_migrations
         WHERE citizen_id = ?
           AND id NOT IN (
             SELECT id FROM (
               SELECT id FROM citizen_migrations
               WHERE citizen_id = ?
               ORDER BY migrated_at DESC
               LIMIT 3
             ) AS keep
           )`,
        [citizen.id, citizen.id]
      );
    }
  } catch (err) {
    logError('citizens.runCitizenMigrationCheck', err);
  }
}

// ─── Bürger eines Gebäudes abfragen (für Gebäude-Tooltip) ─────────────────

async function getCitizensByBuilding(buildingId) {
  ensureDbEnabled();
  try {
    const [rows] = await dbPool.query(
      `SELECT c.id, c.name_seed, c.age, c.gender, c.nationality_id,
              c.education, c.has_car, c.happiness, c.workplace_id,
              f.surname_seed
       FROM citizens c
       LEFT JOIN families f ON c.family_id = f.id
       WHERE c.home_building_id = ?
       LIMIT 50`,
      [buildingId]
    );
    return rows;
  } catch (err) {
    logError('citizens.getCitizensByBuilding', err);
    return [];
  }
}

// ─── Aktive Pendler für Socket-Broadcast ──────────────────────────────────
// Gibt Bürger zurück die gerade "unterwegs" sind (tageszeit-abhängig).
// Wird im 3-Sekunden-Tick aufgerufen – daher sehr lightweight.

async function getActiveCitizensForBroadcast(municipalityId, hour) {
  ensureDbEnabled();
  try {
    const isRushHourMorning = hour >= 6 && hour < 9;
    const isRushHourEvening = hour >= 17 && hour < 19;
    const isLeisure = hour >= 19 || (hour >= 12 && hour < 14);

    if (!isRushHourMorning && !isRushHourEvening && !isLeisure) return [];

    let state = 'leisure';
    if (isRushHourMorning) state = 'to_work';
    if (isRushHourEvening) state = 'to_home';

    // Nur Bürger mit Arbeitsort während Rushhour, alle während Freizeit
    const whereExtra = (state === 'leisure') ? '' : 'AND c.workplace_id IS NOT NULL';
    const limit = isLeisure ? 30 : 50;

    const [rows] = await dbPool.query(
      `SELECT c.id AS citizen_id, c.name_seed, c.nationality_id, c.age,
              c.gender, c.education, c.has_car, c.happiness,
              c.home_building_id, c.workplace_id,
              f.surname_seed
       FROM citizens c
       LEFT JOIN families f ON c.family_id = f.id
       WHERE c.municipality_id = ? ${whereExtra}
       ORDER BY RAND()
       LIMIT ?`,
      [municipalityId, limit]
    );

    return rows.map(r => ({ ...r, commute_state: state }));
  } catch (err) {
    logError('citizens.getActiveCitizensForBroadcast', err);
    return [];
  }
}

// ─── Backfill: Bestehende Gebäude mit Bürgern füllen ──────────────────────
// Wird einmal pro Gemeinde beim Server-Start ausgeführt.
// Generiert Bürger für alle Wohngebäude ohne Bewohner, dann weist Jobs zu.

// Wohngebäude-Typen die aus Zonen entstehen können
const RESIDENTIAL_ZONE_TYPES = new Set([
  'house_small', 'house_medium', 'mansion',
  'apartment_low', 'apartment_high', 'cabin_house',
]);

async function backfillCitizensForAllBuildings(municipalityId) {
  ensureDbEnabled();
  try {
    // 1) Direkt platzierte Wohngebäude (action_type = 'place')
    const [placedBuildings] = await dbPool.query(
      `SELECT gi.id AS building_id, gi.tool
       FROM game_items gi
       LEFT JOIN game_item_details gid ON gi.tool = gid.tool
       WHERE gi.municipality_id = ?
         AND gi.action_type = 'place'
         AND gid.category = 'residential'`,
      [municipalityId]
    );

    // 2) Zone-evolved Wohngebäude (action_type = 'zone', buildingType in metadata)
    const [zoneBuildings] = await dbPool.query(
      `SELECT id AS building_id,
              JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.buildingType')) AS tool
       FROM game_items
       WHERE municipality_id = ?
         AND action_type = 'zone'
         AND JSON_EXTRACT(metadata, '$.buildingType') IS NOT NULL`,
      [municipalityId]
    );
    const residentialZoneBuildings = zoneBuildings.filter(
      b => b.tool && RESIDENTIAL_ZONE_TYPES.has(b.tool)
    );

    const residentialBuildings = [...placedBuildings, ...residentialZoneBuildings];

    // max_pop aus HARD_CODED_BUILDING_STATS ermitteln
    residentialBuildings.forEach(b => {
      b.max_pop = HARD_CODED_BUILDING_STATS.get(b.tool)?.maxPop ?? 4;
    });
    if (!residentialBuildings.length) return;

    // Bereits belegte Gebäude ausfiltern (eine Query statt N)
    const [occupiedRows] = await dbPool.query(
      `SELECT DISTINCT home_building_id FROM citizens WHERE municipality_id = ? AND home_building_id IS NOT NULL`,
      [municipalityId]
    );
    const occupiedSet = new Set(occupiedRows.map(r => r.home_building_id));

    const empty = residentialBuildings.filter(b => !occupiedSet.has(b.building_id));
    if (!empty.length) {
      // Alle Gebäude haben Bewohner — trotzdem Jobs nachweisen
      await assignJobsToCitizens(municipalityId);
      return;
    }

    for (const b of empty) {
      await generateCitizensForBuilding(b.building_id, b.tool, municipalityId, b.max_pop);
    }

    // Jobs für alle (neu und bereits vorhandene) arbeitslosen Bürger zuweisen
    await assignJobsToCitizens(municipalityId);
  } catch (err) {
    logError('citizens.backfillCitizensForAllBuildings', err);
  }
}

// ─── Gesamtstatistik einer Gemeinde (für Stats-Panel) ─────────────────────

async function getCitizenStats(municipalityId) {
  ensureDbEnabled();
  try {
    const [[stats]] = await dbPool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(workplace_id IS NOT NULL) AS employed,
         SUM(has_car = 1) AS with_car,
         ROUND(AVG(happiness)) AS avg_happiness,
         SUM(education = 0) AS edu_none,
         SUM(education = 1) AS edu_apprentice,
         SUM(education = 2) AS edu_college,
         SUM(education = 3) AS edu_university
       FROM citizens
       WHERE municipality_id = ?`,
      [municipalityId]
    );
    return stats;
  } catch (err) {
    logError('citizens.getCitizenStats', err);
    return null;
  }
}

module.exports = {
  generateCitizensForBuilding,
  assignJobsToCitizens,
  backfillCitizensForAllBuildings,
  runCitizenHappinessTick,
  runCitizenMigrationCheck,
  getCitizensByBuilding,
  getActiveCitizensForBroadcast,
  getCitizenStats,
};
