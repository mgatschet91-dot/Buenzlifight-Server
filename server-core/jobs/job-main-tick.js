'use strict';

// Job 3: 3s Authoritative Haupt-Tick
// Stats, Disasters, Building-Upgrades, Zone-Growth, Woodcutter, Crime, NPCs

const { logError } = require('../infra/logger.js');
const { _getCachedRoomItems, invalidateRoomItemsCache, buildBroadcastToRoom } = require('./cache.js');

// Maximal gleichzeitig bearbeitete Rooms (verhindert DB-Pool-Überlastung)
const MAX_CONCURRENT_ROOMS = 6;

async function runRoomTick(key, entry, deps, helpers) {
  const { rooms, disasters, stats, io, wsHelpers, getBuenzli, getCitizens, getPartyEvents, getParkingSystem } = helpers;
  const { roomCode, municipalityId, municipalitySlug } = entry;
  if (!municipalitySlug) return;

  const roomKey  = wsHelpers.wsRoomKey(municipalitySlug, roomCode);
  const sharedRows = await _getCachedRoomItems(rooms, municipalityId, roomCode);

  // --- Batch 1: Stats + ActiveParties parallel (unabhängig voneinander) ---
  const [rawStats, activeParties] = await Promise.all([
    stats.recomputeAuthoritativePopulationAndJobs(municipalityId, roomCode, sharedRows, {
      crimeCount: entry._lastCrimeCount || 0,
    }),
    getPartyEvents().getActivePartiesForRoom(roomCode).catch(() => []),
  ]);

  const upgradeContext = {
    landValueGrid:        rawStats?._landValueGrid || null,
    serviceCoverageGrids: rawStats?._serviceCoverageGrids || null,
  };
  const crimeContext = {
    serviceCoverageGrids: rawStats?._serviceCoverageGrids || null,
    landValueGrid:        rawStats?._landValueGrid || null,
    stats: rawStats || {},
    activeParties,
  };

  // --- Batch 2: Alle Ticks parallel (alle brauchen rawStats, keine Abhängigkeit untereinander) ---
  const [disasterResult, upgradeResult, zoneGrowthResult, woodcutterResult, crimeResult, accidentResult] = await Promise.all([
    disasters.runServerDisasterTick(municipalityId, roomCode, sharedRows),
    disasters.runServerBuildingUpgradeTick(municipalityId, roomCode, sharedRows, upgradeContext),
    disasters.runServerZoneGrowthTick(municipalityId, roomCode, sharedRows, upgradeContext),
    disasters.runServerWoodcutterTick(municipalityId, roomCode, sharedRows),
    disasters.runServerCrimeTick(municipalityId, roomCode, sharedRows, crimeContext),
    disasters.runServerTrafficAccidentTick(municipalityId, roomCode, sharedRows).catch(() => ({ newAccidents: [], resolvedAccidents: [], accidents: [] })),
  ]);

  entry._lastCrimeCount = crimeResult?.criminals?.length || 0;

  if (!io) return;

  const now = Date.now();

  // Stats broadcast
  const payload  = wsHelpers.wsMapStatsToRealtimePayload(rawStats || {});
  const revision = (entry._authRevision || 0) + 1;
  entry._authRevision = revision;
  io.to(roomKey).emit('stats-authoritative', { ...payload, revision, serverTimestamp: now });

  // Disasters
  if (disasterResult?.changes?.length > 0) {
    io.to(roomKey).emit('disasters-authoritative', { changes: disasterResult.changes, serverTimestamp: now });
  }

  // Building changes (upgrades + zone growth + woodcutter)
  const buildingChanges = [
    ...(upgradeResult?.changes || []),
    ...(zoneGrowthResult?.changes || []),
    ...(woodcutterResult?.changes || []),
  ];
  if (buildingChanges.length > 0) {
    invalidateRoomItemsCache(municipalityId, roomCode);
    io.to(roomKey).emit('buildings-authoritative', { changes: buildingChanges, serverTimestamp: now });
  }

  // Traffic accidents
  if (accidentResult.newAccidents.length > 0 || accidentResult.resolvedAccidents.length > 0 || accidentResult.accidents.length > 0) {
    io.to(roomKey).emit('traffic-accident-authoritative', {
      accidents:         accidentResult.accidents,
      newAccidents:      accidentResult.newAccidents,
      resolvedAccidents: accidentResult.resolvedAccidents,
      serverTimestamp:   now,
    });
  }

  // Crime NPCs
  const hasActiveCrime = crimeResult && (crimeResult.criminals?.length > 0 || crimeResult.crimeEvents?.length > 0);
  const homelessCount  = crimeResult?.homeless || 0;
  if (hasActiveCrime || homelessCount > 0) {
    const crimePayload = {
      criminals:   crimeResult?.criminals || [],
      crimeEvents: crimeResult?.crimeEvents || [],
      crimeGrid:   null,
      gridSize:    crimeResult?.gridSize || 0,
      homeless:    homelessCount,
      isNight:     crimeResult?.isNight || false,
      serverTimestamp: now,
    };
    const canSendCrimeGrid = !entry._lastCrimeGridBroadcast || (now - entry._lastCrimeGridBroadcast) >= 15000;
    if (canSendCrimeGrid && crimeResult.crimeGrid && crimeResult.gridSize > 0) {
      const sz = crimeResult.gridSize;
      const flatCrime = new Array(sz * sz);
      for (let gy = 0; gy < sz; gy++) {
        const row = crimeResult.crimeGrid[gy];
        for (let gx = 0; gx < sz; gx++) flatCrime[gy * sz + gx] = Math.round(row[gx] || 0);
      }
      crimePayload.crimeGrid = flatCrime;
      entry._lastCrimeGridBroadcast = now;
    }
    io.to(roomKey).emit('criminals-authoritative', crimePayload);
  }

  // Ausnahmezustand: gecacht (30s TTL — 2 DB-Queries pro Tick gespart)
  const EMERG_TTL = 30000;
  if (!entry._emergencyCache || (now - entry._emergencyCache.ts) >= EMERG_TTL) {
    try {
      const { dbPool } = require('../infra/db');
      const [[emergRows], [relRows]] = await Promise.all([
        dbPool.query(`SELECT is_active, ends_at FROM municipality_emergency WHERE municipality_id = ? LIMIT 1`, [municipalityId]),
        dbPool.query(`SELECT MAX(tension_score) AS max_tension FROM municipality_relations WHERE municipality_a = ? OR municipality_b = ?`, [municipalityId, municipalityId]),
      ]);
      const emerg      = emergRows[0] || null;
      const maxTension = Number(relRows[0]?.max_tension || 0);
      entry._emergencyCache = {
        ts: now,
        isActive:     emerg?.is_active === 1,
        endsAt:       emerg?.ends_at || null,
        maxTension,
        protestCount: emerg?.is_active === 1 ? Math.min(5, Math.floor(maxTension / 20)) : 0,
      };
    } catch (_) {
      entry._emergencyCache = entry._emergencyCache || { ts: now, isActive: false, endsAt: null, maxTension: 0, protestCount: 0 };
    }
  }
  io.to(roomKey).emit('emergency-authoritative', { ...entry._emergencyCache, serverTimestamp: now });

  // Büenzli NPCs
  try {
    const buenzliNpcs = await getBuenzli().getBuenzliNpcPositions(municipalityId, roomCode);
    if (buenzliNpcs.length > 0) io.to(roomKey).emit('buenzli-npc-authoritative', { npcs: buenzliNpcs });
  } catch (buenzliErr) {
    logError('INTERVAL', `Buenzli NPC tick error for ${key}`, { error: buenzliErr?.message });
  }

  // Kontrolleur NPCs
  try {
    const parkSys   = getParkingSystem();
    const broadcast = buildBroadcastToRoom(io);
    await parkSys.tickKontrolleurNpcs(broadcast);
    const kNpcs = parkSys.getKontrolleurNpcStates(municipalityId, roomCode);
    io.to(roomKey).emit('kontrolleur-npc-authoritative', { npcs: kNpcs, serverTimestamp: now });
  } catch (kErr) {
    logError('INTERVAL', `Kontrolleur NPC tick error for ${key}`, { error: kErr?.message });
  }

  // Citizens (Pendler): nur bei Stundenwechsel oder alle 30s neu laden (ändert sich kaum)
  try {
    const hour = new Date().getHours();
    const citizensStale = entry._lastCitizensHour !== hour ||
      !entry._lastCitizensBroadcastTs ||
      (now - entry._lastCitizensBroadcastTs) >= 30000;
    if (citizensStale) {
      const activeCitizens = await getCitizens().getActiveCitizensForBroadcast(municipalityId, hour);
      entry._lastCitizensHour       = hour;
      entry._lastCitizensBroadcastTs = now;
      if (activeCitizens.length > 0) io.to(roomKey).emit('citizens-authoritative', { citizens: activeCitizens, serverTimestamp: now });
    }
  } catch (citErr) {
    logError('INTERVAL', `Citizens tick error for ${key}`, { error: citErr?.message });
  }

  // Party-Tick
  try {
    await getPartyEvents().runPartyTick(roomKey, io, entry.roomCode);
  } catch (partyErr) {
    logError('INTERVAL', `Party tick error for ${key}`, { error: partyErr?.message });
  }

  // Werkhof-Status
  const werkhofStatus = rawStats?._werkhofStatus;
  if (werkhofStatus) io.to(roomKey).emit('werkhof-status', { ...werkhofStatus, serverTimestamp: now });

  // LandValue-Grid (throttled 15s)
  const lvGrid = rawStats?._landValueGrid;
  if (lvGrid && Array.isArray(lvGrid) && lvGrid.length > 0) {
    const canSendLv = !entry._lastLvGridBroadcast || (now - entry._lastLvGridBroadcast) >= 15000;
    if (canSendLv) {
      const gridSize   = lvGrid.length;
      const flatValues = new Array(gridSize * gridSize);
      let checksum     = 0;
      for (let gy = 0; gy < gridSize; gy++) {
        const row = lvGrid[gy];
        for (let gx = 0; gx < gridSize; gx++) {
          const v = Math.round(row[gx] || 0);
          flatValues[gy * gridSize + gx] = v;
          checksum = (checksum + v * (gy * gridSize + gx + 1)) | 0;
        }
      }
      if (checksum !== (entry._lvChecksum || 0)) {
        entry._lvChecksum = checksum;
        entry._lastLvGridBroadcast = now;
        io.to(roomKey).emit('landvalue-authoritative', { gridSize, values: flatValues, serverTimestamp: now });
      }
    }
  }
}

