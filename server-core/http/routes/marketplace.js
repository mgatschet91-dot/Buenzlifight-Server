'use strict';

const { sendJson, readJsonBody } = require('../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../infra/db');
const { getAuthenticatedUser } = require('../../auth/middleware');
const { escapeLike } = require('../../shared/helpers');
const { getMunicipalityMoney } = require('../../game/rooms');
const { applyMunicipalityTransaction } = require('../../game/bank');
const { actionAttempts, ACTION_RATE_LIMIT, ACTION_WINDOW_MS, checkRateLimit, incrementRateLimit } = require('../shared');

module.exports = function registerMarketplaceRoutes(/* deps */) {
  return async function handleMarketplace(req, res, pathname, requestUrl) {

    if (req.method === 'GET' && pathname === '/api/marketplace') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const search = requestUrl.searchParams.get('q') || '';
      let query = `SELECT ml.*, u.nickname AS seller_name FROM marketplace_listings ml JOIN users u ON u.id = ml.seller_id WHERE ml.status = 'active' AND ml.expires_at > NOW()`;
      const params = [];
      if (search) { query += ` AND ml.item_code LIKE ?`; params.push(`%${escapeLike(search)}%`); }
      query += ` ORDER BY ml.created_at DESC LIMIT 50`;
      const [rows] = await dbPool.query(query, params);
      return sendJson(res, 200, { ok: true, data: { listings: rows } });
    }

    if (req.method === 'POST' && pathname === '/api/marketplace/list') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const rlKey = `market:${authUser.id}`;
      const rlRetry = checkRateLimit(actionAttempts, rlKey, ACTION_RATE_LIMIT, ACTION_WINDOW_MS);
      if (rlRetry > 0) return sendJson(res, 429, { ok: false, error: 'Zu viele Anfragen. Bitte warte kurz.' });
      incrementRateLimit(actionAttempts, rlKey);
      const body = await readJsonBody(req);
      const itemCode = String(body.item_code || '').trim();
      const quantity = Math.min(9999, Math.max(1, Math.round(Number(body.quantity) || 1)));
      const price = Math.min(999_999_999, Math.max(1, Math.round(Number(body.price_per_unit) || 1)));
      if (!itemCode) return sendJson(res, 400, { ok: false, error: 'item_code erforderlich' });
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const [result] = await dbPool.query(`INSERT INTO marketplace_listings (seller_id, item_code, quantity, price_per_unit, expires_at) VALUES (?, ?, ?, ?, ?)`, [authUser.id, itemCode, quantity, price, expiresAt]);
      return sendJson(res, 200, { ok: true, data: { listing_id: result.insertId } });
    }

    const marketBuyMatch = pathname.match(/^\/api\/marketplace\/([0-9]+)\/buy$/i);
    if (marketBuyMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const listingId = Number(marketBuyMatch[1]);
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Du gehoerst keiner Gemeinde an' });
      const conn = await dbPool.getConnection();
      try {
        await conn.beginTransaction();
        // Lock listing row to prevent double-purchase
        const [listings] = await conn.query(`SELECT * FROM marketplace_listings WHERE id = ? AND status = 'active' AND expires_at > NOW() FOR UPDATE`, [listingId]);
        if (listings.length === 0) { await conn.rollback(); return sendJson(res, 404, { ok: false, error: 'Angebot nicht verfügbar' }); }
        const listing = listings[0];
        if (listing.seller_id === authUser.id) { await conn.rollback(); return sendJson(res, 400, { ok: false, error: 'Eigene Angebote nicht kaufbar' }); }
        const totalCost = listing.quantity * listing.price_per_unit;
        // Lock buyer treasury to prevent overdraft
        const [buyerStats] = await conn.query(`SELECT treasury FROM municipality_stats WHERE municipality_id = ? FOR UPDATE`, [authUser.municipality_id]);
        const buyerTreasury = Number(buyerStats[0]?.treasury || 0);
        if (buyerTreasury < totalCost) { await conn.rollback(); return sendJson(res, 400, { ok: false, error: `Nicht genug Geld (${totalCost} CHF)` }); }
        // Deduct from buyer
        await conn.query(`UPDATE municipality_stats SET treasury = treasury - ? WHERE municipality_id = ?`, [totalCost, authUser.municipality_id]);
        await conn.query(`INSERT INTO municipality_ledger (municipality_id, amount, type, meta, actor_user_id, source) VALUES (?, ?, 'marketplace_buy', ?, ?, 'user')`, [authUser.municipality_id, -totalCost, JSON.stringify({ listingId, sellerId: listing.seller_id, quantity: listing.quantity }), authUser.id]);
        // Credit seller
        const [sellerMun] = await conn.query(`SELECT municipality_id FROM users WHERE id = ?`, [listing.seller_id]);
        if (sellerMun[0]?.municipality_id) {
          await conn.query(`UPDATE municipality_stats SET treasury = treasury + ? WHERE municipality_id = ?`, [totalCost, sellerMun[0].municipality_id]);
          await conn.query(`INSERT INTO municipality_ledger (municipality_id, amount, type, meta, actor_user_id, source) VALUES (?, ?, 'marketplace_sell', ?, ?, 'system')`, [sellerMun[0].municipality_id, totalCost, JSON.stringify({ listingId, buyerId: authUser.id, quantity: listing.quantity }), listing.seller_id]);
        }
        // Mark listing as sold
        await conn.query(`UPDATE marketplace_listings SET status = 'sold', buyer_id = ?, sold_at = NOW() WHERE id = ?`, [authUser.id, listingId]);
        await conn.commit();
        return sendJson(res, 200, { ok: true, data: { bought: true, cost: totalCost } });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }

    const marketCancelMatch = pathname.match(/^\/api\/marketplace\/([0-9]+)$/i);
    if (marketCancelMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const listingId = Number(marketCancelMatch[1]);
      await dbPool.query(`UPDATE marketplace_listings SET status = 'cancelled' WHERE id = ? AND seller_id = ? AND status = 'active'`, [listingId, authUser.id]);
      return sendJson(res, 200, { ok: true, data: { cancelled: true } });
    }

    if (req.method === 'GET' && pathname === '/api/marketplace/my') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const [rows] = await dbPool.query(`SELECT ml.*, u.nickname AS buyer_name FROM marketplace_listings ml LEFT JOIN users u ON u.id = ml.buyer_id WHERE ml.seller_id = ? ORDER BY ml.created_at DESC LIMIT 50`, [authUser.id]);
      return sendJson(res, 200, { ok: true, data: { listings: rows } });
    }

    if (req.method === 'POST' && pathname === '/api/trades/send') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const rlKey = `trade:${authUser.id}`;
      const rlRetry = checkRateLimit(actionAttempts, rlKey, ACTION_RATE_LIMIT, ACTION_WINDOW_MS);
      if (rlRetry > 0) return sendJson(res, 429, { ok: false, error: 'Zu viele Anfragen. Bitte warte kurz.' });
      incrementRateLimit(actionAttempts, rlKey);
      const body = await readJsonBody(req);
      const receiverId = Number(body.receiver_id);
      const coinsOffered = Math.min(999_999_999, Math.max(0, Math.round(Number(body.coins_offered) || 0)));
      const message = String(body.message || '').trim().substring(0, 255);
      if (!receiverId || receiverId === authUser.id) return sendJson(res, 400, { ok: false, error: 'Ungültiger Empfänger' });
      const [result] = await dbPool.query(`INSERT INTO direct_trades (sender_id, receiver_id, coins_offered, message) VALUES (?, ?, ?, ?)`, [authUser.id, receiverId, coinsOffered, message]);
      return sendJson(res, 200, { ok: true, data: { trade_id: result.insertId } });
    }

    const tradeRespondMatch = pathname.match(/^\/api\/trades\/([0-9]+)\/respond$/i);
    if (tradeRespondMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const tradeId = Number(tradeRespondMatch[1]);
      const body = await readJsonBody(req);
      const decision = body.decision === 'accepted' ? 'accepted' : 'rejected';
      const conn = await dbPool.getConnection();
      try {
        await conn.beginTransaction();
        // Lock trade row to prevent double-accept
        const [trades] = await conn.query(`SELECT * FROM direct_trades WHERE id = ? AND receiver_id = ? AND status = 'pending' FOR UPDATE`, [tradeId, authUser.id]);
        if (trades.length === 0) { await conn.rollback(); return sendJson(res, 404, { ok: false, error: 'Handel nicht gefunden' }); }
        const trade = trades[0];
        if (decision === 'accepted' && trade.coins_offered > 0) {
          const [senderMun] = await conn.query(`SELECT municipality_id FROM users WHERE id = ?`, [trade.sender_id]);
          if (senderMun[0]?.municipality_id) {
            // Lock sender treasury
            const [senderStats] = await conn.query(`SELECT treasury FROM municipality_stats WHERE municipality_id = ? FOR UPDATE`, [senderMun[0].municipality_id]);
            const senderTreasury = Number(senderStats[0]?.treasury || 0);
            if (senderTreasury < trade.coins_offered) { await conn.rollback(); return sendJson(res, 400, { ok: false, error: 'Sender hat nicht genug Geld für diesen Handel' }); }
            await conn.query(`UPDATE municipality_stats SET treasury = treasury - ? WHERE municipality_id = ?`, [trade.coins_offered, senderMun[0].municipality_id]);
            await conn.query(`INSERT INTO municipality_ledger (municipality_id, amount, type, meta, actor_user_id, source) VALUES (?, ?, 'trade_send', ?, ?, 'user')`, [senderMun[0].municipality_id, -trade.coins_offered, JSON.stringify({ tradeId, receiverId: authUser.id }), trade.sender_id]);
          }
          if (authUser.municipality_id) {
            await conn.query(`UPDATE municipality_stats SET treasury = treasury + ? WHERE municipality_id = ?`, [trade.coins_offered, authUser.municipality_id]);
            await conn.query(`INSERT INTO municipality_ledger (municipality_id, amount, type, meta, actor_user_id, source) VALUES (?, ?, 'trade_receive', ?, ?, 'user')`, [authUser.municipality_id, trade.coins_offered, JSON.stringify({ tradeId, senderId: trade.sender_id }), authUser.id]);
          }
        }
        await conn.query(`UPDATE direct_trades SET status = ?, responded_at = NOW() WHERE id = ?`, [decision, tradeId]);
        await conn.commit();
        return sendJson(res, 200, { ok: true, data: { [decision]: true } });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }

    if (req.method === 'GET' && pathname === '/api/trades/pending') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const [rows] = await dbPool.query(`SELECT dt.*, u.nickname AS sender_name FROM direct_trades dt JOIN users u ON u.id = dt.sender_id WHERE dt.receiver_id = ? AND dt.status = 'pending' ORDER BY dt.created_at DESC LIMIT 20`, [authUser.id]);
      return sendJson(res, 200, { ok: true, data: { trades: rows } });
    }

    // ── Strom-Angebot erstellen ────────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/marketplace/energy/sell') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const body = await readJsonBody(req);
      const mwAmount = Math.max(1, Math.min(9999, Math.round(Number(body.mw_amount) || 0)));
      const pricePerMw = Math.max(0.1, Math.min(100, Number(body.price_per_mw) || 2.0));
      if (!mwAmount) return sendJson(res, 400, { ok: false, error: 'mw_amount erforderlich' });
      // Prüfe ob genug verfügbarer Überschuss vorhanden (aus letztem Tick)
      const [msRows] = await dbPool.query(
        `SELECT gs.stats_data, ms.energy_sold_mw FROM municipality_stats ms
         LEFT JOIN game_stats gs ON gs.municipality_id = ms.municipality_id
         WHERE ms.municipality_id = ? LIMIT 1`,
        [authUser.municipality_id]
      );
      const statsData = msRows[0]?.stats_data ? (typeof msRows[0].stats_data === 'string' ? JSON.parse(msRows[0].stats_data) : msRows[0].stats_data) : {};
      const availableToSell = Number(statsData.power_available_to_sell ?? 0);
      const currentlySold = Number(msRows[0]?.energy_sold_mw ?? 0);
      if (mwAmount > availableToSell - currentlySold) {
        return sendJson(res, 400, { ok: false, error: `Nicht genug Überschuss. Verfügbar: ${Math.max(0, availableToSell - currentlySold)} MW` });
      }
      const conn = await dbPool.getConnection();
      try {
        await conn.beginTransaction();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const [result] = await conn.query(
          `INSERT INTO marketplace_listings (seller_id, item_code, quantity, price_per_unit, expires_at) VALUES (?, 'energy_mw', ?, ?, ?)`,
          [authUser.id, mwAmount, Math.round(pricePerMw * 100), expiresAt]
        );
        // Sofort als verkauft reservieren (MW von Produktion abziehen)
        await conn.query(
          `UPDATE municipality_stats SET energy_sold_mw = energy_sold_mw + ? WHERE municipality_id = ?`,
          [mwAmount, authUser.municipality_id]
        );
        await conn.commit();
        return sendJson(res, 200, { ok: true, data: { listing_id: result.insertId, mw_amount: mwAmount } });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }

    // ── Strom-Angebot kaufen (überschreibt den generischen /buy-Handler für energy_mw) ──
    if (req.method === 'POST' && pathname.match(/^\/api\/marketplace\/([0-9]+)\/buy-energy$/i)) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const listingId = Number(pathname.match(/^\/api\/marketplace\/([0-9]+)\/buy-energy$/i)[1]);
      const conn = await dbPool.getConnection();
      try {
        await conn.beginTransaction();
        const [listings] = await conn.query(
          `SELECT ml.*, u.municipality_id AS seller_municipality_id FROM marketplace_listings ml
           JOIN users u ON u.id = ml.seller_id
           WHERE ml.id = ? AND ml.item_code = 'energy_mw' AND ml.status = 'active' AND ml.expires_at > NOW() FOR UPDATE`,
          [listingId]
        );
        if (listings.length === 0) { await conn.rollback(); return sendJson(res, 404, { ok: false, error: 'Angebot nicht verfügbar' }); }
        const listing = listings[0];
        if (listing.seller_id === authUser.id) { await conn.rollback(); return sendJson(res, 400, { ok: false, error: 'Eigene Angebote nicht kaufbar' }); }
        const mwAmount = listing.quantity;
        const totalCost = Math.round(mwAmount * (listing.price_per_unit / 100));
        // Käufer Kasse prüfen
        const [buyerStats] = await conn.query(
          `SELECT treasury FROM municipality_stats WHERE municipality_id = ? FOR UPDATE`,
          [authUser.municipality_id]
        );
        if (Number(buyerStats[0]?.treasury || 0) < totalCost) {
          await conn.rollback();
          return sendJson(res, 400, { ok: false, error: `Nicht genug Geld (${totalCost} CHF benötigt)` });
        }
        // Zahlung: Käufer → Verkäufer
        await conn.query(`UPDATE municipality_stats SET treasury = treasury - ? WHERE municipality_id = ?`, [totalCost, authUser.municipality_id]);
        await conn.query(`INSERT INTO municipality_ledger (municipality_id, amount, type, meta, actor_user_id, source) VALUES (?, ?, 'energy_buy', ?, ?, 'user')`,
          [authUser.municipality_id, -totalCost, JSON.stringify({ listingId, mwAmount }), authUser.id]);
        if (listing.seller_municipality_id) {
          await conn.query(`UPDATE municipality_stats SET treasury = treasury + ? WHERE municipality_id = ?`, [totalCost, listing.seller_municipality_id]);
          await conn.query(`INSERT INTO municipality_ledger (municipality_id, amount, type, meta, actor_user_id, source) VALUES (?, ?, 'energy_sell', ?, ?, 'system')`,
            [listing.seller_municipality_id, totalCost, JSON.stringify({ listingId, mwAmount, buyerId: authUser.id }), listing.seller_id]);
        }
        // Strom-Vertrag erstellen: MW geht vom Verkäufer zum Käufer
        await conn.query(
          `INSERT INTO energy_trade_contracts (seller_municipality_id, buyer_municipality_id, mw_amount, price_per_mw, marketplace_listing_id)
           VALUES (?, ?, ?, ?, ?)`,
          [listing.seller_municipality_id, authUser.municipality_id, mwAmount, listing.price_per_unit / 100, listingId]
        );
        // Käufer bekommt MW gutgeschrieben
        await conn.query(
          `UPDATE municipality_stats SET energy_bought_mw = energy_bought_mw + ? WHERE municipality_id = ?`,
          [mwAmount, authUser.municipality_id]
        );
        // Listing als sold markieren
        await conn.query(`UPDATE marketplace_listings SET status = 'sold', buyer_id = ?, sold_at = NOW() WHERE id = ?`, [authUser.id, listingId]);
        await conn.commit();
        return sendJson(res, 200, { ok: true, data: { bought: true, mw_amount: mwAmount, cost: totalCost } });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }

    // ── Strom-Vertrag kündigen ────────────────────────────────────────────────
    if (req.method === 'DELETE' && pathname.match(/^\/api\/energy-contracts\/([0-9]+)$/i)) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const contractId = Number(pathname.match(/^\/api\/energy-contracts\/([0-9]+)$/i)[1]);
      const conn = await dbPool.getConnection();
      try {
        await conn.beginTransaction();
        const [contracts] = await conn.query(
          `SELECT * FROM energy_trade_contracts WHERE id = ? AND status = 'active' FOR UPDATE`, [contractId]
        );
        if (contracts.length === 0) { await conn.rollback(); return sendJson(res, 404, { ok: false, error: 'Vertrag nicht gefunden' }); }
        const contract = contracts[0];
        const isSeller = contract.seller_municipality_id === authUser.municipality_id;
        const isBuyer  = contract.buyer_municipality_id  === authUser.municipality_id;
        if (!isSeller && !isBuyer) { await conn.rollback(); return sendJson(res, 403, { ok: false, error: 'Kein Zugriff' }); }
        await conn.query(`UPDATE energy_trade_contracts SET status = 'terminated', terminated_at = NOW() WHERE id = ?`, [contractId]);
        // MW zurückbuchen
        if (isSeller) {
          await conn.query(`UPDATE municipality_stats SET energy_sold_mw = GREATEST(0, energy_sold_mw - ?) WHERE municipality_id = ?`, [contract.mw_amount, contract.seller_municipality_id]);
        }
        await conn.query(`UPDATE municipality_stats SET energy_bought_mw = GREATEST(0, energy_bought_mw - ?) WHERE municipality_id = ?`, [contract.mw_amount, contract.buyer_municipality_id]);
        await conn.commit();
        return sendJson(res, 200, { ok: true, data: { terminated: true } });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }

    // ── Meine Strom-Verträge anzeigen ─────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/energy-contracts') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const [rows] = await dbPool.query(
        `SELECT etc.*,
           sm.name AS seller_name,
           bm.name AS buyer_name
         FROM energy_trade_contracts etc
         LEFT JOIN municipalities sm ON sm.id = etc.seller_municipality_id
         LEFT JOIN municipalities bm ON bm.id = etc.buyer_municipality_id
         WHERE (etc.seller_municipality_id = ? OR etc.buyer_municipality_id = ?)
           AND etc.status = 'active'
         ORDER BY etc.started_at DESC`,
        [authUser.municipality_id, authUser.municipality_id]
      );
      return sendJson(res, 200, { ok: true, data: { contracts: rows } });
    }

    // ── Strom-Puffer einstellen ───────────────────────────────────────────────
    if (req.method === 'PUT' && pathname === '/api/municipality/power-settings') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const body = await readJsonBody(req);
      const bufferPct = Math.max(1, Math.min(25, Math.round(Number(body.power_buffer_pct) || 10)));
      await dbPool.query(
        `UPDATE municipality_stats SET power_buffer_pct = ? WHERE municipality_id = ?`,
        [bufferPct, authUser.municipality_id]
      );
      return sendJson(res, 200, { ok: true, data: { power_buffer_pct: bufferPct } });
    }

    // ── Energie-Markt: alle Angebote (Spot + Fix) anderer Gemeinden ─────────
    if (req.method === 'GET' && pathname === '/api/marketplace/energy') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      // Spot-Angebote anderer Gemeinden
      const [spotOffers] = await dbPool.query(
        `SELECT eso.*, m.name AS seller_municipality_name, u.nickname AS seller_name
         FROM energy_spot_offers eso
         JOIN municipalities m ON m.id = eso.seller_municipality_id
         JOIN users u ON u.id = eso.seller_user_id
         WHERE eso.status = 'active'
           AND eso.seller_municipality_id != ?
         ORDER BY eso.price_per_mw_hour ASC, eso.max_mw DESC
         LIMIT 30`,
        [authUser.municipality_id]
      );

      // Fixe Strom-Inserate anderer Gemeinden
      const [fixedListings] = await dbPool.query(
        `SELECT ml.*, u.nickname AS seller_name, m.name AS seller_municipality_name
         FROM marketplace_listings ml
         JOIN users u ON u.id = ml.seller_id
         LEFT JOIN municipalities m ON m.id = u.municipality_id
         WHERE ml.item_code = 'energy_mw'
           AND ml.status = 'active'
           AND ml.expires_at > NOW()
           AND u.municipality_id != ?
         ORDER BY ml.created_at DESC
         LIMIT 20`,
        [authUser.municipality_id]
      );

      return sendJson(res, 200, { ok: true, data: { spot_offers: spotOffers, fixed_listings: fixedListings } });
    }

    // ── Spot-Angebot erstellen ────────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/marketplace/energy/spot/offer') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const body = await readJsonBody(req);
      const maxMw         = Math.max(1, Math.min(9999, Math.round(Number(body.max_mw) || 0)));
      const pricePerHour  = Math.max(0.1, Math.min(100, Number(body.price_per_mw_hour) || 2.0));

      if (!maxMw) return sendJson(res, 400, { ok: false, error: 'max_mw erforderlich (mind. 1)' });

      // Verfügbaren Überschuss prüfen
      const [msRows] = await dbPool.query(
        `SELECT gs.stats_data, ms.energy_sold_mw FROM municipality_stats ms
         LEFT JOIN game_stats gs ON gs.municipality_id = ms.municipality_id
         WHERE ms.municipality_id = ? LIMIT 1`,
        [authUser.municipality_id]
      );
      const statsData = msRows[0]?.stats_data
        ? (typeof msRows[0].stats_data === 'string' ? JSON.parse(msRows[0].stats_data) : msRows[0].stats_data)
        : {};
      const available = Number(statsData.power_available_to_sell ?? 0);
      const alreadySold = Number(msRows[0]?.energy_sold_mw ?? 0);
      const freeCapacity = Math.max(0, available - alreadySold);
      if (maxMw > freeCapacity) {
        return sendJson(res, 400, { ok: false, error: `Nicht genug Kapazität. Verfügbar: ${freeCapacity} MW` });
      }

      const [result] = await dbPool.query(
        `INSERT INTO energy_spot_offers (seller_municipality_id, seller_user_id, max_mw, price_per_mw_hour)
         VALUES (?, ?, ?, ?)`,
        [authUser.municipality_id, authUser.id, maxMw, pricePerHour]
      );
      return sendJson(res, 200, { ok: true, data: { offer_id: result.insertId, max_mw: maxMw, price_per_mw_hour: pricePerHour } });
    }

    // ── Eigenes Spot-Angebot stornieren ───────────────────────────────────────
    const spotOfferDeleteMatch = pathname.match(/^\/api\/marketplace\/energy\/spot\/([0-9]+)$/i);
    if (spotOfferDeleteMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const offerId = Number(spotOfferDeleteMatch[1]);
      const [rows] = await dbPool.query(
        `SELECT id, seller_user_id FROM energy_spot_offers WHERE id = ? AND status = 'active' LIMIT 1`,
        [offerId]
      );
      if (!rows[0]) return sendJson(res, 404, { ok: false, error: 'Angebot nicht gefunden' });
      if (rows[0].seller_user_id !== authUser.id) return sendJson(res, 403, { ok: false, error: 'Nicht dein Angebot' });
      await dbPool.query(`UPDATE energy_spot_offers SET status = 'cancelled' WHERE id = ?`, [offerId]);
      return sendJson(res, 200, { ok: true, data: { cancelled: true } });
    }

    // ── Spot-Angebot abonnieren (Vertrag erstellen, kein Vorauszahlung) ──────
    const spotSubscribeMatch = pathname.match(/^\/api\/marketplace\/energy\/spot\/([0-9]+)\/subscribe$/i);
    if (spotSubscribeMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const offerId = Number(spotSubscribeMatch[1]);

      const [offerRows] = await dbPool.query(
        `SELECT eso.*, m.id AS seller_muni_id FROM energy_spot_offers eso
         JOIN municipalities m ON m.id = eso.seller_municipality_id
         WHERE eso.id = ? AND eso.status = 'active' LIMIT 1`,
        [offerId]
      );
      if (!offerRows[0]) return sendJson(res, 404, { ok: false, error: 'Angebot nicht verfügbar' });
      const offer = offerRows[0];
      if (offer.seller_municipality_id === authUser.municipality_id) {
        return sendJson(res, 400, { ok: false, error: 'Eigenes Angebot nicht abonnierbar' });
      }

      // Bereits ein aktiver Spot-Vertrag mit diesem Angebot?
      const [existingRows] = await dbPool.query(
        `SELECT id FROM energy_trade_contracts
         WHERE buyer_municipality_id = ? AND seller_municipality_id = ?
           AND contract_type = 'spot' AND status = 'active' LIMIT 1`,
        [authUser.municipality_id, offer.seller_municipality_id]
      );
      if (existingRows[0]) return sendJson(res, 400, { ok: false, error: 'Spot-Vertrag mit dieser Gemeinde bereits aktiv' });

      const [result] = await dbPool.query(
        `INSERT INTO energy_trade_contracts
           (seller_municipality_id, buyer_municipality_id, mw_amount, price_per_mw,
            contract_type, spot_max_mw, seller_user_id, buyer_user_id)
         VALUES (?, ?, ?, ?, 'spot', ?, ?, ?)`,
        [offer.seller_municipality_id, authUser.municipality_id,
         offer.max_mw, offer.price_per_mw_hour,
         offer.max_mw, offer.seller_user_id, authUser.id]
      );
      return sendJson(res, 200, { ok: true, data: {
        contract_id: result.insertId,
        spot_max_mw: offer.max_mw,
        price_per_mw_hour: Number(offer.price_per_mw_hour),
        note: 'Abrechnung läuft pro Minute basierend auf deinem tatsächlichen Defizit',
      }});
    }

    // ── Auto-Markt-Kauf Toggle ────────────────────────────────────────────────
    if (req.method === 'PUT' && pathname === '/api/municipality/auto-market-buy') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const body = await readJsonBody(req);
      const enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;
      await dbPool.query(
        `UPDATE municipality_stats SET auto_market_buy_enabled = ? WHERE municipality_id = ?`,
        [enabled, authUser.municipality_id]
      );
      return sendJson(res, 200, { ok: true, data: { auto_market_buy_enabled: enabled } });
    }

    // ── Auto-Markt-Kauf Status ──────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/municipality/auto-market-buy') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const [rows] = await dbPool.query(
        `SELECT auto_market_buy_enabled, auto_market_buy_tariff FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
        [authUser.municipality_id]
      );
      const enabled = rows[0] ? (rows[0].auto_market_buy_enabled === 1) : true;
      const tariff  = rows[0] ? Number(rows[0].auto_market_buy_tariff ?? 3.00) : 3.00;
      return sendJson(res, 200, { ok: true, data: { auto_market_buy_enabled: enabled, auto_market_buy_tariff: tariff } });
    }

    // ── Meine Spot-Angebote abrufen ───────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/marketplace/energy/spot/my') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const [rows] = await dbPool.query(
        `SELECT eso.*, m.name AS seller_municipality_name FROM energy_spot_offers eso
         JOIN municipalities m ON m.id = eso.seller_municipality_id
         WHERE eso.seller_user_id = ? AND eso.status = 'active'
         ORDER BY eso.created_at DESC`,
        [authUser.id]
      );
      return sendJson(res, 200, { ok: true, data: { offers: rows } });
    }
  };
};
