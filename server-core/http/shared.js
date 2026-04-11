'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { toJsonValue, toFiniteNumber, metaValue } = require('../shared/helpers');
const { getRoomItemVersion, loadRoomStats, getMunicipalityMoney, saveRoomStats, toStatsApiShape } = require('../game/rooms');
const { ensureItemDetailExists } = require('../game/building');
const { getZoneBuildingPool, getZoneStarterBuilding, pickRandomZoneBuildingType } = require('../game/disasters');
const { recomputeAuthoritativePopulationAndJobs } = require('../game/stats');
const { refreshGameDataMapFromItems } = require('../game/map');
const { getMunicipalityBySlug } = require('../game/municipality');
const { applyMunicipalityTransaction } = require('../game/bank');
const { wsRoomKey, wsParseRoomKey, wsMapStatsToRealtimePayload } = require('../ws/socketio/helpers');
const { wsRoomAuthoritativeStats } = require('../ws/socketio/index');

// ——— Rate-Limiting ———

const RATE_LIMIT_MAX_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();
const registerAttempts = new Map();
const actionAttempts = new Map();
const ACTION_RATE_LIMIT = 30;
const ACTION_WINDOW_MS = 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, entry] of loginAttempts) {
    if (entry.firstAttempt < cutoff) loginAttempts.delete(ip);
  }
  for (const [ip, entry] of registerAttempts) {
    if (entry.firstAttempt < cutoff) registerAttempts.delete(ip);
  }
  const actionCutoff = Date.now() - ACTION_WINDOW_MS;
  for (const [key, entry] of actionAttempts) {
    if (entry.firstAttempt < actionCutoff) actionAttempts.delete(key);
  }
}, 60_000);

function checkRateLimit(attemptsMap, key, maxAttempts, windowMs) {
  const now = Date.now();
  const entry = attemptsMap.get(key);
  if (entry && entry.count >= maxAttempts && (now - entry.firstAttempt) < windowMs) {
    return Math.ceil((windowMs - (now - entry.firstAttempt)) / 1000);
  }
  return 0;
}

function incrementRateLimit(attemptsMap, key) {
  const now = Date.now();
  const entry = attemptsMap.get(key);
  if (entry) { entry.count++; } else { attemptsMap.set(key, { count: 1, firstAttempt: now }); }
}

// ——— Game helpers ———

const SERVICE_UPGRADE_TOOLS = new Set([
  'police_station', 'fire_station', 'hospital', 'school',
  'university', 'power_plant', 'water_tower', 'woodcutter_house',
]);

const DEBUG_DISASTER_TYPES = new Set(['fire_single', 'fire_cluster', 'fire_storm', 'earthquake', 'meteor', 'extinguish_all']);

function parseManualDisasterIntensity(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(5, Math.round(n)));
}

async function fetchRivers(canton) {
  ensureDbEnabled();
  const normalized = canton ? String(canton).toUpperCase().trim() : null;
  if (normalized) {
    const [rows] = await dbPool.query(
      `SELECT id, name, slug, canton_code, canton_name, length_km, source_name, mouth_name, river_type
       FROM game_data_rivers WHERE is_active = 1 AND canton_code = ? ORDER BY name ASC`,
      [normalized]
    );
    return Array.isArray(rows) ? rows : [];
  }
  const [rows] = await dbPool.query(
    `SELECT id, name, slug, canton_code, canton_name, length_km, source_name, mouth_name, river_type
     FROM game_data_rivers WHERE is_active = 1 ORDER BY canton_code ASC, name ASC`
  );
  return Array.isArray(rows) ? rows : [];
}

