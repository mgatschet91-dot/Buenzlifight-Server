'use strict';

const crypto = require('crypto');
const { dbPool, ensureDbEnabled } = require('../infra/db.js');
const { SERVICE_UPGRADE_TOOLS, SERVICE_LEVEL_CONFIG } = require('../config/constants.js');
const {
  toJsonValue,
  toFiniteNumber,
  jsonEquals,
  metaValue,
  normalizeRoomCode,
  pickRandomRows,
} = require('../shared/helpers.js');
const { pushDiscordEvent } = require('../shared/discord.js');

const disasterTickLocks = new Set();
const upgradeTickLocks = new Set();
const woodcutterTickLocks = new Set();
const crimeTickLocks = new Set();

// ─── Crime NPC In-Memory State ──────────────────────────────────
// Pro Room: Map<lockKey, { criminals: Map<id, criminalObj>, nextId: number }>
const crimeRoomState = new Map();

const DISASTER_NON_BURNABLE_TOOLS = new Set([
  'grass',
  'water',
  'road',
  'rail',
  'bridge',
  'tree',
  'furni',
]);
const FIRE_RESPONSE_RANGE_TILES = 18;

const NON_UPGRADABLE_TOOLS = new Set([
  'grass',
  'water',
  'road',
  'rail',
  'bridge',
  'tree',
  'empty',
  'zone_residential',
  'zone_commercial',
  'zone_industrial',
  'zone_dezone',
  'zone_water',
  'zone_land',
  'terrain_raise',
  'terrain_lower',
  'terrain_lower2',
  'terrain_hill',
  'terrain_mountain',
  'terrain_flatten',
  'paint_green',
  'paint_sand',
  'paint_dirt',
  'paint_snow',
  'paint_dark_grass',
  'paint_rock',
  'paint_reset',
  'bank_house',
  'mansion',
]);

const ZONE_SPAWN_BUILDINGS = Object.freeze({
  residential: Object.freeze(['house_small', 'house_medium']),
  commercial: Object.freeze(['shop_small', 'shop_medium']),
  industrial: Object.freeze(['factory_small']),
});

const ZONE_EVOLUTION_CHAIN = Object.freeze({
  residential: Object.freeze(['house_small', 'house_medium', 'mansion', 'apartment_low', 'apartment_high']),
  commercial: Object.freeze(['shop_small', 'shop_medium', 'office_low', 'office_high', 'mall']),
  industrial: Object.freeze(['factory_small', 'factory_medium', 'warehouse', 'factory_large', 'factory_large']),
});

const SERVER_BUILDING_SIZES = Object.freeze({
  mansion: { width: 2, height: 2 },
  apartment_low: { width: 2, height: 2 },
  apartment_high: { width: 2, height: 2 },
  office_low: { width: 2, height: 2 },
  office_high: { width: 2, height: 2 },
  mall: { width: 3, height: 3 },
  factory_medium: { width: 2, height: 2 },
  factory_large: { width: 3, height: 3 },
  warehouse: { width: 2, height: 2 },
});

const SERVER_CONSOLIDATABLE_BUILDINGS = Object.freeze({
  residential: new Set(['house_small', 'house_medium']),
  commercial: new Set(['shop_small', 'shop_medium']),
  industrial: new Set(['factory_small']),
});

const SERVER_MERGEABLE_TYPES = new Set(['grass', 'tree', '']);

const DEBUG_DISASTER_TYPES = new Set([
  'fire_single',
  'fire_cluster',
  'fire_storm',
  'earthquake',
  'meteor',
  'extinguish_all',
]);

function canBurnTool(tool) {
  const t = String(tool || '').trim().toLowerCase();
  if (!t) return false;
  if (DISASTER_NON_BURNABLE_TOOLS.has(t)) return false;
  if (t.startsWith('tree_') || t.startsWith('bush_') || t.startsWith('flower_') || t.startsWith('topiary_')) return false;
  if (t.startsWith('furni_') || t === 'furni') return false;
  return true;
}

function isFireStationTool(tool) {
  const t = String(tool || '').trim().toLowerCase();
  if (!t) return false;
  if (t === 'fire_station') return true;
  return t.includes('fire') && t.includes('station');
}

function isDisasterEnabledInStats(rawStats) {
  const stats = rawStats && typeof rawStats === 'object' ? rawStats : {};
  const mapData = stats.game_map_data && typeof stats.game_map_data === 'object' ? stats.game_map_data : null;
  const settings = mapData && typeof mapData.settings === 'object' ? mapData.settings : null;
  if (settings && typeof settings.disastersEnabled === 'boolean') {
    return settings.disastersEnabled;
  }
  return true;
}

function getZoneBuildingPool(zoneType) {
  const z = String(zoneType || '').trim().toLowerCase();
  const pool = ZONE_SPAWN_BUILDINGS[z];
  return Array.isArray(pool) ? pool : [];
}

function getZoneStarterBuilding(zoneType) {
  const pool = getZoneBuildingPool(zoneType);
  return pool.length > 0 ? String(pool[0]) : '';
}

function deterministicUpgradeUnit(key) {
  const digest = crypto.createHash('sha256').update(String(key)).digest('hex');
  const n = parseInt(digest.slice(0, 8), 16);
  return n / 0xffffffff;
}

function getUpgradeHourRangeForLevel(fromLevel) {
  switch (Number(fromLevel)) {
    case 1:
      return [2 / 60, 5 / 60];
    case 2:
      return [5 / 60, 12 / 60];
    case 3:
      return [15 / 60, 30 / 60];
    case 4:
      return [30 / 60, 60 / 60];
    default:
      return [1, 2];
  }
}

function getServerTargetLevelByElapsedHours(seedBase, elapsedHours) {
  let cumulative = 0;
  let level = 1;
  for (let fromLevel = 1; fromLevel <= 4; fromLevel += 1) {
    const [minH, maxH] = getUpgradeHourRangeForLevel(fromLevel);
    const r = deterministicUpgradeUnit(`${seedBase}:L${fromLevel}`);
    const needed = minH + (maxH - minH) * r;
    cumulative += needed;
    if (elapsedHours >= cumulative) {
      level = fromLevel + 1;
    } else {
      break;
    }
  }
  return Math.max(1, Math.min(5, level));
}

// === Neue langsamere Level-Progression mit Bodenwert/Service/Demand Modifiern ===
function getSlowUpgradeHourRangeForLevel(fromLevel) {
  switch (Number(fromLevel)) {
    case 1: return [0.5, 1.5];   // L1->L2: 30 min bis 1.5h
    case 2: return [2, 4];        // L2->L3: 2-4h
    case 3: return [6, 12];       // L3->L4: 6-12h
    case 4: return [12, 24];      // L4->L5: 12-24h
    default: return [24, 48];
  }
}

function getServerTargetLevel(seedBase, elapsedHours, landValue, serviceCoverage, zoneDemand) {
  let cumulative = 0;
  let level = 1;
  for (let fromLevel = 1; fromLevel <= 4; fromLevel += 1) {
    const [minH, maxH] = getSlowUpgradeHourRangeForLevel(fromLevel);
    const r = deterministicUpgradeUnit(`${seedBase}:L${fromLevel}`);
    const baseNeeded = minH + (maxH - minH) * r;

    // LandValue-Modifier: bei 50 (Standard) = neutral (1.0x)
    // bei 100 = 0.7x (30% schneller), bei 0 = 1.6x (60% langsamer)
    const lvNorm = Math.max(0, Math.min(200, landValue || 50)) / 100;
    const landValueModifier = Math.max(0.4, Math.min(1.6, 1.6 - lvNorm * 0.6));

    // Service-Modifier: bei 50% = neutral, bei 100% = 0.8x, bei 0% = 1.2x
    const svcNorm = Math.max(0, Math.min(100, serviceCoverage || 0)) / 100;
    const serviceModifier = Math.max(0.8, 1.2 - svcNorm * 0.4);

    // Demand-Modifier: bei 0 = 1.1x, bei 50 = 0.9x, bei -50 = 1.3x
    const demandClamped = Math.max(-100, Math.min(100, zoneDemand || 0));
    const demandModifier = Math.max(0.7, Math.min(1.4, 1.1 - demandClamped * 0.004));

    const needed = baseNeeded * landValueModifier * serviceModifier * demandModifier;
    cumulative += needed;
    if (elapsedHours >= cumulative) {
      level = fromLevel + 1;
    } else {
      break;
    }
  }
  return Math.max(1, Math.min(5, level));
}

function canUpgradeTool(tool) {
  const t = String(tool || '').trim().toLowerCase();
  if (!t) return false;
  if (NON_UPGRADABLE_TOOLS.has(t)) return false;
  if (t.startsWith('tree_') || t.startsWith('bush_') || t.startsWith('flower_') || t.startsWith('topiary_')) return false;
  return true;
}

function getEconomicZoneFromRow(row, meta) {
  const { inferCategoryFromTool } = require('./building.js');
  const explicitZone = String(row?.zone_type || '').trim().toLowerCase();
  if (explicitZone === 'residential' || explicitZone === 'commercial' || explicitZone === 'industrial') {
    return explicitZone;
  }
  const effectiveTool = String(
    row?.action_type === 'zone'
      ? (metaValue(meta, 'buildingType', 'building_type') || '')
      : (row?.tool || '')
  )
    .trim()
    .toLowerCase();
  const inferred = inferCategoryFromTool(effectiveTool, 'general');
  if (inferred === 'residential' || inferred === 'commercial' || inferred === 'industrial') {
    return inferred;
  }
  return null;
}

function getUpgradeToolFromRow(row, meta) {
  const effectiveTool = String(
    row?.action_type === 'zone'
      ? (metaValue(meta, 'buildingType', 'building_type') || '')
      : (row?.tool || '')
  )
    .trim()
    .toLowerCase();
  return effectiveTool;
}

function getTargetBuildingTypeForLevel(zoneCategory, level) {
  const chain = ZONE_EVOLUTION_CHAIN[zoneCategory];
  if (!Array.isArray(chain) || chain.length === 0) return null;
  const safeLevel = Math.max(1, Math.min(chain.length, Math.round(Number(level) || 1)));
  return chain[safeLevel - 1] || chain[0];
}

function getServerBuildingSize(buildingType) {
  const t = String(buildingType || '').trim().toLowerCase();
  const size = SERVER_BUILDING_SIZES[t];
  return size ? { width: size.width, height: size.height } : { width: 1, height: 1 };
}