module.exports = function registerMainTickJob(deps) {
  const wsHelpers      = require('../ws/socketio/helpers');
  const getRooms       = () => require('../game/rooms');
  const getDisasters   = () => require('../game/disasters');
  const getStats       = () => require('../game/stats');
  const getBuenzli     = () => require('../game/buenzli');
  const getCitizens    = () => require('../game/citizens');
  const getPartyEvents = () => require('../game/partyEvents');
  const getParkingSystem = () => require('../game/parkingSystem');

  let _mainTickRunning = false;

  const mainTickInterval = setInterval(async () => {
    if (_mainTickRunning) {
      logError('INTERVAL', '3s-Haupttick übersprungen — vorheriger Tick läuft noch (Server überlastet?)');
      return;
    }
    _mainTickRunning = true;
    const _tickStart = Date.now();

    try {
      const rooms     = getRooms();
      const disasters = getDisasters();
      const stats     = getStats();
      const io        = deps?.io;

      // Aktive Rooms sammeln
      const activeEntries = [];
      for (const [key, entry] of rooms.roomRuntimeCache.entries()) {
        if (entry.activePlayers > 0 && entry.municipalitySlug) {
          activeEntries.push({ key, entry });
        }
      }

      if (activeEntries.length === 0) return;

      const helpers = { rooms, disasters, stats, io, wsHelpers, getBuenzli, getCitizens, getPartyEvents, getParkingSystem };

      // Rooms parallel mit Concurrency-Limit verarbeiten
      const concurrency = Math.min(MAX_CONCURRENT_ROOMS, activeEntries.length);
      const chunks = [];
      for (let i = 0; i < activeEntries.length; i += concurrency) {
        chunks.push(activeEntries.slice(i, i + concurrency));
      }
      for (const chunk of chunks) {
        await Promise.all(
          chunk.map(({ key, entry }) =>
            runRoomTick(key, entry, deps, helpers).catch(err =>
              logError('INTERVAL', `Room tick error for ${key}`, { error: err?.message })
            )
          )
        );
      }
    } catch (err) {
      logError('INTERVAL', 'Stats/disaster tick error', { error: err?.message });
    } finally {
      _mainTickRunning = false;
      const elapsed = Date.now() - _tickStart;
      if (elapsed > 2500) logError('INTERVAL', `3s-Haupttick zu langsam: ${elapsed}ms (Limit: 2500ms)`);
    }
  }, 3000);

  return [mainTickInterval];
};
