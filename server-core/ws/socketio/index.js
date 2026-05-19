'use strict';

const { Server: SocketIOServer } = require('socket.io');
const { logInfo } = require('../../infra/logger');
const {
  CORS_ALLOWED_ORIGINS,
  CORS_ALLOW_ALL,
  GLOBAL_ROLE_USER,
} = require('../../config/constants');
const helpers = require('./helpers');
const { createSocketRateLimiter } = require('./rateLimit');

// Handler modules
const registerRoomHandlers = require('./handlers/room');
const registerConstructionHandlers = require('./handlers/construction');
const registerGameStateHandlers = require('./handlers/gameState');
const registerMessengerHandlers = require('./handlers/messenger');

// Lazy requires to avoid circular dependencies
const lazyRequire = (path) => () => require(path);
const getRooms = lazyRequire('../../game/rooms');

// Shared state maps
const wsRoomPlayers = new Map();
const wsRoomAuthoritativeStats = new Map();
const wsRoomAvatars = new Map();
const wsRoomMetadata = new Map();
const wsUserSockets = new Map();
// Map<roomKey, Set<userId>> — ephemeral mute list (RAM only, no DB)
const wsRoomMuted = new Map();
// Map<roomKey, Set<userId>> — einmalige Whitelist nach Anklopfen-Einlass
const wsRoomWhitelist = new Map();

function createSocketIOServer(httpServer) {
  const corsOrigin = CORS_ALLOW_ALL ? true : CORS_ALLOWED_ORIGINS;
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 60000,
    maxHttpBufferSize: 10 * 1024 * 1024, // 10MB fuer grosse Grid-Payloads
  });

  io.on('connection', (socket) => {
    const rateLimiter = createSocketRateLimiter();

    // Connection-level mutable state, shared across all handlers via context.state
    const state = {
      currentRoomKey: null,
      currentPlayerId: null,
      currentUserId: null,
      playerName: 'Spieler',
      isViewOnly: false,
      canSendStatsUpdates: true,
      socketGlobalRole: GLOBAL_ROLE_USER,
      currentRoomIsPublic: false,
      socketMunicipalityId: null,
      socketMunicipalityRole: null,
      socketAuthUserId: null,
      socketBauzoneMode: 'disabled',
    };

    function leaveCurrentRoom() {
      if (!state.currentRoomKey) return;
      const players = wsRoomPlayers.get(state.currentRoomKey);
      if (players && state.currentPlayerId) {
        players.delete(state.currentPlayerId);
        if (players.size === 0) wsRoomPlayers.delete(state.currentRoomKey);
        io.to(state.currentRoomKey).emit('player-left', { playerId: state.currentPlayerId });
        const leaveList = helpers.wsGetRoomPlayerList(state.currentRoomKey, wsRoomPlayers);
        io.to(state.currentRoomKey).emit('players-list', { players: leaveList, count: leaveList.length });
      }
      const avatars = wsRoomAvatars.get(state.currentRoomKey);
      if (avatars && state.currentPlayerId) {
        avatars.delete(state.currentPlayerId);
        io.to(state.currentRoomKey).emit('avatar-removed', { avatarId: state.currentPlayerId });
      }
      socket.leave(state.currentRoomKey);

      const meta = wsRoomMetadata.get(state.currentRoomKey);
      if (meta) {
        try {
          const rooms = getRooms();
          const activeCount = wsRoomPlayers.get(state.currentRoomKey)?.size || 0;
          rooms.setRoomRuntimePlayers(meta.municipalityId, meta.roomCode, activeCount);
        } catch (_) {}
      }
      state.currentRoomKey = null;
    }

    // Build the shared context object passed to all handler modules
    const context = {
      state,
      rateLimiter,
      wsRoomPlayers,
      wsRoomAuthoritativeStats,
      wsRoomAvatars,
      wsRoomMetadata,
      wsUserSockets,
      leaveCurrentRoom,
    };

    // State am Socket-Objekt verfügbar machen (für Lookup durch andere Sockets)
    socket._roomState = state;

    // Register all handler groups
    registerRoomHandlers(socket, io, context);
    registerConstructionHandlers(socket, io, context);
    registerGameStateHandlers(socket, io, context);
    registerMessengerHandlers(socket, io, context);
  });

  logInfo('WS', 'Socket.IO Server erstellt');
  return io;
}

module.exports = {
  createSocketIOServer,
  wsRoomPlayers,
  wsRoomAuthoritativeStats,
  wsRoomMuted,
  wsRoomWhitelist,
  wsRoomAvatars,
  wsRoomMetadata,
  wsUserSockets,
};