function buildRoomGrid(rows) {
  const grid = new Map();
  for (const row of rows) {
    if (row.action_type !== 'place' && row.action_type !== 'zone') continue;
    const x = Number(row.x);
    const y = Number(row.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    grid.set(`${x},${y}`, row);
  }
  return grid;
}

function isServerMergeableTile(tileRow, tileMeta, targetZone, isOriginTile, allowBuildingConsolidation) {
  if (isOriginTile) {
    const zone = String(tileRow?.zone_type || '').trim().toLowerCase();
    return zone === targetZone && tileMeta.onFire !== true;
  }
  const zone = String(tileRow?.zone_type || '').trim().toLowerCase();
  if (zone !== targetZone) return false;
  if (tileMeta.onFire === true) return false;
  if (tileMeta.abandoned === true) return false;
  const bt = String(metaValue(tileMeta, 'buildingType', 'building_type') || tileRow?.tool || '').trim().toLowerCase();
  if (SERVER_MERGEABLE_TYPES.has(bt) || bt === 'grass') return true;
  if (allowBuildingConsolidation) {
    const consolidatable = SERVER_CONSOLIDATABLE_BUILDINGS[targetZone];
    if (consolidatable && consolidatable.has(bt)) {
      const cp = Number(metaValue(tileMeta, 'constructionProgress', 'construction_progress') ?? 100);
      return cp >= 100 || tileMeta.constructed === true;
    }
  }
  if (bt === 'empty') return false;
  return false;
}

function findServerConsolidationFootprint(grid, x, y, width, height, zone, allowBuildingConsolidation) {
  let bestOrigin = null;
  let bestScore = -Infinity;
  for (let oy = y - (height - 1); oy <= y; oy++) {
    for (let ox = x - (width - 1); ox <= x; ox++) {
      let available = true;
      for (let dy = 0; dy < height && available; dy++) {
        for (let dx = 0; dx < width && available; dx++) {
          const key = `${ox + dx},${oy + dy}`;
          const tileRow = grid.get(key);
          if (!tileRow) {
            available = false;
            break;
          }
          const tileMeta = toJsonValue(tileRow.metadata) || {};
          const isOrigin = ox + dx === x && oy + dy === y;
          if (!isServerMergeableTile(tileRow, tileMeta, zone, isOrigin, allowBuildingConsolidation)) {
            available = false;
          }
        }
      }
      if (!available) continue;
      if (x < ox || x >= ox + width || y < oy || y >= oy + height) continue;
      let score = 0;
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          const neighbors = [
            [ox + dx - 1, oy + dy],
            [ox + dx + 1, oy + dy],
            [ox + dx, oy + dy - 1],
            [ox + dx, oy + dy + 1],
          ];
          for (const [nx, ny] of neighbors) {
            const nRow = grid.get(`${nx},${ny}`);
            if (!nRow) continue;
            const nTool = String(nRow.tool || '').toLowerCase();
            const nMeta = toJsonValue(nRow.metadata) || {};
            const nBt = String(metaValue(nMeta, 'buildingType', 'building_type') || nTool).toLowerCase();
            if (nBt === 'road' || nBt === 'bridge' || nTool === 'road' || nTool === 'bridge') score++;
          }
        }
      }
      score -= width * height * 0.25;
      if (score > bestScore) {
        bestScore = score;
        bestOrigin = { originX: ox, originY: oy };
      }
    }
  }
  return bestOrigin;
}

function pickRandomZoneBuildingType(zoneType) {
  const pool = getZoneBuildingPool(zoneType);
  if (pool.length <= 0) return null;
  // Original-Logik: immer Level-1 Gebaeude spawnen (house_small, shop_small, factory_small)
  // Vielfalt kommt durch Evolution (runServerBuildingUpgradeTick)
  return String(pool[0] || '');
}

