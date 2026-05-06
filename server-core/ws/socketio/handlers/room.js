'use strict';

const { logWarn } = require('../../../infra/logger');
const {
  GLOBAL_ROLE_USER,
  GLOBAL_ROLE_MODERATOR,
  GLOBAL_ROLE_ADMINISTRATOR,
  MUNICIPALITY_ROLE_OWNER,
  MUNICIPALITY_ROLE_COUNCIL,
} = require('../../../config/constants');
const helpers = require('../helpers');

// Lazy requires to avoid circular dependencies
const lazyRequire = (path) => () => require(path);
const getRooms = lazyRequire('../../../game/rooms');
const getMunicipality = lazyRequire('../../../game/municipality');
const getAuth = lazyRequire('../../../auth/middleware');
const getTokens = lazyRequire('../../../auth/tokens');
const getHelpers = lazyRequire('../../../shared/helpers');

/**
 * Registers room-related socket handlers:
 *   join-room, cursor, avatar-spawn-request, avatar-move-request,
 *   partnership-discovered, partnership-connected, disconnect
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {object} context - shared state and connection-level variables
 */
module.exports = function registerRoomHandlers(socket, io, context) {
  const {
    state,
    rateLimiter,
    wsRoomPlayers,
    wsRoomAuthoritativeStats,
    wsRoomAvatars,
    wsRoomMetadata,
    wsUserSockets,
    leaveCurrentRoom,
  } = context;

  // ══════════════════════════════════════════════════════════════
  // JOIN-ROOM
  // ══════════════════════════════════════════════════════════════
  socket.on('join-room', async (data = {}) => {
    const { normalizeRoomCode, toJsonValue } = getHelpers();
    const rooms = getRooms();
    const municipalityMod = getMunicipality();

    const roomCode = normalizeRoomCode(data.roomCode || data.room_code || 'MAIN');
    const municipalitySlug = String(data.municipalitySlug || data.municipality_slug || 'default').toLowerCase();
    const ownerUserId = parseInt(data.ownerUserId || data.owner_user_id || '0', 10) || null;
    if (!roomCode) {
      socket.emit('error', { message: 'roomCode fehlt' });
      return;
    }

    leaveCurrentRoom();

    state.currentPlayerId = socket.id;
    state.playerName = String(data.name || '').slice(0, 32) || state.playerName || '?'; // wird unten durch authUser.nickname überschrieben
    state.isViewOnly = !!data.isViewOnly;
    state.canSendStatsUpdates = !state.isViewOnly;
    state.socketGlobalRole = GLOBAL_ROLE_USER;
    state.currentRoomKey = helpers.wsRoomKey(municipalitySlug, roomCode);

    let municipality = null;
    try {
      municipality = await municipalityMod.getMunicipalityBySlug(municipalitySlug);
    } catch {
      municipality = null;
    }

    if (municipality) {
      wsRoomMetadata.set(state.currentRoomKey, {
        municipalityId: Number(municipality.id),
        municipalitySlug: municipality.slug,
        municipalityName: municipality.name,
        roomCode,
        ownerUserId: ownerUserId || null,
      });
      await rooms.warmRoomRuntimeCache(municipality, roomCode, 'join-room');

      try {
        const room = await rooms.getRoom(municipality.id, roomCode);
        const roomState = toJsonValue(room?.game_state);
        state.currentRoomIsPublic = Boolean(roomCode.startsWith('PUB') || roomState?.navigator_public === true);
      } catch {
        state.currentRoomIsPublic = Boolean(roomCode.startsWith('PUB'));
      }
    } else {
      logWarn('WS', 'join-room ohne gültige Gemeinde', { municipalitySlug, roomCode, currentRoom: state.currentRoomKey });
      state.currentRoomIsPublic = Boolean(roomCode.startsWith('PUB'));
    }

    const isRoomViewer = !!data.isRoomViewer;
    state.isRoomViewerSocket = isRoomViewer;
    const authToken = String(data.authToken || data.auth_token || '').trim();
    if (authToken) {
      try {
        const auth = getAuth();
        const tokens = getTokens();
        const payload = tokens.verifyToken(authToken);
        const validSession = payload ? await auth.isSessionValid(authToken) : false;
        const authUserId = Number(payload?.sub || 0);
        if (validSession && Number.isInteger(authUserId) && authUserId > 0) {
          const authUser = await auth.getUserByIdWithMunicipality(authUserId);
          if (authUser && authUser.is_active && !authUser.is_banned) {
            state.socketGlobalRole = await auth.getUserGlobalRole(authUser.id);
            if (state.currentUserId && state.currentUserId !== authUser.id) {
              helpers.wsUnregisterUserSocket(state.currentUserId, socket.id, wsUserSockets);
            }
            const existingSockets = wsUserSockets.get(authUser.id);
            if (existingSockets && existingSockets.size > 0) {
              for (const oldSid of [...existingSockets]) {
                if (oldSid === socket.id) continue;
                const oldSocket = io.sockets?.sockets?.get(oldSid);
                if (!oldSocket) continue;
                const oldState = oldSocket._roomState; // gesetzt unten via socket._roomState = state
                const oldIsRoomViewer = oldState?.isRoomViewerSocket ?? false;
                // RoomViewer kickt nur andere RoomViewer des gleichen Users
                // Normaler Login kickt alles
                if (isRoomViewer && !oldIsRoomViewer) continue;
                for (const [rk, players] of wsRoomPlayers.entries()) {
                  for (const [pid, pdata] of players.entries()) {
                    if (pdata.socketId === oldSid) {
                      players.delete(pid);
                      if (players.size === 0) wsRoomPlayers.delete(rk);
                      io.to(rk).emit('player-left', { playerId: pid });
                      const rkList = helpers.wsGetRoomPlayerList(rk, wsRoomPlayers);
                      io.to(rk).emit('players-list', { players: rkList, count: rkList.length });
                      const avatars = wsRoomAvatars.get(rk);
                      if (avatars && avatars.has(pid)) {
                        avatars.delete(pid);
                        io.to(rk).emit('avatar-removed', { avatarId: pid });
                      }
                      break;
                    }
                  }
                }
                if (!isRoomViewer) {
                  oldSocket.emit('force-disconnect', { reason: 'Du wurdest abgemeldet, da du dich an einem anderen Ort eingeloggt hast.' });
                }
                oldSocket.disconnect(true);
              }
            }
            state.currentUserId = authUser.id;
            state.socketAuthUserId = authUser.id;
            // Nickname immer aus DB nehmen — nicht vom Client vertrauen
            if (authUser.nickname) {
              state.playerName = authUser.nickname;
              // Falls Avatar bereits mit falschem Namen gespawnt → korrigieren
              const avatarMap = wsRoomAvatars.get(state.currentRoomKey);
              const existing = avatarMap?.get(state.currentPlayerId);
              if (existing && existing.name !== authUser.nickname) {
                existing.name = authUser.nickname;
                io.to(state.currentRoomKey).emit('avatar-spawned', { ...existing, name: authUser.nickname });
              }
            }
            helpers.wsRegisterUserSocket(state.currentUserId, socket.id, wsUserSockets);
            try { const { dbPool } = require('../../../infra/db'); await dbPool.query('UPDATE users SET is_online = 1, last_online_at = NOW() WHERE id = ?', [state.currentUserId]); } catch {}
            // Freunde über Online-Status benachrichtigen
            (async (onlineUserId) => {
              try {
                const { dbPool } = require('../../../infra/db');
                const [friends] = await dbPool.query(
                  `SELECT CASE WHEN user_id = ? THEN friend_id ELSE user_id END AS fid
                   FROM user_friends WHERE (user_id = ? OR friend_id = ?) AND status = 'accepted'`,
                  [onlineUserId, onlineUserId, onlineUserId]
                );
                for (const f of friends) {
                  helpers.wsEmitToUser(io, f.fid, 'messenger-friend-status', { userId: onlineUserId, online: true }, wsUserSockets);
                }
              } catch {}
            })(state.currentUserId);
            const municipalityRole = municipality
              ? await municipalityMod.getUserMunicipalityRole(authUser.id, municipality.id)
              : 'observer';
            state.socketMunicipalityRole = municipalityRole;
            state.socketMunicipalityId = municipality ? Number(municipality.id) : null;
            // Aktivitäts-Timestamp aktualisieren (zählt als Gemeinde-Aktivität)
            if (municipality && authUser) {
              municipalityMod.touchMunicipalityActivity(Number(municipality.id), Number(authUser.id)).catch(() => {});
            }
            // Load bauzone mode for this municipality
            if (municipality) {
              try {
                const { dbPool } = require('../../../infra/db');
                const [mzsRows] = await dbPool.query(
                  `SELECT bauzone_mode FROM municipality_zone_settings WHERE municipality_id = ? AND room_code = 'main' LIMIT 1`,
                  [municipality.id]
                );
                state.socketBauzoneMode = (Array.isArray(mzsRows) && mzsRows.length > 0) ? mzsRows[0].bauzone_mode : 'disabled';
              } catch { state.socketBauzoneMode = 'disabled'; }
            }
            const hasMunicipalityStatsRights =
              municipalityRole === MUNICIPALITY_ROLE_OWNER || municipalityRole === MUNICIPALITY_ROLE_COUNCIL;
            const hasGlobalStatsRights =
              state.socketGlobalRole === GLOBAL_ROLE_MODERATOR || state.socketGlobalRole === GLOBAL_ROLE_ADMINISTRATOR;
            state.canSendStatsUpdates = hasMunicipalityStatsRights || hasGlobalStatsRights;
          }
        }
      } catch {
        logWarn('WS', 'join-room Auth-Auswertung fehlgeschlagen', {
          socketId: socket.id, playerId: state.currentPlayerId, room: state.currentRoomKey,
        });
      }
    } else if (!isRoomViewer) {
      logWarn('WS', 'join-room ohne authToken', {
        socketId: socket.id, playerId: state.currentPlayerId, room: state.currentRoomKey, isViewOnly: state.isViewOnly,
      });
      if (!state.currentRoomIsPublic) {
        socket.emit('error', { message: 'authentication_required' });
        return;
      }
      state.canSendStatsUpdates = false;
    }

    // Ban-Check: Ist der Spieler vom Raum-Eigentümer verbannt?
    if (ownerUserId && state.currentUserId && ownerUserId !== state.currentUserId) {
      try {
        const { dbPool } = require('../../../infra/db');
        const [banRows] = await dbPool.query(
          `SELECT id FROM room_bans WHERE owner_user_id = ? AND banned_user_id = ? LIMIT 1`,
          [ownerUserId, state.currentUserId]
        );
        if (banRows.length > 0) {
          socket.emit('room-banned', { message: 'Du wurdest von diesem Raum verbannt.' });
          return;
        }
      } catch { /* non-critical */ }
    }

    socket.join(state.currentRoomKey);

    // Global- und Kantonal-Chat Rooms beitreten (nur für authentifizierte User)
    if (state.socketAuthUserId) {
      socket.join('global:CHAT');
      if (municipality?.canton_code) {
        socket.join(`canton:${municipality.canton_code.toUpperCase()}:CHAT`);
      }
    }

    if (!wsRoomPlayers.has(state.currentRoomKey)) {
      wsRoomPlayers.set(state.currentRoomKey, new Map());
    }
    wsRoomPlayers.get(state.currentRoomKey).set(state.currentPlayerId, {
      id: state.currentPlayerId,
      name: state.playerName,
      socketId: socket.id,
      joinedAt: Date.now(),
      isViewOnly: state.isViewOnly,
    });

    const playerList = helpers.wsGetRoomPlayerList(state.currentRoomKey, wsRoomPlayers);
    socket.emit('room-joined', {
      roomCode,
      playerId: state.currentPlayerId,
      playerCount: playerList.length,
      players: playerList,
      canSendStatsUpdates: state.canSendStatsUpdates,
      isPublicRoom: state.currentRoomIsPublic,
      globalRole: state.socketGlobalRole,
    });
    socket.emit('avatars-snapshot', {
      avatars: helpers.wsGetRoomAvatars(state.currentRoomKey, wsRoomAvatars),
    });
    // Alle anderen Spieler im Raum bitten, ihre aktuelle Position sofort zu senden
    // (damit der neue Spieler die echte Position sieht, nicht die gespeicherte Destination)
    socket.to(state.currentRoomKey).emit('avatar-resync-request');
    // Möbel-Snapshot beim Join senden (ownerUserId aus join-Daten oder Raummetadaten)
    const joinOwnerUserId = ownerUserId || wsRoomMetadata.get(state.currentRoomKey)?.ownerUserId || null;
    if (joinOwnerUserId) {
      try {
        const { dbPool } = require('../../../infra/db');
        const [furnitureRows] = await dbPool.query(
          `SELECT id, item_code, x, z, floor_level, facing_idx, wy FROM room_furniture WHERE user_id = ? ORDER BY id ASC`,
          [joinOwnerUserId]
        );
        socket.emit('room-furniture-snapshot', { placements: furnitureRows, ownerUserId: joinOwnerUserId });
      } catch (_furErr) { /* non-critical */ }
    }
    // Frische Stats direkt beim Join senden — kein Warten auf nächsten 3s-Broadcast
    const authStats = wsRoomAuthoritativeStats.get(state.currentRoomKey);
    if (authStats) {
      socket.emit('stats-authoritative', authStats);
    }
    // Aktive Parties beim Join direkt senden
    try {
      const { getActivePartiesForRoom } = require('../../../game/partyEvents');
      const activeParties = await getActivePartiesForRoom(roomCode);
      if (activeParties.length > 0) {
        socket.emit('party-authoritative', { parties: activeParties, serverTimestamp: Date.now() });
      }
    } catch (_partyErr) { /* non-critical */ }
    // Geparkte Fahrzeuge + Parking-Config + aktive Verstösse beim Join senden
    if (municipality) {
      try {
        const { dbPool } = require('../../../infra/db');
        const [parkedRows] = await dbPool.query(
          'SELECT tile_x, tile_y, slot, color FROM parked_vehicles WHERE municipality_id = ?',
          [municipality.id]
        );
        socket.emit('parked-vehicles', { vehicles: parkedRows });

        // Parking-Configs senden
        const { getParkingConfigs, getParkingViolations } = require('../../../game/parkingSystem');
        const configs    = await getParkingConfigs(municipality.id);
        const violations = await getParkingViolations(municipality.id);
        socket.emit('parking-configs',    { configs });
        socket.emit('parking-violations', { violations });
      } catch(_e) { /* non-critical */ }
    }
    io.to(state.currentRoomKey).emit('players-list', {
      players: playerList,
      count: playerList.length,
    });
    socket.to(state.currentRoomKey).emit('player-joined', {
      playerId: state.currentPlayerId,
      playerName: state.playerName,
      playerCount: playerList.length,
    });

    if (municipality) {
      rooms.setRoomRuntimePlayers(municipality.id, roomCode, playerList.length);
      rooms.broadcastNavigatorRoomCount(io, roomCode, municipalitySlug, municipality.name, playerList.length);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // PARTNERSHIP EVENTS
  // ══════════════════════════════════════════════════════════════
  socket.on('partnership-discovered', (data = {}) => {
    if (rateLimiter('partnership-discovered')) return;
    if (!state.currentRoomKey || !state.currentUserId) return;
    const partnerSlug = String(data.partnerSlug || '').trim().slice(0, 100);
    const partnerName = String(data.partnerName || '').trim().slice(0, 200);
    const direction = String(data.direction || '').trim().slice(0, 50);
    if (!partnerSlug || !partnerName) return;
    socket.to(state.currentRoomKey).emit('partnership-discovered', {
      partnerSlug, partnerName, direction, playerId: state.currentPlayerId, timestamp: Date.now(),
    });
  });

  socket.on('partnership-connected', (data = {}) => {
    if (rateLimiter('partnership-connected')) return;
    if (!state.currentRoomKey || !state.currentUserId) return;
    const partnerSlug = String(data.partnerSlug || '').trim().slice(0, 100);
    const partnerName = String(data.partnerName || '').trim().slice(0, 200);
    const bonusPaid = Math.max(0, Math.round(Number(data.bonusPaid) || 0));
    const monthlyIncome = Math.max(0, Math.round(Number(data.monthlyIncome) || 0));
    if (!partnerSlug || !partnerName) return;
    socket.to(state.currentRoomKey).emit('partnership-connected', {
      partnerSlug, partnerName, bonusPaid, monthlyIncome, playerId: state.currentPlayerId, timestamp: Date.now(),
    });
  });

  // ══════════════════════════════════════════════════════════════
  // CURSOR / AVATAR
  // ══════════════════════════════════════════════════════════════
  socket.on('cursor', (position = {}) => {
    if (rateLimiter('cursor')) return;
    if (!state.currentRoomKey) return;
    socket.to(state.currentRoomKey).emit('cursor', { playerId: state.currentPlayerId, ...position });
  });

  socket.on('avatar-spawn-request', async (data = {}) => {
    if (!state.currentRoomKey || !state.currentPlayerId) return;
    // Name nur vom Client übernehmen wenn kein authentifizierter User (Gast)
    if (data.name && !state.socketAuthUserId) state.playerName = String(data.name).slice(0, 32);
    // Motto + Gemeinde + Level aus DB (nur für eingeloggte User)
    let motto = null, municipalityName = null, userLevel = 1;
    if (state.socketAuthUserId) {
      try {
        const { dbPool } = require('../../../infra/db');
        const [[row]] = await dbPool.query(
          `SELECT u.motto, m.name AS municipality_name, COALESCE(ux.level, 1) AS level
           FROM users u
           LEFT JOIN municipalities m ON m.id = u.municipality_id
           LEFT JOIN user_xp ux ON ux.user_id = u.id
           WHERE u.id = ?`, [state.socketAuthUserId]
        );
        if (row) { motto = row.motto || null; municipalityName = row.municipality_name || null; userLevel = row.level || 1; }
      } catch (e) { logWarn('WS', 'avatar-spawn motto query failed', { err: e.message }); }
    }
    const avatar = {
      playerId: state.currentPlayerId,
      userId: state.socketAuthUserId || null,
      name: state.playerName,
      x: Number(data.x ?? 0),
      y: Number(data.y ?? 0),
      dir: Number(data.dir ?? 0),
      avatarConfig: data.avatarConfig ? helpers.wsSanitizeAvatarConfig(data.avatarConfig) : undefined,
      motto,
      municipalityName,
      userLevel,
    };
    if (!wsRoomAvatars.has(state.currentRoomKey)) wsRoomAvatars.set(state.currentRoomKey, new Map());
    wsRoomAvatars.get(state.currentRoomKey).set(state.currentPlayerId, avatar);
    io.to(state.currentRoomKey).emit('avatar-spawned', avatar);
  });

  socket.on('avatar-move-request', (data = {}) => {
    if (rateLimiter('avatar-move-request')) return;
    if (!state.currentRoomKey || !state.currentPlayerId) return;
    const avatars = wsRoomAvatars.get(state.currentRoomKey);
    const avatar = avatars?.get(state.currentPlayerId);
    if (!avatar) return;
    const path = helpers.wsSanitizAvatarPath(data.path);
    if (path.length === 0) return;
    const dest = path[path.length - 1];
    avatar.x = dest.x;
    avatar.y = dest.y;
    if (data.level !== undefined) avatar.level = Number(data.level) || 0;
    io.to(state.currentRoomKey).emit('avatar-moved', { playerId: state.currentPlayerId, path, targetX: dest.x, targetY: dest.y, onRoller: !!data.onRoller, level: avatar.level ?? 0 });
  });

  // ══════════════════════════════════════════════════════════════
  // ROOM-LAMP-TOGGLE
  // Spieler schaltet Lampe ein/aus → alle sehen es
  // ══════════════════════════════════════════════════════════════
  socket.on('room-lamp-toggle', (data = {}) => {
    if (!state.currentRoomKey) return;
    const x = helpers.wsClampTile(data.x);
    const z = helpers.wsClampTile(data.z);
    if (x === null || z === null) return;
    io.to(state.currentRoomKey).emit('lamp-toggled', { x, z, on: !!data.on, playerId: state.currentPlayerId });
  });

  // ══════════════════════════════════════════════════════════════
  // AVATAR-STATE-REQUEST
  // Spieler sitzt, schläft, steht auf → an alle broadcasten
  // ══════════════════════════════════════════════════════════════
  socket.on('avatar-state-request', (data = {}) => {
    if (!state.currentRoomKey || !state.currentPlayerId) return;
    const VALID_STATES = ['idle', 'walk', 'sit', 'sleep', 'wave', 'jacuzzi_undress', 'dance'];
    const avState = VALID_STATES.includes(data.state) ? data.state : 'idle';
    const x = helpers.wsClampTile(data.x);
    const z = helpers.wsClampTile(data.z);
    const dir = Number(data.dir || 0);
    const avatars = wsRoomAvatars.get(state.currentRoomKey);
    const avatar = avatars?.get(state.currentPlayerId);
    if (avatar) {
      if (x !== null) avatar.x = x;
      if (z !== null) avatar.y = z;
      avatar.dir = dir;
    }
    io.to(state.currentRoomKey).emit('avatar-state', {
      playerId: state.currentPlayerId, state: avState, x: x ?? 0, y: z ?? 0, dir,
    });
  });

  // ══════════════════════════════════════════════════════════════
  // ROOM-FURNITURE-SYNC
  // Besitzer hat Möbel geändert (via HTTP) → alle im Raum neu laden
  // ══════════════════════════════════════════════════════════════
  socket.on('room-furniture-sync', async () => {
    if (!state.currentRoomKey) return;
    const meta = wsRoomMetadata.get(state.currentRoomKey);
    const syncOwnerUserId = meta?.ownerUserId || null;
    if (!syncOwnerUserId) return;
    // Nur Nicht-ViewOnly darf einen Sync auslösen (= Eigentümer-Socket)
    if (state.isViewOnly) return;
    try {
      const { dbPool } = require('../../../infra/db');
      const [furnitureRows] = await dbPool.query(
        `SELECT id, item_code, x, z, floor_level, facing_idx, wy FROM room_furniture WHERE user_id = ? ORDER BY id ASC`,
        [syncOwnerUserId]
      );
      io.to(state.currentRoomKey).emit('room-furniture-snapshot', { placements: furnitureRows, ownerUserId: syncOwnerUserId });
    } catch { /* non-critical */ }
  });

  // ══════════════════════════════════════════════════════════════
  // PARKING SYSTEM
  // ══════════════════════════════════════════════════════════════
  socket.on('park-vehicle', async (data = {}) => {
    if (!state.currentRoomKey) return;
    const meta = wsRoomMetadata.get(state.currentRoomKey);
    const municipalityId = meta?.municipalityId;
    if (!municipalityId) return;
    try {
      const { tileX, tileY, slot, color } = data;
      const { dbPool } = require('../../../infra/db');
      // Parkdauer nach Preis: teuer = kürzer, kostenlos = länger
      const [[cfg]] = await dbPool.query(
        `SELECT is_free, fee_rate FROM parking_config WHERE municipality_id = ? AND tile_x = ? AND tile_y = ?`,
        [municipalityId, tileX, tileY]
      );
      const isFree = cfg?.is_free ?? 0;
      const feeRate = Number(cfg?.fee_rate ?? 3);
      let leaveAfter;
      if (isFree) {
        leaveAfter = Math.floor(7200 + Math.random() * 7200);  // kostenlos: 2-4 h
      } else if (feeRate <= 5) {
        leaveAfter = Math.floor(3600 + Math.random() * 7200);  // günstig: 1-3 h
      } else if (feeRate <= 12) {
        leaveAfter = Math.floor(1800 + Math.random() * 5400);  // mittel: 0.5-2 h
      } else {
        leaveAfter = Math.floor(900 + Math.random() * 2700);   // teuer: 15 min-1 h
      }
      await dbPool.query(
        'INSERT IGNORE INTO parked_vehicles (municipality_id, tile_x, tile_y, slot, color, leave_after_seconds) VALUES (?, ?, ?, ?, ?, ?)',
        [municipalityId, tileX, tileY, slot, color, leaveAfter]
      );
      // Gebühr prüfen / Schwarzparker erfassen
      const { handleVehicleParked } = require('../../../game/parkingSystem');
      const { isViolation } = await handleVehicleParked(municipalityId, tileX, tileY, slot);
      io.to(state.currentRoomKey).emit('vehicle-parked', { tileX, tileY, slot, color, isViolation });
      if (isViolation) {
        io.to(state.currentRoomKey).emit('parking-violations', {
          violations: [{ tile_x: tileX, tile_y: tileY, slot, status: 'unpaid' }]
        });
      }
    } catch(_e) { /* silent */ }
  });

  socket.on('set-parking-config', async (data = {}) => {
    if (!state.currentRoomKey) return;
    const meta = wsRoomMetadata.get(state.currentRoomKey);
    const municipalityId = meta?.municipalityId;
    if (!municipalityId) return;
    if (!['owner','council'].includes(state.socketMunicipalityRole)) return;
    try {
      const { tileX, tileY, isFree, feeRate } = data;
      const rate = Math.max(1, Math.min(20, Number(feeRate) || 3));
      const { setParkingConfig } = require('../../../game/parkingSystem');
      await setParkingConfig(municipalityId, tileX, tileY, Boolean(isFree), rate);
      io.to(state.currentRoomKey).emit('parking-config-updated', { tileX, tileY, isFree: Boolean(isFree), feeRate: rate });
    } catch(_e) { /* silent */ }
  });

  socket.on('leave-parking', async (data = {}) => {
    if (!state.currentRoomKey) return;
    const meta = wsRoomMetadata.get(state.currentRoomKey);
    const municipalityId = meta?.municipalityId;
    if (!municipalityId) return;
    try {
      const { tileX, tileY, slot } = data;
      const { dbPool } = require('../../../infra/db');
      const { handleVehicleLeft } = require('../../../game/parkingSystem');

      // Gebühr buchen bevor das Fahrzeug gelöscht wird (braucht parked_at)
      await handleVehicleLeft(municipalityId, tileX, tileY, slot);

      await dbPool.query(
        'DELETE FROM parked_vehicles WHERE municipality_id = ? AND tile_x = ? AND tile_y = ? AND slot = ?',
        [municipalityId, tileX, tileY, slot]
      );
      io.to(state.currentRoomKey).emit('vehicle-left-parking', { tileX, tileY, slot });
    } catch(_e) { /* silent */ }
  });

  // ══════════════════════════════════════════════════════════════
  // DISCONNECT
  // ══════════════════════════════════════════════════════════════
  socket.on('disconnect', () => {
    leaveCurrentRoom();
    if (state.currentUserId) {
      helpers.wsUnregisterUserSocket(state.currentUserId, socket.id, wsUserSockets);
      const remainingSockets = wsUserSockets.get(state.currentUserId);
      if (!remainingSockets || remainingSockets.size === 0) {
        const disconnectedUserId = state.currentUserId;
        (async () => {
          try { const { dbPool } = require('../../../infra/db'); await dbPool.query('UPDATE users SET is_online = 0, last_online_at = NOW() WHERE id = ?', [disconnectedUserId]); } catch {}
          try {
            const { dbPool } = require('../../../infra/db');
            const [friends] = await dbPool.query(
              `SELECT CASE WHEN user_id = ? THEN friend_id ELSE user_id END AS fid
               FROM user_friends WHERE (user_id = ? OR friend_id = ?) AND status = 'accepted'`,
              [disconnectedUserId, disconnectedUserId, disconnectedUserId]
            );
            for (const f of friends) {
              helpers.wsEmitToUser(io, f.fid, 'messenger-friend-status', { userId: disconnectedUserId, online: false }, wsUserSockets);
            }
          } catch {}
        })();
      }
    }
  });
};
