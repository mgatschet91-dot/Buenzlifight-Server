'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

// Default avatar code: skin|hair|hairStyle|shirt|shirtStyle|pants|pantsStyle|shoe|shoeStyle|hat
const DEFAULT_AVATAR_CODE = 'ffd7aa|444444|short|5596aa|tshirt|334455|jeans|333333|basic|none';

// Validates that the code is a pipe-separated string of 10-20 segments
function isValidAvatarCode(code) {
  if (typeof code !== 'string') return false;
  const parts = code.split('|');
  if (parts.length < 10 || parts.length > 20) return false;
  return parts.every(p => p.length > 0 && p.length <= 50);
}

module.exports = function registerAvatarCodeRoutes(_deps) {
  return async function handleAvatarCode(req, res, pathname /*, requestUrl */) {

    // GET /api/game/user/avatar
    if (pathname === '/api/game/user/avatar' && req.method === 'GET') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const [rows] = await dbPool.query(
        'SELECT avatar_code FROM users WHERE id = ? LIMIT 1',
        [user.id]
      );
      const code = rows[0]?.avatar_code || DEFAULT_AVATAR_CODE;
      return sendJson(res, 200, { ok: true, data: { avatar_code: code } });
    }

    // PUT /api/game/user/avatar
    if (pathname === '/api/game/user/avatar' && req.method === 'PUT') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const body = await readJsonBody(req);
      const code = (body.avatar_code || '').toString().trim();
      if (!isValidAvatarCode(code)) {
        return sendJson(res, 422, { ok: false, error: 'Ungültiger avatar_code (10 pipe-getrennte Werte erwartet)' });
      }

      await dbPool.query(
        'UPDATE users SET avatar_code = ? WHERE id = ?',
        [code, user.id]
      );
      return sendJson(res, 200, { ok: true, data: { avatar_code: code } });
    }
  };
};
