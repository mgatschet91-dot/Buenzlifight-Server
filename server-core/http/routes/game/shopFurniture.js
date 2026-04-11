'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

module.exports = function registerShopFurnitureRoutes(_deps) {
  return async function handleShopFurniture(req, res, pathname /*, requestUrl */) {

    // GET /api/game/shop/furniture
    // Alle aktiven Shop-Items (öffentlich)
    if (pathname === '/api/game/shop/furniture' && req.method === 'GET') {
      ensureDbEnabled();
      const [rows] = await dbPool.query(
        `SELECT item_code, display_name, category, icon, price, sort_order, rotatable
         FROM shop_items
         WHERE is_active = 1
         ORDER BY category ASC, sort_order ASC, display_name ASC`
      );
      return sendJson(res, 200, { ok: true, data: { items: rows } });
    }

    // POST /api/game/shop/buy
    // Item kaufen → in user_inventory schreiben
    if (pathname === '/api/game/shop/buy' && req.method === 'POST') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const body = await readJsonBody(req);
      const itemCode = (body.item_code || '').toString().trim();
      const qty = Math.max(1, Number(body.quantity) || 1);

      if (!itemCode) return sendJson(res, 422, { ok: false, error: 'item_code erforderlich' });

      const [itemRows] = await dbPool.query(
        `SELECT item_code, display_name, price FROM shop_items
         WHERE item_code = ? COLLATE utf8mb4_unicode_ci AND is_active = 1 LIMIT 1`,
        [itemCode]
      );
      const item = itemRows[0];
      if (!item) return sendJson(res, 404, { ok: false, error: 'Item nicht gefunden' });

      // Teleporter: 1 kaufen = 2 Stück (müssen paarweise platziert werden)
      const actualQty = itemCode === 'teleporter' ? qty * 2 : qty;

      await dbPool.query(
        `INSERT INTO user_inventory (user_id, item_code, quantity)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), updated_at = NOW()`,
        [user.id, itemCode, actualQty]
      );

      return sendJson(res, 200, {
        ok: true,
        data: { item_code: itemCode, display_name: item.display_name, quantity_added: actualQty },
      });
    }

    // POST /api/game/user/inventory/place
    // Platziertes Item verbrauchen (Menge -1)
    if (pathname === '/api/game/user/inventory/place' && req.method === 'POST') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const body = await readJsonBody(req);
      const itemCode = (body.item_code || '').toString().trim();
      if (!itemCode) return sendJson(res, 422, { ok: false, error: 'item_code erforderlich' });

      const [result] = await dbPool.query(
        `UPDATE user_inventory
         SET quantity = GREATEST(0, quantity - 1), updated_at = NOW()
         WHERE user_id = ? AND item_code = ? AND quantity > 0`,
        [user.id, itemCode]
      );

      if (result.affectedRows === 0) {
        return sendJson(res, 409, { ok: false, error: 'Nicht genug im Inventar' });
      }

      const [rows] = await dbPool.query(
        `SELECT quantity FROM user_inventory WHERE user_id = ? AND item_code = ?`,
        [user.id, itemCode]
      );
      return sendJson(res, 200, { ok: true, data: { item_code: itemCode, quantity: rows[0]?.quantity ?? 0 } });
    }

    // POST /api/game/user/inventory/return
    // Aufnehmen: platziertes Möbel zurück ins Inventar legen (+1)
    if (pathname === '/api/game/user/inventory/return' && req.method === 'POST') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const body = await readJsonBody(req);
      const itemCode = (body.item_code || '').toString().trim();
      if (!itemCode) return sendJson(res, 422, { ok: false, error: 'item_code erforderlich' });

      // Sicherstellen dass das Item existiert (kein Cheat mit ungültigen Codes)
      const [itemRows] = await dbPool.query(
        `SELECT item_code FROM shop_items WHERE item_code = ? AND is_active = 1 LIMIT 1`,
        [itemCode]
      );
      if (!itemRows[0]) return sendJson(res, 404, { ok: false, error: 'Item nicht gefunden' });

      await dbPool.query(
        `INSERT INTO user_inventory (user_id, item_code, quantity)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE quantity = quantity + 1, updated_at = NOW()`,
        [user.id, itemCode]
      );

      const [rows] = await dbPool.query(
        `SELECT quantity FROM user_inventory WHERE user_id = ? AND item_code = ?`,
        [user.id, itemCode]
      );
      return sendJson(res, 200, { ok: true, data: { item_code: itemCode, quantity: rows[0]?.quantity ?? 1 } });
    }

    // GET /api/game/user/inventory/furniture
    // Möbel-Items im Inventar des angemeldeten Nutzers
    if (pathname === '/api/game/user/inventory/furniture' && req.method === 'GET') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const [rows] = await dbPool.query(
        `SELECT
           ui.item_code,
           ui.quantity,
           si.display_name,
           si.category,
           si.icon,
           si.price
         FROM user_inventory ui
         JOIN shop_items si ON si.item_code = ui.item_code COLLATE utf8mb4_unicode_ci
         WHERE ui.user_id = ?
           AND si.is_active = 1
           AND ui.quantity > 0
         ORDER BY si.category ASC, si.sort_order ASC`,
        [user.id]
      );
      return sendJson(res, 200, { ok: true, data: { items: rows } });
    }
  };
};
