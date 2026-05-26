'use strict';

const { logInfo, logError } = require('../infra/logger.js');
const { BUENZLI_EVENT_CHECK_INTERVAL_MS, ROOM_CACHE_FLUSH_INTERVAL_MS } = require('../config/constants.js');

// ── Room-Items-Cache ─────────────────────────────────────────────────────────
// Verhindert, dass jede 3s-Tick-Runde alle game_items neu aus der DB lädt.
// TTL: 10 Sekunden. Invalidierung via invalidateRoomItemsCache() bei Mutation.
const _roomItemsCache = new Map(); // `${municipalityId}:${roomCode}` → { rows, cachedAt }
const ROOM_ITEMS_CACHE_TTL_MS = 10_000;

async function _getCachedRoomItems(rooms, municipalityId, roomCode) {
  const key = `${municipalityId}:${roomCode}`;
  const cached = _roomItemsCache.get(key);
  if (cached && (Date.now() - cached.cachedAt) < ROOM_ITEMS_CACHE_TTL_MS) {
    return cached.rows;
  }
  const rows = await rooms.getRoomItemRows(municipalityId, roomCode);
  _roomItemsCache.set(key, { rows, cachedAt: Date.now() });
  return rows;
}

// Wird von Route-Handlern aufgerufen, wenn Gebäude platziert/entfernt werden
function invalidateRoomItemsCache(municipalityId, roomCode) {
  _roomItemsCache.delete(`${municipalityId}:${roomCode}`);
}

