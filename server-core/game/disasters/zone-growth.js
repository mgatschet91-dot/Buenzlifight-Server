'use strict';

const { dbPool, ensureDbEnabled } = require('../../infra/db.js');
const { toJsonValue, toFiniteNumber, metaValue, normalizeRoomCode } = require('../../shared/helpers.js');
const { buildRoomGrid, getServerBuildingSize, pickRandomZoneBuildingType } = require('./config.js');

const zoneGrowthLocks = new Set();
const MAX_SPAWNS_PER_TICK = 5;

async function runServerZoneGrowthTick(municipalityId, roomCode, sharedRows, context) {
  ensureDbEnabled();
  const { loadRoomStats, getRoomItemRows, getRoomItemVersion } = require('../rooms.js');

  const safeRoomCode = normalizeRoomCode(roomCode);
  const lockKey = `${municipalityId}:${safeRoomCode}`;
  if (zoneGrowthLocks.has(lockKey)) return { changes: [] };
  zoneGrowthLocks.add(lockKey);

  try {
    const rawStats = (await loadRoomStats(municipalityId, safeRoomCode)) || {};
    const demand = {
      residential: toFiniteNumber(rawStats.demand_residential, 0),
      commercial:  toFiniteNumber(rawStats.demand_commercial, 0),
      industrial:  toFiniteNumber(rawStats.demand_industrial, 0),
    };
    const hasPower = toFiniteNumber(rawStats.power_production, 0) > toFiniteNumber(rawStats.power_consumption, 0);
    const hasWater = toFiniteNumber(rawStats.water_production, 0) > toFiniteNumber(rawStats.water_consumption, 0);

    const rows = sharedRows || await getRoomItemRows(municipalityId, safeRoomCode);
    if (!rows.length) return { changes: [] };

    const grid = buildRoomGrid(rows);
    const emptyZoneTiles = [];
    const gapClearQueue = [];
    const autoClearGapTiles = [];
    const level5ZoneClearQueue = [];

    for (const row of rows) {
      if (row.action_type !== 'zone') continue;
      const zoneType = String(row.zone_type || '').trim().toLowerCase();
      if (zoneType !== 'residential' && zoneType !== 'commercial' && zoneType !== 'industrial') continue;
      const meta = toJsonValue(row.metadata) || {};
      const bt = String(metaValue(meta, 'buildingType', 'building_type') || '').trim().toLowerCase();
      const gx = Number(row.x), gy = Number(row.y);
      const gapHash = (Math.imul(gx, 73856093) ^ Math.imul(gy, 19349669)) >>> 0;
      const isGapTile = (gapHash % 100) < 30;

      if (!bt || bt === 'grass' || bt === '') {
        if (!isGapTile) emptyZoneTiles.push({ row, zoneType, meta });
        autoClearGapTiles.push({ row, gx, gy });
      } else if (isGapTile) {
        const lvl = Number(metaValue(meta, 'level') || 0);
        if (lvl <= 1) gapClearQueue.push({ row, meta });
      } else {
        const lvl = Number(metaValue(meta, 'level') || 0);
        const progress = Number(metaValue(meta, 'constructionProgress', 'construction_progress') || 0);
        const isConstructed = Boolean(metaValue(meta, 'constructed')) || progress >= 100;
        const alreadyCleared = Boolean(meta.zoneCleared);
        if (lvl >= 5 && isConstructed && !alreadyCleared) level5ZoneClearQueue.push({ row, gx, gy, bt, lvl, meta });
      }
    }

    const changedTiles = [];
    let currentVersion = await getRoomItemVersion(municipalityId, safeRoomCode);
    const now = new Date();
    const timestamp = Date.now();

    // Gap-Tiles bereinigen (max 3 pro Tick)
    for (let gi = 0; gi < Math.min(gapClearQueue.length, 3); gi++) {
      const { row, meta } = gapClearQueue[gi];
      const clearMeta = { ...meta, buildingType: 'grass' };
      delete clearMeta.level; delete clearMeta.constructionProgress; delete clearMeta.constructed; delete clearMeta.abandoned;
      currentVersion += 1;
      await dbPool.query(`UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(clearMeta), currentVersion, timestamp, now, row.id]);
      changedTiles.push({ x: Number(row.x), y: Number(row.y), buildingType: 'grass', level: 0, abandoned: false, constructionProgress: 0, constructed: false });
    }

    // Footprint-Map: Level-5-Positionen
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
      for (let fx = 0; fx < size.width; fx++) for (let fy = 0; fy < size.height; fy++) maxLevelPositions.add(`${ox+fx},${oy+fy}`);
    }

    // Leere Zone-Tiles bei Max-Level-Nachbarn freigeben
    const neighborOffsets = [[-1,0],[1,0],[0,-1],[0,1]];
    let cleared = 0;
    const clearedRowIds = new Set();
    for (const { row, gx, gy } of autoClearGapTiles) {
      if (cleared >= 8) break;
      let hasMaxNeighbor = false;
      for (const [dx, dy] of neighborOffsets) {
        if (maxLevelPositions.has(`${gx+dx},${gy+dy}`)) { hasMaxNeighbor = true; break; }
      }
      if (!hasMaxNeighbor) continue;
      currentVersion += 1;
      await dbPool.query(`DELETE FROM game_items WHERE id = ?`, [row.id]);
      clearedRowIds.add(row.id);
      cleared++;
      changedTiles.push({ x: gx, y: gy, buildingType: 'grass', level: 0, zoneCleared: true });
    }

    // Zone-Rahmen bei Level-5-Gebäuden entfernen (max 5 pro Tick)
    let zoneClearCount = 0;
    for (const { row, gx, gy, bt, lvl, meta } of level5ZoneClearQueue) {
      if (zoneClearCount >= 5) break;
      currentVersion += 1;
      const updatedMeta = { ...meta, zoneCleared: true };
      await dbPool.query(`UPDATE game_items SET metadata = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(updatedMeta), currentVersion, row.id]);
      zoneClearCount++;
      changedTiles.push({ x: gx, y: gy, buildingType: bt, level: lvl, zoneCleared: true });
    }

    if (emptyZoneTiles.length === 0 && changedTiles.length === 0) return { changes: changedTiles };

    // Road-Access BFS (bis 8 Tiles)
    const hasRoadAccess = (startX, startY) => {
      const visited = new Set();
      const queue = [[startX, startY, 0]];
      visited.add(`${startX},${startY}`);
      const offsets = [[-1,0],[1,0],[0,-1],[0,1]];
      while (queue.length > 0) {
        const [cx, cy, dist] = queue.shift();
        for (const [dx, dy] of offsets) {
          const nx = cx+dx, ny = cy+dy;
          const nk = `${nx},${ny}`;
          if (visited.has(nk)) continue;
          visited.add(nk);
          const neighbor = grid.get(nk);
          if (!neighbor) continue;
          const nTool = String(neighbor.tool || '').toLowerCase();
          const nMeta = toJsonValue(neighbor.metadata) || {};
          const nBt = String(metaValue(nMeta, 'buildingType', 'building_type') || nTool).toLowerCase();
          if (nTool === 'road' || nTool === 'bridge' || nBt === 'road' || nBt === 'bridge') return true;
          if (dist < 8 && neighbor.action_type === 'zone') queue.push([nx, ny, dist+1]);
        }
      }
      return false;
    };

    const shuffled = emptyZoneTiles.sort(() => Math.random() - 0.5);
    let spawned = 0;

    for (const { row, zoneType, meta } of shuffled) {
      if (spawned >= MAX_SPAWNS_PER_TICK) break;
      if (clearedRowIds.has(row.id)) continue;
      const x = Number(row.x), y = Number(row.y);
      if (!hasRoadAccess(x, y)) continue;

      const zoneDemand = demand[zoneType] || 0;
      const demandFactor = Math.max(0, Math.min(1, (zoneDemand + 30) / 80));
      const effectiveChance = Math.max(0.015, 0.05 * demandFactor);
      const chance = 1 - Math.pow(1 - effectiveChance, 6);
      if (Math.random() >= chance) continue;

      if (zoneType === 'residential' && context?.serviceCoverageGrids?.police) {
        const tilePoliceCov = context.serviceCoverageGrids.police[y]?.[x] ?? 50;
        if (tilePoliceCov < 20 && Math.random() >= 0.5) continue;
        else if (tilePoliceCov < 40 && Math.random() >= 0.8) continue;
      }

      if (!hasPower || !hasWater) continue;

      const buildingType = pickRandomZoneBuildingType(zoneType);
      if (!buildingType) continue;

      const nextMeta = { ...meta, buildingType, level: 1, constructionProgress: 0, constructed: false, abandoned: false };
      currentVersion += 1;
      await dbPool.query(`UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(nextMeta), currentVersion, timestamp, now, row.id]);
      spawned += 1;
      changedTiles.push({ x, y, level: 1, abandoned: false, buildingType, constructionProgress: 0, constructed: false });
    }

    return { changes: changedTiles, spawned };
  } finally {
    zoneGrowthLocks.delete(lockKey);
  }
}

module.exports = { runServerZoneGrowthTick };
