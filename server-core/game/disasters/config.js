'use strict';

// Gemeinsame Konstanten und Helper-Funktionen für alle disasters-Sub-Module.

const crypto = require('crypto');
const { SERVICE_UPGRADE_TOOLS, SERVICE_LEVEL_CONFIG } = require('../../config/constants.js');
const { toJsonValue, toFiniteNumber, metaValue, normalizeRoomCode } = require('../../shared/helpers.js');

// ── Feuer / Disaster ─────────────────────────────────────────────
const DISASTER_NON_BURNABLE_TOOLS = new Set([
  'grass', 'water', 'road', 'rail', 'bridge', 'tree', 'furni',
]);
const FIRE_RESPONSE_RANGE_TILES = 18;

const DEBUG_DISASTER_TYPES = new Set([
  'fire_single', 'fire_cluster', 'fire_storm', 'earthquake', 'meteor', 'extinguish_all',
]);

// ── Upgrades ─────────────────────────────────────────────────────
const NON_UPGRADABLE_TOOLS = new Set([
  'grass', 'water', 'road', 'rail', 'bridge', 'tree', 'empty',
  'zone_residential', 'zone_commercial', 'zone_industrial',
  'zone_dezone', 'zone_water', 'zone_land',
  'terrain_raise', 'terrain_lower', 'terrain_lower2', 'terrain_hill',
  'terrain_mountain', 'terrain_flatten',
  'paint_green', 'paint_sand', 'paint_dirt', 'paint_snow', 'paint_dark_grass', 'paint_rock', 'paint_reset',
  'bank_house', 'mansion',
]);

// ── Zonen ────────────────────────────────────────────────────────
const ZONE_SPAWN_BUILDINGS = Object.freeze({
  residential: Object.freeze(['house_small', 'house_medium']),
  commercial:  Object.freeze(['shop_small', 'shop_medium']),
  industrial:  Object.freeze(['factory_small']),
});

const ZONE_EVOLUTION_CHAIN = Object.freeze({
  residential: Object.freeze(['house_small', 'house_medium', 'mansion', 'apartment_low', 'apartment_high']),
  commercial:  Object.freeze(['shop_small', 'shop_medium', 'office_low', 'office_high', 'mall']),
  industrial:  Object.freeze(['factory_small', 'factory_medium', 'warehouse', 'factory_large', 'factory_large']),
});

const SERVER_BUILDING_SIZES = Object.freeze({
  mansion:       { width: 2, height: 2 },
  apartment_low: { width: 2, height: 2 },
  apartment_high:{ width: 2, height: 2 },
  office_low:    { width: 2, height: 2 },
  office_high:   { width: 2, height: 2 },
  mall:          { width: 3, height: 3 },
  factory_medium:{ width: 2, height: 2 },
  factory_large: { width: 3, height: 3 },
  warehouse:     { width: 2, height: 2 },
});

const SERVER_CONSOLIDATABLE_BUILDINGS = Object.freeze({
  residential: new Set(['house_small', 'house_medium']),
  commercial:  new Set(['shop_small', 'shop_medium']),
  industrial:  new Set(['factory_small']),
});

const SERVER_MERGEABLE_TYPES = new Set(['grass', 'tree', '']);

// ── Helper-Funktionen ─────────────────────────────────────────────

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
  if (settings && typeof settings.disastersEnabled === 'boolean') return settings.disastersEnabled;
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

function pickRandomZoneBuildingType(zoneType) {
  const pool = getZoneBuildingPool(zoneType);
  if (pool.length <= 0) return null;
  return String(pool[0] || '');
}

function deterministicUpgradeUnit(key) {
  const digest = crypto.createHash('sha256').update(String(key)).digest('hex');
  const n = parseInt(digest.slice(0, 8), 16);
  return n / 0xffffffff;
}

function getUpgradeHourRangeForLevel(fromLevel) {
  switch (Number(fromLevel)) {
    case 1: return [2 / 60, 5 / 60];
    case 2: return [5 / 60, 12 / 60];
    case 3: return [15 / 60, 30 / 60];
    case 4: return [30 / 60, 60 / 60];
    default: return [1, 2];
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
    if (elapsedHours >= cumulative) level = fromLevel + 1;
    else break;
  }
  return Math.max(1, Math.min(5, level));
}

// === Level-Progression: max ~7 Tage bis L5 ===
function getSlowUpgradeHourRangeForLevel(fromLevel) {
  switch (Number(fromLevel)) {
    case 1: return [18, 30];
    case 2: return [54, 78];
    case 3: return [108, 144];
    case 4: return [168, 216];
    default: return [240, 336];
  }
}

function getServerTargetLevel(seedBase, elapsedHours, landValue, serviceCoverage, zoneDemand) {
  let cumulative = 0;
  let level = 1;
  for (let fromLevel = 1; fromLevel <= 4; fromLevel += 1) {
    const [minH, maxH] = getSlowUpgradeHourRangeForLevel(fromLevel);
    const r = deterministicUpgradeUnit(`${seedBase}:L${fromLevel}`);
    const baseNeeded = minH + (maxH - minH) * r;
    const lvNorm = Math.max(0, Math.min(200, landValue || 50)) / 100;
    const landValueModifier = Math.max(0.4, Math.min(1.6, 1.6 - lvNorm * 0.6));
    const svcNorm = Math.max(0, Math.min(100, serviceCoverage || 0)) / 100;
    const serviceModifier = Math.max(0.8, 1.2 - svcNorm * 0.4);
    const demandClamped = Math.max(-100, Math.min(100, zoneDemand || 0));
    const demandModifier = Math.max(0.7, Math.min(1.4, 1.1 - demandClamped * 0.004));
    const needed = baseNeeded * landValueModifier * serviceModifier * demandModifier;
    cumulative += needed;
    if (elapsedHours >= cumulative) level = fromLevel + 1;
    else break;
  }
  const lvComponent  = Math.max(0, Math.min(200, landValue || 50)) / 15;
  const svcComponent = Math.max(0, Math.min(100, serviceCoverage || 0)) / 28;
  const demandBoost  = Math.max(0, ((zoneDemand || 0) - 30) / 70) * 0.7;
  const maxLevelByConditions = Math.min(5, Math.max(1, Math.floor(lvComponent + svcComponent + demandBoost)));
  return Math.max(1, Math.min(maxLevelByConditions, level));
}

