'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

module.exports = function registerRoomFurnitureRoutes(_deps) {
  return async function handleRoomFurniture(req, res, pathname, requestUrl) {

    // GET /api/game/user/room/furniture?user_id=123
    // Alle platzierten Möbel eines Raums (public — für Besucher)
    if (pathname === '/api/game/user/room/furniture' && req.method === 'GET') {
      ensureDbEnabled();
      const params = new URL(requestUrl, 'http://x').searchParams;
      const ownerId = parseInt(params.get('user_id') || '0', 10);

      // If no user_id given, require auth and use own room
      let targetId = ownerId;
      if (!targetId) {
        const user = await getAuthenticatedUser(req);
        if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
        targetId = user.id;
      }

      const [rows] = await dbPool.query(
        `SELECT id, item_code, x, z, floor_level, facing_idx, wy FROM room_furniture WHERE user_id = ? ORDER BY id ASC`,
        [targetId]
      );
      return sendJson(res, 200, { ok: true, data: { placements: rows } });
    }

    // POST /api/game/user/room/furniture
    // Item platzieren → in room_furniture speichern
    if (pathname === '/api/game/user/room/furniture' && req.method === 'POST') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const body     = await readJsonBody(req);
      const itemCode = (body.item_code || '').toString().trim();
      const x        = parseFloat(body.x);
      const z        = parseFloat(body.z);
      const floorLevel = parseInt(body.floor_level ?? 0, 10);
      const facingIdx = parseInt(body.facing_idx ?? body.facingIdx ?? 0, 10);
      const wy       = body.wy != null ? parseFloat(body.wy) : null;

      if (!itemCode || isNaN(x) || isNaN(z)) {
        return sendJson(res, 422, { ok: false, error: 'item_code, x, z erforderlich' });
      }

      const [result] = await dbPool.query(
        `INSERT INTO room_furniture (user_id, item_code, x, z, floor_level, facing_idx, wy) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [user.id, itemCode, x, z, floorLevel, facingIdx, wy]
      );
      return sendJson(res, 200, { ok: true, data: { id: result.insertId } });
    }

    // PATCH /api/game/user/room/furniture/:id
    // Möbel verschieben/drehen (server-autoritativ, keine Duplikate)
    const patchMatch = pathname.match(/^\/api\/game\/user\/room\/furniture\/(\d+)$/)
    if (patchMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const id   = parseInt(patchMatch[1], 10);
      const body = await readJsonBody(req);
      const x          = parseFloat(body.x);
      const z          = parseFloat(body.z);
      const floorLevel = parseInt(body.floor_level ?? 0, 10);
      const facingIdx  = parseInt(body.facing_idx ?? body.facingIdx ?? 0, 10);
      const wy         = body.wy != null ? parseFloat(body.wy) : null;

      if (isNaN(x) || isNaN(z)) {
        return sendJson(res, 422, { ok: false, error: 'x, z erforderlich' });
      }

      const [result] = await dbPool.query(
        `UPDATE room_furniture SET x = ?, z = ?, floor_level = ?, facing_idx = ?, wy = ?
         WHERE id = ? AND user_id = ?`,
        [x, z, floorLevel, facingIdx, wy, id, user.id]
      );

      if (result.affectedRows === 0) {
        return sendJson(res, 404, { ok: false, error: 'Eintrag nicht gefunden' });
      }
      return sendJson(res, 200, { ok: true, data: { id } });
    }

    // DELETE /api/game/user/room/furniture/by-pos
    // Fallback: Item nach Koordinaten löschen (wenn server_id noch nicht bekannt)
    if (pathname === '/api/game/user/room/furniture/by-pos' && req.method === 'DELETE') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const body      = await readJsonBody(req);
      const itemCode  = (body.item_code || '').toString().trim();
      const x         = parseFloat(body.x);
      const z         = parseFloat(body.z);

      if (!itemCode || isNaN(x) || isNaN(z)) {
        return sendJson(res, 422, { ok: false, error: 'item_code, x, z erforderlich' });
      }

      await dbPool.query(
        `DELETE FROM room_furniture
         WHERE user_id = ? AND item_code = ?
           AND ABS(x - ?) < 0.1 AND ABS(z - ?) < 0.1
         LIMIT 1`,
        [user.id, itemCode, x, z]
      );
      return sendJson(res, 200, { ok: true });
    }

    // DELETE /api/game/user/room/furniture/:id
    // Platziertes Item entfernen
    const delMatch = pathname.match(/^\/api\/game\/user\/room\/furniture\/(\d+)$/)
    if (delMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const id = parseInt(delMatch[1], 10);
      await dbPool.query(
        `DELETE FROM room_furniture WHERE id = ? AND user_id = ?`,
        [id, user.id]
      );
      return sendJson(res, 200, { ok: true });
    }
  };
};
