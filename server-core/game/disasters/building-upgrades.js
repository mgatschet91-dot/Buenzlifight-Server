'use strict';

const { dbPool, ensureDbEnabled } = require('../../infra/db.js');
const { SERVICE_UPGRADE_TOOLS } = require('../../config/constants.js');
const { toJsonValue, toFiniteNumber, jsonEquals, metaValue, normalizeRoomCode } = require('../../shared/helpers.js');
const { pushDiscordEvent } = require('../../shared/discord.js');
const {
  canUpgradeTool, getUpgradeToolFromRow, getEconomicZoneFromRow,
  getServerTargetLevel, getTargetBuildingTypeForLevel, getServerBuildingSize,
  buildRoomGrid, findServerConsolidationFootprint,
} = require('./config.js');

const upgradeTickLocks = new Set();

async function runServerBuildingUpgradeTick(municipalityId, roomCode, sharedRows, context) {
  ensureDbEnabled();
  const { loadRoomStats, getRoomItemRows, getRoomItemVersion, toItemsStatsShape } = require('../rooms.js');
  const { refreshGameDataMapFromItems } = require('../map.js');
  const { getMunicipalityById } = require('../municipality');

  const lockKey = `${municipalityId}:${normalizeRoomCode(roomCode)}`;
  if (upgradeTickLocks.has(lockKey)) return { updated: 0 };
  upgradeTickLocks.add(lockKey);

  try {
    const rawStats = (await loadRoomStats(municipalityId, roomCode)) || {};
    const statsShape = toItemsStatsShape(rawStats);
    const demand = statsShape && statsShape.demand && typeof statsShape.demand === 'object'
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
      return canUpgradeTool(getUpgradeToolFromRow(row, meta));
    });
    if (!candidates.length) return { updated: 0 };

    let existingMansionCount = 0;
    let residentialZoneTileCount = 0;
    for (const r of rows) {
      if (r.action_type === 'zone' && String(r.zone_type || '').toLowerCase() === 'residential') {
        residentialZoneTileCount++;
        const m = toJsonValue(r.metadata) || {};
        const bt = String(metaValue(m, 'buildingType', 'building_type') || '').toLowerCase();
        if (bt === 'mansion' && Number(metaValue(m, 'constructionProgress', 'construction_progress') ?? 0) >= 100) existingMansionCount++;
      }
    }
    const maxMansionsAllowed = residentialZoneTileCount < 60 ? 1 : Math.min(5, Math.max(2, Math.floor(residentialZoneTileCount / 120)));

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
          const targetProgress = Math.min(100, Math.round((100 / 15) * elapsedSec * 100) / 100);

          if (targetProgress > constructionProgress) {
            nextMeta.constructionProgress = targetProgress;
            nextMeta.constructed = targetProgress >= 100;
            isConstructed = nextMeta.constructed === true;
            if (isConstructed && !nextMeta.level) nextMeta.level = 1;
          }
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
              `UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [JSON.stringify(nextMeta), currentVersion, timestamp, now, row.id]
            );
            updated += 1;
            changedTiles.push({ x: Number(row.x), y: Number(row.y), level: Number(nextMeta.level ?? 1), abandoned: false, buildingType: String(nextMeta.buildingType || row.tool || ''), constructionProgress: nextMeta.constructionProgress, constructed: false });
          }
          continue;
        }

        if (!meta.constructed || meta.constructionProgress < 100) {
          currentVersion += 1;
          await dbPool.query(
            `UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [JSON.stringify(nextMeta), currentVersion, timestamp, now, row.id]
          );
          updated += 1;
          changedTiles.push({ x: Number(row.x), y: Number(row.y), level: Number(nextMeta.level ?? meta.level ?? 1), abandoned: false, buildingType: String(nextMeta.buildingType || row.tool || ''), constructionProgress: 100, constructed: true });
          Object.assign(meta, nextMeta);
        }
      }
      if (!isConstructed) continue;

      // ── Timed Upgrade Completion ─────────────────────────────
      const upgradeStartedAt = Number(metaValue(meta, 'upgrade_started_at', 'upgradeStartedAt') || 0);
      const upgradeTargetLevel = Number(metaValue(meta, 'upgrade_target_level', 'upgradeTargetLevel') || 0);
      const upgradeDurationSec = Number(metaValue(meta, 'upgrade_seconds', 'upgradeSeconds') || 0);
      if (upgradeStartedAt > 0 && upgradeTargetLevel > 0) {
        const elapsedMs = nowMs - upgradeStartedAt;
        const requiredMs = upgradeDurationSec > 0 ? upgradeDurationSec * 1000 : 0;
        if (elapsedMs >= requiredMs) {
          nextMeta.level = upgradeTargetLevel;
          delete nextMeta.upgrade_started_at; delete nextMeta.upgradeStartedAt;
          delete nextMeta.upgrade_target_level; delete nextMeta.upgradeTargetLevel;
          delete nextMeta.upgrade_seconds; delete nextMeta.upgradeSeconds;
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
          if (Math.random() < chance) nextMeta.abandoned = true;
        } else if (currentAbandoned && zoneDemand > 5) {
          const baseRecoveryPerHour = Math.min(0.04, (zoneDemand - 5) / 2000);
          const utilityBoost = (powerBalance >= 0 ? 0.004 : 0) + (waterBalance >= 0 ? 0.004 : 0);
          const policeRecoveryBoost = policeCov > 60 ? 0.005 : 0;
          const recoveryPerHour = Math.max(0, Math.min(0.08, baseRecoveryPerHour + utilityBoost + policeRecoveryBoost));
          const recoveryChance = 1 - Math.pow(1 - recoveryPerHour, elapsedAbandonHours);
          if (Math.random() < recoveryChance) nextMeta.abandoned = false;
        }
        nextMeta.lastAbandonmentTickAt = nowMs;
      }

      const currentAbandonedAfterTick = Boolean(nextMeta.abandoned === true);
      const toolForUpgrade = getUpgradeToolFromRow(row, meta);
      const tileX = Math.round(Number(row.x || 0));
      const tileY = Math.round(Number(row.y || 0));
      const tileLandValue = context?.landValueGrid?.[tileY]?.[tileX] ?? 50;
      const tileSvcCoverage = context?.serviceCoverageGrids
        ? ((context.serviceCoverageGrids.police?.[tileY]?.[tileX] || 0) +
           (context.serviceCoverageGrids.fire?.[tileY]?.[tileX] || 0) +
           (context.serviceCoverageGrids.health?.[tileY]?.[tileX] || 0) +
           (context.serviceCoverageGrids.education?.[tileY]?.[tileX] || 0)) / 4
        : 0;

      if (!currentAbandonedAfterTick && isEconomicZone && !SERVICE_UPGRADE_TOOLS.has(toolForUpgrade)) {
        if (hasPower && hasWater) {
          const currentLevel = Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1))));
          if (currentLevel < 5) {
            const startedAtMsLevel = row.applied_at ? new Date(row.applied_at).getTime() : Number(row.client_timestamp || 0);
            if (Number.isFinite(startedAtMsLevel) && startedAtMsLevel > 0) {
              const elapsedHours = Math.max(0, (nowMs - startedAtMsLevel) / (1000 * 60 * 60));
              const seedBase = `${municipalityId}:${roomCode}:${row.x}:${row.y}:${toolForUpgrade}`;
              const zoneDemandVal = Math.round(toFiniteNumber(demand[zoneCategory], 0));
              const targetLevel = getServerTargetLevel(seedBase, elapsedHours, tileLandValue, tileSvcCoverage, zoneDemandVal);
              if (targetLevel > currentLevel) nextMeta = { ...nextMeta, level: currentLevel + 1, serverLevelAuthoritative: true };
            }
          }
        }
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
            let allowBuildingConsolidation = zoneDemandVal > 15;
            let consolidationChance = 0.05;
            if (zoneDemandVal > 20) {
              consolidationChance += Math.min(0.08, (zoneDemandVal - 20) / 400);
              if (zoneDemandVal > 50) { consolidationChance += 0.02; allowBuildingConsolidation = true; }
            }

            let effectiveConsolidationChance = consolidationChance;
            let mansionBlocked = false;
            if (targetEvolutionType === 'mansion') {
              if (existingMansionCount >= maxMansionsAllowed) {
                mansionBlocked = true;
              } else {
                const qualityOk = tileLandValue >= 90 && tileSvcCoverage >= 65 && zoneDemandVal >= 20;
                if (!qualityOk) {
                  mansionBlocked = true;
                } else {
                  const CLUSTER_RADIUS = 8, CLUSTER_MAX = 3;
                  let nearbyMansionCount = 0;
                  for (const r2 of rows) {
                    if (r2.action_type !== 'zone') continue;
                    const m2 = toJsonValue(r2.metadata) || {};
                    if (String(metaValue(m2, 'buildingType', 'building_type') || '').toLowerCase() !== 'mansion') continue;
                    if (Number(metaValue(m2, 'constructionProgress', 'construction_progress') ?? 0) < 100) continue;
                    const d = Math.abs(Number(r2.x) - tileX) + Math.abs(Number(r2.y) - tileY);
                    if (d <= CLUSTER_RADIUS) nearbyMansionCount++;
                  }
                  if (nearbyMansionCount >= CLUSTER_MAX) {
                    mansionBlocked = true;
                  } else {
                    const hasNearby = nearbyMansionCount > 0;
                    const prestigeBoost = hasNearby && tileLandValue >= 110 && tileSvcCoverage >= 80 ? 2.5 : 1.0;
                    effectiveConsolidationChance = Math.min(0.025, consolidationChance * 0.08 * prestigeBoost);
                  }
                }
              }
            }

            const fallbackEvolutionType = mansionBlocked ? getTargetBuildingTypeForLevel(zoneCategory, 4) : null;
            const activeEvolutionType = mansionBlocked ? fallbackEvolutionType : targetEvolutionType;
            const activeTargetSize = activeEvolutionType ? getServerBuildingSize(activeEvolutionType) : targetSize;
            const activeChance = mansionBlocked ? consolidationChance : effectiveConsolidationChance;

            if (activeEvolutionType && Math.random() < activeChance) {
              if (activeEvolutionType === 'mansion') existingMansionCount++;
              const footprint = findServerConsolidationFootprint(roomGrid, Number(row.x), Number(row.y), activeTargetSize.width, activeTargetSize.height, zoneCategory, allowBuildingConsolidation);

              if (footprint) {
                const ox = footprint.originX, oy = footprint.originY;
                const activeEvolLevel = (mansionBlocked && activeEvolutionType !== 'mansion') ? Math.max(4, evolLevel) : evolLevel;

                for (let dy = 0; dy < activeTargetSize.height; dy++) {
                  for (let dx = 0; dx < activeTargetSize.width; dx++) {
                    const tx = ox + dx, ty = oy + dy;
                    const isOrigin = dx === 0 && dy === 0;
                    const tk = `${tx},${ty}`;
                    processedTiles.add(tk);
                    const tileRow = roomGrid.get(tk);
                    const isCurrentRow = tileRow ? tileRow.id === row.id : false;

                    if (isOrigin) {
                      if (isCurrentRow) {
                        nextMeta.buildingType = activeEvolutionType; nextMeta.level = activeEvolLevel;
                        nextMeta.constructionStartedAt = nowMs; nextMeta.constructionProgress = 0;
                        nextMeta.constructed = false; nextMeta.abandoned = false;
                        nextMeta.footprintWidth = activeTargetSize.width; nextMeta.footprintHeight = activeTargetSize.height;
                      } else {
                        if (!tileRow) continue;
                        const originMeta = { ...(toJsonValue(tileRow.metadata) || {}) };
                        Object.assign(originMeta, { buildingType: activeEvolutionType, level: activeEvolLevel, constructionStartedAt: nowMs, constructionProgress: 0, constructed: false, abandoned: false, footprintWidth: activeTargetSize.width, footprintHeight: activeTargetSize.height });
                        currentVersion += 1;
                        await dbPool.query(`UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(originMeta), currentVersion, timestamp, now, tileRow.id]);
                        updated += 1;
                        changedTiles.push({ x: tx, y: ty, level: activeEvolLevel, abandoned: false, buildingType: activeEvolutionType, constructionProgress: 0, constructed: false, footprintWidth: activeTargetSize.width, footprintHeight: activeTargetSize.height });
                      }
                    } else {
                      const emptyMeta = JSON.stringify({ buildingType: 'empty', originX: ox, originY: oy, level: 0, constructionProgress: 100, constructed: true, population: 0, jobs: 0, abandoned: false });
                      if (isCurrentRow) {
                        Object.assign(nextMeta, JSON.parse(emptyMeta));
                      } else {
                        currentVersion += 1;
                        await dbPool.query(`DELETE FROM game_items WHERE municipality_id=? AND room_code=? AND x=? AND y=? AND action_type='place'`, [municipalityId, roomCode, tx, ty]);
                        const [upRes] = await dbPool.query(`UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'zone'`, [emptyMeta, currentVersion, timestamp, now, municipalityId, roomCode, tx, ty]);
                        if ((upRes?.affectedRows || 0) === 0) {
                          await dbPool.query(`INSERT INTO game_items (municipality_id, room_code, x, y, action_type, tool, metadata, version, client_timestamp, applied_at, updated_at) VALUES (?, ?, ?, ?, 'zone', 'grass', ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [municipalityId, roomCode, tx, ty, emptyMeta, currentVersion, timestamp, now]);
                        }
                        updated += 1;
                      }
                      changedTiles.push({ x: tx, y: ty, level: 0, abandoned: false, buildingType: 'empty', constructionProgress: 100, constructed: true });
                    }

                    const existingGridRow = roomGrid.get(tk);
                    if (isOrigin) {
                      const snapMeta = isCurrentRow ? { ...nextMeta } : { buildingType: activeEvolutionType, footprintWidth: activeTargetSize.width, footprintHeight: activeTargetSize.height, level: activeEvolLevel, constructed: false, constructionProgress: 0 };
                      roomGrid.set(tk, { ...(existingGridRow || { municipality_id: municipalityId, room_code: roomCode, x: tx, y: ty, action_type: 'zone', tool: 'grass', zone_type: zoneCategory }), metadata: JSON.stringify(snapMeta) });
                    } else {
                      roomGrid.set(tk, { ...(existingGridRow || { municipality_id: municipalityId, room_code: roomCode, x: tx, y: ty, action_type: 'zone', tool: 'grass', zone_type: zoneCategory }), metadata: JSON.stringify({ buildingType: 'empty', originX: ox, originY: oy }) });
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
      await dbPool.query(`UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(nextMeta), currentVersion, timestamp, row.id]);
      updated += 1;
      changedTiles.push({ x: Number(row.x), y: Number(row.y), level: Number(nextMeta.level ?? meta.level ?? 1), abandoned: Boolean(nextMeta.abandoned), buildingType: String(nextMeta.buildingType || row.tool || ''), constructionProgress: Number(nextMeta.constructionProgress ?? meta.constructionProgress ?? 100), constructed: Boolean(nextMeta.constructed ?? meta.constructed ?? true), footprintWidth: Number(nextMeta.footprintWidth || 1), footprintHeight: Number(nextMeta.footprintHeight || 1) });
    }

    if (changedTiles.length > 0) {
      const completedCount = changedTiles.filter(c => c.constructed === true && c.constructionProgress >= 100).length;
      const upgradedCount = changedTiles.filter(c => c.level && c.level > 1 && !c.abandoned).length;
      const abandonedCount = changedTiles.filter(c => c.abandoned === true).length;
      if (completedCount > 0 || upgradedCount > 0 || abandonedCount > 0) {
        getMunicipalityById(municipalityId).then((m) => {
          const name = m?.name || `Gemeinde #${municipalityId}`;
          if (completedCount > 0) pushDiscordEvent('building_complete', { municipalityName: name, roomCode, count: completedCount, message: `${completedCount} Gebäude fertiggestellt in ${name}` });
          if (upgradedCount > 0) pushDiscordEvent('building_upgrade', { municipalityName: name, roomCode, count: upgradedCount, message: `${upgradedCount} Gebäude aufgewertet in ${name}` });
          if (abandonedCount > 0) pushDiscordEvent('building_abandoned', { municipalityName: name, roomCode, count: abandonedCount, message: `${abandonedCount} Gebäude verlassen in ${name}` });
        }).catch(() => {});
      }
    }

    return { updated, changes: changedTiles };
  } finally {
    upgradeTickLocks.delete(lockKey);
  }
}

module.exports = { runServerBuildingUpgradeTick };
