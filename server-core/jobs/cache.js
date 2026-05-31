'use strict';

// Gemeinsamer Room-Items-Cache für den 3s-Haupttick.
// TTL: 10 Sekunden. Invalidierung via invalidateRoomItemsCache() bei Mutation.

const _roomItemsCache = new Map();
const ROOM_ITEMS_CACHE_TTL_MS = 10_000;

async function _getCachedRoomItems(rooms, municipalityId, roomCode) {
  const key = `${municipalityId}:${roomCode}`;
  const cached = _roomItemsCache.get(key);
  if (cached && (Date.now() - cached.cachedAt) < ROOM_ITEMS_CACHE_TTL_MS) return cached.rows;
  const rows = await rooms.getRoomItemRows(municipalityId, roomCode);
  _roomItemsCache.set(key, { rows, cachedAt: Date.now() });
  return rows;
}

// Wird aufgerufen wenn Gebäude platziert/entfernt werden (Route-Handler + admin clear-cache)
function invalidateRoomItemsCache(municipalityId, roomCode) {
  _roomItemsCache.delete(`${municipalityId}:${roomCode}`);
}

// Broadcast-Helper: sendet ein Socket.IO-Event an den Room einer Gemeinde
function buildBroadcastToRoom(io) {
  const { wsRoomMetadata } = require('../ws/socketio/index');
  return (municipalityId, event, data) => {
    if (!io) return;
    for (const [roomKey, meta] of wsRoomMetadata.entries()) {
      if (Number(meta.municipalityId) === Number(municipalityId)) {
        io.to(roomKey).emit(event, data);
        break;
      }
    }
  };
}

module.exports = { _getCachedRoomItems, invalidateRoomItemsCache, buildBroadcastToRoom };
