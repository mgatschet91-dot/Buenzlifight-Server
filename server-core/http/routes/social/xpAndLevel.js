'use strict';

const { sendJson } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { XP_LEVEL_CAP } = require('../../../config/constants');
const { getUserXp, xpForLevel, processDailyLogin } = require('../../../game/xp');

module.exports = function registerXpAndLevelRoutes(deps) {
  return async function handleXpAndLevel(req, res, pathname, requestUrl) {

    // ================================================================
    // XP & LEVEL API
    // ================================================================

    if (req.method === 'GET' && pathname === '/api/xp/me') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const xpData = await getUserXp(authUser.id);
      const nextLevelXp = xpData.level < XP_LEVEL_CAP ? xpForLevel(xpData.level + 1) : null;
      return sendJson(res, 200, {
        ok: true,
        data: {
          total_xp: xpData.total_xp,
          level: xpData.level,
          max_level: XP_LEVEL_CAP,
          next_level_xp: nextLevelXp,
          xp_to_next: nextLevelXp ? nextLevelXp - xpData.total_xp : 0,
          login_streak: xpData.login_streak,
          best_streak: xpData.best_streak,
          last_login_date: xpData.last_login_date,
        },
      });
    }

    if (req.method === 'GET' && pathname === '/api/xp/log') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const limit = Math.min(100, Math.max(1, Number(requestUrl.searchParams.get('limit')) || 20));
      const [rows] = await dbPool.query(
        `SELECT id, xp_amount, reason, description, ref_type, ref_id, total_after, level_after, created_at
         FROM user_xp_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
        [authUser.id, limit]
      );
      return sendJson(res, 200, { ok: true, data: { log: rows } });
    }

    if (req.method === 'GET' && pathname === '/api/xp/leaderboard') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const limit = Math.min(50, Math.max(1, Number(requestUrl.searchParams.get('limit')) || 20));
      const [rows] = await dbPool.query(
        `SELECT ux.user_id, u.nickname, ux.total_xp, ux.level, ux.login_streak
         FROM user_xp ux
         JOIN users u ON u.id = ux.user_id AND u.is_active = 1
         ORDER BY ux.total_xp DESC
         LIMIT ?`,
        [limit]
      );
      return sendJson(res, 200, { ok: true, data: { leaderboard: rows } });
    }

    if (req.method === 'POST' && pathname === '/api/xp/daily-login') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const result = await processDailyLogin(authUser.id);
      if (!result) return sendJson(res, 200, { ok: true, data: { already_claimed: true } });
      return sendJson(res, 200, { ok: true, data: result });
    }

  };
};
