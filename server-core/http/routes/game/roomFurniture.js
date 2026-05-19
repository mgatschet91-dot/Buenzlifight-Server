'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

// Hilfsfunktion: municipality_id aus Slug oder direktem Param auflösen
async function resolveMunicipalityId(slug, directId) {
  if (directId && Number(directId) > 0) return Number(directId);
  if (!slug) return null;
  const [rows] = await dbPool.query(
    'SELECT id FROM municipalities WHERE slug = ? AND is_active = 1 LIMIT 1',
    [String(slug)]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

module.exports = function registerRoomFurnitureRoutes(_deps) {
  return async function handleRoomFurniture(req, res, pathname, requestUrl) {

    // GET /api/game/user/room/furniture?user_id=123&municipality_slug=xxx
    if (pathname === '/api/game/user/room/furniture' && req.method === 'GET') {
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
          `SELECT id, item_code, x, z, floor_level, facing_idx, wy, pair_id
           FROM room_furniture WHERE user_id = ? AND municipality_id = ? ORDER BY id ASC`,
          [targetId, municipalityId]
        );
      } else {
        // Fallback ohne municipality — zeigt legacy-Daten (NULL municipality)
        [rows] = await dbPool.query(
          `SELECT id, item_code, x, z, floor_level, facing_idx, wy, pair_id
           FROM room_furniture WHERE user_id = ? AND municipality_id IS NULL ORDER BY id ASC`,
          [targetId]
        );
      }
      return sendJson(res, 200, { ok: true, data: { placements: rows } });
    }

    // POST /api/game/user/room/furniture
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
      const pairId   = body.pair_id != null ? parseInt(body.pair_id, 10) : null;

      if (!itemCode || isNaN(x) || isNaN(z)) {
        return sendJson(res, 422, { ok: false, error: 'item_code, x, z erforderlich' });
      }

      const municipalityId = await resolveMunicipalityId(
        body.municipality_slug || null,
        body.municipality_id || null
      );

      const [result] = await dbPool.query(
        `INSERT INTO room_furniture (user_id, municipality_id, item_code, x, z, floor_level, facing_idx, wy, pair_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [user.id, municipalityId || null, itemCode, x, z, floorLevel, facingIdx, wy, pairId]
      );
      return sendJson(res, 200, { ok: true, data: { id: result.insertId } });
    }

    // PATCH /api/game/user/room/furniture/:id
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

      const municipalityId = await resolveMunicipalityId(
        body.municipality_slug || null,
        body.municipality_id || null
      );

      if (municipalityId) {
        await dbPool.query(
          `DELETE FROM room_furniture
           WHERE user_id = ? AND municipality_id = ? AND item_code = ?
             AND ABS(x - ?) < 0.1 AND ABS(z - ?) < 0.1
           LIMIT 1`,
          [user.id, municipalityId, itemCode, x, z]
        );
      } else {
        await dbPool.query(
          `DELETE FROM room_furniture
           WHERE user_id = ? AND item_code = ?
             AND ABS(x - ?) < 0.1 AND ABS(z - ?) < 0.1
           LIMIT 1`,
          [user.id, itemCode, x, z]
        );
      }
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/game/user/room/furniture/teleport?furniture_id=X
    if (pathname === '/api/game/user/room/furniture/teleport' && req.method === 'GET') {
      ensureDbEnabled();
      const params = new URL(requestUrl, 'http://x').searchParams;
      const furnitureId = parseInt(params.get('furniture_id') || '0', 10);
      if (!furnitureId) return sendJson(res, 422, { ok: false, error: 'furniture_id erforderlich' });

      const [rows] = await dbPool.query(
        `SELECT rf2.id AS target_furniture_id, rf2.user_id AS target_user_id,
                rf2.x, rf2.z, rf2.floor_level
         FROM room_furniture rf1
         JOIN room_furniture rf2 ON rf2.pair_id = rf1.pair_id AND rf2.id != rf1.id
         WHERE rf1.id = ? AND rf1.pair_id IS NOT NULL
         LIMIT 1`,
        [furnitureId]
      );
      if (!rows[0]) return sendJson(res, 404, { ok: false, error: 'Kein verknüpfter Teleporter gefunden' });
      return sendJson(res, 200, { ok: true, data: rows[0] });
    }

    // DELETE /api/game/user/room/furniture/:id
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
