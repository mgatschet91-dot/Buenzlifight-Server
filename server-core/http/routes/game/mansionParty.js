'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { startParty, stopParty, getActivePartiesForRoom } = require('../../../game/partyEvents');
const { wsRoomKey } = require('../../../ws/socketio/helpers');

module.exports = function registerMansionPartyRoutes(deps) {
  const io = deps?.io;
  return async function handleMansionParty(req, res, pathname, _requestUrl) {

    // POST /api/game/municipality/:slug/mansion-party/start
    const startMatch = pathname.match(/^\/api\/game\/municipality\/([^/]+)\/mansion-party\/start$/i);
    if (startMatch && req.method === 'POST') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const slug = startMatch[1];
      const body = await readJsonBody(req);
      const tileX = Number(body.tile_x);
      const tileY = Number(body.tile_y);
      const roomCode = (body.room_code || '').toString().trim();

      if (!Number.isInteger(tileX) || !Number.isInteger(tileY) || !roomCode) {
        return sendJson(res, 422, { ok: false, error: 'tile_x, tile_y und room_code erforderlich' });
      }

      const [muniRows] = await dbPool.query(
        'SELECT id FROM municipalities WHERE slug = ? LIMIT 1', [slug]
      );
      const muni = muniRows[0];
      if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const [residenceRows] = await dbPool.query(
        `SELECT pr.id FROM player_residences pr
         JOIN game_items gi ON gi.municipality_id = pr.municipality_id
           AND gi.x = pr.tile_x AND gi.y = pr.tile_y AND gi.room_code = pr.room_code
         WHERE pr.municipality_id = ? AND pr.tile_x = ? AND pr.tile_y = ?
           AND pr.room_code = ? AND pr.user_id = ?
           AND gi.tool = 'mansion'
         LIMIT 1`,
        [muni.id, tileX, tileY, roomCode, user.id]
      );
      if (!residenceRows[0]) {
        return sendJson(res, 403, { ok: false, error: 'Du besitzt kein Mansion an dieser Position' });
      }

      try {
        await startParty(user.id, muni.id, tileX, tileY, roomCode);

        // Sofort an Room broadcasten damit alle Clients es sehen ohne auf den nächsten Tick zu warten
        if (io) {
          const roomSocketKey = wsRoomKey(slug, roomCode);
          const parties = await getActivePartiesForRoom(roomCode);
          io.to(roomSocketKey).emit('party-authoritative', {
            parties,
            serverTimestamp: Date.now(),
          });
        }

        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 409, { ok: false, error: err.message });
      }
    }

    // POST /api/game/municipality/:slug/mansion-party/stop
    const stopMatch = pathname.match(/^\/api\/game\/municipality\/([^/]+)\/mansion-party\/stop$/i);
    if (stopMatch && req.method === 'POST') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const slug = stopMatch[1];
      const body = await readJsonBody(req);
      const partyId = Number(body.party_id);
      if (!Number.isInteger(partyId) || partyId <= 0) {
        return sendJson(res, 422, { ok: false, error: 'party_id erforderlich' });
      }

      // Room-Code der Party nachladen (für Broadcast)
      const [partyRows] = await dbPool.query(
        'SELECT room_code FROM mansion_parties WHERE id = ? AND owner_id = ? LIMIT 1',
        [partyId, user.id]
      );
      const roomCode = partyRows[0]?.room_code;

      try {
        await stopParty(partyId, user.id);

        // Sofort aktualisierten State an Room broadcasten (korrekter wsRoomKey!)
        if (io && roomCode) {
          const roomSocketKey = wsRoomKey(slug, roomCode);
          const remaining = await getActivePartiesForRoom(roomCode);
          io.to(roomSocketKey).emit('party-authoritative', {
            parties: remaining,
            serverTimestamp: Date.now(),
          });
        }

        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 404, { ok: false, error: err.message });
      }
    }
  };
};