async function runServerBuildingUpgradeTick(municipalityId, roomCode, sharedRows, context) {
  ensureDbEnabled();
  const { loadRoomStats, getRoomItemRows, getRoomItemVersion, toItemsStatsShape } = require('./rooms.js');
  const { refreshGameDataMapFromItems } = require('./map.js');
  const { getMunicipalityById } = require('./municipality.js');

  const lockKey = `${municipalityId}:${normalizeRoomCode(roomCode)}`;
  if (upgradeTickLocks.has(lockKey)) return { updated: 0 };
  upgradeTickLocks.add(lockKey);

  try {
    const rawStats = (await loadRoomStats(municipalityId, roomCode)) || {};
    const statsShape = toItemsStatsShape(rawStats);
    const demand =
      statsShape && statsShape.demand && typeof statsShape.demand === 'object'
        ? statsShape.demand
        : { residential: 0, commercial: 0, industrial: 0 };
    const powerBalance = toFiniteNumber(rawStats.power_production, 0) - toFiniteNumber(rawStats.power_consumption, 0);
    const waterBalance = toFiniteNumber(rawStats.water_production, 0) - toFiniteNumber(rawStats.water_consumption, 0);
    const hasPower = powerBalance > 0;
    const hasWater = waterBalance > 0;

    const rows = sharedRows || await getRoomItemRows(municipalityId, roomCode);
    if (!rows.length) return { updated: 0 };

    const candidates = rows.filter((row) => {
      if (row.action_type !== 'place' && row.action_type !== 'zone') return false;
      const meta = toJsonValue(row.metadata) || {};
      const toolForUpgrade = getUpgradeToolFromRow(row, meta);
      return canUpgradeTool(toolForUpgrade);
    });
    if (!candidates.length) return { updated: 0 };

    let currentVersion = await getRoomItemVersion(municipalityId, roomCode);
    const nowMs = Date.now();
    const now = new Date();
    const timestamp = Date.now();
    let updated = 0;
    const changedTiles = [];
    let roomGrid = null;
    const processedTiles = new Set();

    for (const row of candidates) {
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent) continue;
      if (meta.onFire === true) continue;
      const rowTool = String(row.tool || '').trim().toLowerCase();
      if (rowTool === 'furni' || rowTool.startsWith('furni_')) continue;
      if (processedTiles.has(`${row.x},${row.y}`)) continue;

      const constructionProgress = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 100);
      let isConstructed = constructionProgress >= 100;

      let nextMeta = { ...meta };

      if (!isConstructed && (row.action_type === 'zone' || row.action_type === 'place')) {
        const buildingType = String(metaValue(meta, 'buildingType', 'building_type') || row.tool || '').trim().toLowerCase();

        if (buildingType.length > 0) {
          const consolidatedAtMs = Number(metaValue(meta, 'constructionStartedAt') || 0);
          const createdAtMs = row.created_at ? new Date(row.created_at).getTime() : Number(row.client_timestamp || 0);
          const referenceMs = consolidatedAtMs > 0 ? consolidatedAtMs : createdAtMs;
          const safeCreatedAtMs = Number.isFinite(referenceMs) && referenceMs > 0 ? referenceMs : nowMs;
          const elapsedSec = Math.max(0, (nowMs - safeCreatedAtMs) / 1000);
          const constructionSpeedPerSec = 100 / 15; // ~15 Sekunden Bauzeit
          const targetProgress = Math.min(100, Math.round(constructionSpeedPerSec * elapsedSec * 100) / 100);

          if (targetProgress > constructionProgress) {
            nextMeta.constructionProgress = targetProgress;
            nextMeta.constructed = targetProgress >= 100;
            isConstructed = nextMeta.constructed === true;
            // Level explizit setzen sobald Bau fertig
            if (isConstructed && !nextMeta.level) {
              nextMeta.level = 1;
            }
          }
          // Sicherheitsnetz: constructionProgress=100 aber constructed fehlt → fixieren
          if (nextMeta.constructionProgress >= 100 && !nextMeta.constructed) {
            nextMeta.constructed = true;
            isConstructed = true;
            if (!nextMeta.level) nextMeta.level = 1;
          }
        }

        if (!isConstructed) {
          if (!jsonEquals(meta, nextMeta)) {
            currentVersion += 1;
            await dbPool.query(
              `UPDATE game_items
               SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [JSON.stringify(nextMeta), currentVersion, timestamp, now, row.id]
            );
            updated += 1;
            changedTiles.push({
              x: Number(row.x),
              y: Number(row.y),
              level: Number(nextMeta.level ?? 1),
              abandoned: false,
              buildingType: String(nextMeta.buildingType || row.tool || ''),
              constructionProgress: nextMeta.constructionProgress,
              constructed: false,
            });
          }
          continue;
        }

        // Bau gerade fertig geworden (isConstructed = true, aber meta.constructed war noch false)
        // → sofort in DB speichern damit der Status nicht verloren geht
        if (!meta.constructed || meta.constructionProgress < 100) {
          currentVersion += 1;
          await dbPool.query(
            `UPDATE game_items
             SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [JSON.stringify(nextMeta), currentVersion, timestamp, now, row.id]
          );
          updated += 1;
          changedTiles.push({
            x: Number(row.x),
            y: Number(row.y),
            level: Number(nextMeta.level ?? meta.level ?? 1),
            abandoned: false,
            buildingType: String(nextMeta.buildingType || row.tool || ''),
            constructionProgress: 100,
            constructed: true,
          });
          // meta jetzt aktualisieren damit jsonEquals weiter unten korrekt arbeitet
          Object.assign(meta, nextMeta);
        }
      }
      if (!isConstructed) continue;

      // ── Timed Upgrade Completion ──────────────────────────────────────
      // upgrade-building Handler speichert upgrade_started_at, upgrade_target_level, upgrade_seconds.
      // Wenn die Zeit abgelaufen ist: Level setzen und Upgrade-Felder aufraeumen.
      const upgradeStartedAt = Number(metaValue(meta, 'upgrade_started_at', 'upgradeStartedAt') || 0);
      const upgradeTargetLevel = Number(metaValue(meta, 'upgrade_target_level', 'upgradeTargetLevel') || 0);
      const upgradeDurationSec = Number(metaValue(meta, 'upgrade_seconds', 'upgradeSeconds') || 0);
      if (upgradeStartedAt > 0 && upgradeTargetLevel > 0) {
        const elapsedMs = nowMs - upgradeStartedAt;
        const requiredMs = upgradeDurationSec > 0 ? upgradeDurationSec * 1000 : 0;
        if (elapsedMs >= requiredMs) {
          // Upgrade abgeschlossen → Level setzen, Felder aufraeumen
          nextMeta.level = upgradeTargetLevel;
          delete nextMeta.upgrade_started_at;
          delete nextMeta.upgradeStartedAt;
          delete nextMeta.upgrade_target_level;
          delete nextMeta.upgradeTargetLevel;
          delete nextMeta.upgrade_seconds;
          delete nextMeta.upgradeSeconds;
        }
      }

      const zoneCategory = getEconomicZoneFromRow(row, meta);
      const isEconomicZone = zoneCategory === 'residential' || zoneCategory === 'commercial' || zoneCategory === 'industrial';
      const currentAbandoned = Boolean(meta.abandoned === true);
      const startedAtMsBase = row.applied_at ? new Date(row.applied_at).getTime() : Number(row.client_timestamp || 0);
      const startedAtMs = Number.isFinite(startedAtMsBase) && startedAtMsBase > 0 ? startedAtMsBase : nowMs;
      const ageHours = Math.max(0, (nowMs - startedAtMs) / (1000 * 60 * 60));
      const lastAbandonTickMsRaw = Number(metaValue(meta, 'lastAbandonmentTickAt', 'last_abandonment_tick_at') || startedAtMs);
      const lastAbandonTickMs = Number.isFinite(lastAbandonTickMsRaw) && lastAbandonTickMsRaw > 0 ? lastAbandonTickMsRaw : startedAtMs;
      const elapsedAbandonHours = Math.max(0, (nowMs - lastAbandonTickMs) / (1000 * 60 * 60));

      if (isEconomicZone && elapsedAbandonHours > 0.01) {
        const zoneDemand = Math.round(toFiniteNumber(demand[zoneCategory], 0));
        const currentLevel = Math.max(1, Math.min(5, Math.round(Number(metaValue(meta, 'level') ?? 1))));

        // Police coverage affects abandonment thresholds and chances
        const tileX = Number(row.x);
        const tileY = Number(row.y);
        const policeCov = context?.serviceCoverageGrids?.police?.[tileY]?.[tileX] ?? 50;
        const abandonThreshold = policeCov < 10 ? -50 : policeCov < 20 ? -80 : -120;
        const policePenalty = policeCov < 15 ? 0.0001 : policeCov < 30 ? 0.00005 : 0;

        if (!currentAbandoned && ageHours >= 72 && zoneDemand < abandonThreshold) {
          const basePerHour = Math.min(0.0002, Math.abs(zoneDemand - abandonThreshold) / 300000);
          const utilityPenalty = (powerBalance < 0 ? 0.00005 : 0) + (waterBalance < 0 ? 0.00005 : 0);
          const levelPenalty = currentLevel <= 2 ? 0.00003 : 0;
          const perHourChance = Math.max(0, Math.min(0.0004, basePerHour + utilityPenalty + levelPenalty + policePenalty));
          const chance = 1 - Math.pow(1 - perHourChance, elapsedAbandonHours);
          if (Math.random() < chance) {
            nextMeta.abandoned = true;
          }
        } else if (currentAbandoned && zoneDemand > 5) {
          const baseRecoveryPerHour = Math.min(0.04, (zoneDemand - 5) / 2000);
          const utilityBoost = (powerBalance >= 0 ? 0.004 : 0) + (waterBalance >= 0 ? 0.004 : 0);
          const policeRecoveryBoost = policeCov > 60 ? 0.005 : 0;
          const recoveryPerHour = Math.max(0, Math.min(0.08, baseRecoveryPerHour + utilityBoost + policeRecoveryBoost));
          const recoveryChance = 1 - Math.pow(1 - recoveryPerHour, elapsedAbandonHours);
          if (Math.random() < recoveryChance) {
            nextMeta.abandoned = false;
          }
        }
        nextMeta.lastAbandonmentTickAt = nowMs;
      }

      const currentAbandonedAfterTick = Boolean(nextMeta.abandoned === true);
      const toolForUpgrade = getUpgradeToolFromRow(row, meta);

      if (!currentAbandonedAfterTick && isEconomicZone && !SERVICE_UPGRADE_TOOLS.has(toolForUpgrade)) {
        // Kein Level-Upgrade ohne Strom UND Wasser
        if (!hasPower || !hasWater) {
          // Utilities fehlen — kein Upgrade, aber Abandonment-Check laeuft weiter
        } else {
        const currentLevel = Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1))));
        if (currentLevel < 5) {
          const startedAtMsLevel = row.applied_at ? new Date(row.applied_at).getTime() : Number(row.client_timestamp || 0);
          if (Number.isFinite(startedAtMsLevel) && startedAtMsLevel > 0) {
            const elapsedHours = Math.max(0, (nowMs - startedAtMsLevel) / (1000 * 60 * 60));
            const seedBase = `${municipalityId}:${roomCode}:${row.x}:${row.y}:${toolForUpgrade}`;
            // Bodenwert + Service-Coverage vom context (berechnet in stats.js)
            const tileX = Math.round(Number(row.x || 0));
            const tileY = Math.round(Number(row.y || 0));
            const tileLandValue = context?.landValueGrid?.[tileY]?.[tileX] ?? 50;
            const tileSvcCoverage = context?.serviceCoverageGrids
              ? ((context.serviceCoverageGrids.police?.[tileY]?.[tileX] || 0) +
                 (context.serviceCoverageGrids.fire?.[tileY]?.[tileX] || 0) +
                 (context.serviceCoverageGrids.health?.[tileY]?.[tileX] || 0) +
                 (context.serviceCoverageGrids.education?.[tileY]?.[tileX] || 0)) / 4
              : 0;
            const zoneDemandVal = Math.round(toFiniteNumber(demand[zoneCategory], 0));
            const targetLevel = getServerTargetLevel(seedBase, elapsedHours, tileLandValue, tileSvcCoverage, zoneDemandVal);
            if (targetLevel > currentLevel) {
              nextMeta = {
                ...nextMeta,
                level: targetLevel,
                serverLevelAuthoritative: true,
              };
            }
          }
        }
        } // end else (hasPower && hasWater)
      }

      if (isEconomicZone && row.action_type === 'zone' && !currentAbandonedAfterTick && hasPower && hasWater) {
        const currentBuildingType = String(metaValue(nextMeta, 'buildingType', 'building_type') || '').trim().toLowerCase();
        const evolLevel = Math.max(1, Math.min(5, Math.round(Number(nextMeta.level ?? meta.level ?? 1))));
        const targetEvolutionType = getTargetBuildingTypeForLevel(zoneCategory, evolLevel);

        if (targetEvolutionType && targetEvolutionType !== currentBuildingType && currentBuildingType !== 'empty') {
          const currentSize = getServerBuildingSize(currentBuildingType);
          const targetSize = getServerBuildingSize(targetEvolutionType);

          if (targetSize.width <= currentSize.width && targetSize.height <= currentSize.height) {
            nextMeta.buildingType = targetEvolutionType;
          } else {
            if (!roomGrid) roomGrid = buildRoomGrid(rows);
            const zoneDemandVal = Math.round(toFiniteNumber(demand[zoneCategory], 0));
            let allowBuildingConsolidation = zoneDemandVal > 20;
            let consolidationChance = 0.14;
            if (zoneDemandVal > 20) {
              consolidationChance += Math.min(0.25, (zoneDemandVal - 20) / 300);
              if (zoneDemandVal > 50) {
                consolidationChance += 0.05;
                allowBuildingConsolidation = true;
              }
            }

            if (Math.random() < consolidationChance) {
              const footprint = findServerConsolidationFootprint(
                roomGrid,
                Number(row.x),
                Number(row.y),
                targetSize.width,
                targetSize.height,
                zoneCategory,
                allowBuildingConsolidation
              );

              if (footprint) {
                const ox = footprint.originX;
                const oy = footprint.originY;

                for (let dy = 0; dy < targetSize.height; dy++) {
                  for (let dx = 0; dx < targetSize.width; dx++) {
                    const tx = ox + dx;
                    const ty = oy + dy;
                    const isOrigin = dx === 0 && dy === 0;
                    const tk = `${tx},${ty}`;
                    processedTiles.add(tk);

                    const tileRow = roomGrid.get(tk);
                    const isCurrentRow = tileRow ? tileRow.id === row.id : false;

                    if (isOrigin) {
                      if (isCurrentRow) {
                        nextMeta.buildingType = targetEvolutionType;
                        nextMeta.level = evolLevel;
                        nextMeta.constructionStartedAt = nowMs;
                        nextMeta.constructionProgress = 0;
                        nextMeta.constructed = false;
                        nextMeta.abandoned = false;
                      } else {
                        if (!tileRow) continue;
                        const originMeta = { ...(toJsonValue(tileRow.metadata) || {}) };
                        originMeta.buildingType = targetEvolutionType;
                        originMeta.level = evolLevel;
                        originMeta.constructionStartedAt = nowMs;
                        originMeta.constructionProgress = 0;
                        originMeta.constructed = false;
                        originMeta.abandoned = false;
                        currentVersion += 1;
                        await dbPool.query(
                          `UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                          [JSON.stringify(originMeta), currentVersion, timestamp, now, tileRow.id]
                        );
                        updated += 1;
                        changedTiles.push({
                          x: tx,
                          y: ty,
                          level: evolLevel,
                          abandoned: false,
                          buildingType: targetEvolutionType,
                          constructionProgress: 0,
                          constructed: false,
                        });
                      }
                    } else {
                      // Nicht-Origin Tile: immer leeren – direkt via Koordinaten (robust,
                      // unabhängig davon ob das Tile im roomGrid-Snapshot vorhanden ist)
                      const emptyMeta = JSON.stringify({
                        buildingType: 'empty',
                        level: 0,
                        constructionProgress: 100,
                        constructed: true,
                        population: 0,
                        jobs: 0,
                        abandoned: false,
                      });
                      if (isCurrentRow) {
                        // Wird am Ende des outer loops über nextMeta gespeichert
                        Object.assign(nextMeta, JSON.parse(emptyMeta));
                      } else {
                        currentVersion += 1;
                        await dbPool.query(
                          `UPDATE game_items
                           SET metadata = JSON_MERGE_PATCH(COALESCE(metadata, '{}'), ?),
                               version = ?, client_timestamp = ?, applied_at = ?,
                               updated_at = CURRENT_TIMESTAMP
                           WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ?
                             AND action_type IN ('place', 'zone')`,
                          [emptyMeta, currentVersion, timestamp, now, municipalityId, roomCode, tx, ty]
                        );
                        updated += 1;
                      }
                      changedTiles.push({
                        x: tx,
                        y: ty,
                        level: 0,
                        abandoned: false,
                        buildingType: 'empty',
                        constructionProgress: 100,
                        constructed: true,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (jsonEquals(meta, nextMeta)) continue;

      currentVersion += 1;
      // applied_at wird hier NICHT aktualisiert — nur beim echten Spawn/Konsolidieren.
      // Würde applied_at hier zurückgesetzt (z.B. durch lastAbandonmentTickAt alle ~36s),
      // wäre elapsedHours immer ~0 und kein Gebäude könnte je das Level-Upgrade-Threshold erreichen.
      await dbPool.query(
        `UPDATE game_items
         SET metadata = ?, version = ?, client_timestamp = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(nextMeta), currentVersion, timestamp, row.id]
      );
      updated += 1;
      changedTiles.push({
        x: Number(row.x),
        y: Number(row.y),
        level: Number(nextMeta.level ?? meta.level ?? 1),
        abandoned: Boolean(nextMeta.abandoned),
        buildingType: String(nextMeta.buildingType || row.tool || ''),
        constructionProgress: Number(nextMeta.constructionProgress ?? meta.constructionProgress ?? 100),
        constructed: Boolean(nextMeta.constructed ?? meta.constructed ?? true),
      });
    }

    if (changedTiles.length > 0) {
      const completedCount = changedTiles.filter((c) => c.constructed === true && c.constructionProgress >= 100).length;
      const upgradedCount = changedTiles.filter((c) => c.level && c.level > 1 && !c.abandoned).length;
      const abandonedCount = changedTiles.filter((c) => c.abandoned === true).length;
      if (completedCount > 0 || upgradedCount > 0 || abandonedCount > 0) {
        getMunicipalityById(municipalityId)
          .then((m) => {
            const name = m?.name || `Gemeinde #${municipalityId}`;
            if (completedCount > 0) pushDiscordEvent('building_complete', { municipalityName: name, roomCode, count: completedCount, message: `${completedCount} Gebäude fertiggestellt in ${name}` });
            if (upgradedCount > 0) pushDiscordEvent('building_upgrade', { municipalityName: name, roomCode, count: upgradedCount, message: `${upgradedCount} Gebäude aufgewertet in ${name}` });
            if (abandonedCount > 0) pushDiscordEvent('building_abandoned', { municipalityName: name, roomCode, count: abandonedCount, message: `${abandonedCount} Gebäude verlassen in ${name}` });
          })
          .catch(() => {});
      }
    }

    return { updated, changes: changedTiles };
  } finally {
    upgradeTickLocks.delete(lockKey);
  }
}

// ── Zone Growth: Server-Authoritative ──────────────────────────────────────
// Spawnt neue Gebaeude in Zonen basierend auf Demand, Road-Access und Utilities.
// Wird alle 3s aufgerufen (3s / 0.5s = 6x schnellere Spawn-Chance als Client-Tick).

const zoneGrowthLocks = new Set();
const MAX_SPAWNS_PER_TICK = 5;

async function runServerZoneGrowthTick(municipalityId, roomCode, sharedRows, context) {
  ensureDbEnabled();
  const { loadRoomStats, getRoomItemRows, getRoomItemVersion } = require('./rooms.js');

  const safeRoomCode = normalizeRoomCode(roomCode);
  const lockKey = `${municipalityId}:${safeRoomCode}`;
  if (zoneGrowthLocks.has(lockKey)) return { changes: [] };
  zoneGrowthLocks.add(lockKey);

  try {
    const rawStats = (await loadRoomStats(municipalityId, safeRoomCode)) || {};
    const demand = {
      residential: toFiniteNumber(rawStats.demand_residential, 0),
      commercial: toFiniteNumber(rawStats.demand_commercial, 0),
      industrial: toFiniteNumber(rawStats.demand_industrial, 0),
    };

    const hasPower = toFiniteNumber(rawStats.power_production, 0) > toFiniteNumber(rawStats.power_consumption, 0);
    const hasWater = toFiniteNumber(rawStats.water_production, 0) > toFiniteNumber(rawStats.water_consumption, 0);

    const rows = sharedRows || await getRoomItemRows(municipalityId, safeRoomCode);
    if (!rows.length) return { changes: [] };

    const grid = buildRoomGrid(rows);

    // Alle Zone-Tiles sammeln
    const emptyZoneTiles = [];
    const gapClearQueue = []; // Gebaeude auf Gap-Tiles die zurueckgesetzt werden muessen
    const autoClearGapTiles = []; // Leere Gap-Tiles die freigegeben werden wenn Nachbarn Max-Level
    const level5ZoneClearQueue = []; // Zone-Rows von Level-5-Gebaeuden loeschen (Rahmen entfernen)
    for (const row of rows) {
      if (row.action_type !== 'zone') continue;
      const zoneType = String(row.zone_type || '').trim().toLowerCase();
      if (zoneType !== 'residential' && zoneType !== 'commercial' && zoneType !== 'industrial') continue;
      const meta = toJsonValue(row.metadata) || {};
      const bt = String(metaValue(meta, 'buildingType', 'building_type') || '').trim().toLowerCase();

      // Gap-Hash: deterministische Luecken (~30% bleiben immer leer)
      const gx = Number(row.x), gy = Number(row.y);
      const gapHash = (Math.imul(gx, 73856093) ^ Math.imul(gy, 19349669)) >>> 0;
      const isGapTile = (gapHash % 100) < 30;

      if (!bt || bt === 'grass' || bt === '') {
        // Leeres Tile — nur spawnen wenn KEIN Gap-Tile
        if (!isGapTile) emptyZoneTiles.push({ row, zoneType, meta });
        // Alle leeren Tiles (gap + non-gap) pruefen ob Nachbar Max-Level → dann loeschen
        autoClearGapTiles.push({ row, gx, gy });
      } else if (isGapTile) {
        // Gebaeude auf Gap-Tile: zuruecksetzen wenn Level <= 1 (noch nicht evolved)
        const lvl = Number(metaValue(meta, 'level') || 0);
        if (lvl <= 1) gapClearQueue.push({ row, meta });
      } else {
        // Gebaeude auf normalem Zone-Tile: Zone-Rahmen entfernen wenn Level 5 erreicht (NUR einmal)
        const lvl = Number(metaValue(meta, 'level') || 0);
        const progress = Number(metaValue(meta, 'constructionProgress', 'construction_progress') || 0);
        const isConstructed = Boolean(metaValue(meta, 'constructed')) || progress >= 100;
        const alreadyCleared = Boolean(meta.zoneCleared);
        if (lvl >= 5 && isConstructed && !alreadyCleared) level5ZoneClearQueue.push({ row, gx, gy, bt, lvl, meta });
      }
    }

    // Gap-Tiles automatisch bereinigen (max 3 pro Tick um Performance zu schonen)
    const changedTiles = [];
    let currentVersion = await getRoomItemVersion(municipalityId, safeRoomCode);
    const now = new Date();
    const timestamp = Date.now();

    for (let gi = 0; gi < Math.min(gapClearQueue.length, 3); gi++) {
      const { row, meta } = gapClearQueue[gi];
      const clearMeta = { ...meta, buildingType: 'grass' };
      delete clearMeta.level;
      delete clearMeta.constructionProgress;
      delete clearMeta.constructed;
      delete clearMeta.abandoned;
      currentVersion += 1;
      await dbPool.query(
        `UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify(clearMeta), currentVersion, timestamp, now, row.id]
      );
      changedTiles.push({ x: Number(row.x), y: Number(row.y), buildingType: 'grass', level: 0, abandoned: false, constructionProgress: 0, constructed: false });
    }

    // Footprint-Map: alle Positionen die von Level-5-Gebaeuden belegt sind (inkl. multi-tile)
    const MAX_LEVEL = 5;
    const maxLevelPositions = new Set();
    for (const row of rows) {
      if (row.action_type !== 'zone' && row.action_type !== 'place') continue;
      const m = toJsonValue(row.metadata) || {};
      const lvl = Number(metaValue(m, 'level') || 0);
      if (lvl < MAX_LEVEL) continue;
      const bt = String(metaValue(m, 'buildingType', 'building_type') || row.tool || '').toLowerCase();
      if (!bt || bt === 'grass') continue;
      const ox = Number(row.x), oy = Number(row.y);
      const size = getServerBuildingSize(bt);
      for (let fx = 0; fx < size.width; fx++) {
        for (let fy = 0; fy < size.height; fy++) {
          maxLevelPositions.add(`${ox + fx},${oy + fy}`);
        }
      }
    }

    // Leere Zone-Tiles freigeben wenn mindestens ein Nachbar im Footprint eines Max-Level-Gebaeudes liegt
    const neighborOffsets = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    let cleared = 0;
    const clearedRowIds = new Set();
    for (const { row, gx, gy } of autoClearGapTiles) {
      if (cleared >= 8) break;
      let hasMaxNeighbor = false;
      for (const [dx, dy] of neighborOffsets) {
        if (maxLevelPositions.has(`${gx + dx},${gy + dy}`)) {
          hasMaxNeighbor = true;
          break;
        }
      }
      if (!hasMaxNeighbor) continue;
      currentVersion += 1;
      await dbPool.query(
        `DELETE FROM game_items WHERE id = ?`,
        [row.id]
      );
      clearedRowIds.add(row.id);
      cleared++;
      changedTiles.push({ x: gx, y: gy, buildingType: 'grass', level: 0, zoneCleared: true });
    }

    // Zone-Rahmen bei Level-5-Gebaeuden entfernen (max 5 pro Tick)
    // WICHTIG: Row NICHT loeschen — das wuerde das Gebaeude aus der DB entfernen!
    // Stattdessen zoneCleared:true ins Metadata schreiben damit der Rahmen visuell verschwindet.
    let zoneClearCount = 0;
    for (const { row, gx, gy, bt, lvl, meta } of level5ZoneClearQueue) {
      if (zoneClearCount >= 5) break;
      currentVersion += 1;
      const updatedMeta = { ...meta, zoneCleared: true };
      await dbPool.query(
        `UPDATE game_items SET metadata = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify(updatedMeta), currentVersion, row.id]
      );
      zoneClearCount++;
      changedTiles.push({ x: gx, y: gy, buildingType: bt, level: lvl, zoneCleared: true });
    }

    if (emptyZoneTiles.length === 0 && changedTiles.length === 0) return { changes: changedTiles };

    // Road-Access Helper (BFS bis 8 Tiles durch gleiche Zone — wie Original)
    const hasRoadAccess = (startX, startY) => {
      const visited = new Set();
      const queue = [[startX, startY, 0]];
      visited.add(`${startX},${startY}`);
      const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      while (queue.length > 0) {
        const [cx, cy, dist] = queue.shift();
        for (const [dx, dy] of offsets) {
          const nx = cx + dx, ny = cy + dy;
          const nk = `${nx},${ny}`;
          if (visited.has(nk)) continue;
          visited.add(nk);
          const neighbor = grid.get(nk);
          if (!neighbor) continue;
          const nTool = String(neighbor.tool || '').toLowerCase();
          const nMeta = toJsonValue(neighbor.metadata) || {};
          const nBt = String(metaValue(nMeta, 'buildingType', 'building_type') || nTool).toLowerCase();
          if (nTool === 'road' || nTool === 'bridge' || nBt === 'road' || nBt === 'bridge') return true;
          // Durch gleiche Zone weitersuchen (Gras/leere Tiles)
          if (dist < 8 && neighbor.action_type === 'zone') {
            queue.push([nx, ny, dist + 1]);
          }
        }
      }
      return false;
    };

    // Shuffle und begrenzen
    const shuffled = emptyZoneTiles.sort(() => Math.random() - 0.5);
    let spawned = 0;

    for (const { row, zoneType, meta } of shuffled) {
      if (spawned >= MAX_SPAWNS_PER_TICK) break;
      if (clearedRowIds.has(row.id)) continue; // bereits in diesem Tick geloescht

      const x = Number(row.x);
      const y = Number(row.y);
      if (!hasRoadAccess(x, y)) continue;

      // Spawn-Chance: Client hat 5% pro 500ms Tick, Server tickt alle 3s
      // Adjusted: 1 - (1 - 0.05 * demandFactor)^6
      const zoneDemand = demand[zoneType] || 0;
      const demandFactor = Math.max(0, Math.min(1, (zoneDemand + 30) / 80));
      const clientTickChance = 0.05 * demandFactor;
      // Starter-Gebaeude haben Mindest-Chance
      const effectiveChance = Math.max(0.015, clientTickChance);
      const chance = 1 - Math.pow(1 - effectiveChance, 6);

      if (Math.random() >= chance) continue;

      // Police coverage slows residential growth in dangerous areas
      if (zoneType === 'residential' && context?.serviceCoverageGrids?.police) {
        const tilePoliceCov = context.serviceCoverageGrids.police[y]?.[x] ?? 50;
        if (tilePoliceCov < 20 && Math.random() >= 0.5) continue;
        else if (tilePoliceCov < 40 && Math.random() >= 0.8) continue;
      }

      // Strikt: kein Spawn ohne Wasser UND Strom (und Road-Access oben bereits geprueft)
      if (!hasPower || !hasWater) continue;

      // Gebaeude-Typ waehlen
      const buildingType = pickRandomZoneBuildingType(zoneType);
      if (!buildingType) continue;

      // Metadata aktualisieren
      const nextMeta = {
        ...meta,
        buildingType,
        level: 1,
        constructionProgress: 0,
        constructed: false,
        abandoned: false,
      };

      currentVersion += 1;
      await dbPool.query(
        `UPDATE game_items
         SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(nextMeta), currentVersion, timestamp, now, row.id]
      );

      spawned += 1;
      changedTiles.push({
        x,
        y,
        level: 1,
        abandoned: false,
        buildingType,
        constructionProgress: 0,
        constructed: false,
      });
    }

    return { changes: changedTiles, spawned };
  } finally {
    zoneGrowthLocks.delete(lockKey);
  }
}

// ─── Woodcutter / Plantation Tick ──────────────────────────────────
// Server-authoritative: Bäume ernten, Geld gutschreiben, fehlende Bäume pflanzen.
const WOODCUTTER_LEVEL_CONFIG = {
  1: { maxTrees: 6,  radius: 4, moneyPerHarvest: 150 },
  2: { maxTrees: 9,  radius: 5, moneyPerHarvest: 175 },
  3: { maxTrees: 12, radius: 5, moneyPerHarvest: 200 },
  4: { maxTrees: 16, radius: 6, moneyPerHarvest: 250 },
};
const WOODCUTTER_GROWTH_MS = 6 * 60 * 60 * 1000; // 6h Echtzeit
const TREE_TYPES = ['tree_oak', 'tree_maple', 'tree_birch', 'tree_pine', 'tree_spruce'];

async function runServerWoodcutterTick(municipalityId, roomCode, sharedRows) {
  ensureDbEnabled();
  const { getRoomItemRows, getRoomItemVersion } = require('./rooms.js');
  const { applyMunicipalityTransaction } = require('./bank.js');
  const { logInfo } = require('../infra/logger.js');

  const safeRoomCode = normalizeRoomCode(roomCode);
  const lockKey = `${municipalityId}:${safeRoomCode}`;
  if (woodcutterTickLocks.has(lockKey)) return { changes: [], harvested: 0, planted: 0, earned: 0 };
  woodcutterTickLocks.add(lockKey);

  try {
    const rows = sharedRows || await getRoomItemRows(municipalityId, safeRoomCode);
    if (!rows.length) return { changes: [], harvested: 0, planted: 0, earned: 0 };

    // 1) Finde alle fertig gebauten Holzfäller-Häuser
    const woodcutters = [];
    for (const row of rows) {
      if (row.action_type !== 'place') continue;
      const t = String(row.tool || '').toLowerCase();
      if (t !== 'woodcutter_house') continue;
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent) continue;
      if (meta.abandoned === true) continue;
      const cp = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 100);
      const isConstructed = cp >= 100 || meta.constructed === true;
      if (!isConstructed) continue;
      const level = Math.max(1, Math.min(4, Math.round(Number(meta.level ?? 1))));
      woodcutters.push({ row, meta, level, x: Number(row.x), y: Number(row.y) });
    }

    if (woodcutters.length === 0) return { changes: [], harvested: 0, planted: 0, earned: 0 };

    // 2) Grid mit allen Items aufbauen (für Baum-Suche und freie Plätze)
    const grid = buildRoomGrid(rows);

    const nowMs = Date.now();
    const now = new Date();
    let currentVersion = await getRoomItemVersion(municipalityId, safeRoomCode);
    const changes = [];
    let totalHarvested = 0;
    let totalPlanted = 0;
    let totalEarned = 0;

    for (const wc of woodcutters) {
      const cfg = WOODCUTTER_LEVEL_CONFIG[wc.level] || WOODCUTTER_LEVEL_CONFIG[1];

      // 3) Bäume im Radius zählen
      const treesInRadius = [];
      const emptyInRadius = [];

      for (let dy = -cfg.radius; dy <= cfg.radius; dy++) {
        for (let dx = -cfg.radius; dx <= cfg.radius; dx++) {
          if (dx === 0 && dy === 0) continue;
          const dist = Math.abs(dx) + Math.abs(dy);
          if (dist > cfg.radius) continue;
          const tx = wc.x + dx;
          const ty = wc.y + dy;
          const key = `${tx},${ty}`;
          const cell = grid.get(key);

          if (cell) {
            const cellTool = String(cell.tool || '').toLowerCase();
            if (cellTool === 'tree' || cellTool.startsWith('tree_')) {
              const cellMeta = toJsonValue(cell.metadata) || {};
              const plantedAt = Number(metaValue(cellMeta, 'plantedAt', 'planted_at') ?? 0);
              const isMature = plantedAt > 0 ? (nowMs - plantedAt >= WOODCUTTER_GROWTH_MS) : true;
              treesInRadius.push({ row: cell, x: tx, y: ty, isMature, meta: cellMeta });
            } else if (cellTool === 'grass') {
              // Nur echtes Gras ohne Gebäude/Zone
              const cellMeta = toJsonValue(cell.metadata) || {};
              const bt = metaValue(cellMeta, 'buildingType', 'building_type');
              if (!bt) {
                emptyInRadius.push({ x: tx, y: ty });
              }
            }
          } else {
            // Kein Item an dieser Position = könnte freier Platz sein
            // Aber wir pflanzen nur auf existierenden grass-Tiles
          }
        }
      }

      const matureTrees = treesInRadius.filter(t => t.isMature);

      // 4) Reife Bäume ernten (max 2 pro Tick pro Holzfäller, damit es natürlich wirkt)
      const harvestCount = Math.min(matureTrees.length, 2);
      if (harvestCount > 0) {
        // Zufällige Auswahl
        const toHarvest = matureTrees.sort(() => Math.random() - 0.5).slice(0, harvestCount);
        const earnedThisTick = toHarvest.length * cfg.moneyPerHarvest;

        for (const tree of toHarvest) {
          // Baum wird zu Gras: metadata zurücksetzen
          const nextMeta = { ...tree.meta };
          delete nextMeta.plantedAt;
          delete nextMeta.planted_at;
          delete nextMeta.buildingType;
          delete nextMeta.building_type;
          nextMeta.level = 0;

          currentVersion += 1;
          await dbPool.query(
            `UPDATE game_items
             SET tool = 'grass', metadata = ?, version = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [JSON.stringify(nextMeta), currentVersion, tree.row.id]
          );

          changes.push({
            x: tree.x,
            y: tree.y,
            buildingType: 'grass',
            level: 0,
            harvested: true,
          });
          totalHarvested += 1;
        }

        // Geld gutschreiben
        if (earnedThisTick > 0) {
          await applyMunicipalityTransaction(municipalityId, {
            amount: earnedThisTick,
            type: 'woodcutter_harvest',
            meta: { roomCode: safeRoomCode, woodcutterX: wc.x, woodcutterY: wc.y, trees: toHarvest.length },
            source: 'system',
          });
          totalEarned += earnedThisTick;
        }
      }

      // 5) Fehlende Bäume nachpflanzen (max 2 pro Tick)
      const currentTreeCount = treesInRadius.length - harvestCount;
      const treesToPlant = Math.min(cfg.maxTrees - currentTreeCount, 2, emptyInRadius.length);

      if (treesToPlant > 0) {
        const plantSpots = emptyInRadius.sort(() => Math.random() - 0.5).slice(0, treesToPlant);

        for (const spot of plantSpots) {
          const treeType = TREE_TYPES[Math.floor(Math.random() * TREE_TYPES.length)];
          currentVersion += 1;

          // Prüfen ob an dieser Position schon ein Item existiert
          const existingKey = `${spot.x},${spot.y}`;
          const existing = grid.get(existingKey);

          if (existing && existing.id) {
            // Update bestehendes grass-Item zu Baum
            await dbPool.query(
              `UPDATE game_items
               SET tool = ?, metadata = ?, version = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [treeType, JSON.stringify({ plantedAt: nowMs }), currentVersion, existing.id]
            );
          } else {
            // Neues Item einfügen
            await dbPool.query(
              `INSERT INTO game_items (municipality_id, room_code, action_type, tool, x, y, metadata, version, applied_at, created_at, updated_at)
               VALUES (?, ?, 'place', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              [municipalityId, safeRoomCode, treeType, spot.x, spot.y, JSON.stringify({ plantedAt: nowMs }), currentVersion, now]
            );
          }

          changes.push({
            x: spot.x,
            y: spot.y,
            buildingType: treeType,
            level: 1,
            planted: true,
            plantedAt: nowMs,
          });
          totalPlanted += 1;
        }
      }
    }

    if (totalHarvested > 0 || totalPlanted > 0) {
      logInfo('WOODCUTTER', `Room ${municipalityId}:${safeRoomCode} — ${totalHarvested} geerntet, ${totalPlanted} gepflanzt, +${totalEarned} CHF`);
    }

    return { changes, harvested: totalHarvested, planted: totalPlanted, earned: totalEarned };
  } finally {
    woodcutterTickLocks.delete(lockKey);
  }
}

// ─── Crime / Kriminalitaets-System ──────────────────────────────────
// Gangster/Dealer spawnen bei tiefer Polizei-Coverage.
// Tags: Dealer dealt mit NPCs (kein Diebstahl). Nachts: Einbrueche (1% Schaden).
// Polizei kommt nach Verzoegerung und jagt sie.
const CRIME_CONFIG = {
  maxCriminalsPerRoom: 3,           // Max 3 gleichzeitige Gangster/Dealer
  spawnCooldownTicks: 15,           // 45s Pause zwischen Spawns
  spawnChancePerTick: 0.006,        // 0.6% pro Candidate-Tile pro Tick — langsam
  maxSpawnsPerTick: 1,              // Nur 1 Spawn pro Tick
  policeCoverageThreshold: 25,      // Unter 25% → Crime moeglich
  // Einbruch nur nachts (Server-Uhrzeit 21:00-05:00)
  burglaryNightStartHour: 21,
  burglaryNightEndHour: 5,
  burglaryAmountPerTick: 2,         // Winziger Betrag: 2 CHF pro Einbruch-Tick
  // Polizei-Mechanik
  policeNoticeDelayTicks: 4,        // Polizei bemerkt Gangster erst nach 12s (4 Ticks)
  policeChaseRadius: 20,            // Grosser Radius — Polizei kommt von weit her
  chaseDurationTicks: 6,            // 18s Chase bis gefasst
  catchChanceGangster: 0.65,          // 65% Fangquote fuer Gangster
  catchChanceDealer: 0.50,            // 50% Fangquote fuer Dealer (schlauer)
  catchRewardXp: 10,
  catchRewardMoney: 50,             // Kleine Belohnung
  // Crime-Grid (visuell)
  crimeRadiusTiles: 3,
  crimeValuePerTick: 3,
  maxCrimeValue: 100,
  // Lebensdauer
  despawnAfterTicks: 30,            // 90s max Lebensdauer wenn keine Polizei
  // Warmup: Erste 5 Ticks (15s) nach Room-Start keine Spawns
  warmupTicks: 5,
};

/**
 * Server-autoritativer Crime-Tick.
 * Laeuft alle 3s im Game-Loop.
 *
 * Mechanik:
 * - Gangster/Dealer spawnen langsam auf Tiles mit tiefer Polizei-Coverage
 * - Tags: Dealer dealt mit NPCs (visuell), kein wirtschaftlicher Schaden
 * - Nachts (21-05 Uhr): Einbrueche — kleiner Betrag aus Treasury
 * - Polizei bemerkt Gangster nach Delay, jagt und faengt sie
 * - Max 3 pro Room, Cooldown zwischen Spawns
 *
 * @param {number} municipalityId
 * @param {string} roomCode
 * @param {Array} sharedRows - Vorgeladene game_items
 * @param {object} context - { serviceCoverageGrids, landValueGrid, stats }
 * @returns {{ criminals: Array, crimeEvents: Array, stolenTotal: number, crimeGrid, gridSize, homeless }}
 */
async function runServerCrimeTick(municipalityId, roomCode, sharedRows, context) {
  const { logInfo } = require('../infra/logger.js');
  const { applyMunicipalityTransaction } = require('./bank.js');

  const safeRoomCode = normalizeRoomCode(roomCode);
  const lockKey = `${municipalityId}:${safeRoomCode}`;
  if (crimeTickLocks.has(lockKey)) return { criminals: [], crimeEvents: [], stolenTotal: 0 };
  crimeTickLocks.add(lockKey);

  try {
    const rows = sharedRows || [];
    if (!rows.length) return { criminals: [], crimeEvents: [], stolenTotal: 0 };

    // Room-State initialisieren
    if (!crimeRoomState.has(lockKey)) {
      crimeRoomState.set(lockKey, {
        criminals: new Map(),
        nextId: 1,
        tickCount: 0,
        lastSpawnTick: -CRIME_CONFIG.spawnCooldownTicks, // Sofort spawnen erlaubt
      });
    }
    const roomState = crimeRoomState.get(lockKey);
    const { criminals } = roomState;
    roomState.tickCount += 1;

    // Service-Coverage-Grids aus dem Context
    const policeCoverageGrid = context?.serviceCoverageGrids?.police || null;
    const gridSize = policeCoverageGrid ? policeCoverageGrid.length : 0;

    // Homeless aus Stats (Housing-Mangel)
    const homeless = Math.max(0, Number(context?.stats?.homeless ?? 0));

    // Nacht-Check fuer Einbrueche (Server-Uhrzeit)
    const currentHour = new Date().getHours();
    const isNight = currentHour >= CRIME_CONFIG.burglaryNightStartHour ||
                    currentHour < CRIME_CONFIG.burglaryNightEndHour;

    // 1) Grid mit allen Items aufbauen
    const grid = buildRoomGrid(rows);

    // 2) Finde Polizei-Stationen (bevor Spawns — werden fuer Chase + Spawn-Check gebraucht)
    const policeStations = [];
    for (const row of rows) {
      if (row.action_type !== 'place') continue;
      const t = String(row.tool || '').toLowerCase();
      if (t !== 'police_station') continue;
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent) continue;
      if (meta.abandoned === true) continue;
      const cp = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 100);
      const isConstructed = cp >= 100 || meta.constructed === true;
      if (!isConstructed) continue;
      policeStations.push({
        x: Number(row.x),
        y: Number(row.y),
        level: Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1)))),
      });
    }

    // 3) Spawn-Candidates finden (Tiles mit tiefer Polizei-Coverage + Gebaeude)
    // Police-Budget-Funding beeinflusst max. Kriminelle und Spawn-Chance
    const policeFunding = Number(
      context?.stats?.game_map_data?.budget?.police?.funding ??
      context?.stats?.budget?.police?.funding ?? 100
    );
    // 0% Funding → bis zu 6 Kriminelle, volle Spawn-Chance × 2.5; 100% → normal (3, ×1)
    const fundingFactor = Math.max(0, (100 - policeFunding) / 100); // 0 bei 100%, 1 bei 0%
    // Arbeitslosigkeit + Unzufriedenheit erhoehen Kriminalitaet
    // Arbeitslosigkeit > 10%: +0.5 max Kriminelle pro 10% Extra-AL (max +3)
    // Zufriedenheit < 40: +Spawn-Chance (max ×1.5 zusaetzlich)
    const unemploymentRate = Math.max(0, Number(context?.stats?.unemployment_rate ?? 0));
    const happiness = Math.max(0, Math.min(100, Number(context?.stats?.happiness ?? 100)));
    const unemploymentCrimeFactor = Math.min(3, Math.max(0, (unemploymentRate - 10) / 10) * 0.5);
    const unhappinessCrimeFactor = happiness < 40 ? (40 - happiness) / 40 * 1.5 : 0;

    // Party-Effekt: Ab 18 Uhr erhöht jede aktive Party Kriminalität in der Nähe
    // +2 max Kriminelle pro Party, doppelte Spawn-Chance
    const isEvening = currentHour >= 18;
    const eveningParties = isEvening
      ? (context?.activeParties || []).filter(p => p.status !== 'shutdown' && p.status !== 'ended')
      : [];
    const partyMaxBoost   = eveningParties.length * 2;   // +2 max Kriminelle pro aktiver Party
    const partySpawnBoost = eveningParties.length * 1.0; // ×2 Spawn-Chance bei 1 Party (×3 bei 2 etc.)

    const dynamicMaxCriminals = Math.round(CRIME_CONFIG.maxCriminalsPerRoom + fundingFactor * 3 + unemploymentCrimeFactor + partyMaxBoost); // 3-9 + Party
    const dynamicSpawnChance = CRIME_CONFIG.spawnChancePerTick * (1 + fundingFactor * 1.5 + unhappinessCrimeFactor + partySpawnBoost); // ×1 bis ×4 + Party
    const crimeEvents = [];
    const canSpawn = criminals.size < dynamicMaxCriminals
      && (roomState.tickCount - roomState.lastSpawnTick) >= CRIME_CONFIG.spawnCooldownTicks
      && roomState.tickCount >= CRIME_CONFIG.warmupTicks;

    if (canSpawn && policeCoverageGrid && gridSize > 0) {
      const spawnCandidates = [];
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          const coverage = policeCoverageGrid[y]?.[x] ?? 100;
          if (coverage >= CRIME_CONFIG.policeCoverageThreshold) continue;

          const key = `${x},${y}`;
          const cell = grid.get(key);
          if (!cell) continue;
          const cellTool = String(cell.tool || '').toLowerCase();
          // Nur echte Gebaeude-Tiles
          if (!cellTool || cellTool === 'grass' || cellTool === 'water' || cellTool === 'road' ||
              cellTool === 'rail' || cellTool === 'bridge' || cellTool === 'empty' ||
              cellTool.startsWith('tree') || cellTool.startsWith('bush_') ||
              cellTool.startsWith('flower_') || cellTool.startsWith('topiary_') ||
              cellTool.startsWith('zone_') || cellTool.startsWith('terrain_') ||
              cellTool.startsWith('paint_')) continue;

          // Nicht auf Tile wo schon ein Gangster ist
          let occupied = false;
          for (const c of criminals.values()) {
            if (c.x === x && c.y === y) { occupied = true; break; }
          }
          if (occupied) continue;

          const meta = toJsonValue(cell.metadata) || {};
          const isAbandoned = meta.abandoned === true;
          const isOnFire = meta.onFire === true;
          let spawnWeight = isAbandoned ? 3 : (isOnFire ? 2 : 1);
          // Party-Nähe (Radius 6 Tiles): 3× höheres Gewicht → Diebstähle konzentrieren sich ums Haus
          const PARTY_CRIME_RADIUS = 6;
          for (const party of eveningParties) {
            if (Math.abs(x - party.tileX) <= PARTY_CRIME_RADIUS &&
                Math.abs(y - party.tileY) <= PARTY_CRIME_RADIUS) {
              spawnWeight *= 3;
              break;
            }
          }
          const coverageFactor = Math.max(0.2, 1 - coverage / CRIME_CONFIG.policeCoverageThreshold);
          spawnCandidates.push({ x, y, spawnWeight, coverageFactor, isAbandoned });
        }
      }

      if (spawnCandidates.length > 0) {
        // Beste Candidates zuerst
        spawnCandidates.sort((a, b) => b.spawnWeight * b.coverageFactor - a.spawnWeight * a.coverageFactor);
        let spawned = 0;
        for (const cand of spawnCandidates) {
          if (spawned >= CRIME_CONFIG.maxSpawnsPerTick) break;
          if (criminals.size >= dynamicMaxCriminals) break;

          const chance = dynamicSpawnChance * cand.spawnWeight * cand.coverageFactor;
          if (Math.random() >= chance) continue;

          const criminalId = roomState.nextId++;
          // Dealer wenn Obdachlose existieren (40% Chance), sonst normaler Gangster
          const isDealer = homeless > 0 && Math.random() < 0.4;
          const criminal = {
            id: criminalId,
            x: cand.x,
            y: cand.y,
            state: isDealer ? 'dealing' : 'loitering',
            ticksAlive: 0,
            ticksChased: 0,
            beingChased: false,
            chasingPoliceStation: null,
            stolenTotal: 0,
            isDealer,
          };
          criminals.set(criminalId, criminal);
          roomState.lastSpawnTick = roomState.tickCount;
          spawned++;
          crimeEvents.push({ type: 'spawn', id: criminalId, x: cand.x, y: cand.y, isDealer });
        }
      }
    }

    // 4) Bestehende Gangster updaten
    let stolenTotal = 0;
    const toRemove = [];

    for (const [id, criminal] of criminals.entries()) {
      criminal.ticksAlive += 1;

      // 4a) Timeout-Despawn
      if (criminal.ticksAlive >= CRIME_CONFIG.despawnAfterTicks) {
        toRemove.push(id);
        crimeEvents.push({ type: 'despawn', id, x: criminal.x, y: criminal.y, reason: 'timeout' });
        continue;
      }

      // 4b) Einbruch NUR nachts — winziger Treasury-Schaden
      if (isNight && !criminal.beingChased) {
        const burglaryAmount = CRIME_CONFIG.burglaryAmountPerTick;
        criminal.stolenTotal += burglaryAmount;
        stolenTotal += burglaryAmount;
        if (criminal.state !== 'fleeing') {
          criminal.state = 'burglary';
        }
      } else if (!criminal.beingChased && criminal.state === 'burglary') {
        // Tag geworden → zurueck zu dealing/loitering
        criminal.state = criminal.isDealer ? 'dealing' : 'loitering';
      }

      // 4c) Polizei bemerkt Gangster nach Delay (Level-skaliert)
      // Finde naechste Station und nutze deren Level fuer NoticeDelay + ChaseRadius
      if (!criminal.beingChased) {
        let nearestStation = null;
        let nearestDist = Infinity;
        for (const station of policeStations) {
          // Chase-Radius steigt mit Level: L1=20, L5=36
          const stationChaseRadius = SERVICE_LEVEL_CONFIG.policeChaseRadiusBase + (station.level - 1) * SERVICE_LEVEL_CONFIG.policeChaseRadiusPerLevel;
          const dist = Math.abs(station.x - criminal.x) + Math.abs(station.y - criminal.y);
          if (dist <= stationChaseRadius && dist < nearestDist) {
            nearestDist = dist;
            nearestStation = station;
          }
        }
        // Notice-Delay sinkt mit Level: L1=4 Ticks(12s), L3=3(9s), L5=2(6s)
        const stationLevel = nearestStation ? nearestStation.level : 1;
        const noticeDelay = Math.max(
          SERVICE_LEVEL_CONFIG.policeNoticeDelayMin,
          Math.round(SERVICE_LEVEL_CONFIG.policeNoticeDelayBase - (stationLevel - 1) * SERVICE_LEVEL_CONFIG.policeNoticeDelayReduction)
        );
        if (nearestStation && criminal.ticksAlive >= noticeDelay) {
          criminal.beingChased = true;
          criminal.chasingPoliceStation = nearestStation;
          criminal.state = 'fleeing';
          crimeEvents.push({
            type: 'chase_start', id,
            x: criminal.x, y: criminal.y,
            policeX: nearestStation.x, policeY: nearestStation.y,
          });
          logInfo('CRIME', `Polizei L${stationLevel} jagt ${criminal.isDealer ? 'Dealer' : 'Gangster'} #${id} von Station (${nearestStation.x},${nearestStation.y})`);
        }
      }

      // 4d) Chase-Countdown → Gefasst oder Entkommen (Fangquote level-skaliert)
      if (criminal.beingChased) {
        criminal.ticksChased += 1;
        if (criminal.ticksChased >= CRIME_CONFIG.chaseDurationTicks) {
          const chasingLevel = criminal.chasingPoliceStation?.level || 1;
          const baseCatch = criminal.isDealer
            ? CRIME_CONFIG.catchChanceDealer
            : CRIME_CONFIG.catchChanceGangster;
          // +6%/Level → L1=65%/50%, L5=89%/74%
          const catchChance = Math.min(
            SERVICE_LEVEL_CONFIG.policeCatchMax,
            baseCatch + (chasingLevel - 1) * SERVICE_LEVEL_CONFIG.policeCatchBonusPerLevel
          );
          toRemove.push(id);
          if (Math.random() < catchChance) {
            crimeEvents.push({ type: 'caught', id, x: criminal.x, y: criminal.y, stolenTotal: criminal.stolenTotal });
          } else {
            crimeEvents.push({ type: 'escaped', id, x: criminal.x, y: criminal.y });
          }
        }
      }

      // 4e) Gangster bewegt sich langsam (alle 4 Ticks = 12s)
      if (!criminal.beingChased && criminal.ticksAlive % 4 === 0) {
        const dx = Math.floor(Math.random() * 3) - 1;
        const dy = Math.floor(Math.random() * 3) - 1;
        criminal.x = Math.max(0, Math.min(gridSize - 1, criminal.x + dx));
        criminal.y = Math.max(0, Math.min(gridSize - 1, criminal.y + dy));
      }
    }

    // 5) Gefasste/despawnte entfernen + Belohnungen
    for (const id of toRemove) {
      const criminal = criminals.get(id);
      if (criminal && crimeEvents.find(e => e.type === 'caught' && e.id === id)) {
        await applyMunicipalityTransaction(municipalityId, {
          amount: CRIME_CONFIG.catchRewardMoney,
          type: 'crime_catch_reward',
          meta: { roomCode: safeRoomCode, criminalId: id },
          source: 'system',
        }).catch(() => {});
      }
      criminals.delete(id);
    }

    // 6) Nacht-Einbruch: Treasury-Schaden (nur wenn was gestohlen wurde)
    if (stolenTotal > 0) {
      await applyMunicipalityTransaction(municipalityId, {
        amount: -stolenTotal,
        type: 'crime_burglary',
        meta: { roomCode: safeRoomCode, criminals: criminals.size, stolen: stolenTotal, night: isNight },
        source: 'system',
      }).catch(() => {});
    }

    // 7) Crime-Grid berechnen (fuer Client-Overlay)
    let crimeGrid = null;
    if (gridSize > 0 && criminals.size > 0) {
      crimeGrid = Array.from({ length: gridSize }, () => Array(gridSize).fill(0));
      for (const criminal of criminals.values()) {
        const radius = CRIME_CONFIG.crimeRadiusTiles;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const tx = criminal.x + dx;
            const ty = criminal.y + dy;
            if (tx < 0 || tx >= gridSize || ty < 0 || ty >= gridSize) continue;
            const dist = Math.abs(dx) + Math.abs(dy);
            if (dist > radius) continue;
            const falloff = 1 - dist / (radius + 1);
            const val = Math.round(CRIME_CONFIG.crimeValuePerTick * falloff * (criminal.isDealer ? 1.5 : 1));
            crimeGrid[ty][tx] = Math.min(CRIME_CONFIG.maxCrimeValue, crimeGrid[ty][tx] + val);
          }
        }
      }
    }

    // 8) Serialisierte Criminal-Liste fuer Client
    const criminalsList = [];
    for (const criminal of criminals.values()) {
      criminalsList.push({
        id: criminal.id,
        x: criminal.x,
        y: criminal.y,
        state: criminal.state,        // 'loitering' | 'dealing' | 'burglary' | 'fleeing'
        isDealer: criminal.isDealer,
        beingChased: criminal.beingChased,
        policeX: criminal.chasingPoliceStation?.x ?? null,
        policeY: criminal.chasingPoliceStation?.y ?? null,
        ticksAlive: criminal.ticksAlive,
      });
    }


    return { criminals: criminalsList, crimeEvents, stolenTotal, crimeGrid, gridSize, homeless, isNight };
  } finally {
    crimeTickLocks.delete(lockKey);
  }
}

