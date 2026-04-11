'use strict';

const { sendJson } = require('../../infra/http');
const { lookupUserByReferralCode } = require('../../game/referral');

module.exports = function registerReferralRoutes(/* deps */) {
  return async function handleReferral(req, res, pathname) {

    // GET /api/referral/validate?code=XXXXXXXX
    if (req.method === 'GET' && pathname === '/api/referral/validate') {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const code = (url.searchParams.get('code') || '').toUpperCase().trim();
      if (!code) return sendJson(res, 400, { ok: false, error: 'Code fehlt' });

      const referrer = await lookupUserByReferralCode(code);
      if (!referrer) return sendJson(res, 200, { ok: false, error: 'Unbekannter Code' });

      return sendJson(res, 200, { ok: true, referrer_nickname: referrer.nickname });
    }

    return null; // Route nicht gefunden → nächster Handler
  };
};