function registerIntervals(deps) {
  const intervals = [];

  const getRooms = () => require('../game/rooms');
  const getDisasters = () => require('../game/disasters');
  const getStats = () => require('../game/stats');
  const getBuenzli = () => require('../game/buenzli');
  const getCitizens = () => require('../game/citizens');
  const getBank = () => require('../game/bank');
  const getCompanyLoans = () => require('../game/companyLoans');
  const getMansionRentals = () => require('../game/mansionRentals');
  const getTransportRevenue = () => require('../game/transportRevenue');
  const getPartyEvents = () => require('../game/partyEvents');
  const wsHelpers = require('../ws/socketio/helpers');
  const getWsState = () => require('../ws/socketio/index');

  // 1) Room cache flush + player-count sync + idle unload (every 5s)
  intervals.push(setInterval(async () => {
    try {
      const rooms = getRooms();
      const ws = getWsState();
      const io = deps?.io;
      const now = Date.now();
      for (const [, entry] of rooms.roomRuntimeCache.entries()) {
        if (entry.statsDirty && (now - Number(entry.lastFlushedAt || entry.lastFlushAttemptAt || 0)) > (ROOM_CACHE_FLUSH_INTERVAL_MS || 10000)) {
          await rooms.flushRoomRuntimeEntry(entry, 'periodic_flush');
        }

        if (Number(entry.activePlayers || 0) > 0 && entry.municipalitySlug && entry.roomCode) {
          const roomKey = wsHelpers.wsRoomKey(entry.municipalitySlug, entry.roomCode);
          const wsPlayers = ws.wsRoomPlayers.get(roomKey);
          const actualWsCount = wsPlayers ? wsHelpers.wsGetRoomPlayerList(roomKey, ws.wsRoomPlayers).length : 0;
          if (actualWsCount <= 0 && Number(entry.activePlayers || 0) > 0) {
            entry.activePlayers = 0;
            entry.idleSince = entry.idleSince || now;
            rooms.updateRoomPlayerCount(entry.municipalityId, entry.roomCode, 0).catch(() => {});
            if (io) {
              rooms.broadcastNavigatorRoomCount(io, entry.roomCode, entry.municipalitySlug, entry.municipalityName, 0);
            }
          }
        }

        const idleMs = entry.idleSince ? (now - entry.idleSince) : 0;
        if (Number(entry.activePlayers || 0) <= 0 && idleMs > 180000) {
          await rooms.unloadRoomRuntimeEntry(entry, 'idle_timeout', io);
        }
      }
    } catch (err) {
      logError('INTERVAL', 'Room cache tick error', { error: err?.message });
    }
  }, 5000));

  // 2) Stale player cleanup (every 5s)
  intervals.push(setInterval(() => {
    try {
      const io = deps?.io;
      const ws = getWsState();
      const rooms = getRooms();
      if (!io || ws.wsRoomPlayers.size <= 0) return;

      for (const [roomKey, players] of ws.wsRoomPlayers.entries()) {
        const stalePlayerIds = [];
        for (const [pid, pdata] of players.entries()) {
          const sid = pdata.socketId;
          if (!sid) { stalePlayerIds.push(pid); continue; }
          const sock = io.sockets?.sockets?.get(sid);
          if (!sock || sock.disconnected) {
            stalePlayerIds.push(pid);
          }
        }
        if (stalePlayerIds.length === 0) continue;

        for (const pid of stalePlayerIds) {
          players.delete(pid);
        }

        const avatars = ws.wsRoomAvatars.get(roomKey);
        if (avatars) {
          for (const [avatarId, avatar] of avatars.entries()) {
            if (stalePlayerIds.includes(avatar.ownerPlayerId)) {
              avatars.delete(avatarId);
              io.to(roomKey).emit('avatar-removed', { avatarId });
            }
          }
          if (avatars.size === 0) ws.wsRoomAvatars.delete(roomKey);
        }

        const remainingPlayerList = wsHelpers.wsGetRoomPlayerList(roomKey, ws.wsRoomPlayers);
        const remainingCount = remainingPlayerList.length;

        io.to(roomKey).emit('players-list', {
          players: remainingPlayerList,
          count: remainingCount,
        });

        if (players.size === 0) {
          ws.wsRoomPlayers.delete(roomKey);
          ws.wsRoomAuthoritativeStats.delete(roomKey);
          ws.wsRoomAvatars.delete(roomKey);
          ws.wsRoomMetadata.delete(roomKey);
        }

        const meta = ws.wsRoomMetadata.get(roomKey);
        if (meta) {
          rooms.setRoomRuntimePlayers(meta.municipalityId, meta.roomCode, remainingCount);
          rooms.broadcastNavigatorRoomCount(io, meta.roomCode, meta.municipalitySlug, meta.municipalityName, remainingCount);
        }

      }
    } catch (err) {
      logError('INTERVAL', 'Stale player cleanup error', { error: err?.message });
    }
  }, 5000));

  // 3) Authoritative stats + disaster + building upgrade broadcast (every 3s)
  let _mainTickRunning = false;
  intervals.push(setInterval(async () => {
    if (_mainTickRunning) {
      logError('INTERVAL', '3s-Haupttick übersprungen — vorheriger Tick läuft noch (Server überlastet?)');
      return;
    }
    _mainTickRunning = true;
    const _tickStart = Date.now();
    try {
      const rooms = getRooms();
      const disasters = getDisasters();
      const stats = getStats();
      const io = deps?.io;
      for (const [key, entry] of rooms.roomRuntimeCache.entries()) {
        if (entry.activePlayers <= 0) continue;
        const roomCode = entry.roomCode;
        const municipalityId = entry.municipalityId;
        const municipalitySlug = entry.municipalitySlug;
        if (!municipalitySlug) continue;

        try {
          const roomKey = wsHelpers.wsRoomKey(municipalitySlug, roomCode);
          // Items gecacht laden (10s TTL) – verhindert DB-Roundtrip jede 3s
          const sharedRows = await _getCachedRoomItems(rooms, municipalityId, roomCode);
          // Crime-Count vom letzten Tick übergeben (für Happiness-Berechnung)
          const rawStats = await stats.recomputeAuthoritativePopulationAndJobs(municipalityId, roomCode, sharedRows, { crimeCount: entry._lastCrimeCount || 0 });
          // LandValue-Grid + Service-Grids aus stats an Upgrade-Tick weitergeben
          const upgradeContext = {
            landValueGrid: rawStats?._landValueGrid || null,
            serviceCoverageGrids: rawStats?._serviceCoverageGrids || null,
          };
          const disasterResult = await disasters.runServerDisasterTick(municipalityId, roomCode, sharedRows);
          const upgradeResult = await disasters.runServerBuildingUpgradeTick(municipalityId, roomCode, sharedRows, upgradeContext);
          const zoneGrowthResult = await disasters.runServerZoneGrowthTick(municipalityId, roomCode, sharedRows, upgradeContext);
          const woodcutterResult = await disasters.runServerWoodcutterTick(municipalityId, roomCode, sharedRows);

          // Crime-Tick: Gangster spawnen/updaten (braucht serviceCoverageGrids + Stats)
          // Aktive Parties übergeben → erhöhte Kriminalität ab 18 Uhr in der Nähe
          const activeParties = await getPartyEvents().getActivePartiesForRoom(roomCode).catch(() => []);
          const crimeContext = {
            serviceCoverageGrids: rawStats?._serviceCoverageGrids || null,
            landValueGrid: rawStats?._landValueGrid || null,
            stats: rawStats || {},
            activeParties,
          };
          const crimeResult = await disasters.runServerCrimeTick(municipalityId, roomCode, sharedRows, crimeContext);
          // Crime-Count für nächsten Stats-Tick speichern
          entry._lastCrimeCount = crimeResult?.criminals?.length || 0;

          if (io) {
            const payload = wsHelpers.wsMapStatsToRealtimePayload(rawStats || {});
            const prev = entry._authRevision || 0;
            const revision = prev + 1;
            entry._authRevision = revision;
            io.to(roomKey).emit('stats-authoritative', {
              ...payload,
              revision,
              serverTimestamp: Date.now(),
            });

            if (disasterResult?.changes?.length > 0) {
              io.to(roomKey).emit('disasters-authoritative', {
                changes: disasterResult.changes,
                serverTimestamp: Date.now(),
              });
            }
            // Merge upgrade + zone growth + woodcutter changes in einen broadcast
            const buildingChanges = [
              ...(upgradeResult?.changes || []),
              ...(zoneGrowthResult?.changes || []),
              ...(woodcutterResult?.changes || []),
            ];
            if (buildingChanges.length > 0) {
              // Server hat game_items geändert → Cache invalidieren
              invalidateRoomItemsCache(municipalityId, roomCode);
              io.to(roomKey).emit('buildings-authoritative', {
                changes: buildingChanges,
                serverTimestamp: Date.now(),
              });
            }

            // Crime-NPCs broadcasten (Gangster-Positionen + Events + Homeless-Count)
            const hasActiveCrime = crimeResult && (crimeResult.criminals?.length > 0 || crimeResult.crimeEvents?.length > 0);
            const homelessCount = crimeResult?.homeless || 0;
            if (hasActiveCrime || homelessCount > 0) {
              const now = Date.now();
              const crimePayload = {
                criminals: crimeResult?.criminals || [],
                crimeEvents: crimeResult?.crimeEvents || [],
                crimeGrid: null,
                gridSize: crimeResult?.gridSize || 0,
                homeless: homelessCount,
                isNight: crimeResult?.isNight || false,
                serverTimestamp: now,
              };
              // Crime-Grid nur senden wenn sich was geaendert hat UND max alle 15s (grosse Payloads)
              const crimeGridThrottle = 15000;
              const canSendCrimeGrid = !entry._lastCrimeGridBroadcast || (now - entry._lastCrimeGridBroadcast) >= crimeGridThrottle;
              if (canSendCrimeGrid && crimeResult.crimeGrid && crimeResult.gridSize > 0) {
                const flatCrime = new Array(crimeResult.gridSize * crimeResult.gridSize);
                for (let gy = 0; gy < crimeResult.gridSize; gy++) {
                  const row = crimeResult.crimeGrid[gy];
                  for (let gx = 0; gx < crimeResult.gridSize; gx++) {
                    flatCrime[gy * crimeResult.gridSize + gx] = Math.round(row[gx] || 0);
                  }
                }
                crimePayload.crimeGrid = flatCrime;
                entry._lastCrimeGridBroadcast = now;
              }
              io.to(roomKey).emit('criminals-authoritative', crimePayload);
            }

            // Buenzli-NPCs broadcasten (Positionen aktiver Events)
            try {
              const buenzliNpcs = await getBuenzli().getBuenzliNpcPositions(municipalityId, roomCode);
              if (buenzliNpcs.length > 0) {
                io.to(roomKey).emit('buenzli-npc-authoritative', { npcs: buenzliNpcs });
              }
            } catch (buenzliErr) {
              logError('INTERVAL', `Buenzli NPC tick error for ${key}`, { error: buenzliErr?.message });
            }

            // Kontrolleur-NPCs ticken + broadcasten
            try {
              const parkSys = getParkingSystem();
              await parkSys.tickKontrolleurNpcs(buildBroadcastToRoom());
              const kNpcs = parkSys.getKontrolleurNpcStates(municipalityId, roomCode);
              io.to(roomKey).emit('kontrolleur-npc-authoritative', { npcs: kNpcs, serverTimestamp: Date.now() });
            } catch (kErr) {
              logError('INTERVAL', `Kontrolleur NPC tick error for ${key}`, { error: kErr?.message });
            }

            // Citizens-authoritative: aktive Pendler broadcasten (tageszeit-abhängig)
            try {
              const hour = new Date().getHours();
              const activeCitizens = await getCitizens().getActiveCitizensForBroadcast(municipalityId, hour);
              if (activeCitizens.length > 0) {
                io.to(roomKey).emit('citizens-authoritative', {
                  citizens: activeCitizens,
                  serverTimestamp: Date.now(),
                });
              }
            } catch (citErr) {
              logError('INTERVAL', `Citizens tick error for ${key}`, { error: citErr?.message });
            }

            // Party-Tick: Polizei-Warnungen + State-Broadcast
            try {
              await getPartyEvents().runPartyTick(roomKey, io, entry.roomCode);
            } catch (partyErr) {
              logError('INTERVAL', `Party tick error for ${key}`, { error: partyErr?.message });
            }

            // Werkhof-Status broadcasten (Reparaturqueue + Müllabfuhr)
            const werkhofStatus = rawStats?._werkhofStatus;
            if (werkhofStatus) {
              io.to(roomKey).emit('werkhof-status', {
                ...werkhofStatus,
                serverTimestamp: Date.now(),
              });
            }

            // LandValue-Grid broadcasten (nur bei Änderung, max alle 15s fuer grosse Gemeinden)
            const lvGrid = rawStats?._landValueGrid;
            if (lvGrid && Array.isArray(lvGrid) && lvGrid.length > 0) {
              const lvNow = Date.now();
              const lvThrottle = 15000;
              const canSendLvGrid = !entry._lastLvGridBroadcast || (lvNow - entry._lastLvGridBroadcast) >= lvThrottle;
              if (canSendLvGrid) {
                const gridSize = lvGrid.length;
                const flatValues = new Array(gridSize * gridSize);
                let checksum = 0;
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
                  entry._lastLvGridBroadcast = lvNow;
                  io.to(roomKey).emit('landvalue-authoritative', {
                    gridSize,
                    values: flatValues,
                    serverTimestamp: lvNow,
                  });
                }
              }
            }
          }
        } catch (err) {
          logError('INTERVAL', `Room tick error for ${key}`, { error: err?.message });
        }
      }
    } catch (err) {
      logError('INTERVAL', 'Stats/disaster tick error', { error: err?.message });
    } finally {
      _mainTickRunning = false;
      const elapsed = Date.now() - _tickStart;
      if (elapsed > 2500) logError('INTERVAL', `3s-Haupttick zu langsam: ${elapsed}ms (Limit: 2500ms)`);
    }
  }, 3000));

  // 4a) Citizen happiness + migration tick (every 5 minutes)
  // Backfill wird einmalig pro Gemeinde ausgeführt — beim ersten Tick sofort
  const _citizenBackfilledMunicipalities = new Set();

  // Backfill direkt beim Start für alle Gemeinden mit aktiven Spielern auslösen
  // (läuft im Hintergrund, blockiert nicht den Start)
  setTimeout(async () => {
    try {
      const rooms = getRooms();
      const citizens = getCitizens();
      const { dbPool } = require('../infra/db.js');
      const [munis] = await dbPool.query(`SELECT id FROM municipalities WHERE is_active = 1 LIMIT 50`);
      for (const m of munis) {
        if (_citizenBackfilledMunicipalities.has(m.id)) continue;
        _citizenBackfilledMunicipalities.add(m.id);
        citizens.backfillCitizensForAllBuildings(m.id).catch(() => {});
      }
      void rooms; // suppress unused warning
    } catch (_e) { /* ignorieren */ }
  }, 5000); // 5s nach Start — DB ist dann sicher bereit

  intervals.push(setInterval(async () => {
    try {
      const rooms = getRooms();
      const citizens = getCitizens();
      for (const [, entry] of rooms.roomRuntimeCache.entries()) {
        if (entry.activePlayers <= 0) continue;
        const municipalityId = entry.municipalityId;

        // Einmaligen Backfill für neue/bestehende Gebäude ohne Bewohner
        if (!_citizenBackfilledMunicipalities.has(municipalityId)) {
          _citizenBackfilledMunicipalities.add(municipalityId);
          citizens.backfillCitizensForAllBuildings(municipalityId).catch(() => {});
        }

        const crimeRate = Math.min(1, (entry._lastCrimeCount || 0) / 10);
        await citizens.runCitizenHappinessTick(municipalityId, crimeRate).catch(() => {});
        await citizens.runCitizenMigrationCheck(municipalityId).catch(() => {});
      }
    } catch (err) {
      logError('INTERVAL', 'Citizen happiness tick error', { error: err?.message });
    }
  }, 5 * 60 * 1000));

  // 4) Buenzli event tick (every 60s)
  intervals.push(setInterval(async () => {
    try {
      await getBuenzli().runBuenzliEventTick(deps);
    } catch (err) {
      logError('INTERVAL', 'Buenzli tick error', { error: err?.message });
    }
  }, BUENZLI_EVENT_CHECK_INTERVAL_MS || 60000));

  // 5) Bank interest tick (every 60s)
  intervals.push(setInterval(async () => {
    try {
      await getBank().processAllPendingInterest();
    } catch (err) {
      logError('INTERVAL', 'Bank interest tick error', { error: err?.message });
    }
  }, 60000));

  // 5b) Partnership tier upgrade check (every 6h)
  intervals.push(setInterval(async () => {
    try {
      const { processTierUpgrades } = require('../game/partnerships');
      const result = await processTierUpgrades();
      if (result.upgraded > 0) {
        logInfo('PARTNERSHIP', `Tier-Upgrades verarbeitet: ${result.upgraded} Partnerschaften aufgestuft`);
      }
    } catch (err) {
      logError('INTERVAL', 'Partnership tier tick error', { error: err?.message });
    }
  }, 6 * 60 * 60 * 1000));

  // 5c) Partnership trade income payout (every 60s, pays only if 24h since last payout)
  //     Idle-ready: zahlt auch wenn kein Spieler online ist (wie Transport Revenue)
  intervals.push(setInterval(async () => {
    try {
      const { processTradeIncomePayouts } = require('../game/partnerships');
      const result = await processTradeIncomePayouts();
      if (result.paid > 0) {
        logInfo('PARTNERSHIP', `Handelseinnahmen ausgezahlt: ${result.paid} Partnerschaften, ${result.totalAmount} CHF total`);
      }
    } catch (err) {
      logError('INTERVAL', 'Partnership trade payout error', { error: err?.message });
    }
  }, 60000));

  // 6) Company loan weekly repayment tick (every 60s, pays only if 7 days passed)
  intervals.push(setInterval(async () => {
    try {
      await getCompanyLoans().processWeeklyLoanPayments();
    } catch (err) {
      logError('INTERVAL', 'Company loan tick error', { error: err?.message });
    }
  }, 60000));

  // 7) Transport company revenue tick (every 60s, pays hourly)
  intervals.push(setInterval(async () => {
    try {
      await getTransportRevenue().processTransportRevenue();
    } catch (err) {
      logError('INTERVAL', 'Transport revenue tick error', { error: err?.message });
    }
  }, 60000));

  // 8) Spot-Energie: Auto-Subscribe + Billing (every 60s)
  //    Erst Auto-Abo (neue Verträge für Defizit), dann Billing (abrechnen)
  const getEnergySpot = () => require('../game/energySpot');
  intervals.push(setInterval(async () => {
    try {
      await getEnergySpot().autoSubscribeSpotEnergy();
    } catch (err) {
      logError('INTERVAL', 'Spot-Energie auto-subscribe Fehler', { error: err?.message });
    }
    try {
      await getEnergySpot().processSpotEnergyBilling();
    } catch (err) {
      logError('INTERVAL', 'Spot-Energie billing Fehler', { error: err?.message });
    }
  }, 60000));

  // 9) NPC-Bot Arbeitstick (every 60s) + Wochenlohn (every 60s, zahlt nur wenn faellig)
  const getNpcBots = () => require('../game/npcBots');
  intervals.push(setInterval(async () => {
    try {
      await getNpcBots().runNpcBotTick();
    } catch (err) {
      logError('INTERVAL', 'NPC-Bot Arbeitstick Fehler', { error: err?.message });
    }
    try {
      await getNpcBots().runNpcSalaryTick();
    } catch (err) {
      logError('INTERVAL', 'NPC-Bot Lohntick Fehler', { error: err?.message });
    }
  }, 60000));

  // 10) Idle water storage fill (every 60s)
  //     Füllt/leert Wasserspeicher für alle Gemeinden die gerade keine aktiven Spieler haben.
  //     Aktive Gemeinden werden schon durch den 3s-Tick (Interval 3) verwaltet.
  intervals.push(setInterval(async () => {
    try {
      const rooms = getRooms();
      const { dbPool } = require('../infra/db.js');

      // Sammle IDs aller aktuell aktiven Gemeinden (werden durch 3s-Tick verwaltet)
      const activeIds = new Set();
      for (const [, entry] of rooms.roomRuntimeCache.entries()) {
        if (Number(entry.activePlayers || 0) > 0 && entry.municipalityId) {
          activeIds.add(Number(entry.municipalityId));
        }
      }

      // 60s = 1/60 Stunde → Füll-/Leerrate in m³
      const tickHours = 60 / 3600;

      let sql = `
        UPDATE municipality_stats
        SET water_storage_level = GREATEST(0, LEAST(
          water_storage_capacity,
          water_storage_level + (water_production - water_consumption) * ?
        ))
        WHERE water_storage_capacity > 0
      `;
      const params = [tickHours];

      if (activeIds.size > 0) {
        const placeholders = [...activeIds].map(() => '?').join(',');
        sql += ` AND municipality_id NOT IN (${placeholders})`;
        params.push(...activeIds);
      }

      await dbPool.query(sql, params);
    } catch (err) {
      logError('INTERVAL', 'Idle water fill tick error', { error: err?.message });
    }
  }, 60000));

  // 11) Idle Infra-Recompute (alle 10min)
  //     Berechnet Power/Water/Solar für alle Gemeinden ohne aktive Spieler neu.
  //     Aktive Gemeinden werden schon durch den 3s-Tick (Interval 3) verwaltet.
  intervals.push(setInterval(async () => {
    try {
      const rooms = getRooms();
      const { dbPool } = require('../infra/db.js');
      const { recomputeIdleInfraStats } = require('../game/stats.js');

      // Aktive Gemeinden überspringen (haben eigenen 3s-Tick)
      const activeIds = new Set();
      for (const [, entry] of rooms.roomRuntimeCache.entries()) {
        if (Number(entry.activePlayers || 0) > 0 && entry.municipalityId) {
          activeIds.add(Number(entry.municipalityId));
        }
      }

      // Alle Gemeinden mit Bevölkerung laden
      const [idleRows] = await dbPool.query(
        `SELECT ms.municipality_id, gr.room_code
         FROM municipality_stats ms
         LEFT JOIN game_rooms gr ON gr.municipality_id = ms.municipality_id AND gr.is_active = 1
         WHERE ms.population > 0
         GROUP BY ms.municipality_id, gr.room_code`
      );

      for (const row of idleRows) {
        const mid = Number(row.municipality_id);
        if (activeIds.has(mid)) continue; // aktive Gemeinde → 3s-Tick übernimmt
        const rc = row.room_code || 'MAIN';
        try {
          await recomputeIdleInfraStats(mid, rc);
        } catch (e) {
          logError('INTERVAL', `Idle infra recompute Fehler (mid=${mid})`, { error: e?.message });
        }
      }
    } catch (err) {
      logError('INTERVAL', 'Idle infra recompute Fehler', { error: err?.message });
    }
  }, 600000)); // alle 10 Minuten

  // 12) Täglicher Snapshot-Job (stündlich prüfen, einmal pro Tag schreiben)
  //     Schreibt für jede Gemeinde mit population > 0 einen Snapshot, falls noch keiner
  //     für heute existiert. Liest direkt aus municipality_stats (persistierte Live-Werte).
  intervals.push(setInterval(async () => {
    try {
      const { dbPool } = require('../infra/db.js');
      await dbPool.query(`
        INSERT IGNORE INTO municipality_stats_history
          (municipality_id, room_code, snapshot_date,
           population, jobs, money, income, expenses, happiness,
           power_production, power_consumption,
           water_production, water_consumption, solar_production)
        SELECT
          ms.municipality_id, 'default', CURDATE(),
          ms.population, ms.jobs, ms.treasury,
          ms.income, ms.expenses, 50,
          ms.power_production, ms.power_consumption,
          ms.water_production, ms.water_consumption, ms.solar_production
        FROM municipality_stats ms
        WHERE ms.population > 0
      `);
    } catch (err) {
      logError('INTERVAL', 'Daily snapshot job error', { error: err?.message });
    }
  }, 3600000)); // jede Stunde prüfen

  // 13) Mansion-Mietabrechnungen (alle 6h, via next_due_at-Guard idempotent)
  intervals.push(setInterval(async () => {
    try {
      await getMansionRentals().processMonthlyRentals();
    } catch (err) {
      logError('INTERVAL', 'Mansion rentals tick error', { error: err?.message });
    }
  }, 6 * 60 * 60 * 1000));

  // 14) Büenzli-Dispatch Auflösung (alle 5min: löst fällige Dispatches auf)
  //     Ziel-Gemeinde muss NICHT online sein. Busse wird direkt aus treasury abgezogen.
  intervals.push(setInterval(async () => {
    try {
      const { dbPool } = require('../infra/db.js');
      const { findBuildingForEvent } = require('../game/buenzli.js');
      const { applyMunicipalityTransaction } = require('../game/bank.js');
      const { creditUserBankAccount } = require('../game/userBanking.js');
      const { awardXp } = require('../game/xp.js');

      // Alle fälligen Dispatches holen
      const [pending] = await dbPool.query(
        `SELECT bd.*, m.name AS target_name, gr.room_code AS target_room_code,
                ms.population AS target_population
         FROM buenzli_dispatches bd
         JOIN municipalities m ON m.id = bd.target_municipality_id
         LEFT JOIN municipality_stats ms ON ms.municipality_id = bd.target_municipality_id
         LEFT JOIN game_rooms gr ON gr.municipality_id = bd.target_municipality_id AND gr.is_active = 1
         WHERE bd.status = 'searching' AND bd.arrives_at <= NOW()
         LIMIT 20`
      );

      for (const dispatch of pending) {
        try {
          // Zufälligen Ordnungs-Event-Typ wählen
          // Quiz-Score beeinflusst Chance: score 2 = 60%, score 3 = 85%
          const findChance = dispatch.quiz_score >= 3 ? 0.85 : 0.60;
          const foundViolation = Math.random() < findChance;

          if (!foundViolation || (dispatch.target_population || 0) === 0) {
            // Nichts gefunden
            await dbPool.query(
              `UPDATE buenzli_dispatches SET status = 'found_nothing', resolved_at = NOW() WHERE id = ?`,
              [dispatch.id]
            );
            continue;
          }

          const [eventTypes] = await dbPool.query(
            `SELECT * FROM event_types WHERE is_active = 1 AND category = 'ordnung' ORDER BY RAND() LIMIT 1`
          );
          if (eventTypes.length === 0) {
            await dbPool.query(
              `UPDATE buenzli_dispatches SET status = 'found_nothing', resolved_at = NOW() WHERE id = ?`,
              [dispatch.id]
            );
            continue;
          }
          const chosenType = eventTypes[0];

          const building = await findBuildingForEvent(
            Number(dispatch.target_municipality_id), chosenType.id, chosenType.code
          );

          // Severity erhöht bei guter Quiz-Leistung
          const severity = Math.min(5, chosenType.severity + (dispatch.quiz_score >= 3 ? 2 : 1));
          const fixCost = chosenType.fix_cost_min +
            Math.floor(Math.random() * (chosenType.fix_cost_max - chosenType.fix_cost_min + 1));
          const confidence = Math.max(0.7, Number(chosenType.base_confidence) + 0.1);
          const durationHours = chosenType.duration_hours_min +
            Math.floor(Math.random() * (chosenType.duration_hours_max - chosenType.duration_hours_min + 1));

          // Busse berechnen: fixCost × severity Multiplikator
          const fineAmount = Math.round(fixCost * (1 + severity * 0.3));

          // Event in Ziel-Gemeinde einfügen
          const [insertResult] = await dbPool.query(
            `INSERT INTO municipality_events
             (municipality_id, event_type_id, status, severity, confidence, fix_cost,
              location_x, location_y, room_code, spawned_at, expires_at,
              external_reporter_id, escalation_level)
             VALUES (?, ?, 'external_reported', ?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR), ?, 1)`,
            [
              dispatch.target_municipality_id,
              chosenType.id,
              severity,
              confidence,
              fixCost,
              building?.x ?? null,
              building?.y ?? null,
              building?.room_code || dispatch.target_room_code || null,
              durationHours,
              dispatch.sender_user_id,
            ]
          );

          // Busse direkt aus Ziel-Gemeindekasse abziehen
          try {
            await applyMunicipalityTransaction(Number(dispatch.target_municipality_id), {
              amount: -fineAmount,
              type: 'buenzli_fine',
              description: `Büenzli-Inspektion: Busse für ${chosenType.name} (Severity ${severity})`,
            });
          } catch (_) {}

          // Sender belohnen: 50 CHF + 15 XP + Achievement
          try {
            await creditUserBankAccount(dispatch.sender_user_id, {
              amount: 50 + Math.round(fineAmount * 0.1), // 10% der Busse als Tipp
              type: 'buenzli_reward',
              description: `Büenzli-Belohnung: ${chosenType.name} in ${dispatch.target_name}`,
            });
            await awardXp(dispatch.sender_user_id, 15, 'buenzli_found', `Verstoss gefunden in ${dispatch.target_name}`, 'event', insertResult.insertId);
            // Achievement: erster erfolgreicher Dispatch
            await dbPool.query(
              `INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, 'ACH_BuenzliHetzer')`,
              [dispatch.sender_user_id]
            );
            // Achievement: 5 erfolgreiche Funde
            const [foundCount] = await dbPool.query(
              `SELECT COUNT(*) AS cnt FROM buenzli_dispatches WHERE sender_user_id = ? AND status = 'found_violation'`,
              [dispatch.sender_user_id]
            );
            if ((foundCount[0]?.cnt || 0) >= 4) { // wird 5 nach diesem Update
              await dbPool.query(
                `INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, 'ACH_BuenzliProfi')`,
                [dispatch.sender_user_id]
              );
            }
          } catch (_) {}

          // Dispatch abschliessen
          await dbPool.query(
            `UPDATE buenzli_dispatches
             SET status = 'found_violation', resolved_at = NOW(),
                 fine_amount = ?, event_id = ?, violation_type = ?, sender_rewarded = 1
             WHERE id = ?`,
            [fineAmount, insertResult.insertId, chosenType.code, dispatch.id]
          );

          logInfo('BUENZLI', `Dispatch ${dispatch.id} aufgelöst: ${chosenType.code} in ${dispatch.target_name}, Busse CHF ${fineAmount}`);
        } catch (err) {
          logError('BUENZLI', `Dispatch ${dispatch.id} Auflösung fehlgeschlagen`, { error: err?.message });
          // Nicht blockieren — nächsten dispatch versuchen
        }
      }
    } catch (err) {
      logError('INTERVAL', 'Büenzli dispatch resolve error', { error: err?.message });
    }
  }, 5 * 60 * 1000)); // alle 5 Minuten

  // 15) Server-seitige Werkhof-Patrol-Reparatur (alle 2min, nur tagsüber 07–22 Schweizer Zeit)
  intervals.push(setInterval(async () => {
    try {
      await getNpcBots().runServerWerkhofRepairTick(deps?.io);
    } catch (err) {
      logError('INTERVAL', 'Werkhof Patrol Reparatur-Tick Fehler', { error: err?.message });
    }
  }, 10 * 60 * 1000)); // alle 10 Minuten

  // 16) Parkraum-Ticks
  const getParkingSystem = () => require('../game/parkingSystem');
  const buildBroadcastToRoom = () => {
    const wsIo = deps?.io;
    const { wsRoomMetadata } = require('../ws/socketio/index');
    return (municipalityId, event, data) => {
      if (!wsIo) return;
      for (const [roomKey, meta] of wsRoomMetadata.entries()) {
        if (Number(meta.municipalityId) === Number(municipalityId)) {
          wsIo.to(roomKey).emit(event, data);
          break;
        }
      }
    };
  };
  // 16a) Ablauf-Tick: Abgelaufene Fahrzeuge rauswerfen (alle 60s)
  intervals.push(setInterval(async () => {
    try {
      await getParkingSystem().runParkingExpiryTick(buildBroadcastToRoom());
    } catch (err) {
      logError('INTERVAL', 'Parkraum-Ablauf-Tick Fehler', { error: err?.message });
    }
  }, 60000)); // alle 60 Sekunden
  // 16b) Kontrolleur-Tick: Schwarzparker büssen (alle 30s)
  intervals.push(setInterval(async () => {
    try {
      await getParkingSystem().runParkingControlTick(buildBroadcastToRoom());
    } catch (err) {
      logError('INTERVAL', 'Parkraum-Kontrolleur-Tick Fehler', { error: err?.message });
    }
  }, 30000)); // alle 30 Sekunden

  const getMunicipality = () => require('../game/municipality');

  // 17) Election-Phase-Check + No-Confidence-Ablauf (every 60s)
  intervals.push(setInterval(async () => {
    try {
      const m = getMunicipality();
      await m.resolveElectionPhases();
      await m.resolveExpiredNoConfidenceVotes();
    } catch (err) {
      logError('INTERVAL', 'Election phase check error', { error: err?.message });
    }
  }, 60000));

  // 18) Bürgermeister-Nachfolge bei Inaktivität (alle 6h)
  intervals.push(setInterval(async () => {
    try {
      await getMunicipality().checkAndSucceedInactiveMunicipalityOwners();
    } catch (err) {
      logError('INTERVAL', 'Mayor succession tick error', { error: err?.message });
    }
  }, 6 * 60 * 60 * 1000));

  // N) Einnahmen-Scheduler: alle 5 Minuten für ALLE Gemeinden (online & offline gleich)
  //    Gutschrift erfolgt wenn seit last_income_at >= 60 Minuten vergangen sind.
  //    Basiert auf municipality_stats.daily_income / daily_expenses (vom Stats-Loop gepflegt).
  intervals.push(setInterval(async () => {
    try {
      const { dbPool } = require('../infra/db.js');
      const { applyMunicipalityTransaction } = require('../game/bank.js');
      const { createNotificationForAllMembers } = require('../game/notifications.js');
      if (!dbPool) return;

      const INCOME_INTERVAL_MS = 60 * 60 * 1000; // 1 Stunde
      const MAX_CATCHUP_DAYS = 7;

      const [rows] = await dbPool.query(
        `SELECT municipality_id, daily_income, daily_expenses, last_income_at
         FROM municipality_stats
         WHERE last_income_at IS NULL
            OR last_income_at <= DATE_SUB(NOW(), INTERVAL 60 MINUTE)`
      );

      for (const row of rows) {
        try {
          const dailyNet = (Number(row.daily_income) || 0) - (Number(row.daily_expenses) || 0);

          const lastAt = row.last_income_at ? new Date(row.last_income_at).getTime() : null;
          const nowMs = Date.now();
          const elapsedMs = lastAt ? (nowMs - lastAt) : INCOME_INTERVAL_MS;
          const elapsedDays = Math.min(elapsedMs / (1000 * 60 * 60 * 24), MAX_CATCHUP_DAYS);
          const elapsedHours = Math.round(elapsedMs / (1000 * 60 * 60) * 10) / 10;
          const earnings = Math.floor(dailyNet * elapsedDays);

          logInfo('INCOME', `Gemeinde ${row.municipality_id}: Einnahmen-Tick`, {
            lastIncomeAt: row.last_income_at || 'nie',
            elapsedHours,
            dailyNet,
            earnings,
          });

          // last_income_at immer aktualisieren (auch wenn earnings=0) damit der Timer korrekt läuft
          await dbPool.query(
            `UPDATE municipality_stats SET last_income_at = NOW() WHERE municipality_id = ?`,
            [row.municipality_id]
          );

          if (earnings === 0) {
            logInfo('INCOME', `Gemeinde ${row.municipality_id}: earnings=0 (kein Ledger-Eintrag)`, { dailyNet });
            continue;
          }

          await applyMunicipalityTransaction(row.municipality_id, {
            amount: earnings,
            type: 'income',
            allowOverdraft: true, // Defizit → geht auf Schulden, wird nie still ignoriert
            meta: {
              days: Math.round(elapsedDays * 100) / 100,
              hours: elapsedHours,
              dailyIncome: row.daily_income,
              dailyExpenses: row.daily_expenses,
              dailyNet,
            },
            source: 'system',
          });

          logInfo('INCOME', `Gemeinde ${row.municipality_id}: +${earnings} CHF gutgeschrieben`, {
            hours: elapsedHours,
            dailyNet,
          });

          // Notification nur bei echter Abwesenheit (>30 Min) – gespeichert in DB, erscheint beim nächsten Login
          if (elapsedDays > 30 / (60 * 24)) {
            const timeText = elapsedDays >= 1
              ? `${Math.round(elapsedDays)} Tag${Math.round(elapsedDays) !== 1 ? 'e' : ''}`
              : `${Math.round(elapsedDays * 24)} Stunde${Math.round(elapsedDays * 24) !== 1 ? 'n' : ''}`;
            const earningsText = earnings >= 0
              ? `+${earnings.toLocaleString()} CHF`
              : `-${Math.abs(earnings).toLocaleString()} CHF`;
            await createNotificationForAllMembers(row.municipality_id, {
              type: 'idle_earnings',
              title: earnings >= 0 ? 'Einnahmen gutgeschrieben' : 'Defizit abgebucht',
              message: `Deine Stadt hat in ${timeText} ${earningsText} verdient`,
              icon: earnings >= 0 ? 'money' : 'warning',
              amount: earnings,
            });
          }
        } catch (innerErr) {
          logError('INCOME', `Einnahmen-Tick fehlgeschlagen für municipality ${row.municipality_id}`, { error: innerErr?.message });
        }
      }
    } catch (err) {
      logError('INCOME', 'Einnahmen-Scheduler Fehler', { error: err?.message });
    }
  }, 5 * 60 * 1000)); // alle 5 Minuten prüfen, aber nur gutschreiben wenn 60 Min rum

  // 19) Firmen-Auftrags-Cleanup (alle 5min)
  //   a) Abgelaufene offene Contracts → failed
  //   b) Verwaiste Events: Contract completed/failed/cancelled aber Event noch aktiv → resolved/failed
  intervals.push(setInterval(async () => {
    try {
      const { dbPool } = require('../infra/db.js');
      if (!dbPool) return;

      // a) Contracts mit abgelaufener Deadline die noch offen sind → failed
      const [expired] = await dbPool.query(
        `SELECT id, event_id FROM company_contracts
         WHERE status IN ('open', 'accepted', 'assigned')
           AND deadline_at < NOW()`
      );
      if (expired.length > 0) {
        const contractIds = expired.map(r => r.id);
        const eventIds    = [...new Set(expired.map(r => r.event_id).filter(Boolean))];

        await dbPool.query(
          `UPDATE company_contracts SET status = 'failed' WHERE id IN (?)`,
          [contractIds]
        );
        if (eventIds.length > 0) {
          await dbPool.query(
            `UPDATE municipality_events
             SET status = 'failed', resolved_at = NOW()
             WHERE id IN (?)
               AND status NOT IN ('resolved','expired','false_alarm','failed')`,
            [eventIds]
          );
        }
        logInfo('JOBS', `Contract-Cleanup: ${expired.length} abgelaufene Auftraege auf failed gesetzt`);
      }

      // b) Events deren Contract completed/failed/cancelled ist aber Event noch aktiv hängt
      const [orphaned] = await dbPool.query(
        `SELECT me.id AS event_id, cc.status AS contract_status
         FROM municipality_events me
         JOIN company_contracts cc ON cc.event_id = me.id
         WHERE me.status NOT IN ('resolved','expired','false_alarm','failed')
           AND cc.status IN ('completed','failed','cancelled')`
      );
      if (orphaned.length > 0) {
        const orphanEventIds = orphaned.map(r => r.event_id);
        // completed contract → event resolved, sonst failed
        const completedEventIds = orphaned.filter(r => r.contract_status === 'completed').map(r => r.event_id);
        const failedEventIds    = orphaned.filter(r => r.contract_status !== 'completed').map(r => r.event_id);

        if (completedEventIds.length > 0) {
          await dbPool.query(
            `UPDATE municipality_events SET status = 'resolved', resolved_at = NOW()
             WHERE id IN (?) AND status NOT IN ('resolved','expired','false_alarm','failed')`,
            [completedEventIds]
          );
        }
        if (failedEventIds.length > 0) {
          await dbPool.query(
            `UPDATE municipality_events SET status = 'failed', resolved_at = NOW()
             WHERE id IN (?) AND status NOT IN ('resolved','expired','false_alarm','failed')`,
            [failedEventIds]
          );
        }
        logInfo('JOBS', `Contract-Cleanup: ${orphanEventIds.length} verwaiste Events bereinigt`);
      }
    } catch (err) {
      logError('JOBS', 'Contract-Expiry-Tick Fehler', { error: err?.message });
    }
  }, 5 * 60 * 1000));

  logInfo('JOBS', `${intervals.length} Intervalle registriert`);
  return intervals;
}

module.exports = { registerIntervals, invalidateRoomItemsCache };
