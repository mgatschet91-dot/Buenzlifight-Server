'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

const {
  getUserAvatarConfig,
  upsertUserAvatarConfig,
  adjustUserInventoryItem,
} = require('../../../game/municipality');

const {
  normalizeInventoryItemCode,
} = require('../../../shared/helpers');

module.exports = function registerUserDataRoutes(/* deps */) {
  return async function handleUserData(req, res, pathname /*, requestUrl */) {

    // ── User data: avatar-config ───────────────────────────────
    if (pathname === '/api/game/user-data/avatar-config' && (req.method === 'GET' || req.method === 'PUT')) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      if (req.method === 'GET') {
        const avatarConfig = await getUserAvatarConfig(authUser.id);
        return sendJson(res, 200, {
          success: true,
          data: {
            user_id: Number(authUser.id),
            avatar_config: avatarConfig,
          avatar_figure: String(avatarConfig?.figure || ''),
          },
        });
      }

      const body = await readJsonBody(req);
      const avatarConfig = await upsertUserAvatarConfig(authUser.id, body?.avatar_config || body || {});
      return sendJson(res, 200, {
        success: true,
        data: {
          user_id: Number(authUser.id),
          avatar_config: avatarConfig,
          avatar_figure: String(avatarConfig?.figure || ''),
          message: 'Avatar-Konfiguration gespeichert',
        },
      });
    }

    // Inventory PATCH: Wird vom mapGame-Client beim Furni-Platzieren genutzt (Menge reduzieren).
    // GET/PUT/DELETE entfernt – Inventar-UI läuft über den Bobba-Client (WebSocket).
    if (pathname === '/api/game/user-data/inventory' && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      const body = await readJsonBody(req);
      const itemCode = normalizeInventoryItemCode(body?.item_code || body?.itemCode || body?.code);
      if (!itemCode) {
        return sendJson(res, 422, { success: false, error: 'item_code ist erforderlich' });
      }

      const delta = Math.round(Number(body?.delta || 0));
      if (!Number.isFinite(delta) || delta === 0) {
        return sendJson(res, 422, { success: false, error: 'delta muss ungleich 0 sein' });
      }
      const metadata = body?.metadata && typeof body.metadata === 'object' ? body.metadata : null;
      const item = await adjustUserInventoryItem(authUser.id, itemCode, delta, metadata);
      return sendJson(res, 200, {
        success: true,
        data: {
          user_id: Number(authUser.id),
          item,
          delta,
          message: 'Inventar angepasst',
        },
      });
    }

  };
};
