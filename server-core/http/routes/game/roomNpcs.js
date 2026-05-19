'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

async function resolveMunicipalityId(slug, directId) {
  if (directId && Number(directId) > 0) return Number(directId);
  if (!slug) return null;
  const [rows] = await dbPool.query(
    'SELECT id FROM municipalities WHERE slug = ? AND is_active = 1 LIMIT 1',
    [String(slug)]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

module.exports = function registerRoomNpcRoutes(_deps) {
  return async function handleRoomNpcs(req, res, pathname, requestUrl) {

    // GET /api/game/user/room/npcs?user_id=X&municipality_slug=xxx
    if (pathname === '/api/game/user/room/npcs' && req.method === 'GET') {
      ensureDbEnabled();
      const params = new URL(requestUrl, 'http://x').searchParams;
      const ownerId = parseInt(params.get('user_id') || '0', 10);
      const municipalitySlug = params.get('municipality_slug') || '';
      const municipalityIdParam = params.get('municipality_id') || '';

      let targetId = ownerId;
      if (!targetId) {
        const user = await getAuthenticatedUser(req);
        if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
        targetId = user.id;
      }

      const municipalityId = await resolveMunicipalityId(municipalitySlug, municipalityIdParam);

      let rows;
      if (municipalityId) {
        [rows] = await dbPool.query(
          `SELECT id, npc_name, npc_style, x, z, facing_idx, floor_level
           FROM room_npcs WHERE user_id = ? AND municipality_id = ? ORDER BY id ASC`,
          [targetId, municipalityId]
        );
      } else {
        [rows] = await dbPool.query(
          `SELECT id, npc_name, npc_style, x, z, facing_idx, floor_level
           FROM room_npcs WHERE user_id = ? AND municipality_id IS NULL ORDER BY id ASC`,
          [targetId]
        );
      }
      return sendJson(res, 200, { ok: true, data: { npcs: rows } });
    }

    // POST /api/game/user/room/npcs
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

      const municipalityId = await resolveMunicipalityId(
        body.municipality_slug || null,
        body.municipality_id || null
      );

      const [result] = await dbPool.query(
        `INSERT INTO room_npcs (user_id, municipality_id, npc_name, npc_style, x, z, facing_idx, floor_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [user.id, municipalityId || null, npcName, npcStyle, x, z, facingIdx, floorLevel]
      );
      return sendJson(res, 200, { ok: true, data: { id: result.insertId } });
    }

    // PATCH /api/game/user/room/npcs/:id
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
