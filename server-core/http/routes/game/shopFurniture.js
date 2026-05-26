'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

module.exports = function registerShopFurnitureRoutes(deps) {
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

      const totalCost = item.price * qty;

      const conn = await dbPool.getConnection();
      try {
        await conn.beginTransaction();

        // Kontostand prüfen und abbuchen (nur wenn Preis > 0)
        if (totalCost > 0) {
          const [accRows] = await conn.query(
            `SELECT id, balance FROM user_bank_accounts WHERE user_id = ? AND status = 'active' LIMIT 1`,
            [user.id]
          );
          if (!accRows.length) {
            await conn.rollback();
            conn.release();
            return sendJson(res, 400, { ok: false, error: 'Kein aktives Bankkonto gefunden' });
          }
          const acc = accRows[0];
          const newBalance = Number(acc.balance) - totalCost;
          if (newBalance < 0) {
            await conn.rollback();
            conn.release();
            return sendJson(res, 402, { ok: false, error: 'Nicht genug Geld auf dem Konto' });
          }
          await conn.query(
            `UPDATE user_bank_accounts SET balance = ?, updated_at = NOW() WHERE id = ?`,
            [newBalance, acc.id]
          );
          await conn.query(
            `INSERT INTO bank_transactions (account_id, direction, type, amount, balance_after, reference, description, meta_json)
             VALUES (?, 'debit', 'shop_purchase', ?, ?, ?, ?, NULL)`,
            [acc.id, totalCost, newBalance, `shop:${itemCode}`, `Shop: ${item.display_name} (${qty}x)`]
          );
        }

        let pairIds = [];
        if (itemCode === 'teleporter') {
          // Teleporter: jeder Kauf = separates Paar mit 2 Stücken (nie stacken)
          for (let i = 0; i < qty; i++) {
            const [pr] = await conn.query(
              `INSERT INTO teleporter_pairs (user_id, pieces_left) VALUES (?, 2)`,
              [user.id]
            );
            pairIds.push(pr.insertId);
          }
        } else {
          await conn.query(
            `INSERT INTO user_inventory (user_id, item_code, quantity)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), updated_at = NOW()`,
            [user.id, itemCode, qty]
          );
        }

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }

      return sendJson(res, 200, {
        ok: true,
        data: { item_code: itemCode, display_name: item.display_name, quantity_added: itemCode === 'teleporter' ? qty * 2 : qty },
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

      if (itemCode === 'teleporter') {
        const pairId = parseInt(body.pair_id, 10);
        if (!pairId) return sendJson(res, 422, { ok: false, error: 'pair_id erforderlich für Teleporter' });
        const [result] = await dbPool.query(
          `UPDATE teleporter_pairs SET pieces_left = GREATEST(0, pieces_left - 1)
           WHERE id = ? AND user_id = ? AND pieces_left > 0`,
          [pairId, user.id]
        );
        if (result.affectedRows === 0) return sendJson(res, 409, { ok: false, error: 'Nicht genug im Inventar' });
        const [rows] = await dbPool.query(`SELECT pieces_left FROM teleporter_pairs WHERE id = ?`, [pairId]);
        return sendJson(res, 200, { ok: true, data: { item_code: itemCode, pair_id: pairId, quantity: rows[0]?.pieces_left ?? 0 } });
      }

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

      if (itemCode === 'teleporter') {
        const pairId = parseInt(body.pair_id, 10);
        if (!pairId) return sendJson(res, 422, { ok: false, error: 'pair_id erforderlich für Teleporter' });
        await dbPool.query(
          `UPDATE teleporter_pairs SET pieces_left = LEAST(2, pieces_left + 1)
           WHERE id = ? AND user_id = ?`,
          [pairId, user.id]
        );
        const [rows] = await dbPool.query(`SELECT pieces_left FROM teleporter_pairs WHERE id = ?`, [pairId]);
        return sendJson(res, 200, { ok: true, data: { item_code: itemCode, pair_id: pairId, quantity: rows[0]?.pieces_left ?? 1 } });
      }

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

      // Reguläre Items (ohne Teleporter, die in teleporter_pairs verwaltet werden)
      const [invRows] = await dbPool.query(
        `SELECT
           ui.item_code,
           ui.quantity,
           si.display_name,
           si.category,
           si.icon,
           si.price,
           NULL AS pair_id
         FROM user_inventory ui
         JOIN shop_items si ON si.item_code = ui.item_code COLLATE utf8mb4_unicode_ci
         WHERE ui.user_id = ?
           AND ui.item_code != 'teleporter'
           AND si.is_active = 1
           AND ui.quantity > 0
         ORDER BY si.category ASC, si.sort_order ASC`,
        [user.id]
      );

      // Teleporter-Paare: jedes Paar als eigene Zeile
      const [tpRows] = await dbPool.query(
        `SELECT
           tp.id AS pair_id,
           tp.pieces_left AS quantity,
           si.display_name,
           si.category,
           si.icon,
           si.price
         FROM teleporter_pairs tp
         JOIN shop_items si ON si.item_code = 'teleporter' COLLATE utf8mb4_unicode_ci
         WHERE tp.user_id = ?
           AND tp.pieces_left > 0
           AND si.is_active = 1
         ORDER BY tp.id ASC`,
        [user.id]
      );

      const teleporterItems = tpRows.map(r => ({
        item_code: 'teleporter',
        quantity: r.quantity,
        display_name: r.display_name,
        category: r.category,
        icon: r.icon,
        price: r.price,
        pair_id: r.pair_id,
      }));

      return sendJson(res, 200, { ok: true, data: { items: [...invRows, ...teleporterItems] } });
    }
  };
};