async function hasAdjacentWaterForFootprint(municipalityId, roomCode, x, y, width = 1, height = 1) {
  const fw = Math.max(1, Math.round(Number(width) || 1));
  const fh = Math.max(1, Math.round(Number(height) || 1));
  const minX = Math.round(Number(x) || 0);
  const minY = Math.round(Number(y) || 0);
  const maxX = minX + fw - 1;
  const maxY = minY + fh - 1;
  const [rows] = await dbPool.query(
    `SELECT id FROM game_items
     WHERE municipality_id = ? AND room_code = ? AND action_type = 'place' AND tool = 'water'
       AND ((x BETWEEN ? AND ? AND y = ?) OR (x BETWEEN ? AND ? AND y = ?)
         OR (x = ? AND y BETWEEN ? AND ?) OR (x = ? AND y BETWEEN ? AND ?))
     LIMIT 1`,
    [municipalityId, roomCode, minX, maxX, minY - 1, minX, maxX, maxY + 1, minX - 1, minY, maxY, maxX + 1, minY, maxY]
  );
  return Array.isArray(rows) && rows.length > 0;
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort((a, b) => a.localeCompare(b)).reduce((acc, key) => {
      acc[key] = canonicalizeJson(value[key]);
      return acc;
    }, {});
  }
  return value ?? null;
}

function jsonEquals(a, b) {
  return JSON.stringify(canonicalizeJson(a)) === JSON.stringify(canonicalizeJson(b));
}

