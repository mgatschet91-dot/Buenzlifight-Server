'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

module.exports = function registerRoomNpcRoutes(_deps) {
  return async function handleRoomNpcs(req, res, pathname, requestUrl) {

    // GET /api/game/user/room/npcs?user_id=X
    // Alle platzierten NPCs eines Raums (public — für Besucher)
    if (pathname === '/api/game/user/room/npcs' && req.method === 'GET') {
      ensureDbEnabled();
      const params = new URL(requestUrl, 'http://x').searchParams;
      const ownerId = parseInt(params.get('user_id') || '0', 10);

      let targetId = ownerId;
      if (!targetId) {
        const user = await getAuthenticatedUser(req);
        if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
        targetId = user.id;
      }

      const [rows] = await dbPool.query(
        `SELECT id, npc_name, npc_style, x, z, facing_idx, floor_level FROM room_npcs WHERE user_id = ? ORDER BY id ASC`,
        [targetId]
      );
      return sendJson(res, 200, { ok: true, data: { npcs: rows } });
    }

    // POST /api/game/user/room/npcs
    // NPC platzieren (aus Inventar heraus)
    if (pathname === '/api/game/user/room/npcs' && req.method === 'POST') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const body       = await readJsonBody(req);
      const npcName    = (body.npc_name || 'NPC').toString().trim().slice(0, 32);
      const npcStyle   = Math.max(1, Math.min(3, parseInt(body.npc_style ?? 1, 10)));
      const x          = parseFloat(body.x);
      const z          = parseFloat(body.z);
      const facingIdx  = parseInt(body.facing_idx ?? 0, 10);
      const floorLevel = parseInt(body.floor_level ?? 0, 10);

      if (isNaN(x) || isNaN(z)) {
        return sendJson(res, 422, { ok: false, error: 'x, z erforderlich' });
      }

      const [result] = await dbPool.query(
        `INSERT INTO room_npcs (user_id, npc_name, npc_style, x, z, facing_idx, floor_level)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [user.id, npcName, npcStyle, x, z, facingIdx, floorLevel]
      );
      return sendJson(res, 200, { ok: true, data: { id: result.insertId } });
    }

    // PATCH /api/game/user/room/npcs/:id
    // NPC verschieben/drehen
    const patchMatch = pathname.match(/^\/api\/game\/user\/room\/npcs\/(\d+)$/);
    if (patchMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const id   = parseInt(patchMatch[1], 10);
      const body = await readJsonBody(req);
      const x          = parseFloat(body.x);
      const z          = parseFloat(body.z);
      const facingIdx  = parseInt(body.facing_idx ?? 0, 10);
      const floorLevel = parseInt(body.floor_level ?? 0, 10);

      if (isNaN(x) || isNaN(z)) {
        return sendJson(res, 422, { ok: false, error: 'x, z erforderlich' });
      }

      const [result] = await dbPool.query(
        `UPDATE room_npcs SET x = ?, z = ?, facing_idx = ?, floor_level = ?
         WHERE id = ? AND user_id = ?`,
        [x, z, facingIdx, floorLevel, id, user.id]
      );
      if (result.affectedRows === 0) {
        return sendJson(res, 404, { ok: false, error: 'NPC nicht gefunden' });
      }
      return sendJson(res, 200, { ok: true, data: { id } });
    }

    // DELETE /api/game/user/room/npcs/:id
    // NPC entfernen → zurück ins Inventar
    const delMatch = pathname.match(/^\/api\/game\/user\/room\/npcs\/(\d+)$/);
    if (delMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const id = parseInt(delMatch[1], 10);
      const [result] = await dbPool.query(
        `DELETE FROM room_npcs WHERE id = ? AND user_id = ?`,
        [id, user.id]
      );
      if (result.affectedRows === 0) {
        return sendJson(res, 404, { ok: false, error: 'NPC nicht gefunden' });
      }
      return sendJson(res, 200, { ok: true });
    }
  };
};
