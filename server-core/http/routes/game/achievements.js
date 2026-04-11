'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

const {
  toStatsApiShape,
} = require('../../../game/rooms');

const {
  getMunicipalityBySlug,
  getMunicipalityById,
} = require('../../../game/municipality');

const {
  syncUserAchievements,
  claimAchievementForUser,
} = require('../../../game/achievements');

const {
  normalizeRoomCode,
} = require('../../../shared/helpers');

const { wsRoomKey } = require('../../../ws/socketio/helpers');

const {
  wsPublishAuthoritativeStats,
} = require('../../shared');

const { isGlobalAdmin } = require('./_shared');

module.exports = function registerAchievementsRoutes(deps) {
  const io = deps?.io;

  return async function handleAchievements(req, res, pathname, requestUrl) {

    // ── Achievements ───────────────────────────────────────────
    if (pathname === '/api/game/me/achievements' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { success: false, error: 'Keine Gemeinde zugeordnet' });
      const municipality = await getMunicipalityById(Number(authUser.municipality_id));
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const roomCode = normalizeRoomCode(requestUrl.searchParams.get('room_code') || 'MAIN') || 'MAIN';
      const synced = await syncUserAchievements(authUser.id, municipality.id, roomCode);
      const total = synced.achievements.length;
      const achieved = synced.achievements.filter((a) => a.achieved).length;
      const claimed = synced.achievements.filter((a) => a.claimed).length;
      return sendJson(res, 200, {
        success: true,
        data: {
          room_code: synced.room_code,
          achievements: synced.achievements,
          totals: { total, achieved, claimed },
        },
      });
    }

    const myAchievementClaimMatch = pathname.match(/^\/api\/game\/me\/achievements\/([a-z0-9_-]+)\/claim$/i);
    if (myAchievementClaimMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { success: false, error: 'Keine Gemeinde zugeordnet' });
      const municipality = await getMunicipalityById(Number(authUser.municipality_id));
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const body = await readJsonBody(req);
      const roomCode = normalizeRoomCode(body?.room_code || 'MAIN') || 'MAIN';
      const result = await claimAchievementForUser({
        userId: authUser.id,
        municipalityId: municipality.id,
        achievementCode: myAchievementClaimMatch[1],
        roomCode,
      });
      if (!result.ok) {
        return sendJson(res, result.status || 400, {
          success: false,
          error: result.error || 'Achievement konnte nicht geclaimed werden',
          achievement: result.achievement || null,
        });
      }
      if (result.updated_stats) {
        const roomKey = wsRoomKey(municipality.slug, result.room_code || roomCode);
        try {
          await wsPublishAuthoritativeStats(io, roomKey, String(authUser.id));
        } catch {
          // Antwort nicht fehlschlagen lassen, wenn WS kurzzeitig nicht verfügbar ist.
        }
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          room_code: result.room_code,
          achievement: result.achievement,
          already_claimed: Boolean(result.already_claimed),
          reward_money_applied: Number(result.reward_money_applied || 0),
          reward_xp_applied: Number(result.reward_xp_applied || 0),
          xp: result.xp || null,
          updated_stats: result.updated_stats || null,
        },
      });
    }

    const municipalityAchievementsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/achievements$/i);
    if (municipalityAchievementsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityAchievementsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const roomCode = normalizeRoomCode(requestUrl.searchParams.get('room_code') || 'MAIN') || 'MAIN';
      const synced = await syncUserAchievements(authUser.id, municipality.id, roomCode);
      const total = synced.achievements.length;
      const achieved = synced.achievements.filter((a) => a.achieved).length;
      const claimed = synced.achievements.filter((a) => a.claimed).length;
      return sendJson(res, 200, {
        success: true,
        data: {
          room_code: synced.room_code,
          achievements: synced.achievements,
          totals: { total, achieved, claimed },
        },
      });
    }

    const municipalityAchievementClaimMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/achievements\/([a-z0-9_-]+)\/claim$/i);
    if (municipalityAchievementClaimMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityAchievementClaimMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const body = await readJsonBody(req);
      const roomCode = normalizeRoomCode(body?.room_code || 'MAIN') || 'MAIN';
      const result = await claimAchievementForUser({
        userId: authUser.id,
        municipalityId: municipality.id,
        achievementCode: municipalityAchievementClaimMatch[2],
        roomCode,
      });
      if (!result.ok) {
        return sendJson(res, result.status || 400, {
          success: false,
          error: result.error || 'Achievement konnte nicht geclaimed werden',
          achievement: result.achievement || null,
        });
      }
      if (result.updated_stats) {
        const roomKey = wsRoomKey(municipality.slug, result.room_code || roomCode);
        try {
          await wsPublishAuthoritativeStats(io, roomKey, String(authUser.id));
        } catch {
          // Antwort nicht fehlschlagen lassen, wenn WS kurzzeitig nicht verfügbar ist.
        }
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          room_code: result.room_code,
          achievement: result.achievement,
          already_claimed: Boolean(result.already_claimed),
          reward_money_applied: Number(result.reward_money_applied || 0),
          updated_stats: result.updated_stats ? toStatsApiShape(result.updated_stats) : null,
        },
      });
    }

  };
};
