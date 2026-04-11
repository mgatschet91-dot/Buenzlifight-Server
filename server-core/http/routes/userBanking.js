'use strict';

const { sendJson } = require('../../infra/http');
const { ensureDbEnabled } = require('../../infra/db');
const { getAuthenticatedUser } = require('../../auth/middleware');
const {
  ensureUserBankingProfile,
  getUserBankingProfile,
  listUserBankTransactions,
} = require('../../game/userBanking');

module.exports = function registerUserBankingRoutes(/* deps */) {
  return async function handleUserBanking(req, res, pathname, requestUrl) {
    if (req.method === 'GET' && pathname === '/api/banking/me') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      try {
        await ensureUserBankingProfile(authUser.id);
        const profile = await getUserBankingProfile(authUser.id, { includeSensitive: true });
        if (!profile) return sendJson(res, 404, { ok: false, error: 'Bankprofil nicht gefunden' });
        return sendJson(res, 200, { ok: true, data: profile });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err?.message || 'Bankprofil konnte nicht geladen werden' });
      }
    }

    if (req.method === 'GET' && pathname === '/api/banking/me/transactions') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      try {
        const url = requestUrl || new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

        await ensureUserBankingProfile(authUser.id);
        const result = await listUserBankTransactions(authUser.id, { limit, offset });
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err?.message || 'Transaktionen konnten nicht geladen werden' });
      }
    }
  };
};