function canUpgradeTool(tool) {
  const t = String(tool || '').trim().toLowerCase();
  if (!t) return false;
  if (NON_UPGRADABLE_TOOLS.has(t)) return false;
  if (t.startsWith('tree_') || t.startsWith('bush_') || t.startsWith('flower_') || t.startsWith('topiary_')) return false;
  return true;
}

function getEconomicZoneFromRow(row, meta) {
  const { inferCategoryFromTool } = require('../building.js');
  const explicitZone = String(row?.zone_type || '').trim().toLowerCase();
  if (explicitZone === 'residential' || explicitZone === 'commercial' || explicitZone === 'industrial') return explicitZone;
  const effectiveTool = String(
    row?.action_type === 'zone'
      ? (metaValue(meta, 'buildingType', 'building_type') || '')
      : (row?.tool || '')
  ).trim().toLowerCase();
  const inferred = inferCategoryFromTool(effectiveTool, 'general');
  if (inferred === 'residential' || inferred === 'commercial' || inferred === 'industrial') return inferred;
  return null;
}

function getUpgradeToolFromRow(row, meta) {
  return String(
    row?.action_type === 'zone'
      ? (metaValue(meta, 'buildingType', 'building_type') || '')
      : (row?.tool || '')
  ).trim().toLowerCase();
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
    const key = `${x},${y}`;
    const existing = grid.get(key);
    if (existing) {
      if (row.action_type === 'place' && existing.action_type === 'zone') {
        grid.set(key, { ...row, zone_type: existing.zone_type || row.zone_type });
      } else if (row.action_type === 'zone' && existing.action_type === 'place') {
        grid.set(key, { ...existing, zone_type: row.zone_type || existing.zone_type });
      } else {
        grid.set(key, row);
      }
    } else {
      grid.set(key, row);
    }
  }
  return grid;
}

function isServerMergeableTile(tileRow, tileMeta, targetZone, isOriginTile, allowBuildingConsolidation) {
  if (isOriginTile) {
    const zone = String(tileRow?.zone_type || '').trim().toLowerCase();
    return zone === targetZone && tileMeta.onFire !== true;
  }
  if (tileMeta.onFire === true) return false;
  if (tileMeta.abandoned === true) return false;
  const bt = String(metaValue(tileMeta, 'buildingType', 'building_type') || tileRow?.tool || '').trim().toLowerCase();
  if (bt === 'empty') return false;
  const zone = String(tileRow?.zone_type || '').trim().toLowerCase();
  if (zone !== targetZone) return false;
  const fw = Number(tileMeta.footprintWidth || 1);
  const fh = Number(tileMeta.footprintHeight || 1);
  if (fw > 1 || fh > 1) return false;
  if (SERVER_MERGEABLE_TYPES.has(bt) || bt === 'grass' || bt === '') return true;
  if (allowBuildingConsolidation) {
    const consolidatable = SERVER_CONSOLIDATABLE_BUILDINGS[targetZone];
    if (consolidatable && consolidatable.has(bt)) {
      const cp = Number(metaValue(tileMeta, 'constructionProgress', 'construction_progress') ?? 100);
      return cp >= 100 || tileMeta.constructed === true;
    }
  }
  return false;
}

function findServerConsolidationFootprint(grid, x, y, width, height, zone, allowBuildingConsolidation) {
  let bestOrigin = null;
  let bestScore = -Infinity;
  for (let oy = Math.max(0, y - (height - 1)); oy <= y; oy++) {
    for (let ox = Math.max(0, x - (width - 1)); ox <= x; ox++) {
      let available = true;
      for (let dy = 0; dy < height && available; dy++) {
        for (let dx = 0; dx < width && available; dx++) {
          const key = `${ox + dx},${oy + dy}`;
          const tileRow = grid.get(key);
          const isOrigin = ox + dx === x && oy + dy === y;
          if (!tileRow) {
            if (isOrigin) { available = false; break; }
            continue;
          }
          const tileMeta = toJsonValue(tileRow.metadata) || {};
          if (!isServerMergeableTile(tileRow, tileMeta, zone, isOrigin, allowBuildingConsolidation)) available = false;
        }
      }
      if (!available) continue;
      if (x < ox || x >= ox + width || y < oy || y >= oy + height) continue;
      let score = 0;
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          const neighbors = [[ox+dx-1,oy+dy],[ox+dx+1,oy+dy],[ox+dx,oy+dy-1],[ox+dx,oy+dy+1]];
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
      if (score > bestScore) { bestScore = score; bestOrigin = { originX: ox, originY: oy }; }
    }
  }
  return bestOrigin;
}

module.exports = {
  DISASTER_NON_BURNABLE_TOOLS,
  FIRE_RESPONSE_RANGE_TILES,
  DEBUG_DISASTER_TYPES,
  NON_UPGRADABLE_TOOLS,
  ZONE_SPAWN_BUILDINGS,
  ZONE_EVOLUTION_CHAIN,
  SERVER_BUILDING_SIZES,
  SERVER_CONSOLIDATABLE_BUILDINGS,
  SERVER_MERGEABLE_TYPES,
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
};
