'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { toJsonValue, escapeLike } = require('../../../shared/helpers');

module.exports = function registerProfileRoutes(deps) {
  return async function handleProfile(req, res, pathname, requestUrl) {

    // ================================================================
    // NOTIFICATIONS (LEGACY PATH)
    // ================================================================

    if (req.method === 'GET' && pathname === '/api/notifications') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const unreadOnly = requestUrl.searchParams.get('unread_only') === '1';
      const [rows] = await dbPool.query(
        `SELECT id, notification_type, title, message, payload, is_read, created_at, read_at
         FROM user_notifications
         WHERE user_id = ? ${unreadOnly ? 'AND is_read = 0' : ''}
         ORDER BY created_at DESC
         LIMIT 200`,
        [authUser.id]
      );
      const notifications = (Array.isArray(rows) ? rows : []).map((row) => ({
        id: Number(row.id),
        notification_type: row.notification_type,
        title: row.title,
        message: row.message,
        payload: toJsonValue(row.payload),
        is_read: Boolean(row.is_read),
        created_at: row.created_at,
        read_at: row.read_at || null,
      }));
      return sendJson(res, 200, { success: true, data: { notifications, count: notifications.length } });
    }

    const notificationReadMatch = pathname.match(/^\/api\/notifications\/([0-9]+)\/read$/i);
    if (notificationReadMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const notificationId = Number(notificationReadMatch[1]);
      const [result] = await dbPool.query(
        `UPDATE user_notifications
         SET is_read = 1, read_at = NOW()
         WHERE id = ? AND user_id = ?`,
        [notificationId, authUser.id]
      );
      return sendJson(res, 200, { success: true, data: { updated: Number(result.affectedRows || 0) } });
    }

    // ================================================================
    // TUTORIAL
    // ================================================================

    if (req.method === 'GET' && pathname === '/api/tutorial/status') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `SELECT JSON_EXTRACT(project_data, '$.tutorial_completed') AS tc,
                JSON_EXTRACT(project_data, '$.tutorial_step') AS ts
         FROM users_data WHERE user_id = ?`, [authUser.id]
      );
      const row = rows[0] || {};
      return sendJson(res, 200, {
        ok: true,
        data: {
          completed: !!(row.tc && Number(row.tc)),
          step: Number(row.ts) || 0,
        }
      });
    }

    if (req.method === 'POST' && pathname === '/api/tutorial/progress') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const body = await readJsonBody(req);
      const step = Math.max(0, Number(body.step) || 0);

      await dbPool.query(
        `INSERT INTO users_data (user_id, project_data) VALUES (?, JSON_OBJECT('tutorial_step', ?))
         ON DUPLICATE KEY UPDATE project_data = JSON_SET(COALESCE(project_data, '{}'), '$.tutorial_step', ?)`,
        [authUser.id, step, step]
      );
      return sendJson(res, 200, { ok: true, data: { step } });
    }

    if (req.method === 'POST' && pathname === '/api/tutorial/complete') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      await dbPool.query(
        `INSERT INTO users_data (user_id, project_data) VALUES (?, JSON_OBJECT('tutorial_completed', 1))
         ON DUPLICATE KEY UPDATE project_data = JSON_SET(COALESCE(project_data, '{}'), '$.tutorial_completed', 1)`,
        [authUser.id]
      );
      return sendJson(res, 200, { ok: true, data: { completed: true } });
    }

    if (req.method === 'POST' && pathname === '/api/tutorial/reset') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      await dbPool.query(
        `INSERT INTO users_data (user_id, project_data) VALUES (?, JSON_OBJECT('tutorial_completed', 0, 'tutorial_step', 0))
         ON DUPLICATE KEY UPDATE project_data = JSON_SET(COALESCE(project_data, '{}'), '$.tutorial_completed', 0, '$.tutorial_step', 0)`,
        [authUser.id]
      );
      return sendJson(res, 200, { ok: true, data: { reset: true } });
    }

    // ================================================================
    // LEADERBOARD
    // ================================================================

    if (req.method === 'GET' && pathname === '/api/leaderboard') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const type = requestUrl.searchParams.get('type') || 'players';

      if (type === 'players') {
        const [rows] = await dbPool.query(
          `SELECT u.id, u.nickname, m.name AS municipality_name,
                  COALESCE(ux.total_xp, 0) AS xp, COALESCE(ux.level, 1) AS level
           FROM users u
           LEFT JOIN user_xp ux ON ux.user_id = u.id
           LEFT JOIN municipalities m ON m.id = u.municipality_id
           ORDER BY COALESCE(ux.total_xp, 0) DESC LIMIT 50`
        );
        return sendJson(res, 200, { ok: true, data: { entries: rows, type: 'players' } });
      } else {
        const [rows] = await dbPool.query(
          `SELECT m.id, m.name, m.slug,
                  COALESCE(agg.total_pop, 0) AS population,
                  COALESCE(agg.avg_happiness, 50) AS happiness,
                  COALESCE(ms.treasury, 0) AS money,
                  owner_u.nickname AS owner_name
           FROM municipalities m
           LEFT JOIN (
             SELECT municipality_id,
                    SUM(CAST(JSON_EXTRACT(stats_data, '$.population') AS UNSIGNED)) AS total_pop,
                    ROUND(
                      CASE
                        WHEN SUM(CAST(JSON_EXTRACT(stats_data, '$.population') AS UNSIGNED)) > 0
                        THEN SUM(CAST(JSON_EXTRACT(stats_data, '$.population') AS UNSIGNED) * CAST(JSON_EXTRACT(stats_data, '$.happiness') AS UNSIGNED))
                             / SUM(CAST(JSON_EXTRACT(stats_data, '$.population') AS UNSIGNED))
                        ELSE AVG(CAST(JSON_EXTRACT(stats_data, '$.happiness') AS UNSIGNED))
                      END
                    ) AS avg_happiness
             FROM game_stats
             GROUP BY municipality_id
           ) agg ON agg.municipality_id = m.id
           LEFT JOIN municipality_stats ms ON ms.municipality_id = m.id
           LEFT JOIN municipality_memberships mm ON mm.municipality_id = m.id AND mm.role = 'owner'
           LEFT JOIN users owner_u ON owner_u.id = mm.user_id
           ORDER BY COALESCE(agg.total_pop, 0) DESC LIMIT 50`
        );
        return sendJson(res, 200, { ok: true, data: { entries: rows, type: 'municipalities' } });
      }
    }

    // ================================================================
    // PROFILE
    // ================================================================

    const profileMatch = pathname.match(/^\/api\/users\/([0-9]+|me)\/profile$/i);
    if (profileMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      let userId;
      if (profileMatch[1] === 'me') {
        userId = authUser.id;
      } else {
        userId = Number(profileMatch[1]);
      }
      const [users] = await dbPool.query(
        `SELECT u.id, u.nickname, u.municipality_id, u.created_at,
                COALESCE(u.motto, '') AS motto,
                m.name AS municipality_name, m.slug AS municipality_slug,
                COALESCE(ux.total_xp, 0) AS xp, COALESCE(ux.level, 1) AS level
         FROM users u
         LEFT JOIN municipalities m ON m.id = u.municipality_id
         LEFT JOIN user_xp ux ON ux.user_id = u.id
         WHERE u.id = ?`, [userId]
      );
      if (users.length === 0) return sendJson(res, 404, { ok: false, error: 'Spieler nicht gefunden' });

      const [badges] = await dbPool.query(
        `SELECT ub.badge_code AS code, b.name, b.description, COALESCE(b.image_url, '') AS image_url, b.rarity, b.category
         FROM user_badges ub
         JOIN badges b ON b.code = ub.badge_code
         WHERE ub.user_id = ?
         ORDER BY b.rarity DESC`, [userId]
      );

      const [companies] = await dbPool.query(
        `SELECT c.name, c.level, c.reputation, ct.emoji, ct.name AS type_name, cm.role
         FROM company_members cm
         JOIN companies c ON c.id = cm.company_id
         JOIN company_types ct ON ct.id = c.company_type_id
         WHERE cm.user_id = ? AND c.is_active = 1`, [userId]
      );

      return sendJson(res, 200, {
        ok: true,
        data: {
          ...users[0],
          badges,
          companies,
        }
      });
    }

    // ================================================================
    // MOTTO SETZEN
    // ================================================================

    if (pathname === '/api/users/me/motto' && req.method === 'PUT') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const body = await readJsonBody(req);
      const raw = typeof body.motto === 'string' ? body.motto : '';
      const motto = raw.trim().slice(0, 128);
      await dbPool.query(`UPDATE users SET motto = ? WHERE id = ?`, [motto || null, authUser.id]);
      return sendJson(res, 200, { ok: true, motto: motto || null });
    }

    // ================================================================
    // GAME NOTIFICATIONS
    // ================================================================

    if (pathname === '/api/game/notifications' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `SELECT id, notification_type AS type, title, message, icon, amount, municipality_id, is_read,
                created_at
         FROM user_notifications
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 50`,
        [authUser.id]
      );

      return sendJson(res, 200, { ok: true, data: rows });
    }

    const notifReadMatch = pathname.match(/^\/api\/game\/notifications\/(\d+)\/read$/);
    if (notifReadMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      await dbPool.query(
        `UPDATE user_notifications SET is_read = 1 WHERE id = ? AND user_id = ?`,
        [notifReadMatch[1], authUser.id]
      );

      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/game/notifications/read-all' && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      await dbPool.query(
        `UPDATE user_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`,
        [authUser.id]
      );

      return sendJson(res, 200, { ok: true });
    }

    const notifDeleteMatch = pathname.match(/^\/api\/game\/notifications\/(\d+)$/);
    if (notifDeleteMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [result] = await dbPool.query(
        `DELETE FROM user_notifications WHERE id = ? AND user_id = ?`,
        [notifDeleteMatch[1], authUser.id]
      );

      return sendJson(res, 200, { ok: true, data: { deleted: Number(result.affectedRows || 0) } });
    }

    if (pathname === '/api/game/notifications' && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [result] = await dbPool.query(
        `DELETE FROM user_notifications WHERE user_id = ?`,
        [authUser.id]
      );

      return sendJson(res, 200, { ok: true, data: { deleted: Number(result.affectedRows || 0) } });
    }

    // ================================================================
    // USER SETTINGS (Messenger-Einstellungen etc.)
    // ================================================================

    if (pathname === '/api/user/settings' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `SELECT JSON_EXTRACT(project_data, '$.messenger_sounds') AS messenger_sounds,
                JSON_EXTRACT(project_data, '$.allow_friend_requests') AS allow_friend_requests,
                JSON_EXTRACT(project_data, '$.profile_searchable') AS profile_searchable
         FROM users_data WHERE user_id = ?`,
        [authUser.id]
      );
      const row = rows[0] || {};
      return sendJson(res, 200, {
        ok: true,
        data: {
          messenger_sounds: row.messenger_sounds !== null ? Boolean(Number(row.messenger_sounds)) : true,
          allow_friend_requests: row.allow_friend_requests !== null ? Boolean(Number(row.allow_friend_requests)) : true,
          profile_searchable: row.profile_searchable !== null ? Boolean(Number(row.profile_searchable)) : true,
        },
      });
    }

    if (pathname === '/api/user/settings' && req.method === 'PUT') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const body = await readJsonBody(req);
      const updates = [];
      const values = [authUser.id];
      const jsonInit = {};

      if (typeof body.messenger_sounds === 'boolean') {
        updates.push("'$.messenger_sounds', ?");
        values.push(body.messenger_sounds ? 1 : 0);
        jsonInit.messenger_sounds = body.messenger_sounds ? 1 : 0;
      }
      if (typeof body.allow_friend_requests === 'boolean') {
        updates.push("'$.allow_friend_requests', ?");
        values.push(body.allow_friend_requests ? 1 : 0);
        jsonInit.allow_friend_requests = body.allow_friend_requests ? 1 : 0;
      }
      if (typeof body.profile_searchable === 'boolean') {
        updates.push("'$.profile_searchable', ?");
        values.push(body.profile_searchable ? 1 : 0);
        jsonInit.profile_searchable = body.profile_searchable ? 1 : 0;
      }

      if (updates.length === 0) {
        return sendJson(res, 422, { ok: false, error: 'Keine gültigen Einstellungen übergeben' });
      }

      await dbPool.query(
        `INSERT INTO users_data (user_id, project_data) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE project_data = JSON_SET(COALESCE(project_data, '{}'), ${updates.join(', ')})`,
        [authUser.id, JSON.stringify(jsonInit), ...values.slice(1)]
      );

      return sendJson(res, 200, { ok: true, data: { updated: true } });
    }

    // ================================================================
    // USER SEARCH
    // ================================================================

    if (req.method === 'GET' && pathname === '/api/users/search') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const query = String(requestUrl.searchParams.get('q') || '').trim();
      if (query.length < 2) return sendJson(res, 200, { ok: true, data: { users: [] } });

      const [rows] = await dbPool.query(
        `SELECT u.id, u.nickname, u.municipality_id, m.name AS municipality_name,
                (SELECT level FROM user_xp WHERE user_id = u.id) AS user_level
         FROM users u
         LEFT JOIN municipalities m ON m.id = u.municipality_id
         LEFT JOIN users_data ud ON ud.user_id = u.id
         WHERE u.nickname LIKE ? AND u.id != ? AND u.is_active = 1
           AND COALESCE(JSON_EXTRACT(ud.project_data, '$.profile_searchable'), 1) != 0
         ORDER BY u.nickname ASC LIMIT 20`,
        [`%${escapeLike(query)}%`, authUser.id]
      );

      return sendJson(res, 200, { ok: true, data: { users: rows } });
    }

  };
};
