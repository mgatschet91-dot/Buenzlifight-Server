'use strict';

const { SERVICE_LEVEL_CONFIG } = require('../../config/constants.js');
const { toJsonValue, metaValue, normalizeRoomCode } = require('../../shared/helpers.js');
const { buildRoomGrid } = require('./config.js');

const crimeTickLocks = new Set();

// Pro Room: Map<lockKey, { criminals, nextId, tickCount, lastSpawnTick }>
const crimeRoomState = new Map();

const CRIME_CONFIG = {
  maxCriminalsPerRoom: 3,
  spawnCooldownTicks: 15,
  spawnChancePerTick: 0.006,
  maxSpawnsPerTick: 1,
  policeCoverageThreshold: 25,
  burglaryNightStartHour: 21,
  burglaryNightEndHour: 5,
  burglaryAmountPerTick: 2,
  policeNoticeDelayTicks: 4,
  policeChaseRadius: 20,
  chaseDurationTicks: 6,
  catchChanceGangster: 0.65,
  catchChanceDealer: 0.50,
  catchRewardXp: 10,
  catchRewardMoney: 50,
  crimeRadiusTiles: 3,
  crimeValuePerTick: 3,
  maxCrimeValue: 100,
  despawnAfterTicks: 30,
  warmupTicks: 5,
};