/**
 * Raeume Crime-State fuer einen Room auf (z.B. wenn Room entladen wird)
 */
function clearCrimeState(municipalityId, roomCode) {
  const lockKey = `${municipalityId}:${normalizeRoomCode(roomCode)}`;
  crimeRoomState.delete(lockKey);
}

async function runServerDisasterTick(municipalityId, roomCode, sharedRows) {
  ensureDbEnabled();
  const { loadRoomStats, getRoomItemRows, getRoomItemVersion } = require('./rooms.js');
  const { getMunicipalityById } = require('./municipality.js');
  const { refreshGameDataMapFromItems } = require('./map.js');

  const lockKey = `${municipalityId}:${normalizeRoomCode(roomCode)}`;
  if (disasterTickLocks.has(lockKey)) return { updated: 0, deleted: 0, changes: [] };
  disasterTickLocks.add(lockKey);

  try {
    const nowMs = Date.now();
    const stats = await loadRoomStats(municipalityId, roomCode);
    if (!isDisasterEnabledInStats(stats)) {
      return { updated: 0, deleted: 0, changes: [] };
    }

    const rows = sharedRows || await getRoomItemRows(municipalityId, roomCode);
    if (!rows.length) return { updated: 0, deleted: 0, changes: [] };

    const furniHealMutations = [];
    for (const row of rows) {
      if (row.action_type !== 'place') continue;
      const t = String(row.tool || '').trim().toLowerCase();
      if (!(t === 'furni' || t.startsWith('furni_'))) continue;
      const meta = toJsonValue(row.metadata) || {};
      if (meta.onFire) {
        furniHealMutations.push({ type: 'update', row, meta: { ...meta, onFire: false, fireProgress: 0 } });
      }
    }
    const placeRows = rows.filter((row) => row.action_type === 'place' && canBurnTool(row.tool));
    if (!placeRows.length && !furniHealMutations.length) return { updated: 0, deleted: 0, changes: [] };

    const allPlaceRows = rows.filter((row) => row.action_type === 'place');
    const activeFireStations = [];
    for (const row of allPlaceRows) {
      if (!isFireStationTool(row.tool)) continue;
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent) continue;
      if (meta.abandoned === true) continue;
      if (meta.onFire === true) continue;
      const constructionProgress = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 100);
      const isConstructed = constructionProgress >= 100 || meta.constructed === true;
      if (!isConstructed) continue;
      activeFireStations.push({
        x: Number(row.x),
        y: Number(row.y),
        level: Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1)))),
      });
    }

    const mapData = stats && typeof stats.game_map_data === 'object' ? stats.game_map_data : null;
    const budgetData = mapData && typeof mapData.budget === 'object' ? mapData.budget : null;
    const fireBudgetNode = budgetData && typeof budgetData.fire === 'object' ? budgetData.fire : null;
    const fireFunding = Math.max(0, Math.min(200, Number(fireBudgetNode?.funding ?? 100)));
    const fireFundingFactor = Math.max(0.35, fireFunding / 100);

    const byPos = new Map();
    for (const row of placeRows) {
      byPos.set(`${Number(row.x)},${Number(row.y)}`, row);
    }

    const currentlyBurning = new Set();
    for (const row of placeRows) {
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent) continue;
      if (Boolean(meta.onFire)) {
        currentlyBurning.add(`${Number(row.x)},${Number(row.y)}`);
      }
    }

    const mutations = [...furniHealMutations];
    const hasBurningNeighbor = (x, y) => {
      const offsets = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
      for (const [dx, dy] of offsets) {
        if (currentlyBurning.has(`${x + dx},${y + dy}`)) return true;
      }
      return false;
    };
    const getFireResponseAt = (x, y) => {
      let stationsInRange = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      let bestLevel = 1;
      for (const station of activeFireStations) {
        const distance = Math.abs(Number(station.x) - x) + Math.abs(Number(station.y) - y);
        if (distance > FIRE_RESPONSE_RANGE_TILES) continue;
        stationsInRange += 1;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          bestLevel = station.level;
        }
      }
      if (stationsInRange <= 0) {
        return {
          stationsInRange: 0,
          nearestDistance: Number.POSITIVE_INFINITY,
          distanceFactor: 0,
          stationStrength: 0,
          hasCoverage: false,
        };
      }
      const distanceFactor = Math.max(0.05, 1 - nearestDistance / (FIRE_RESPONSE_RANGE_TILES + 1));
      const stationStrength = Math.min(2.5, (0.8 + stationsInRange * 0.35) * (1 + (bestLevel - 1) * 0.12));
      return {
        stationsInRange,
        nearestDistance,
        distanceFactor,
        stationStrength,
        hasCoverage: true,
      };
    };

    for (const row of placeRows) {
      const x = Number(row.x);
      const y = Number(row.y);
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent) continue;
      const response = getFireResponseAt(x, y);

      const onFire = Boolean(meta.onFire);
      const fireProgress = Math.max(0, Math.min(100, Math.round(Number(meta.fireProgress || 0))));

      if (onFire) {
        const extinguishChance = response.hasCoverage
          ? Math.min(0.9, 0.12 + 0.3 * response.distanceFactor * response.stationStrength * fireFundingFactor)
          : 0;
        if (response.hasCoverage && Math.random() < extinguishChance) {
          mutations.push({ type: 'update', row, meta: { ...meta, onFire: false, fireProgress: 0 } });
          continue;
        }
        const suppressionFactor = response.hasCoverage
          ? Math.max(0.2, 1 - response.distanceFactor * response.stationStrength * fireFundingFactor * 0.55)
          : 1;
        const progressStep = Math.max(1, Math.round(2 * suppressionFactor));
        const nextProgress = Math.min(100, fireProgress + progressStep);
        if (nextProgress >= 100) {
          mutations.push({ type: 'update', row, meta: { ...meta, onFire: false, fireProgress: 0, abandoned: true } });
        } else {
          mutations.push({ type: 'update', row, meta: { ...meta, onFire: true, fireProgress: nextProgress } });
        }
        continue;
      }

      const startedAtMsFire = row.applied_at ? new Date(row.applied_at).getTime() : Number(row.client_timestamp || 0);
      const fireAgeHours =
        Number.isFinite(startedAtMsFire) && startedAtMsFire > 0 ? Math.max(0, (nowMs - startedAtMsFire) / (1000 * 60 * 60)) : 0;
      if (fireAgeHours < 24) continue;

      const baseIgnitionChance = hasBurningNeighbor(x, y) ? 0.012 : 0.0004;
      const preventionFactor = response.hasCoverage
        ? Math.max(0.08, 1 - response.distanceFactor * response.stationStrength * fireFundingFactor * 0.5)
        : 1;
      const ignitionChance = baseIgnitionChance * preventionFactor;
      if (Math.random() < ignitionChance) {
        mutations.push({ type: 'update', row, meta: { ...meta, onFire: true, fireProgress: 0 } });
      }
    }

    if (!mutations.length) return { updated: 0, deleted: 0, changes: [] };

    let currentVersion = await getRoomItemVersion(municipalityId, roomCode);
    const now = new Date();
    const timestamp = Date.now();
    let updated = 0;
    let deleted = 0;
    const changes = [];

    for (const mutation of mutations) {
      if (mutation.type === 'delete') {
        const [result] = await dbPool.query(`DELETE FROM game_items WHERE id = ?`, [mutation.row.id]);
        if ((result?.affectedRows || 0) > 0) {
          deleted += 1;
          changes.push({ x: Number(mutation.row.x), y: Number(mutation.row.y), removed: true });
        }
        continue;
      }

      const prevMeta = toJsonValue(mutation.row.metadata) || {};
      const nextMeta = mutation.meta || {};
      if (jsonEquals(prevMeta, nextMeta)) continue;

      currentVersion += 1;
      await dbPool.query(
        `UPDATE game_items
         SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(nextMeta), currentVersion, timestamp, now, mutation.row.id]
      );
      updated += 1;
      const change = {
        x: Number(mutation.row.x),
        y: Number(mutation.row.y),
        on_fire: Boolean(nextMeta.onFire),
        fire_progress: Math.max(0, Math.min(100, Math.round(Number(nextMeta.fireProgress || 0)))),
      };
      if (nextMeta.abandoned === true) {
        change.abandoned = true;
      }
      changes.push(change);
    }

    if (updated > 0 || deleted > 0) {
      const municipality = await getMunicipalityById(municipalityId);
      if (municipality) {
        await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-disaster-v1');
      }
      const mName = municipality?.name || `Gemeinde #${municipalityId}`;
      const fireCount = changes.filter((c) => c.on_fire === true).length;
      if (fireCount > 0) {
        pushDiscordEvent('fire', { municipalityName: mName, roomCode, affectedCount: fireCount, message: `${fireCount} Gebäude brennen in ${mName}!` });
      }
      if (deleted > 0) {
        pushDiscordEvent('disaster', { municipalityName: mName, roomCode, destroyedCount: deleted, message: `${deleted} Gebäude zerstört in ${mName}!` });
      }
    }

    return { updated, deleted, changes };
  } finally {
    disasterTickLocks.delete(lockKey);
  }
}

