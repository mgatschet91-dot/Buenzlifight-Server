'use strict';

const { logWarn, logError } = require('../../../infra/logger');
const helpers = require('../helpers');

// Lazy requires to avoid circular dependencies
const lazyRequire = (path) => () => require(path);
const getRooms = lazyRequire('../../../game/rooms');
const getHelpers = lazyRequire('../../../shared/helpers');
const getHandler = lazyRequire('../../../http/handler');

/**
 * Registers game-state-related socket handlers:
 *   stats-update, stats-request, budget-update, room-chat
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {object} context - shared state and connection-level variables
 */
module.exports = function registerGameStateHandlers(socket, io, context) {
  const {
    state,
    rateLimiter,
    wsRoomMetadata,
  } = context;

  // ══════════════════════════════════════════════════════════════
  // STATS-UPDATE / STATS-REQUEST
  // ══════════════════════════════════════════════════════════════
  socket.on('stats-update', async (data = {}, ack = null) => {
    if (rateLimiter('stats-update')) {
      if (typeof ack === 'function') ack({ success: false, error: 'rate_limited' });
      return;
    }
    if (!state.currentRoomKey || !state.canSendStatsUpdates) {
      logWarn('WS', 'stats-update blockiert (fehlende Rechte)', {
        socketId: socket.id, playerId: state.currentPlayerId, room: state.currentRoomKey,
        isViewOnly: state.isViewOnly, canSendStatsUpdates: state.canSendStatsUpdates, globalRole: state.socketGlobalRole,
      });
      if (typeof ack === 'function') ack({
        success: false,
        error: 'forbidden_missing_stats_rights',
        debug: { isViewOnly: state.isViewOnly, canSendStatsUpdates: state.canSendStatsUpdates, globalRole: state.socketGlobalRole },
      });
      return;
    }
    const roomMeta = wsRoomMetadata.get(state.currentRoomKey);
    if (!roomMeta) {
      if (typeof ack === 'function') ack({ success: false, error: 'room_meta_missing' });
      return;
    }
    try {
      const rooms = getRooms();
      const sharedHelpers = getHelpers();
      const { recomputeAuthoritativePopulationAndJobs } = require('../../../game/stats');
      const rawStats = (await rooms.loadRoomStats(roomMeta.municipalityId, roomMeta.roomCode)) || {};
      const patchedStats = rooms.applyStatsPatch(rawStats, data || {});
      const requestedMoney = Number(data?.money);
      const storedMoney = await rooms.getMunicipalityMoney(roomMeta.municipalityId);
      if (!sharedHelpers.jsonEquals(rawStats, patchedStats)) {
        await rooms.saveRoomStats(roomMeta.municipalityId, roomMeta.roomCode, patchedStats);
      }
      const recomputed = await recomputeAuthoritativePopulationAndJobs(roomMeta.municipalityId, roomMeta.roomCode);
      const authoritativeMoney = await rooms.getMunicipalityMoney(roomMeta.municipalityId);
      const handler = getHandler();
      if (handler.wsPublishAuthoritativeStats) {
        await handler.wsPublishAuthoritativeStats(io, state.currentRoomKey, String(state.currentPlayerId || ''));
      } else {
        const payload = helpers.wsMapStatsToRealtimePayload(recomputed || {});
        io.to(state.currentRoomKey).emit('stats-authoritative', { ...payload, revision: 0, serverTimestamp: Date.now() });
      }
      if (typeof ack === 'function') ack({
        success: true,
        data: rooms.toStatsApiShape(recomputed),
        debug: {
          isViewOnly: state.isViewOnly, canSendStatsUpdates: state.canSendStatsUpdates, globalRole: state.socketGlobalRole,
          requestedMoney: Number.isFinite(requestedMoney) ? Math.round(requestedMoney) : null,
          storedMoney,
          authoritativeMoney,
        },
      });
    } catch (err) {
      logError('WS', 'stats-update fehlgeschlagen', {
        socketId: socket.id, playerId: state.currentPlayerId, room: state.currentRoomKey,
        error: err?.message || String(err),
      });
      if (typeof ack === 'function') ack({
        success: false,
        error: err?.message || 'stats_update_failed',
        debug: { isViewOnly: state.isViewOnly, canSendStatsUpdates: state.canSendStatsUpdates, globalRole: state.socketGlobalRole },
      });
    }
  });

  socket.on('stats-request', async () => {
    if (rateLimiter('stats-request')) return;
    if (!state.currentRoomKey) return;
    if (!state.currentRoomIsPublic && !state.currentUserId) return;
    const roomMeta = wsRoomMetadata.get(state.currentRoomKey);
    if (!roomMeta) return;
    try {
      const { recomputeAuthoritativePopulationAndJobs } = require('../../../game/stats');
      const rawStats = await recomputeAuthoritativePopulationAndJobs(roomMeta.municipalityId, roomMeta.roomCode);
      const payload = helpers.wsMapStatsToRealtimePayload(rawStats || {});
      socket.emit('stats-authoritative', { ...payload, revision: 0, serverTimestamp: Date.now() });
    } catch {}
  });

  // ══════════════════════════════════════════════════════════════
  // BUDGET-UPDATE
  // ══════════════════════════════════════════════════════════════
  socket.on('budget-update', async (data = {}, ack = null) => {
    if (rateLimiter('budget-update')) {
      if (typeof ack === 'function') ack({ success: false, error: 'rate_limited' });
      return;
    }
    if (!state.currentRoomKey || !state.canSendStatsUpdates) {
      if (typeof ack === 'function') ack({ success: false, error: 'not_allowed' });
      return;
    }
    const roomMeta = wsRoomMetadata.get(state.currentRoomKey);
    if (!roomMeta) {
      if (typeof ack === 'function') ack({ success: false, error: 'room_meta_missing' });
      return;
    }
    try {
      const rooms = getRooms();
      const budget = data.budget || data;
      if (!budget || typeof budget !== 'object') {
        if (typeof ack === 'function') ack({ success: false, error: 'invalid_budget' });
        return;
      }
      const validCategories = ['police', 'fire', 'health', 'education', 'transportation', 'parks', 'power', 'water'];
      const validatedBudget = {};
      for (const [key, val] of Object.entries(budget)) {
        if (!validCategories.includes(key)) continue;
        let funding = 100;
        if (val && typeof val === 'object' && typeof val.funding !== 'undefined') {
          funding = Number(val.funding);
        } else {
          funding = Number(val);
        }
        validatedBudget[key] = {
          funding: Math.max(0, Math.min(100, Math.round(Number.isFinite(funding) ? funding : 100))),
        };
      }

      const sharedHelpers = getHelpers();
      const { recomputeAuthoritativePopulationAndJobs } = require('../../../game/stats');
      const rawStats = (await rooms.loadRoomStats(roomMeta.municipalityId, roomMeta.roomCode)) || {};
      const patchedStats = rooms.applyStatsPatch(rawStats, { budget: validatedBudget });
      if (!sharedHelpers.jsonEquals(rawStats, patchedStats)) {
        await rooms.saveRoomStats(roomMeta.municipalityId, roomMeta.roomCode, patchedStats);
      }

      const recomputed = await recomputeAuthoritativePopulationAndJobs(roomMeta.municipalityId, roomMeta.roomCode);
      const handler = getHandler();
      if (handler.wsPublishAuthoritativeStats) {
        await handler.wsPublishAuthoritativeStats(io, state.currentRoomKey, String(state.currentPlayerId || ''));
      } else {
        const payload = helpers.wsMapStatsToRealtimePayload(recomputed || {});
        io.to(state.currentRoomKey).emit('stats-authoritative', { ...payload, revision: 0, serverTimestamp: Date.now() });
      }

      if (typeof ack === 'function') {
        ack({ success: true, categories: Object.keys(validatedBudget) });
      }
    } catch (err) {
      logError('WS', 'budget-update fehlgeschlagen', { error: err?.message });
      if (typeof ack === 'function') ack({ success: false, error: err?.message || 'budget_update_failed' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // ROOM-CHAT
  // ══════════════════════════════════════════════════════════════
  socket.on('room-chat', (data = {}) => {
    if (rateLimiter('room-chat')) return;
    if (!state.currentRoomKey || !state.currentPlayerId) return;
    const message = String(data.message || '').trim().slice(0, 500);
    if (!message) return;
    io.to(state.currentRoomKey).emit('room-chat', {
      playerId: state.currentPlayerId,
      playerName: state.playerName,
      message,
      timestamp: Date.now(),
    });
  });
};
