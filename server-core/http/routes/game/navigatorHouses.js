'use strict';

const fs   = require('fs');
const path = require('path');
const { sendJson } = require('../../../infra/http');
const { ensureDbEnabled, dbPool } = require('../../../infra/db');

const THUMBS_DIR = path.join(__dirname, '../../../uploads/room-thumbs');
const { getAuthenticatedUser, getUserGlobalRole } = require('../../../auth/middleware');
const { escapeLike } = require('../../../shared/helpers');
const { GLOBAL_ROLE_MODERATOR, GLOBAL_ROLE_ADMINISTRATOR } = require('../../../config/constants');

module.exports = function registerNavigatorHousesRoute(/* deps */) {
  return async function handleNavigatorHouses(req, res, pathname, requestUrl) {

    // ── Private Häuser (alle gekauften Häuser aller User) ─────────────────────
    if (pathname === '/api/game/navigator/houses' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      const q = String(requestUrl.searchParams.get('q') || '').trim().toLowerCase();
      const limit = Math.min(200, Math.max(1, Number(requestUrl.searchParams.get('limit')) || 80));

      const where = ['m.is_active = 1', 'u.is_active = 1'];
      const args = [];
      if (q) {
        where.push('(LOWER(u.nickname) LIKE ? OR LOWER(m.name) LIKE ? OR LOWER(m.slug) LIKE ?)');
        const eq = escapeLike(q);
        args.push(`%${eq}%`, `%${eq}%`, `%${eq}%`);
      }
      args.push(limit);

      const [rows] = await dbPool.query(
        `SELECT
           pr.user_id     AS owner_id,
           u.nickname     AS owner_nickname,
           m.id           AS municipality_id,
           m.name         AS municipality_name,
           m.slug         AS municipality_slug,
           m.canton_code,
           pr.room_code,
           COALESCE(urs.room_display_name, CONCAT(u.nickname, '\\'s Zimmer')) AS room_name,
           COALESCE(gr.player_count, 0)   AS player_count,
           COALESCE(urs.is_locked, 0)     AS is_locked,
           urs.room_description
         FROM player_residences pr
         JOIN users u         ON u.id  = pr.user_id
         JOIN municipalities m ON m.id = pr.municipality_id
         LEFT JOIN game_rooms gr
           ON gr.municipality_id = m.id
          AND gr.room_code       = pr.room_code
          AND gr.is_active       = 1
         LEFT JOIN user_room_settings urs ON urs.user_id = pr.user_id
         WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(gr.player_count, 0) DESC, u.nickname ASC, m.name ASC
         LIMIT ?`,
        args
      );

      const houses = (Array.isArray(rows) ? rows : []).map((row) => {
        const ownerId = Number(row.owner_id);
        return {
          municipality_id:   Number(row.municipality_id),
          municipality_name: String(row.municipality_name || ''),
          municipality_slug: String(row.municipality_slug || ''),
          canton_code:       row.canton_code || null,
          room_code:         String(row.room_code || ''),
          room_name:         String(row.room_name || row.municipality_name || ''),
          room_description:  row.room_description ? String(row.room_description) : null,
          player_count:      Math.max(0, Number(row.player_count || 0)),
          is_locked:         row.is_locked ? true : false,
          has_thumbnail:     fs.existsSync(path.join(THUMBS_DIR, `${ownerId}.jpg`)),
          owner: {
            id:       ownerId,
            nickname: String(row.owner_nickname || `User #${ownerId}`),
          },
        };
      });

      return sendJson(res, 200, { success: true, data: { houses, count: houses.length } });
    }

    // ── Aktive Räume (alle Räume mit Spielern online) ─────────────────────────
    if (pathname === '/api/game/navigator/active' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `(
          SELECT 'private' AS type,
                 COALESCE(urs.room_display_name, CONCAT(u.nickname, '\\'s Zimmer')) AS room_name,
                 m.name  AS municipality_name,
                 m.slug  AS municipality_slug,
                 pr.room_code,
                 COALESCE(gr.player_count, 0) AS player_count,
                 pr.user_id AS owner_id,
                 u.nickname  AS owner_nickname
          FROM player_residences pr
          JOIN users u         ON u.id  = pr.user_id
          JOIN municipalities m ON m.id = pr.municipality_id
          JOIN game_rooms gr   ON gr.municipality_id = m.id
                              AND gr.room_code = pr.room_code
                              AND gr.is_active = 1
          LEFT JOIN user_room_settings urs ON urs.user_id = pr.user_id
          WHERE gr.player_count > 0
        )
        UNION ALL
        (
          SELECT 'public' AS type,
                 gr.city_name AS room_name,
                 m.name  AS municipality_name,
                 m.slug  AS municipality_slug,
                 gr.room_code,
                 COALESCE(gr.player_count, 0) AS player_count,
                 NULL AS owner_id,
                 NULL AS owner_nickname
          FROM game_rooms gr
          JOIN municipalities m ON m.id = gr.municipality_id
          WHERE gr.room_code LIKE 'PUB%'
            AND gr.is_active = 1
            AND gr.player_count > 0
        )
        ORDER BY player_count DESC
        LIMIT 60`
      );

      const rooms = (Array.isArray(rows) ? rows : []).map((r) => ({
        type:              String(r.type),
        municipality_name: String(r.municipality_name || ''),
        municipality_slug: String(r.municipality_slug || ''),
        room_code:         String(r.room_code || ''),
        room_name:         String(r.room_name || ''),
        player_count:      Math.max(0, Number(r.player_count || 0)),
        owner_id:          r.owner_id ? Number(r.owner_id) : null,
        owner_nickname:    r.owner_nickname || null,
      }));

      return sendJson(res, 200, { success: true, data: { rooms } });
    }

    // ── Haupt-Ansicht: Öffentliche Räume + aktive Private ────────────────────
    if (pathname === '/api/game/navigator/rooms' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      // Alle öffentlichen Räume (unabhängig von Spielerzahl)
      const [pubRows] = await dbPool.query(
        `SELECT gr.room_code, COALESCE(gr.city_name, m.name) AS room_name,
                m.name AS municipality_name, m.slug AS municipality_slug,
                COALESCE(gr.player_count, 0) AS player_count
         FROM game_rooms gr
         JOIN municipalities m ON m.id = gr.municipality_id
         WHERE gr.room_code LIKE 'PUB%' AND gr.is_active = 1
         ORDER BY gr.player_count DESC, m.name ASC`
      );

      // Aktive private Räume (player_count > 0), max 4, nach Spielerzahl sortiert
      const [privRows] = await dbPool.query(
        `SELECT pr.user_id AS owner_id, u.nickname AS owner_nickname,
                m.name AS municipality_name, m.slug AS municipality_slug,
                pr.room_code,
                COALESCE(urs.room_display_name, CONCAT(u.nickname, '\\'s Zimmer')) AS room_name,
                COALESCE(gr.player_count, 0) AS player_count
         FROM player_residences pr
         JOIN users u ON u.id = pr.user_id AND u.is_active = 1
         JOIN municipalities m ON m.id = pr.municipality_id AND m.is_active = 1
         JOIN game_rooms gr ON gr.municipality_id = m.id AND gr.room_code = pr.room_code AND gr.is_active = 1
         LEFT JOIN user_room_settings urs ON urs.user_id = pr.user_id
         WHERE gr.player_count > 0
         ORDER BY gr.player_count DESC
         LIMIT 4`
      );

      const publicRooms = (Array.isArray(pubRows) ? pubRows : []).map((r) => ({
        type: 'public',
        municipality_name: String(r.municipality_name || ''),
        municipality_slug: String(r.municipality_slug || ''),
        room_code:         String(r.room_code || ''),
        room_name:         String(r.room_name || ''),
        player_count:      Math.max(0, Number(r.player_count || 0)),
        owner_id:          null,
        owner_nickname:    null,
      }));

      const privateRooms = (Array.isArray(privRows) ? privRows : []).map((r) => ({
        type: 'private',
        municipality_name: String(r.municipality_name || ''),
        municipality_slug: String(r.municipality_slug || ''),
        room_code:         String(r.room_code || ''),
        room_name:         String(r.room_name || ''),
        player_count:      Math.max(0, Number(r.player_count || 0)),
        owner_id:          r.owner_id ? Number(r.owner_id) : null,
        owner_nickname:    r.owner_nickname || null,
      }));

      return sendJson(res, 200, { success: true, data: { publicRooms, privateRooms } });
    }

    // ── Meine Räume ───────────────────────────────────────────────────────────
    if (pathname === '/api/game/navigator/my-rooms' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      const rooms = [];

      // 0. Gemeinde des Users ermitteln (wird auch für MAIN-Raum gebraucht)
      const [[userRowEarly]] = await dbPool.query(
        `SELECT u.municipality_id, m.slug AS municipality_slug, m.name AS municipality_name,
                mm.role AS municipality_role
         FROM users u
         LEFT JOIN municipalities m ON m.id = u.municipality_id
         LEFT JOIN municipality_memberships mm ON mm.municipality_id = m.id AND mm.user_id = u.id
         WHERE u.id = ?`, [authUser.id]
      );

      // Persönliches Zimmer (MAIN) immer als erstes anzeigen
      if (userRowEarly && userRowEarly.municipality_id) {
        const [mainRoomRows] = await dbPool.query(
          `SELECT COALESCE(player_count, 0) AS player_count
           FROM game_rooms
           WHERE municipality_id = ? AND room_code = 'MAIN' AND is_active = 1
           LIMIT 1`,
          [userRowEarly.municipality_id]
        );
        const mainRoomRow = mainRoomRows[0] || null;
        const [mainVisitRows] = await dbPool.query(
          `SELECT MAX(visited_at) AS visited_at, COUNT(*) AS visit_count
           FROM user_room_visits
           WHERE user_id = ? AND room_code = 'MAIN'`,
          [authUser.id]
        );
        const mainVisitRow = mainVisitRows[0] || null;
        // Eigenen Anzeigenamen + Schloss-Status + Beschreibung aus user_room_settings holen
        const [settingsRows] = await dbPool.query(
          `SELECT room_display_name, is_locked, room_description FROM user_room_settings WHERE user_id = ? LIMIT 1`,
          [authUser.id]
        );
        const customName = settingsRows[0]?.room_display_name || null;
        const mainIsLocked = settingsRows[0]?.is_locked ? true : false;
        const mainDesc = settingsRows[0]?.room_description ? String(settingsRows[0].room_description) : null;
        rooms.push({
          type:              'private',
          municipality_id:   Number(userRowEarly.municipality_id),
          municipality_name: String(userRowEarly.municipality_name || ''),
          municipality_slug: String(userRowEarly.municipality_slug || ''),
          room_code:         'MAIN',
          room_name:         customName || 'Mein Zimmer',
          room_description:  mainDesc,
          player_count:      Math.max(0, Number(mainRoomRow?.player_count || 0)),
          owner_id:          authUser.id,
          last_visited_at:   mainVisitRow?.visited_at || null,
          visit_count:       Number(mainVisitRow?.visit_count || 0),
          is_personal:       true,
          is_locked:         mainIsLocked,
        });
      }

      // 1. Eigene private Zimmer aus player_residences (mit letztem Besuch)
      const [privRows] = await dbPool.query(
        `SELECT
           pr.room_code,
           m.id   AS municipality_id,
           m.name AS municipality_name,
           m.slug AS municipality_slug,
           COALESCE(gr.player_count, 0) AS player_count,
           rv.visited_at AS last_visited_at,
           rv.visit_count
         FROM player_residences pr
         JOIN municipalities m ON m.id = pr.municipality_id
         LEFT JOIN game_rooms gr
           ON gr.municipality_id = m.id
          AND gr.room_code = pr.room_code
          AND gr.is_active = 1
         LEFT JOIN (
           SELECT municipality_slug, room_code,
                  MAX(visited_at) AS visited_at,
                  COUNT(*) AS visit_count
           FROM user_room_visits
           WHERE user_id = ?
           GROUP BY municipality_slug, room_code
         ) rv ON rv.municipality_slug = m.slug AND rv.room_code = pr.room_code
         WHERE pr.user_id = ?
         ORDER BY m.name ASC`,
        [authUser.id, authUser.id]
      );
      for (const r of (Array.isArray(privRows) ? privRows : [])) {
        rooms.push({
          type:              'private',
          municipality_id:   Number(r.municipality_id),
          municipality_name: String(r.municipality_name || ''),
          municipality_slug: String(r.municipality_slug || ''),
          room_code:         String(r.room_code || ''),
          room_name:         'Mein Zimmer',
          player_count:      Math.max(0, Number(r.player_count || 0)),
          last_visited_at:   r.last_visited_at || null,
          visit_count:       Number(r.visit_count || 0),
        });
      }

      // 2. Öffentliche Räume der eigenen Gemeinde (nur für admin/mod/mayor)
      const globalRole = await getUserGlobalRole(authUser.id);
      const role = String(globalRole || '').toLowerCase();
      const isGlobalAdmin = role === GLOBAL_ROLE_MODERATOR || role === GLOBAL_ROLE_ADMINISTRATOR;

      const userRow = userRowEarly;
      const isMayor = userRow && userRow.municipality_role === 'owner';

      if (userRow && userRow.municipality_id && (isGlobalAdmin || isMayor)) {
        const [pubRows] = await dbPool.query(
          `SELECT room_code, city_name AS room_name, COALESCE(player_count, 0) AS player_count
           FROM game_rooms
           WHERE municipality_id = ? AND is_active = 1 AND room_code LIKE 'PUB%'
           ORDER BY room_code ASC`,
          [userRow.municipality_id]
        );
        for (const r of (Array.isArray(pubRows) ? pubRows : [])) {
          rooms.push({
            type:              'public',
            municipality_id:   Number(userRow.municipality_id),
            municipality_name: String(userRow.municipality_name || ''),
            municipality_slug: String(userRow.municipality_slug || ''),
            room_code:         String(r.room_code || ''),
            room_name:         String(r.room_name || r.room_code),
            player_count:      Math.max(0, Number(r.player_count || 0)),
          });
        }
      }

      return sendJson(res, 200, { success: true, data: { rooms } });
    }

    // ── Zuletzt besuchte Räume ────────────────────────────────────────────────
    if (pathname === '/api/game/navigator/recent' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      const limit = Math.min(20, Math.max(1, Number(requestUrl.searchParams.get('limit')) || 10));
      const [rows] = await dbPool.query(
        `SELECT urv.municipality_id, urv.municipality_slug, urv.municipality_name,
                urv.room_code, urv.room_name, urv.visited_at,
                pr.user_id AS owner_user_id
         FROM user_room_visits urv
         LEFT JOIN municipalities m ON m.slug = urv.municipality_slug
         LEFT JOIN player_residences pr ON pr.municipality_id = m.id AND pr.room_code = urv.room_code
         WHERE urv.user_id = ?
         ORDER BY urv.visited_at DESC
         LIMIT ?`,
        [authUser.id, limit]
      );
      const visits = (Array.isArray(rows) ? rows : []).map((row) => ({
        municipality_id:   Number(row.municipality_id),
        municipality_slug: String(row.municipality_slug || ''),
        municipality_name: String(row.municipality_name || ''),
        room_code:         String(row.room_code || ''),
        room_name:         String(row.room_name || ''),
        visited_at:        row.visited_at || null,
        owner_user_id:     row.owner_user_id ? Number(row.owner_user_id) : null,
      }));
      return sendJson(res, 200, { success: true, data: { visits, count: visits.length } });
    }

    // ── Favoriten: Liste ─────────────────────────────────────────────────────────
    if (pathname === '/api/game/navigator/favorites' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `SELECT f.municipality_slug, f.municipality_name, f.room_code,
                COALESCE(urs.room_display_name, f.room_name) AS room_name,
                f.owner_user_id,
                u.nickname AS owner_nickname,
                COALESCE(gr.player_count, 0) AS player_count,
                COALESCE(urs.is_locked, 0)   AS is_locked,
                f.added_at
         FROM user_room_favorites f
         LEFT JOIN users u          ON u.id = f.owner_user_id
         LEFT JOIN municipalities m ON m.slug = f.municipality_slug
         LEFT JOIN game_rooms gr    ON gr.municipality_id = m.id
                                   AND gr.room_code = f.room_code AND gr.is_active = 1
         LEFT JOIN user_room_settings urs ON urs.user_id = f.owner_user_id
         WHERE f.user_id = ?
         ORDER BY f.added_at DESC`,
        [authUser.id]
      );

      const favorites = (Array.isArray(rows) ? rows : []).map((r) => ({
        municipality_slug: String(r.municipality_slug || ''),
        municipality_name: String(r.municipality_name || ''),
        room_code:         String(r.room_code || ''),
        room_name:         String(r.room_name || ''),
        owner_user_id:     r.owner_user_id ? Number(r.owner_user_id) : null,
        owner_nickname:    r.owner_nickname || null,
        player_count:      Math.max(0, Number(r.player_count || 0)),
        is_locked:         r.is_locked ? true : false,
        added_at:          r.added_at || null,
      }));

      return sendJson(res, 200, { success: true, data: { favorites } });
    }

    // ── Favoriten: Hinzufügen ────────────────────────────────────────────────────
    if (pathname === '/api/game/navigator/favorites' && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      const { readJsonBody } = require('../../../infra/http');
      const body = await readJsonBody(req);
      const slug      = String(body?.municipality_slug || '').trim().toLowerCase().slice(0, 100);
      const roomCode  = String(body?.room_code || '').trim().toUpperCase().slice(0, 50);
      const roomName  = String(body?.room_name || '').trim().slice(0, 80);
      const muniName  = String(body?.municipality_name || '').trim().slice(0, 100);
      const ownerUid  = body?.owner_user_id ? Number(body.owner_user_id) || null : null;

      if (!slug || !roomCode) return sendJson(res, 400, { success: false, error: 'municipality_slug und room_code erforderlich' });

      await dbPool.query(
        `INSERT INTO user_room_favorites
           (user_id, municipality_slug, municipality_name, room_code, room_name, owner_user_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE room_name = VALUES(room_name), municipality_name = VALUES(municipality_name)`,
        [authUser.id, slug, muniName, roomCode, roomName, ownerUid]
      );

      return sendJson(res, 200, { success: true });
    }

    // ── Favoriten: Entfernen ─────────────────────────────────────────────────────
    if (pathname === '/api/game/navigator/favorites' && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      const slug     = String(requestUrl.searchParams.get('slug') || '').trim().toLowerCase();
      const roomCode = String(requestUrl.searchParams.get('room_code') || '').trim().toUpperCase();

      if (!slug || !roomCode) return sendJson(res, 400, { success: false, error: 'slug und room_code erforderlich' });

      await dbPool.query(
        `DELETE FROM user_room_favorites WHERE user_id = ? AND municipality_slug = ? AND room_code = ?`,
        [authUser.id, slug, roomCode]
      );

      return sendJson(res, 200, { success: true });
    }

    // ── Favoriten: Status eines Raums prüfen (bulk) ──────────────────────────────
    if (pathname === '/api/game/navigator/favorites/check' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `SELECT municipality_slug, room_code FROM user_room_favorites WHERE user_id = ?`,
        [authUser.id]
      );
      const set = (Array.isArray(rows) ? rows : []).map(r => `${r.municipality_slug}:${r.room_code}`);
      return sendJson(res, 200, { success: true, data: { favoriteKeys: set } });
    }

  };
};