async function markItemsConstructed(municipalityId, roomCode, positions) {
  ensureDbEnabled();
  let updated = 0;
  let deleted = 0;
  let currentVersion = await getRoomItemVersion(municipalityId, roomCode);
  let statsSnapshot = (await loadRoomStats(municipalityId, roomCode)) || {};
  let currentMoney = await getMunicipalityMoney(municipalityId);
  const originalMoney = currentMoney;
  let statsChanged = false;
  const itemDetailCache = new Map();
  const timestamp = Date.now();
  const now = new Date();

  for (const pos of positions) {
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (pos.removed) {
      const [result] = await dbPool.query(
        `DELETE FROM game_items WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('place', 'zone')`,
        [municipalityId, roomCode, x, y]
      );
      deleted += result.affectedRows || 0;
      continue;
    }
    const [rows] = await dbPool.query(
      `SELECT id, metadata, tool FROM game_items
       WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('zone', 'place')
       ORDER BY CASE WHEN action_type='zone' THEN 0 ELSE 1 END, version DESC LIMIT 1`,
      [municipalityId, roomCode, x, y]
    );
    const row = rows[0];
    if (!row) continue;
    const meta = toJsonValue(row.metadata) || {};
    let changed = false;
    const setIfDiff = (key, value) => {
      if (typeof value === 'undefined') return;
      if (!jsonEquals(meta[key], value)) { meta[key] = value; changed = true; }
    };
    if (typeof pos.progress !== 'undefined' && pos.progress !== null) {
      const progress = Math.max(0, Math.min(100, Math.round(Number(pos.progress) * 100) / 100));
      setIfDiff('constructionProgress', progress);
      setIfDiff('constructed', progress >= 100);
    }
    let buildingTypeForSync = pos.tool;
    if (row.action_type === 'zone') {
      const zoneType = String(pos.zone || row.zone_type || '').trim().toLowerCase();
      const existingBuildingType = String(metaValue(meta, 'buildingType', 'building_type') || '').trim().toLowerCase();
      const incomingTool = String(pos.tool || '').trim().toLowerCase();
      const zonePool = getZoneBuildingPool(zoneType);
      const starterTool = getZoneStarterBuilding(zoneType);
      const randomizedTool = pickRandomZoneBuildingType(zoneType);
      const hasExistingBuildingType = existingBuildingType.length > 0;
      const existingInPool = hasExistingBuildingType && zonePool.includes(existingBuildingType);
      const incomingInPool = incomingTool.length > 0 && zonePool.includes(incomingTool);
      const shouldRandomizeStarter = !hasExistingBuildingType && incomingTool.length > 0 && starterTool.length > 0 && incomingTool === starterTool && randomizedTool;
      const shouldReplaceExistingStarter = hasExistingBuildingType && existingInPool && starterTool.length > 0 && existingBuildingType === starterTool && randomizedTool;
      const shouldReplaceIncomingStarter = incomingTool.length > 0 && starterTool.length > 0 && incomingTool === starterTool && randomizedTool;
      const shouldReplaceInvalidExisting = hasExistingBuildingType && !existingInPool && randomizedTool;
      const shouldReplaceInvalidIncoming = incomingTool.length > 0 && !incomingInPool && randomizedTool;

      if (!incomingTool && !hasExistingBuildingType && randomizedTool) buildingTypeForSync = randomizedTool;
      else if (shouldReplaceExistingStarter) buildingTypeForSync = randomizedTool;
      else if (shouldReplaceIncomingStarter) buildingTypeForSync = randomizedTool;
      else if (shouldReplaceInvalidExisting) buildingTypeForSync = randomizedTool;
      else if (shouldReplaceInvalidIncoming) buildingTypeForSync = randomizedTool;
      else if (shouldRandomizeStarter) buildingTypeForSync = randomizedTool;
      else if (!incomingTool && hasExistingBuildingType) buildingTypeForSync = existingBuildingType;
    }
    setIfDiff('buildingType', buildingTypeForSync);
    if (typeof pos.abandoned !== 'undefined') setIfDiff('abandoned', Boolean(pos.abandoned));
    if (typeof pos.planted_at !== 'undefined' && pos.planted_at !== null) setIfDiff('plantedAt', Date.now()); // Always use server time
    if (typeof pos.on_fire !== 'undefined') setIfDiff('onFire', Boolean(pos.on_fire));
    if (typeof pos.fire_progress !== 'undefined' && pos.fire_progress !== null) setIfDiff('fireProgress', Math.max(0, Math.min(100, Math.round(Number(pos.fire_progress)))));
    const toolName = String(pos.tool || row.tool || metaValue(meta, 'buildingType', 'building_type') || '').trim().toLowerCase();
    const previousLevel = Math.max(1, Math.min(5, Math.round(Number(metaValue(meta, 'level') ?? 1))));

    if (typeof pos.upgrade_started_at !== 'undefined' && pos.upgrade_started_at !== null &&
        typeof pos.upgrade_target_level !== 'undefined' && pos.upgrade_target_level !== null) {
      const targetLevel = Math.max(1, Math.min(5, Math.round(Number(pos.upgrade_target_level))));
      const upgradeStartedAt = Date.now(); // Always use server time, never trust client timestamp
      if (targetLevel > previousLevel && SERVICE_UPGRADE_TOOLS.has(toolName)) {
        let detail = itemDetailCache.get(toolName);
        if (typeof detail === 'undefined') { detail = await ensureItemDetailExists(toolName, null); itemDetailCache.set(toolName, detail || null); }
        const baseCost = detail ? Math.max(0, Math.round(toFiniteNumber(detail.build_cost, 0))) : 0;
        const upgradeCost = Math.max(0, Math.round(baseCost * Math.pow(2, previousLevel)));
        if (!(upgradeCost > 0 && currentMoney < upgradeCost)) {
          if (upgradeCost > 0) {
            currentMoney = Math.max(0, currentMoney - upgradeCost);
            statsSnapshot = { ...(statsSnapshot || {}), money: currentMoney, total_spent: Math.max(0, Math.round(toFiniteNumber(statsSnapshot.total_spent, 0))) + upgradeCost };
            statsChanged = true;
          }
          setIfDiff('upgradeStartedAt', upgradeStartedAt);
          setIfDiff('upgradeTargetLevel', targetLevel);
        }
      }
    }

    if (typeof pos.level !== 'undefined' && pos.level !== null) {
      let safeLevel = Math.max(0, Math.min(5, Math.round(Number(pos.level))));
      if (safeLevel > previousLevel && SERVICE_UPGRADE_TOOLS.has(toolName)) {
        const storedUpgradeStartedAt = Number(metaValue(meta, 'upgradeStartedAt', 'upgrade_started_at') || 0);
        const storedUpgradeTargetLevel = Number(metaValue(meta, 'upgradeTargetLevel', 'upgrade_target_level') || 0);
        if (storedUpgradeStartedAt > 0 && storedUpgradeTargetLevel === safeLevel) {
          let detail = itemDetailCache.get(toolName);
          if (typeof detail === 'undefined') { detail = await ensureItemDetailExists(toolName, null); itemDetailCache.set(toolName, detail || null); }
          const baseUpgradeSeconds = detail ? Math.max(0, Math.round(toFiniteNumber(detail.upgrade_build_time_seconds, 0))) : 0;
          if (baseUpgradeSeconds > 0) {
            const scaledSeconds = baseUpgradeSeconds * Math.pow(2, Math.max(0, safeLevel - 2));
            const elapsedSeconds = (Date.now() - storedUpgradeStartedAt) / 1000;
            if (elapsedSeconds < scaledSeconds * 0.9) safeLevel = previousLevel;
            else { setIfDiff('upgradeStartedAt', null); setIfDiff('upgradeTargetLevel', null); }
          } else { setIfDiff('upgradeStartedAt', null); setIfDiff('upgradeTargetLevel', null); }
        } else if (storedUpgradeStartedAt <= 0) {
          let detail = itemDetailCache.get(toolName);
          if (typeof detail === 'undefined') { detail = await ensureItemDetailExists(toolName, null); itemDetailCache.set(toolName, detail || null); }
          const baseCost = detail ? Math.max(0, Math.round(toFiniteNumber(detail.build_cost, 0))) : 0;
          let totalUpgradeCost = 0;
          for (let lvl = previousLevel; lvl < safeLevel; lvl++) totalUpgradeCost += Math.max(0, Math.round(baseCost * Math.pow(2, lvl)));
          if (totalUpgradeCost > 0) {
            if (currentMoney < totalUpgradeCost) safeLevel = previousLevel;
            else {
              currentMoney = Math.max(0, currentMoney - totalUpgradeCost);
              statsSnapshot = { ...(statsSnapshot || {}), money: currentMoney, total_spent: Math.max(0, Math.round(toFiniteNumber(statsSnapshot.total_spent, 0))) + totalUpgradeCost };
              statsChanged = true;
            }
          }
        } else { safeLevel = previousLevel; }
      }
      if (safeLevel > 0) setIfDiff('level', safeLevel);
    }
    if (typeof pos.population !== 'undefined' && pos.population !== null) setIfDiff('population', Math.max(0, Math.round(Number(pos.population))));
    if (typeof pos.jobs !== 'undefined' && pos.jobs !== null) setIfDiff('jobs', Math.max(0, Math.round(Number(pos.jobs))));
    if (typeof pos.footprint_width !== 'undefined' && pos.footprint_width !== null) setIfDiff('footprintWidth', Math.max(1, Math.round(Number(pos.footprint_width))));
    if (typeof pos.footprint_height !== 'undefined' && pos.footprint_height !== null) setIfDiff('footprintHeight', Math.max(1, Math.round(Number(pos.footprint_height))));
    if (!changed) continue;
    currentVersion += 1;
    await dbPool.query(
      `UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [JSON.stringify(meta), currentVersion, timestamp, now, row.id]
    );
    updated += 1;
  }

  if (statsChanged) {
    await saveRoomStats(municipalityId, roomCode, statsSnapshot);
    const totalCost = originalMoney - currentMoney;
    if (totalCost > 0) {
      await applyMunicipalityTransaction(municipalityId, { amount: -totalCost, type: 'upgrade_cost', meta: { roomCode, positionsProcessed: positions.length }, source: 'system' });
    }
  }
  return { updated, deleted };
}

async function processConstructionSyncAndBroadcast({ municipality, roomCode, positions, io, sourcePlayerId = null }) {
  const result = await markItemsConstructed(municipality.id, roomCode, positions);
  let authoritativeStats = null;
  if (result.updated > 0 || result.deleted > 0) {
    await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
    authoritativeStats = await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);
    const roomKey = wsRoomKey(municipality.slug, roomCode);
    try { await wsPublishAuthoritativeStats(io, roomKey, sourcePlayerId); } catch {}
  }
  return { ...result, authoritativeStats: authoritativeStats ? toStatsApiShape(authoritativeStats) : null };
}

async function wsPublishAuthoritativeStats(io, roomKey, sourcePlayerId = null) {
  const { municipalitySlug, roomCode } = wsParseRoomKey(roomKey);
  const municipality = await getMunicipalityBySlug(municipalitySlug);
  if (!municipality) return false;
  const rawStats = await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);
  const payloadBase = wsMapStatsToRealtimePayload(rawStats || {});
  const prev = wsRoomAuthoritativeStats.get(roomKey);
  const revision = (prev?.revision || 0) + 1;
  const payload = { ...payloadBase, revision, serverTimestamp: Date.now(), sourcePlayerId };
  if (rawStats?._idle_earnings) { payload.idle_earnings = rawStats._idle_earnings; payload.idle_days = rawStats._idle_days || 0; delete rawStats._idle_earnings; delete rawStats._idle_days; }
  if (rawStats?._milestones_awarded) { payload.milestones_awarded = rawStats._milestones_awarded; delete rawStats._milestones_awarded; }
  payload.tax_income = Number(rawStats?.tax_income || 0);
  payload.tax_income_population = Number(rawStats?.tax_income_population || 0);
  payload.tax_income_business = Number(rawStats?.tax_income_business || 0);
  payload.tax_income_property = Number(rawStats?.tax_income_property || 0);
  payload.building_income = Number(rawStats?.building_income || 0);
  payload.company_tax_income = Number(rawStats?.company_tax_income || 0);
  payload.budget_expenses = Number(rawStats?.budget_expenses || 0);
  payload.budget_cost_police = Number(rawStats?.budget_cost_police || 0);
  payload.budget_cost_fire = Number(rawStats?.budget_cost_fire || 0);
  payload.budget_cost_health = Number(rawStats?.budget_cost_health || 0);
  payload.budget_cost_education = Number(rawStats?.budget_cost_education || 0);
  payload.budget_cost_transportation = Number(rawStats?.budget_cost_transportation || 0);
  payload.budget_cost_parks = Number(rawStats?.budget_cost_parks || 0);
  payload.budget_cost_power = Number(rawStats?.budget_cost_power || 0);
  payload.budget_cost_water = Number(rawStats?.budget_cost_water || 0);
  payload.maintenance_expenses = Number(rawStats?.maintenance_expenses || 0);
  payload.administration_base_expenses = Number(rawStats?.administration_base_expenses || 0);
  payload.civic_overhead_expenses = Number(rawStats?.civic_overhead_expenses || 0);
  payload.utility_overhead_expenses = Number(rawStats?.utility_overhead_expenses || 0);
  wsRoomAuthoritativeStats.set(roomKey, { revision, updatedAt: payload.serverTimestamp, stats: payload });
  io.to(roomKey).emit('stats-authoritative', payload);
  return true;
}

module.exports = {
  loginAttempts, registerAttempts, actionAttempts,
  RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS, ACTION_RATE_LIMIT, ACTION_WINDOW_MS,
  checkRateLimit, incrementRateLimit,
  SERVICE_UPGRADE_TOOLS, DEBUG_DISASTER_TYPES, parseManualDisasterIntensity,
  fetchRivers, hasAdjacentWaterForFootprint, canonicalizeJson, jsonEquals,
  markItemsConstructed, processConstructionSyncAndBroadcast, wsPublishAuthoritativeStats,
};
