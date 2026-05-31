'use strict';

// Job 1: Room-Cache Flush + Idle-Unload (every 5s)
// Job 2: Stale-Player Cleanup (every 5s)

const { logError } = require('../infra/logger.js');
const { ROOM_CACHE_FLUSH_INTERVAL_MS } = require('../config/constants.js');

module.exports = function registerRoomJobs(deps) {
  const wsHelpers = require('../ws/socketio/helpers');
  const getWsState = () => require('../ws/socketio/index');
  const getRooms  = () => require('../game/rooms');

  // 1) Room cache flush + player-count sync + idle unload
  const roomFlushInterval = setInterval(async () => {
    try {
      const rooms = getRooms();
      const ws    = getWsState();
      const io    = deps?.io;
      const now   = Date.now();

      for (const [, entry] of rooms.roomRuntimeCache.entries()) {
        // Flush dirty entries
        if (entry.statsDirty && (now - Number(entry.lastFlushedAt || entry.lastFlushAttemptAt || 0)) > (ROOM_CACHE_FLUSH_INTERVAL_MS || 10000)) {
          await rooms.flushRoomRuntimeEntry(entry, 'periodic_flush');
        }

        // Sync WS player count
        if (Number(entry.activePlayers || 0) > 0 && entry.municipalitySlug && entry.roomCode) {
          const roomKey = wsHelpers.wsRoomKey(entry.municipalitySlug, entry.roomCode);
          const wsPlayers = ws.wsRoomPlayers.get(roomKey);
          const actualWsCount = wsPlayers ? wsHelpers.wsGetRoomPlayerList(roomKey, ws.wsRoomPlayers).length : 0;
          if (actualWsCount <= 0 && Number(entry.activePlayers || 0) > 0) {
            entry.activePlayers = 0;
            entry.idleSince = entry.idleSince || now;
            rooms.updateRoomPlayerCount(entry.municipalityId, entry.roomCode, 0).catch(() => {});
            if (io) rooms.broadcastNavigatorRoomCount(io, entry.roomCode, entry.municipalitySlug, entry.municipalityName, 0);
          }
        }

        // Idle unload nach 3 Minuten
        const idleMs = entry.idleSince ? (now - entry.idleSince) : 0;
        if (Number(entry.activePlayers || 0) <= 0 && idleMs > 180000) {
          await rooms.unloadRoomRuntimeEntry(entry, 'idle_timeout', deps?.io);
        }
      }
    } catch (err) {
      logError('INTERVAL', 'Room cache tick error', { error: err?.message });
    }
  }, 5000);

  // 2) Stale player cleanup
  const stalePlayerInterval = setInterval(() => {
    try {
      const io    = deps?.io;
      const ws    = getWsState();
      const rooms = getRooms();
      if (!io || ws.wsRoomPlayers.size <= 0) return;

      for (const [roomKey, players] of ws.wsRoomPlayers.entries()) {
        const stalePlayerIds = [];
        for (const [pid, pdata] of players.entries()) {
          const sid = pdata.socketId;
          if (!sid) { stalePlayerIds.push(pid); continue; }
          const sock = io.sockets?.sockets?.get(sid);
          if (!sock || sock.disconnected) stalePlayerIds.push(pid);
        }
        if (stalePlayerIds.length === 0) continue;

        for (const pid of stalePlayerIds) players.delete(pid);

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
        io.to(roomKey).emit('players-list', { players: remainingPlayerList, count: remainingPlayerList.length });

        if (players.size === 0) {
          ws.wsRoomPlayers.delete(roomKey);
          ws.wsRoomAuthoritativeStats.delete(roomKey);
          ws.wsRoomAvatars.delete(roomKey);
          ws.wsRoomMetadata.delete(roomKey);
        }

        const meta = ws.wsRoomMetadata.get(roomKey);
        if (meta) {
          const rooms2 = getRooms();
          rooms2.setRoomRuntimePlayers(meta.municipalityId, meta.roomCode, remainingPlayerList.length);
          rooms2.broadcastNavigatorRoomCount(io, meta.roomCode, meta.municipalitySlug, meta.municipalityName, remainingPlayerList.length);
        }
      }
    } catch (err) {
      logError('INTERVAL', 'Stale player cleanup error', { error: err?.message });
    }
  }, 5000);

  return [roomFlushInterval, stalePlayerInterval];
};
