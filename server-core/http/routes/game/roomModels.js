'use strict';

const { sendJson } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');

module.exports = function registerRoomModelsRoutes(_deps) {
  return async function handleRoomModels(req, res, pathname /*, requestUrl */) {

    // GET /api/game/room-models
    if (pathname === '/api/game/room-models' && req.method === 'GET') {
      ensureDbEnabled();
      const [rows] = await dbPool.query(
        `SELECT model_name, display_name, is_default, sort_order
         FROM room_models
         ORDER BY sort_order ASC, id ASC`
      );
      return sendJson(res, 200, { ok: true, data: { models: rows } });
    }
  };
};