function parseManualDisasterIntensity(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(5, Math.round(n)));
}

async function triggerManualDisaster(municipalityId, roomCode, disasterType, rawIntensity = 1, targetTile = null) {
  ensureDbEnabled();
  const { getRoomItemRows, getRoomItemVersion } = require('./rooms.js');
  const { getMunicipalityById } = require('./municipality.js');

  const type = String(disasterType || '').trim().toLowerCase();
  if (!DEBUG_DISASTER_TYPES.has(type)) {
    return { updated: 0, deleted: 0, changes: [], error: 'Unknown disaster type' };
  }
  const intensity = parseManualDisasterIntensity(rawIntensity);
  const rows = await getRoomItemRows(municipalityId, roomCode);
  const placeRows = rows.filter((row) => row.action_type === 'place');
  if (!placeRows.length) {
    return { updated: 0, deleted: 0, changes: [] };
  }

  const burnableRows = placeRows.filter((row) => {
    if (!canBurnTool(row.tool)) return false;
    const meta = toJsonValue(row.metadata) || {};
    if (meta.mapPersistent) return false;
    return true;
  });

  const burningRows = burnableRows.filter((row) => {
    const meta = toJsonValue(row.metadata) || {};
    return Boolean(meta.onFire);
  });

  const destructionCandidates = placeRows.filter((row) => {
    const tool = String(row.tool || '').trim().toLowerCase();
    if (!tool) return false;
    if (tool === 'grass' || tool === 'water' || tool === 'empty') return false;
    if (tool === 'furni' || tool.startsWith('furni_')) return false;
    const meta = toJsonValue(row.metadata) || {};
    if (meta.mapPersistent) return false;
    return true;
  });

  const placeByPos = new Map();
  for (const row of placeRows) {
    placeByPos.set(`${Number(row.x)},${Number(row.y)}`, row);
  }

  const getDistance = (ax, ay, bx, by) => Math.hypot(Number(ax) - Number(bx), Number(ay) - Number(by));
  const isDestructibleTool = (tool) => {
    const t = String(tool || '').trim().toLowerCase();
    if (!t) return false;
    if (t === 'grass' || t === 'water' || t === 'road' || t === 'rail' || t === 'bridge' || t === 'empty') return false;
    if (t.startsWith('tree_') || t.startsWith('bush_') || t.startsWith('flower_') || t.startsWith('topiary_')) return false;
    if (t === 'furni' || t.startsWith('furni_')) return false;
    return true;
  };

  const updatesById = new Map();
  const deletesById = new Map();
  const meteorRestoreById = new Map();
  const upsertUpdate = (row, nextMeta) => {
    if (!row || !row.id) return;
    if (deletesById.has(row.id)) return;
    updatesById.set(row.id, { row, meta: nextMeta });
  };
  const upsertDelete = (row) => {
    if (!row || !row.id) return;
    updatesById.delete(row.id);
    deletesById.set(row.id, { row });
  };
  let disasterMeta = {};

  if (type === 'fire_single') {
    const target = pickRandomRows(burnableRows, 1)[0] || null;
    if (target) {
      const prevMeta = toJsonValue(target.metadata) || {};
      const nextMeta = { ...prevMeta, onFire: true, fireProgress: 0 };
      upsertUpdate(target, nextMeta);
    }
  } else if (type === 'fire_cluster') {
    const center = pickRandomRows(burnableRows, 1)[0] || null;
    if (center) {
      const cx = Number(center.x);
      const cy = Number(center.y);
      const radius = intensity >= 4 ? 3 : 2;
      const cluster = burnableRows.filter((row) => {
        const d = Math.abs(Number(row.x) - cx) + Math.abs(Number(row.y) - cy);
        return d <= radius;
      });
      const pickCount = Math.max(3, Math.min(cluster.length, 4 + intensity * 3));
      for (const row of pickRandomRows(cluster, pickCount)) {
        const prevMeta = toJsonValue(row.metadata) || {};
        const nextMeta = {
          ...prevMeta,
          onFire: true,
          fireProgress: Math.max(0, Math.min(100, Math.round(Number(prevMeta.fireProgress || 0)))),
        };
        upsertUpdate(row, nextMeta);
      }
    }
  } else if (type === 'fire_storm') {
    const pickCount = Math.max(5, Math.min(burnableRows.length, 6 + intensity * 5));
    for (const row of pickRandomRows(burnableRows, pickCount)) {
      const prevMeta = toJsonValue(row.metadata) || {};
      const nextMeta = {
        ...prevMeta,
        onFire: true,
        fireProgress: Math.max(0, Math.min(100, Math.round(Number(prevMeta.fireProgress || 0)))),
      };
      upsertUpdate(row, nextMeta);
    }
  } else if (type === 'earthquake') {
    const pickCount = Math.max(1, Math.min(destructionCandidates.length, 1 + intensity * 2));
    for (const row of pickRandomRows(destructionCandidates, pickCount)) {
      upsertDelete(row);
    }
  } else if (type === 'meteor') {
    const impactCandidates = placeRows.filter((row) => {
      const tool = String(row.tool || '').trim().toLowerCase();
      if (tool === 'water') return false;
      return true;
    });
    const desiredX = Number(targetTile?.x);
    const desiredY = Number(targetTile?.y);
    const impactTile =
      Number.isFinite(desiredX) && Number.isFinite(desiredY)
        ? placeByPos.get(`${Math.round(desiredX)},${Math.round(desiredY)}`) || null
        : pickRandomRows(impactCandidates, 1)[0] || null;
    if (impactTile) {
      const impactX = Number(impactTile.x);
      const impactY = Number(impactTile.y);
      const radius = Math.max(2, Math.min(6, 2 + Math.floor(intensity / 2) + 1));
      const impactRows = [];
      for (let y = impactY - radius; y <= impactY + radius; y += 1) {
        for (let x = impactX - radius; x <= impactX + radius; x += 1) {
          const distance = getDistance(x, y, impactX, impactY);
          if (distance > radius + 0.15) continue;
          const row = placeByPos.get(`${x},${y}`);
          if (!row) continue;
          impactRows.push({ row, distance });
        }
      }
      for (const entry of impactRows) {
        const row = entry.row;
        const distance = entry.distance;
        const normalized = Math.max(0, 1 - distance / Math.max(1, radius));
        const prevMeta = toJsonValue(row.metadata) || {};
        const isMapPersistent = Boolean(prevMeta.mapPersistent);
        const prevElevation = Math.max(0, Math.round(Number(metaValue(prevMeta, 'elevation') || 0)));
        const depression = Math.max(1, Math.round(4 * normalized));
        const nextElevation = Math.max(0, prevElevation - depression);
        const nextMeta = { ...prevMeta, elevation: nextElevation, meteorDamagedAt: Date.now() };
        if (nextElevation !== prevElevation) {
          meteorRestoreById.set(Number(row.id), { id: Number(row.id), x: Number(row.x), y: Number(row.y), restore_elevation: prevElevation });
        }
        const tool = String(row.tool || '').trim().toLowerCase();
        const destroyChance = Math.max(0, Math.min(0.92, (0.18 + intensity * 0.08) * normalized));
        if (!isMapPersistent && isDestructibleTool(tool) && Math.random() < destroyChance) {
          upsertDelete(row);
          continue;
        }
        if (!isMapPersistent && canBurnTool(tool) && normalized >= 0.35) {
          nextMeta.onFire = true;
          nextMeta.fireProgress = Math.max(0, Math.min(100, Math.round(Number(prevMeta.fireProgress || 0) + (8 + intensity * 3) * normalized)));
        }
        upsertUpdate(row, nextMeta);
      }
      disasterMeta = { impact_x: impactX, impact_y: impactY, impact_radius: radius };
    }
  } else if (type === 'extinguish_all') {
    for (const row of burningRows) {
      const prevMeta = toJsonValue(row.metadata) || {};
      const nextMeta = { ...prevMeta, onFire: false, fireProgress: 0 };
      upsertUpdate(row, nextMeta);
    }
  }

  if (updatesById.size === 0 && deletesById.size === 0) {
    return { updated: 0, deleted: 0, changes: [] };
  }

  let currentVersion = await getRoomItemVersion(municipalityId, roomCode);
  const now = new Date();
  const timestamp = Date.now();
  let updated = 0;
  let deleted = 0;
  const changes = [];

  for (const mutation of deletesById.values()) {
    const [result] = await dbPool.query(`DELETE FROM game_items WHERE id = ?`, [mutation.row.id]);
    if ((result?.affectedRows || 0) > 0) {
      deleted += 1;
      changes.push({ x: Number(mutation.row.x), y: Number(mutation.row.y), removed: true, elevation: 0 });
    }
  }

  for (const mutation of updatesById.values()) {
    const prevMeta = toJsonValue(mutation.row.metadata) || {};
    const nextMeta = mutation.meta || {};
    if (jsonEquals(prevMeta, nextMeta)) continue;
    currentVersion += 1;
    await dbPool.query(
      `UPDATE game_items
       SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [JSON.stringify(nextMeta), currentVersion, timestamp, now, mutation.row.id]
    );
    updated += 1;
    changes.push({
      x: Number(mutation.row.x),
      y: Number(mutation.row.y),
      on_fire: Boolean(nextMeta.onFire),
      fire_progress: Math.max(0, Math.min(100, Math.round(Number(nextMeta.fireProgress || 0)))),
      elevation: Math.max(0, Math.round(Number(metaValue(nextMeta, 'elevation') || 0))),
    });
  }

  if (updated > 0 || deleted > 0) {
    const municipality = await getMunicipalityById(municipalityId);
    if (municipality) {
      const { refreshGameDataMapFromItems } = require('./map.js');
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-disaster-debug');
    }
  }

  return {
    updated,
    deleted,
    changes,
    disasterType: type,
    intensity,
    meteor_restore_entries: Array.from(meteorRestoreById.values()),
    ...disasterMeta,
  };
}

module.exports = {
  canBurnTool,
  isFireStationTool,
  isDisasterEnabledInStats,
  getZoneBuildingPool,
  getZoneStarterBuilding,
  pickRandomZoneBuildingType,
  deterministicUpgradeUnit,
  getUpgradeHourRangeForLevel,
  getSlowUpgradeHourRangeForLevel,
  getServerTargetLevelByElapsedHours,
  getServerTargetLevel,
  canUpgradeTool,
  getEconomicZoneFromRow,
  getUpgradeToolFromRow,
  getTargetBuildingTypeForLevel,
  getServerBuildingSize,
  buildRoomGrid,
  isServerMergeableTile,
  findServerConsolidationFootprint,
  runServerBuildingUpgradeTick,
  runServerZoneGrowthTick,
  runServerWoodcutterTick,
  runServerCrimeTick,
  clearCrimeState,
  runServerDisasterTick,
  triggerManualDisaster,
};
