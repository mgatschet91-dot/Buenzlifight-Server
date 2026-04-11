'use strict';

const { sendJson } = require('../../../infra/http');

module.exports = function registerHealthRoutes(/* deps */) {
  return async function handleHealth(req, res, pathname /*, requestUrl */) {

    // ── Health ──────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, phase: 1, service: 'auth-server' });
    }

  };
};
