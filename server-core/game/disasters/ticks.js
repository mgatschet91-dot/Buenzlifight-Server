'use strict';

// Disaster-Tick (Feuer/Erdbeben/Meteor) + Traffic Accidents

const { dbPool, ensureDbEnabled } = require('../../infra/db.js');
const { toJsonValue, jsonEquals, metaValue, normalizeRoomCode, pickRandomRows } = require('../../shared/helpers.js');
const { pushDiscordEvent } = require('../../shared/discord.js');
const {
  canBurnTool, isFireStationTool, isDisasterEnabledInStats,
  DEBUG_DISASTER_TYPES, FIRE_RESPONSE_RANGE_TILES,
} = require('./config.js');

const disasterTickLocks = new Set();

// ── Traffic Accident State ────────────────────────────────────────
const _trafficAccidentState = new Map();
const ACCIDENT_CONFIG = {
  spawnCooldownTicks: 1200, // min. 1h zwischen Unfällen (1200 × 3s)
  spawnChance: 0.15,
  durationTicks: 40,        // 2 Minuten bis Auto-Auflösung
  maxAccidents: 1,
  costLeicht: 350,
  costSchwer: 800,
};

// ── Disaster Tick ─────────────────────────────────────────────────

async function runServerDisasterTick(municipalityId, roomCode, sharedRows) {
  ensureDbEnabled();
  const { loadRoomStats, getRoomItemRows, getRoomItemVersion } = require('../rooms.js');
  const { getMunicipalityById } = require('../municipality');
  const { refreshGameDataMapFromItems } = require('../map.js');

  const lockKey = `${municipalityId}:${normalizeRoomCode(roomCode)}`;
  if (disasterTickLocks.has(lockKey)) return { updated: 0, deleted: 0, changes: [] };
  disasterTickLocks.add(lockKey);

  try {
    const nowMs = Date.now();
    const stats = await loadRoomStats(municipalityId, roomCode);
    if (!isDisasterEnabledInStats(stats)) return { updated: 0, deleted: 0, changes: [] };

    const rows = sharedRows || await getRoomItemRows(municipalityId, roomCode);
    if (!rows.length) return { updated: 0, deleted: 0, changes: [] };

    const furniHealMutations = [];
    for (const row of rows) {
      if (row.action_type !== 'place') continue;
      const t = String(row.tool || '').trim().toLowerCase();
      if (!(t === 'furni' || t.startsWith('furni_'))) continue;
      const meta = toJsonValue(row.metadata) || {};
      if (meta.onFire) furniHealMutations.push({ type: 'update', row, meta: { ...meta, onFire: false, fireProgress: 0 } });
    }

    const placeRows = rows.filter(row => row.action_type === 'place' && canBurnTool(row.tool));
    if (!placeRows.length && !furniHealMutations.length) return { updated: 0, deleted: 0, changes: [] };

    const allPlaceRows = rows.filter(row => row.action_type === 'place');
    const activeFireStations = [];
    for (const row of allPlaceRows) {
      if (!isFireStationTool(row.tool)) continue;
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent || meta.abandoned === true || meta.onFire === true) continue;
      const constructionProgress = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 100);
      if (!(constructionProgress >= 100 || meta.constructed === true)) continue;
      activeFireStations.push({ x: Number(row.x), y: Number(row.y), level: Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1)))) });
    }

    const mapData = stats && typeof stats.game_map_data === 'object' ? stats.game_map_data : null;
    const fireFunding = Math.max(0, Math.min(200, Number(mapData?.budget?.fire?.funding ?? 100)));
    const fireFundingFactor = Math.max(0.35, fireFunding / 100);

    const byPos = new Map();
    for (const row of placeRows) byPos.set(`${Number(row.x)},${Number(row.y)}`, row);

    const currentlyBurning = new Set();
    for (const row of placeRows) {
      const meta = toJsonValue(row.metadata) || {};
      if (!meta.mapPersistent && Boolean(meta.onFire)) currentlyBurning.add(`${Number(row.x)},${Number(row.y)}`);
    }

    const mutations = [...furniHealMutations];
    const hasBurningNeighbor = (x, y) => [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => currentlyBurning.has(`${x+dx},${y+dy}`));

    const getFireResponseAt = (x, y) => {
      let stationsInRange = 0, nearestDistance = Infinity, bestLevel = 1;
      for (const station of activeFireStations) {
        const distance = Math.abs(Number(station.x) - x) + Math.abs(Number(station.y) - y);
        if (distance > FIRE_RESPONSE_RANGE_TILES) continue;
        stationsInRange += 1;
        if (distance < nearestDistance) { nearestDistance = distance; bestLevel = station.level; }
      }
      if (stationsInRange <= 0) return { stationsInRange: 0, nearestDistance: Infinity, distanceFactor: 0, stationStrength: 0, hasCoverage: false };
      const distanceFactor = Math.max(0.05, 1 - nearestDistance / (FIRE_RESPONSE_RANGE_TILES + 1));
      const stationStrength = Math.min(2.5, (0.8 + stationsInRange * 0.35) * (1 + (bestLevel - 1) * 0.12));
      return { stationsInRange, nearestDistance, distanceFactor, stationStrength, hasCoverage: true };
    };

    for (const row of placeRows) {
      const x = Number(row.x), y = Number(row.y);
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent) continue;
      const response = getFireResponseAt(x, y);
      const onFire = Boolean(meta.onFire);
      const fireProgress = Math.max(0, Math.min(100, Math.round(Number(meta.fireProgress || 0))));

      if (onFire) {
        const extinguishChance = response.hasCoverage ? Math.min(0.9, 0.12 + 0.3 * response.distanceFactor * response.stationStrength * fireFundingFactor) : 0;
        if (response.hasCoverage && Math.random() < extinguishChance) { mutations.push({ type: 'update', row, meta: { ...meta, onFire: false, fireProgress: 0 } }); continue; }
        const suppressionFactor = response.hasCoverage ? Math.max(0.2, 1 - response.distanceFactor * response.stationStrength * fireFundingFactor * 0.55) : 1;
        const nextProgress = Math.min(100, fireProgress + Math.max(1, Math.round(2 * suppressionFactor)));
        mutations.push({ type: 'update', row, meta: { ...meta, onFire: nextProgress < 100, fireProgress: nextProgress < 100 ? nextProgress : 0, ...(nextProgress >= 100 ? { abandoned: true } : {}) } });
        continue;
      }

      const startedAtMsFire = row.applied_at ? new Date(row.applied_at).getTime() : Number(row.client_timestamp || 0);
      const fireAgeHours = Number.isFinite(startedAtMsFire) && startedAtMsFire > 0 ? Math.max(0, (Date.now() - startedAtMsFire) / (1000 * 60 * 60)) : 0;
      if (fireAgeHours < 24) continue;

      const baseIgnitionChance = hasBurningNeighbor(x, y) ? 0.012 : 0.0004;
      const preventionFactor = response.hasCoverage ? Math.max(0.08, 1 - response.distanceFactor * response.stationStrength * fireFundingFactor * 0.5) : 1;
      if (Math.random() < baseIgnitionChance * preventionFactor) {
        mutations.push({ type: 'update', row, meta: { ...meta, onFire: true, fireProgress: 0 } });
      }
    }

    if (!mutations.length) return { updated: 0, deleted: 0, changes: [] };

    let currentVersion = await getRoomItemVersion(municipalityId, roomCode);
    const now = new Date(), timestamp = Date.now();
    let updated = 0, deleted = 0;
    const changes = [];

    for (const mutation of mutations) {
      if (mutation.type === 'delete') {
        const [result] = await dbPool.query(`DELETE FROM game_items WHERE id = ?`, [mutation.row.id]);
        if ((result?.affectedRows || 0) > 0) { deleted += 1; changes.push({ x: Number(mutation.row.x), y: Number(mutation.row.y), removed: true }); }
        continue;
      }
      const prevMeta = toJsonValue(mutation.row.metadata) || {};
      if (jsonEquals(prevMeta, mutation.meta || {})) continue;
      currentVersion += 1;
      await dbPool.query(`UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(mutation.meta), currentVersion, timestamp, now, mutation.row.id]);
      updated += 1;
      const nextMeta = mutation.meta || {};
      const change = { x: Number(mutation.row.x), y: Number(mutation.row.y), on_fire: Boolean(nextMeta.onFire), fire_progress: Math.max(0, Math.min(100, Math.round(Number(nextMeta.fireProgress || 0)))) };
      if (nextMeta.abandoned === true) change.abandoned = true;
      changes.push(change);
    }

    if (updated > 0 || deleted > 0) {
      const municipality = await getMunicipalityById(municipalityId);
      if (municipality) await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-disaster-v1');
      const mName = municipality?.name || `Gemeinde #${municipalityId}`;
      const fireCount = changes.filter(c => c.on_fire === true).length;
      if (fireCount > 0) pushDiscordEvent('fire', { municipalityName: mName, roomCode, affectedCount: fireCount, message: `${fireCount} Gebäude brennen in ${mName}!` });
      if (deleted > 0) pushDiscordEvent('disaster', { municipalityName: mName, roomCode, destroyedCount: deleted, message: `${deleted} Gebäude zerstört in ${mName}!` });
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
  const { getRoomItemRows, getRoomItemVersion } = require('../rooms.js');
  const { getMunicipalityById } = require('../municipality');

  const type = String(disasterType || '').trim().toLowerCase();
  if (!DEBUG_DISASTER_TYPES.has(type)) return { updated: 0, deleted: 0, changes: [], error: 'Unknown disaster type' };
  const intensity = parseManualDisasterIntensity(rawIntensity);
  const rows = await getRoomItemRows(municipalityId, roomCode);
  const placeRows = rows.filter(row => row.action_type === 'place');
  if (!placeRows.length) return { updated: 0, deleted: 0, changes: [] };

  const burnableRows = placeRows.filter(row => canBurnTool(row.tool) && !toJsonValue(row.metadata)?.mapPersistent);
  const burningRows = burnableRows.filter(row => Boolean((toJsonValue(row.metadata) || {}).onFire));
  const destructionCandidates = placeRows.filter(row => {
    const tool = String(row.tool || '').trim().toLowerCase();
    if (!tool || tool === 'grass' || tool === 'water' || tool === 'empty' || tool === 'furni' || tool.startsWith('furni_')) return false;
    return !(toJsonValue(row.metadata) || {}).mapPersistent;
  });

  const placeByPos = new Map();
  for (const row of placeRows) placeByPos.set(`${Number(row.x)},${Number(row.y)}`, row);

  const getDistance = (ax, ay, bx, by) => Math.hypot(Number(ax) - Number(bx), Number(ay) - Number(by));
  const isDestructibleTool = (tool) => {
    const t = String(tool || '').trim().toLowerCase();
    if (!t || t === 'grass' || t === 'water' || t === 'road' || t === 'rail' || t === 'bridge' || t === 'empty') return false;
    if (t.startsWith('tree_') || t.startsWith('bush_') || t.startsWith('flower_') || t.startsWith('topiary_')) return false;
    if (t === 'furni' || t.startsWith('furni_')) return false;
    return true;
  };

  const updatesById = new Map(), deletesById = new Map(), meteorRestoreById = new Map();
  const upsertUpdate = (row, nextMeta) => { if (!row?.id || deletesById.has(row.id)) return; updatesById.set(row.id, { row, meta: nextMeta }); };
  const upsertDelete = (row) => { if (!row?.id) return; updatesById.delete(row.id); deletesById.set(row.id, { row }); };
  let disasterMeta = {};

  if (type === 'fire_single') {
    const target = pickRandomRows(burnableRows, 1)[0];
    if (target) upsertUpdate(target, { ...(toJsonValue(target.metadata) || {}), onFire: true, fireProgress: 0 });
  } else if (type === 'fire_cluster') {
    const center = pickRandomRows(burnableRows, 1)[0];
    if (center) {
      const cx = Number(center.x), cy = Number(center.y);
      const radius = intensity >= 4 ? 3 : 2;
      const cluster = burnableRows.filter(row => Math.abs(Number(row.x) - cx) + Math.abs(Number(row.y) - cy) <= radius);
      for (const row of pickRandomRows(cluster, Math.max(3, Math.min(cluster.length, 4 + intensity * 3)))) {
        const prevMeta = toJsonValue(row.metadata) || {};
        upsertUpdate(row, { ...prevMeta, onFire: true, fireProgress: Math.max(0, Math.min(100, Math.round(Number(prevMeta.fireProgress || 0)))) });
      }
    }
  } else if (type === 'fire_storm') {
    for (const row of pickRandomRows(burnableRows, Math.max(5, Math.min(burnableRows.length, 6 + intensity * 5)))) {
      const prevMeta = toJsonValue(row.metadata) || {};
      upsertUpdate(row, { ...prevMeta, onFire: true, fireProgress: Math.max(0, Math.min(100, Math.round(Number(prevMeta.fireProgress || 0)))) });
    }
  } else if (type === 'earthquake') {
    for (const row of pickRandomRows(destructionCandidates, Math.max(1, Math.min(destructionCandidates.length, 1 + intensity * 2)))) upsertDelete(row);
  } else if (type === 'meteor') {
    const desiredX = Number(targetTile?.x), desiredY = Number(targetTile?.y);
    const impactTile = Number.isFinite(desiredX) && Number.isFinite(desiredY) ? placeByPos.get(`${Math.round(desiredX)},${Math.round(desiredY)}`) || null : pickRandomRows(placeRows.filter(r => String(r.tool || '').trim().toLowerCase() !== 'water'), 1)[0] || null;
    if (impactTile) {
      const impactX = Number(impactTile.x), impactY = Number(impactTile.y);
      const radius = Math.max(2, Math.min(6, 2 + Math.floor(intensity / 2) + 1));
      const impactRows = [];
      for (let y = impactY - radius; y <= impactY + radius; y++) {
        for (let x = impactX - radius; x <= impactX + radius; x++) {
          const distance = getDistance(x, y, impactX, impactY);
          if (distance > radius + 0.15) continue;
          const row = placeByPos.get(`${x},${y}`);
          if (row) impactRows.push({ row, distance });
        }
      }
      for (const { row, distance } of impactRows) {
        const normalized = Math.max(0, 1 - distance / Math.max(1, radius));
        const prevMeta = toJsonValue(row.metadata) || {};
        const prevElevation = Math.max(0, Math.round(Number(metaValue(prevMeta, 'elevation') || 0)));
        const depression = Math.max(1, Math.round(4 * normalized));
        const nextElevation = Math.max(0, prevElevation - depression);
        const nextMeta = { ...prevMeta, elevation: nextElevation, meteorDamagedAt: Date.now() };
        if (nextElevation !== prevElevation) meteorRestoreById.set(Number(row.id), { id: Number(row.id), x: Number(row.x), y: Number(row.y), restore_elevation: prevElevation });
        const tool = String(row.tool || '').trim().toLowerCase();
        if (!prevMeta.mapPersistent && isDestructibleTool(tool) && Math.random() < Math.max(0, Math.min(0.92, (0.18 + intensity * 0.08) * normalized))) { upsertDelete(row); continue; }
        if (!prevMeta.mapPersistent && canBurnTool(tool) && normalized >= 0.35) { nextMeta.onFire = true; nextMeta.fireProgress = Math.max(0, Math.min(100, Math.round(Number(prevMeta.fireProgress || 0) + (8 + intensity * 3) * normalized))); }
        upsertUpdate(row, nextMeta);
      }
      disasterMeta = { impact_x: impactX, impact_y: impactY, impact_radius: radius };
    }
  } else if (type === 'extinguish_all') {
    for (const row of burningRows) upsertUpdate(row, { ...(toJsonValue(row.metadata) || {}), onFire: false, fireProgress: 0 });
  }

  if (updatesById.size === 0 && deletesById.size === 0) return { updated: 0, deleted: 0, changes: [] };

  let currentVersion = await getRoomItemVersion(municipalityId, roomCode);
  const now = new Date(), timestamp = Date.now();
  let updated = 0, deleted = 0;
  const changes = [];

  for (const mutation of deletesById.values()) {
    const [result] = await dbPool.query(`DELETE FROM game_items WHERE id = ?`, [mutation.row.id]);
    if ((result?.affectedRows || 0) > 0) { deleted += 1; changes.push({ x: Number(mutation.row.x), y: Number(mutation.row.y), removed: true, elevation: 0 }); }
  }
  for (const mutation of updatesById.values()) {
    const prevMeta = toJsonValue(mutation.row.metadata) || {};
    if (jsonEquals(prevMeta, mutation.meta || {})) continue;
    currentVersion += 1;
    await dbPool.query(`UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(mutation.meta), currentVersion, timestamp, now, mutation.row.id]);
    updated += 1;
    const nextMeta = mutation.meta || {};
    changes.push({ x: Number(mutation.row.x), y: Number(mutation.row.y), on_fire: Boolean(nextMeta.onFire), fire_progress: Math.max(0, Math.min(100, Math.round(Number(nextMeta.fireProgress || 0)))), elevation: Math.max(0, Math.round(Number(metaValue(nextMeta, 'elevation') || 0))) });
  }

  if (updated > 0 || deleted > 0) {
    const municipality = await getMunicipalityById(municipalityId);
    if (municipality) { const { refreshGameDataMapFromItems } = require('../map.js'); await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-disaster-debug'); }
  }

  return { updated, deleted, changes, disasterType: type, intensity, meteor_restore_entries: Array.from(meteorRestoreById.values()), ...disasterMeta };
}

// ── Traffic Accidents ─────────────────────────────────────────────

async function runServerTrafficAccidentTick(municipalityId, roomCode, sharedRows) {
  const lockKey = `${municipalityId}:${normalizeRoomCode(roomCode)}`;
  if (!_trafficAccidentState.has(lockKey)) {
    _trafficAccidentState.set(lockKey, { accidents: new Map(), nextId: 1, lastSpawnTick: -999, tickCount: 0 });
  }
  const roomState = _trafficAccidentState.get(lockKey);
  roomState.tickCount++;

  const newAccidents = [], resolvedAccidents = [];

  for (const [id, acc] of roomState.accidents.entries()) {
    acc.ticksAlive++;
    if (acc.ticksAlive >= ACCIDENT_CONFIG.durationTicks) {
      roomState.accidents.delete(id);
      resolvedAccidents.push({ id, x: acc.x, y: acc.y });
    }
  }

  const cooldownOk = (roomState.tickCount - roomState.lastSpawnTick) >= ACCIDENT_CONFIG.spawnCooldownTicks;
  const belowMax = roomState.accidents.size < ACCIDENT_CONFIG.maxAccidents;
  if (cooldownOk && belowMax && Math.random() < ACCIDENT_CONFIG.spawnChance) {
    const roadTiles = sharedRows.filter(r => { const t = String(r.tool || '').toLowerCase(); return t === 'road' || t === 'bridge'; }).map(r => ({ x: Number(r.x), y: Number(r.y) }));
    if (roadTiles.length > 0) {
      const tile = roadTiles[Math.floor(Math.random() * roadTiles.length)];
      const id = roomState.nextId++;
      const severity = Math.random() < 0.25 ? 'schwer' : 'leicht';
      const cost = severity === 'schwer' ? ACCIDENT_CONFIG.costSchwer : ACCIDENT_CONFIG.costLeicht;
      roomState.accidents.set(id, { id, x: tile.x, y: tile.y, ticksAlive: 0, severity, cost });
      roomState.lastSpawnTick = roomState.tickCount;
      newAccidents.push({ id, x: tile.x, y: tile.y, severity, cost });
      try {
        const { applyMunicipalityTransaction } = require('../bank.js');
        await applyMunicipalityTransaction(municipalityId, { amount: -cost, type: 'accident_cost', description: `Verkehrsunfall (${severity}): Rettungseinsatz & Bergung`, allowOverdraft: true, source: 'system' });
      } catch (_) {}
    }
  }

  return { accidents: Array.from(roomState.accidents.values()), newAccidents, resolvedAccidents };
}

function clearTrafficAccidentState(municipalityId, roomCode) {
  _trafficAccidentState.delete(`${municipalityId}:${normalizeRoomCode(roomCode)}`);
}

module.exports = {
  runServerDisasterTick,
  triggerManualDisaster,
  runServerTrafficAccidentTick,
  clearTrafficAccidentState,
};
