'use strict';

const { dbPool, ensureDbEnabled } = require('../../infra/db.js');
const { toJsonValue, metaValue, normalizeRoomCode } = require('../../shared/helpers.js');
const { buildRoomGrid } = require('./config.js');

const woodcutterTickLocks = new Set();

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
  const { getRoomItemRows, getRoomItemVersion } = require('../rooms.js');
  const { applyMunicipalityTransaction } = require('../bank.js');
  const { logInfo } = require('../../infra/logger.js');

  const safeRoomCode = normalizeRoomCode(roomCode);
  const lockKey = `${municipalityId}:${safeRoomCode}`;
  if (woodcutterTickLocks.has(lockKey)) return { changes: [], harvested: 0, planted: 0, earned: 0 };
  woodcutterTickLocks.add(lockKey);

  try {
    const rows = sharedRows || await getRoomItemRows(municipalityId, safeRoomCode);
    if (!rows.length) return { changes: [], harvested: 0, planted: 0, earned: 0 };

    // 1) Fertig gebaute Holzfäller-Häuser finden
    const woodcutters = [];
    for (const row of rows) {
      if (row.action_type !== 'place') continue;
      const t = String(row.tool || '').toLowerCase();
      if (t !== 'woodcutter_house') continue;
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent || meta.abandoned === true) continue;
      const cp = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 100);
      const isConstructed = cp >= 100 || meta.constructed === true;
      if (!isConstructed) continue;
      const level = Math.max(1, Math.min(4, Math.round(Number(meta.level ?? 1))));
      woodcutters.push({ row, meta, level, x: Number(row.x), y: Number(row.y) });
    }
    if (woodcutters.length === 0) return { changes: [], harvested: 0, planted: 0, earned: 0 };

    // 2) Grid aufbauen
    const grid = buildRoomGrid(rows);
    const nowMs = Date.now();
    const now = new Date();
    let currentVersion = await getRoomItemVersion(municipalityId, safeRoomCode);
    const changes = [];
    let totalHarvested = 0, totalPlanted = 0, totalEarned = 0;

    for (const wc of woodcutters) {
      const cfg = WOODCUTTER_LEVEL_CONFIG[wc.level] || WOODCUTTER_LEVEL_CONFIG[1];
      const treesInRadius = [];
      const emptyInRadius = [];

      for (let dy = -cfg.radius; dy <= cfg.radius; dy++) {
        for (let dx = -cfg.radius; dx <= cfg.radius; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (Math.abs(dx) + Math.abs(dy) > cfg.radius) continue;
          const tx = wc.x + dx, ty = wc.y + dy;
          if (tx < 0 || ty < 0) continue; // int unsigned verträgt keine negativen Koordinaten
          const cell = grid.get(`${tx},${ty}`);
          if (cell) {
            const cellTool = String(cell.tool || '').toLowerCase();
            if (cellTool === 'tree' || cellTool.startsWith('tree_')) {
              const cellMeta = toJsonValue(cell.metadata) || {};
              const plantedAt = Number(metaValue(cellMeta, 'plantedAt', 'planted_at') ?? 0);
              const isMature = plantedAt > 0 ? (nowMs - plantedAt >= WOODCUTTER_GROWTH_MS) : true;
              treesInRadius.push({ row: cell, x: tx, y: ty, isMature, meta: cellMeta });
            } else if (cellTool === 'grass') {
              const cellMeta = toJsonValue(cell.metadata) || {};
              if (!metaValue(cellMeta, 'buildingType', 'building_type')) emptyInRadius.push({ x: tx, y: ty });
            }
          }
        }
      }

      // 3) Reife Bäume ernten (max 2 pro Tick)
      const matureTrees = treesInRadius.filter(t => t.isMature);
      const harvestCount = Math.min(matureTrees.length, 2);
      if (harvestCount > 0) {
        const toHarvest = matureTrees.sort(() => Math.random() - 0.5).slice(0, harvestCount);
        const earnedThisTick = toHarvest.length * cfg.moneyPerHarvest;
        for (const tree of toHarvest) {
          const nextMeta = { ...tree.meta };
          delete nextMeta.plantedAt; delete nextMeta.planted_at;
          delete nextMeta.buildingType; delete nextMeta.building_type;
          nextMeta.level = 0;
          currentVersion += 1;
          await dbPool.query(`UPDATE game_items SET tool = 'grass', metadata = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(nextMeta), currentVersion, tree.row.id]);
          changes.push({ x: tree.x, y: tree.y, buildingType: 'grass', level: 0, harvested: true });
          totalHarvested += 1;
        }
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

      // 4) Fehlende Bäume pflanzen (max 2 pro Tick)
      const currentTreeCount = treesInRadius.length - harvestCount;
      const treesToPlant = Math.min(cfg.maxTrees - currentTreeCount, 2, emptyInRadius.length);
      if (treesToPlant > 0) {
        const plantSpots = emptyInRadius.sort(() => Math.random() - 0.5).slice(0, treesToPlant);
        for (const spot of plantSpots) {
          const treeType = TREE_TYPES[Math.floor(Math.random() * TREE_TYPES.length)];
          currentVersion += 1;
          const existing = grid.get(`${spot.x},${spot.y}`);
          if (existing && existing.id) {
            await dbPool.query(`UPDATE game_items SET tool = ?, metadata = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [treeType, JSON.stringify({ plantedAt: nowMs }), currentVersion, existing.id]);
          } else {
            await dbPool.query(`INSERT INTO game_items (municipality_id, room_code, action_type, tool, x, y, metadata, version, applied_at, created_at, updated_at) VALUES (?, ?, 'place', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [municipalityId, safeRoomCode, treeType, spot.x, spot.y, JSON.stringify({ plantedAt: nowMs }), currentVersion, now]);
          }
          changes.push({ x: spot.x, y: spot.y, buildingType: treeType, level: 1, planted: true, plantedAt: nowMs });
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

module.exports = { runServerWoodcutterTick };