async function runServerCrimeTick(municipalityId, roomCode, sharedRows, context) {
  const { logInfo } = require('../../infra/logger.js');
  const { applyMunicipalityTransaction } = require('../bank.js');

  const safeRoomCode = normalizeRoomCode(roomCode);
  const lockKey = `${municipalityId}:${safeRoomCode}`;
  if (crimeTickLocks.has(lockKey)) return { criminals: [], crimeEvents: [], stolenTotal: 0 };
  crimeTickLocks.add(lockKey);

  try {
    const rows = sharedRows || [];
    if (!rows.length) return { criminals: [], crimeEvents: [], stolenTotal: 0 };

    if (!crimeRoomState.has(lockKey)) {
      crimeRoomState.set(lockKey, { criminals: new Map(), nextId: 1, tickCount: 0, lastSpawnTick: -CRIME_CONFIG.spawnCooldownTicks });
    }
    const roomState = crimeRoomState.get(lockKey);
    const { criminals } = roomState;
    roomState.tickCount += 1;

    const policeCoverageGrid = context?.serviceCoverageGrids?.police || null;
    const gridSize = policeCoverageGrid ? policeCoverageGrid.length : 0;
    const homeless = Math.max(0, Number(context?.stats?.homeless ?? 0));
    const currentHour = new Date().getHours();
    const isNight = currentHour >= CRIME_CONFIG.burglaryNightStartHour || currentHour < CRIME_CONFIG.burglaryNightEndHour;

    const grid = buildRoomGrid(rows);

    // Polizei-Stationen finden
    const policeStations = [];
    for (const row of rows) {
      if (row.action_type !== 'place') continue;
      const t = String(row.tool || '').toLowerCase();
      if (t !== 'police_station') continue;
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent || meta.abandoned === true) continue;
      const cp = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 100);
      if (!(cp >= 100 || meta.constructed === true)) continue;
      policeStations.push({ x: Number(row.x), y: Number(row.y), level: Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1)))) });
    }

    // Dynamische Werte basierend auf Budget, Arbeitslosigkeit, Unzufriedenheit
    const policeFunding = Number(context?.stats?.game_map_data?.budget?.police?.funding ?? context?.stats?.budget?.police?.funding ?? 100);
    const fundingFactor = Math.max(0, (100 - policeFunding) / 100);
    const unemploymentRate = Math.max(0, Number(context?.stats?.unemployment_rate ?? 0));
    const happiness = Math.max(0, Math.min(100, Number(context?.stats?.happiness ?? 100)));
    const unemploymentCrimeFactor = Math.min(3, Math.max(0, (unemploymentRate - 10) / 10) * 0.5);
    const unhappinessCrimeFactor = happiness < 40 ? (40 - happiness) / 40 * 1.5 : 0;

    const isEvening = currentHour >= 18;
    const eveningParties = isEvening ? (context?.activeParties || []).filter(p => p.status !== 'shutdown' && p.status !== 'ended') : [];
    const partyMaxBoost   = eveningParties.length * 2;
    const partySpawnBoost = eveningParties.length * 1.0;

    const dynamicMaxCriminals = Math.round(CRIME_CONFIG.maxCriminalsPerRoom + fundingFactor * 3 + unemploymentCrimeFactor + partyMaxBoost);
    const dynamicSpawnChance = CRIME_CONFIG.spawnChancePerTick * (1 + fundingFactor * 1.5 + unhappinessCrimeFactor + partySpawnBoost);
    const crimeEvents = [];
    const canSpawn = criminals.size < dynamicMaxCriminals
      && (roomState.tickCount - roomState.lastSpawnTick) >= CRIME_CONFIG.spawnCooldownTicks
      && roomState.tickCount >= CRIME_CONFIG.warmupTicks;

    // Spawn-Kandidaten
    if (canSpawn && policeCoverageGrid && gridSize > 0) {
      const spawnCandidates = [];
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          const coverage = policeCoverageGrid[y]?.[x] ?? 100;
          if (coverage >= CRIME_CONFIG.policeCoverageThreshold) continue;
          const cell = grid.get(`${x},${y}`);
          if (!cell) continue;
          const cellTool = String(cell.tool || '').toLowerCase();
          if (!cellTool || cellTool === 'grass' || cellTool === 'water' || cellTool === 'road' || cellTool === 'rail' || cellTool === 'bridge' || cellTool === 'empty' || cellTool.startsWith('tree') || cellTool.startsWith('bush_') || cellTool.startsWith('flower_') || cellTool.startsWith('topiary_') || cellTool.startsWith('zone_') || cellTool.startsWith('terrain_') || cellTool.startsWith('paint_')) continue;
          let occupied = false;
          for (const c of criminals.values()) { if (c.x === x && c.y === y) { occupied = true; break; } }
          if (occupied) continue;
          const meta = toJsonValue(cell.metadata) || {};
          let spawnWeight = meta.abandoned === true ? 3 : (meta.onFire === true ? 2 : 1);
          const PARTY_CRIME_RADIUS = 6;
          for (const party of eveningParties) {
            if (Math.abs(x - party.tileX) <= PARTY_CRIME_RADIUS && Math.abs(y - party.tileY) <= PARTY_CRIME_RADIUS) { spawnWeight *= 3; break; }
          }
          const coverageFactor = Math.max(0.2, 1 - coverage / CRIME_CONFIG.policeCoverageThreshold);
          spawnCandidates.push({ x, y, spawnWeight, coverageFactor, isAbandoned: meta.abandoned === true });
        }
      }

      if (spawnCandidates.length > 0) {
        spawnCandidates.sort((a, b) => b.spawnWeight * b.coverageFactor - a.spawnWeight * a.coverageFactor);
        let spawned = 0;
        for (const cand of spawnCandidates) {
          if (spawned >= CRIME_CONFIG.maxSpawnsPerTick || criminals.size >= dynamicMaxCriminals) break;
          if (Math.random() >= dynamicSpawnChance * cand.spawnWeight * cand.coverageFactor) continue;
          const criminalId = roomState.nextId++;
          const isDealer = homeless > 0 && Math.random() < 0.4;
          criminals.set(criminalId, { id: criminalId, x: cand.x, y: cand.y, state: isDealer ? 'dealing' : 'loitering', ticksAlive: 0, ticksChased: 0, beingChased: false, chasingPoliceStation: null, stolenTotal: 0, isDealer });
          roomState.lastSpawnTick = roomState.tickCount;
          spawned++;
          crimeEvents.push({ type: 'spawn', id: criminalId, x: cand.x, y: cand.y, isDealer });
        }
      }
    }

    // Bestehende Gangster updaten
    let stolenTotal = 0;
    const toRemove = [];

    for (const [id, criminal] of criminals.entries()) {
      criminal.ticksAlive += 1;

      if (criminal.ticksAlive >= CRIME_CONFIG.despawnAfterTicks) {
        toRemove.push(id);
        crimeEvents.push({ type: 'despawn', id, x: criminal.x, y: criminal.y, reason: 'timeout' });
        continue;
      }

      if (isNight && !criminal.beingChased) {
        criminal.stolenTotal += CRIME_CONFIG.burglaryAmountPerTick;
        stolenTotal += CRIME_CONFIG.burglaryAmountPerTick;
        if (criminal.state !== 'fleeing') criminal.state = 'burglary';
      } else if (!criminal.beingChased && criminal.state === 'burglary') {
        criminal.state = criminal.isDealer ? 'dealing' : 'loitering';
      }

      if (!criminal.beingChased) {
        let nearestStation = null, nearestDist = Infinity;
        for (const station of policeStations) {
          const stationChaseRadius = SERVICE_LEVEL_CONFIG.policeChaseRadiusBase + (station.level - 1) * SERVICE_LEVEL_CONFIG.policeChaseRadiusPerLevel;
          const dist = Math.abs(station.x - criminal.x) + Math.abs(station.y - criminal.y);
          if (dist <= stationChaseRadius && dist < nearestDist) { nearestDist = dist; nearestStation = station; }
        }
        const stationLevel = nearestStation ? nearestStation.level : 1;
        const noticeDelay = Math.max(SERVICE_LEVEL_CONFIG.policeNoticeDelayMin, Math.round(SERVICE_LEVEL_CONFIG.policeNoticeDelayBase - (stationLevel - 1) * SERVICE_LEVEL_CONFIG.policeNoticeDelayReduction));
        if (nearestStation && criminal.ticksAlive >= noticeDelay) {
          criminal.beingChased = true; criminal.chasingPoliceStation = nearestStation; criminal.state = 'fleeing';
          crimeEvents.push({ type: 'chase_start', id, x: criminal.x, y: criminal.y, policeX: nearestStation.x, policeY: nearestStation.y });
          logInfo('CRIME', `Polizei L${stationLevel} jagt ${criminal.isDealer ? 'Dealer' : 'Gangster'} #${id} von Station (${nearestStation.x},${nearestStation.y})`);
        }
      }

      if (criminal.beingChased) {
        criminal.ticksChased += 1;
        if (criminal.ticksChased >= CRIME_CONFIG.chaseDurationTicks) {
          const chasingLevel = criminal.chasingPoliceStation?.level || 1;
          const baseCatch = criminal.isDealer ? CRIME_CONFIG.catchChanceDealer : CRIME_CONFIG.catchChanceGangster;
          const catchChance = Math.min(SERVICE_LEVEL_CONFIG.policeCatchMax, baseCatch + (chasingLevel - 1) * SERVICE_LEVEL_CONFIG.policeCatchBonusPerLevel);
          toRemove.push(id);
          crimeEvents.push(Math.random() < catchChance
            ? { type: 'caught', id, x: criminal.x, y: criminal.y, stolenTotal: criminal.stolenTotal }
            : { type: 'escaped', id, x: criminal.x, y: criminal.y }
          );
        }
      }

      if (!criminal.beingChased && criminal.ticksAlive % 4 === 0) {
        criminal.x = Math.max(0, Math.min(gridSize - 1, criminal.x + Math.floor(Math.random() * 3) - 1));
        criminal.y = Math.max(0, Math.min(gridSize - 1, criminal.y + Math.floor(Math.random() * 3) - 1));
      }
    }

    // Gefasste/despawnte entfernen + Belohnungen
    for (const id of toRemove) {
      const criminal = criminals.get(id);
      if (criminal && crimeEvents.find(e => e.type === 'caught' && e.id === id)) {
        await applyMunicipalityTransaction(municipalityId, { amount: CRIME_CONFIG.catchRewardMoney, type: 'crime_catch_reward', meta: { roomCode: safeRoomCode, criminalId: id }, source: 'system' }).catch(() => {});
      }
      criminals.delete(id);
    }

    if (stolenTotal > 0) {
      await applyMunicipalityTransaction(municipalityId, { amount: -stolenTotal, type: 'crime_burglary', meta: { roomCode: safeRoomCode, criminals: criminals.size, stolen: stolenTotal, night: isNight }, source: 'system' }).catch(() => {});
    }

    // Crime-Grid berechnen
    let crimeGrid = null;
    if (gridSize > 0 && criminals.size > 0) {
      crimeGrid = Array.from({ length: gridSize }, () => Array(gridSize).fill(0));
      for (const criminal of criminals.values()) {
        const radius = CRIME_CONFIG.crimeRadiusTiles;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const tx = criminal.x + dx, ty = criminal.y + dy;
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

    const criminalsList = [];
    for (const criminal of criminals.values()) {
      criminalsList.push({ id: criminal.id, x: criminal.x, y: criminal.y, state: criminal.state, isDealer: criminal.isDealer, beingChased: criminal.beingChased, policeX: criminal.chasingPoliceStation?.x ?? null, policeY: criminal.chasingPoliceStation?.y ?? null, ticksAlive: criminal.ticksAlive });
    }

    return { criminals: criminalsList, crimeEvents, stolenTotal, crimeGrid, gridSize, homeless, isNight };
  } finally {
    crimeTickLocks.delete(lockKey);
  }
}

function clearCrimeState(municipalityId, roomCode) {
  crimeRoomState.delete(`${municipalityId}:${normalizeRoomCode(roomCode)}`);
}

module.exports = { runServerCrimeTick, clearCrimeState };
