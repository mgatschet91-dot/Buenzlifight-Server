'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { manualKontrolle } = require('../../../game/parkingSystem');
const { wsRoomKey } = require('../../../ws/socketio/helpers');
const { dbPool } = require('../../../infra/db');

module.exports = function registerParkingKontrolleRoutes(deps) {
  return async function handleParkingKontrolle(req, res, pathname) {

    // POST /api/parking/kontrolle
    if (req.method === 'POST' && pathname === '/api/parking/kontrolle') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const body = await readJsonBody(req);
      const tileX = Number(body.tileX);
      const tileY = Number(body.tileY);
      const slot  = Number(body.slot);
      if (isNaN(tileX) || isNaN(tileY) || isNaN(slot) || slot < 0 || slot > 7) {
        return sendJson(res, 400, { ok: false, error: 'tileX, tileY und slot (0-7) erforderlich' });
      }

      const result = await manualKontrolle(tileX, tileY, slot, authUser.id);
      if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });

      // Fahrzeug wegschicken via Socket wenn Busse ausgestellt
      if (result.hasViolation && deps?.io) {
        try {
          const [[muni]] = await dbPool.query(
            `SELECT slug FROM municipalities WHERE id = ?`, [result.municipalityId]
          );
          if (muni?.slug) {
            const roomKey = wsRoomKey(muni.slug, 'MAIN');
            deps.io.to(roomKey).emit('vehicle-left-parking', { tileX, tileY, slot });
          }
        } catch (_e) { /* silent */ }
      }

      return sendJson(res, 200, { ok: true, data: result });
    }
  };
};
