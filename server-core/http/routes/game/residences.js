'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { loadLayoutForUser, loadTemplateForUser } = require('./roomLayout');
const { debitUserBankAccount } = require('../../../game/userBanking');
const { getMansionTenants, startRental, endRental, getTierConfig } = require('../../../game/mansionRentals');

const RESIDENTIAL_TOOLS = new Set([
  'house_small', 'house_medium', 'mansion',
  'apartment_low', 'apartment_high', 'cabin_house',
]);

const RESIDENCE_PRICES = {
  house_small:  8000,
  cabin_house:  8000,
  house_medium: 10000,
};

// Villa-Katalog (spiegelt mapGame/src/lib/villaCatalog.ts)
const VILLA_CATALOG = [
  // Tier 1
  { row: 0, col: 0, price: 5000,   min_rank: 0, requires_council: false, requires_president: false },
  { row: 0, col: 1, price: 7500,   min_rank: 0, requires_council: false, requires_president: false },
  { row: 0, col: 2, price: 10000,  min_rank: 0, requires_council: false, requires_president: false },
  { row: 0, col: 3, price: 12000,  min_rank: 0, requires_council: false, requires_president: false },
  { row: 0, col: 4, price: 15000,  min_rank: 0, requires_council: false, requires_president: false },
  // Tier 2
  { row: 1, col: 0, price: 25000,  min_rank: 2, requires_council: false, requires_president: false },
  { row: 1, col: 1, price: 32000,  min_rank: 2, requires_council: false, requires_president: false },
  { row: 1, col: 2, price: 38000,  min_rank: 2, requires_council: false, requires_president: false },
  { row: 1, col: 3, price: 42000,  min_rank: 2, requires_council: false, requires_president: false },
  { row: 1, col: 4, price: 48000,  min_rank: 2, requires_council: false, requires_president: false },
  // Tier 3
  { row: 2, col: 0, price: 65000,  min_rank: 3, requires_council: false, requires_president: false },
  { row: 2, col: 1, price: 78000,  min_rank: 3, requires_council: false, requires_president: false },
  { row: 2, col: 2, price: 88000,  min_rank: 3, requires_council: false, requires_president: false },
  { row: 2, col: 3, price: 95000,  min_rank: 3, requires_council: false, requires_president: false },
  { row: 2, col: 4, price: 110000, min_rank: 3, requires_council: false, requires_president: false },
  // Tier 4 – Verwaltung
  { row: 3, col: 0, price: 150000, min_rank: 0, requires_council: true,  requires_president: false },
  { row: 3, col: 1, price: 175000, min_rank: 0, requires_council: true,  requires_president: false },
  { row: 3, col: 2, price: 185000, min_rank: 0, requires_council: true,  requires_president: false },
  { row: 3, col: 3, price: 220000, min_rank: 0, requires_council: true,  requires_president: false },
  { row: 3, col: 4, price: 260000, min_rank: 0, requires_council: true,  requires_president: false },
  // Tier 5 – Präsident
  { row: 4, col: 0, price: 300000, min_rank: 0, requires_council: false, requires_president: true },
  { row: 4, col: 1, price: 350000, min_rank: 0, requires_council: false, requires_president: true },
  { row: 4, col: 2, price: 400000, min_rank: 0, requires_council: false, requires_president: true },
  { row: 4, col: 3, price: 450000, min_rank: 0, requires_council: false, requires_president: true },
  { row: 4, col: 4, price: 500000, min_rank: 0, requires_council: false, requires_president: true },
];

module.exports = function registerResidencesRoutes(_deps) {
  return async function handleResidences(req, res, pathname, requestUrl) {

    // GET /api/game/municipality/:slug/residence/my-villa
    const myVillaMatch = pathname.match(/^\/api\/game\/municipality\/([^/]+)\/residence\/my-villa$/i);
    if (myVillaMatch && req.method === 'GET') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const slug = myVillaMatch[1];
      const [muniRows] = await dbPool.query('SELECT id FROM municipalities WHERE slug = ? LIMIT 1', [slug]);
      const muni = muniRows[0];
      if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      const [purchaseRows] = await dbPool.query(
        'SELECT variant_row, variant_col, price_paid, purchased_at FROM user_mansion_purchases WHERE user_id = ? AND municipality_id = ? LIMIT 1',
        [user.id, muni.id]
      );
      const purchase = purchaseRows[0] || null;
      let is_placed = false;
      if (purchase) {
        const [placedRows] = await dbPool.query(
          'SELECT 1 FROM player_residences WHERE user_id = ? AND municipality_id = ? LIMIT 1',
          [user.id, muni.id]
        );
        is_placed = placedRows.length > 0;
      }
      return sendJson(res, 200, { ok: true, data: { purchase, is_placed } });
    }

    // GET /api/game/municipality/:slug/residences
    const listMatch = pathname.match(/^\/api\/game\/municipality\/([^/]+)\/residences$/i);
    if (listMatch && req.method === 'GET') {
      ensureDbEnabled();
      const slug = listMatch[1];
      const [rows] = await dbPool.query(
        `SELECT pr.tile_x, pr.tile_y, pr.room_code, pr.user_id, pr.occupied_since,
                pr.mansion_variant_row, pr.mansion_variant_col,
                u.nickname
         FROM player_residences pr
         JOIN users u ON u.id = pr.user_id
         JOIN municipalities m ON m.id = pr.municipality_id
         WHERE m.slug = ?`,
        [slug]
      );
      return sendJson(res, 200, { ok: true, data: { residences: rows } });
    }

    // POST /api/game/municipality/:slug/residence/claim
    const claimMatch = pathname.match(/^\/api\/game\/municipality\/([^/]+)\/residence\/claim$/i);
    if (claimMatch && req.method === 'POST') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const slug = claimMatch[1];
      const body = await readJsonBody(req);
      const tileX = Number(body.tile_x);
      const tileY = Number(body.tile_y);
      const roomCode = (body.room_code || '').toString().trim();
      if (!Number.isInteger(tileX) || !Number.isInteger(tileY) || !roomCode) {
        return sendJson(res, 422, { ok: false, error: 'tile_x, tile_y und room_code erforderlich' });
      }
      // Look up municipality
      const [muniRows] = await dbPool.query('SELECT id FROM municipalities WHERE slug = ? LIMIT 1', [slug]);
      const muni = muniRows[0];
      if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      // Nur manuell platzierte Gebäude (action_type='place') sind kaufbar — keine Zone-generierten
      const [itemRows] = await dbPool.query(
        `SELECT tool FROM game_items
         WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'place'
         ORDER BY version DESC LIMIT 1`,
        [muni.id, roomCode, tileX, tileY]
      );
      const tool = itemRows[0]?.tool || '';
      if (!RESIDENCE_PRICES[tool]) {
        return sendJson(res, 422, { ok: false, error: 'Nur manuell platzierte Wohngebäude können gekauft werden' });
      }
      // Check tile not already claimed by someone else
      const [existingRows] = await dbPool.query(
        `SELECT user_id FROM player_residences WHERE municipality_id = ? AND room_code = ? AND tile_x = ? AND tile_y = ? LIMIT 1`,
        [muni.id, roomCode, tileX, tileY]
      );
      if (existingRows[0] && existingRows[0].user_id !== user.id) {
        return sendJson(res, 409, { ok: false, error: 'Dieses Haus ist bereits belegt' });
      }

      // Kaufpreis berechnen und vom Privatkonto abbuchen
      const price = RESIDENCE_PRICES[tool] || 8000;
      try {
        await debitUserBankAccount(user.id, {
          amount: price,
          type: 'residence_purchase',
          reference: `res_${muni.id}_${roomCode}_${tileX}_${tileY}`,
          description: `Hauskauf (${tool}) in ${slug}`,
        });
      } catch (err) {
        return sendJson(res, 402, { ok: false, error: err.message || 'Nicht genug Guthaben' });
      }
      // Preis geht an Gemeindekasse
      await dbPool.query(
        'UPDATE municipality_stats SET treasury = treasury + ?, updated_at = NOW() WHERE municipality_id = ?',
        [price, muni.id]
      );

      // Check if user has a pre-purchased villa design for this municipality
      const [purchaseRows] = await dbPool.query(
        'SELECT variant_row, variant_col, price_paid FROM user_mansion_purchases WHERE user_id = ? AND municipality_id = ? LIMIT 1',
        [user.id, muni.id]
      );
      const purchase = purchaseRows[0];
      const applyVariant = tool === 'mansion' && purchase;

      // UPSERT: user can only have one house per municipality (unique constraint)
      await dbPool.query(
        `INSERT INTO player_residences (user_id, municipality_id, room_code, tile_x, tile_y, mansion_variant_row, mansion_variant_col, villa_paid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE room_code = VALUES(room_code), tile_x = VALUES(tile_x), tile_y = VALUES(tile_y),
           occupied_since = NOW(),
           mansion_variant_row = VALUES(mansion_variant_row),
           mansion_variant_col = VALUES(mansion_variant_col),
           villa_paid = VALUES(villa_paid)`,
        [user.id, muni.id, roomCode, tileX, tileY,
         applyVariant ? purchase.variant_row : null,
         applyVariant ? purchase.variant_col : null,
         applyVariant ? purchase.price_paid : 0]
      );
      return sendJson(res, 200, { ok: true, data: { tile_x: tileX, tile_y: tileY, nickname: user.nickname, price } });
    }

    // GET /api/game/municipality/:slug/residence/room/:userId
    // Gibt das Raum-Layout eines Spielers zurück (v:1 Format für den ISOMETRIC-Client)
    const roomGetMatch = pathname.match(/^\/api\/game\/municipality\/([^/]+)\/residence\/room\/(\d+)$/i);
    if (roomGetMatch && req.method === 'GET') {
      ensureDbEnabled();
      const slug = roomGetMatch[1];
      const targetUserId = Number(roomGetMatch[2]);

      const [muniRows] = await dbPool.query('SELECT id FROM municipalities WHERE slug = ? LIMIT 1', [slug]);
      const muni = muniRows[0];
      if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const [roomRows] = await dbPool.query(
        'SELECT model_name FROM residence_rooms WHERE user_id = ? AND municipality_id = ? LIMIT 1',
        [targetUserId, muni.id]
      );
      const modelName = roomRows[0]?.model_name || 'model_standard';

      const [userRows] = await dbPool.query(
        'SELECT nickname, avatar_code FROM users WHERE id = ? LIMIT 1',
        [targetUserId]
      );
      const ownerNickname = userRows[0]?.nickname || 'Unbekannt';
      const avatarCode = userRows[0]?.avatar_code || null;

      // Eingeloggten User ermitteln → my_nickname für den Besucher
      let myNickname = null;
      try {
        const me = await getAuthenticatedUser(req);
        if (me) myNickname = me.nickname;
      } catch {}

      // User-Layout laden (eigenes gespeichertes) oder Template als Fallback
      const userLayout = await loadLayoutForUser(targetUserId);
      const geometry   = userLayout || await loadTemplateForUser(targetUserId);

      return sendJson(res, 200, {
        ok: true,
        data: {
          model_name:     modelName,
          avatar_code:    avatarCode,
          owner_nickname: ownerNickname,
          my_nickname:    myNickname,  // Name des eingeloggten Besuchers
          geometry,
        },
      });
    }

    // PUT /api/game/municipality/:slug/residence/room/model
    // Nur Besitzer: Raum-Modell wechseln
    const roomModelMatch = pathname.match(/^\/api\/game\/municipality\/([^/]+)\/residence\/room\/model$/i);
    if (roomModelMatch && req.method === 'PUT') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const slug = roomModelMatch[1];
      const body = await readJsonBody(req);
      const modelName = (body.model_name || '').toString().trim();

      // Validiere gegen room_models-Tabelle (dynamisch)
      const [validRows] = await dbPool.query(
        'SELECT model_name FROM room_models WHERE model_name = ? LIMIT 1',
        [modelName]
      );
      if (!validRows[0]) {
        return sendJson(res, 422, { ok: false, error: 'Ungültiges Raum-Modell' });
      }

      const [muniRows] = await dbPool.query('SELECT id FROM municipalities WHERE slug = ? LIMIT 1', [slug]);
      const muni = muniRows[0];
      if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      // Spieler muss eine Residence in dieser Gemeinde haben
      const [resRows] = await dbPool.query(
        'SELECT id FROM player_residences WHERE user_id = ? AND municipality_id = ? LIMIT 1',
        [user.id, muni.id]
      );
      if (!resRows[0]) return sendJson(res, 403, { ok: false, error: 'Du hast kein Haus in dieser Gemeinde' });

      await dbPool.query(
        `INSERT INTO residence_rooms (user_id, municipality_id, model_name)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE model_name = VALUES(model_name), updated_at = NOW()`,
        [user.id, muni.id, modelName]
      );
      return sendJson(res, 200, { ok: true, data: { model_name: modelName } });
    }

    // DELETE /api/game/municipality/:slug/residence/release
    const releaseMatch = pathname.match(/^\/api\/game\/municipality\/([^/]+)\/residence\/release$/i);
    if (releaseMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const slug = releaseMatch[1];
      const [muniRows] = await dbPool.query('SELECT id FROM municipalities WHERE slug = ? LIMIT 1', [slug]);
      const muni = muniRows[0];
      if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      await dbPool.query('DELETE FROM player_residences WHERE user_id = ? AND municipality_id = ?', [user.id, muni.id]);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/game/municipality/:slug/residence/villa-upgrade
    // Wählt ein Premium-Villa-Design und zahlt vom Privatkonto in die Gemeindekasse
    const upgradeMatch = pathname.match(/^\/api\/game\/municipality\/([^/]+)\/residence\/villa-upgrade$/i);
    if (upgradeMatch && req.method === 'POST') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const slug = upgradeMatch[1];
      const body = await readJsonBody(req);
      const variantRow = Number(body.variant_row);
      const variantCol = Number(body.variant_col);

      if (!Number.isInteger(variantRow) || !Number.isInteger(variantCol) ||
          variantRow < 0 || variantRow > 4 || variantCol < 0 || variantCol > 4) {
        return sendJson(res, 422, { ok: false, error: 'Ungültige Variante' });
      }

      // Find catalog entry
      const entry = VILLA_CATALOG.find(v => v.row === variantRow && v.col === variantCol);
      if (!entry) return sendJson(res, 422, { ok: false, error: 'Unbekannte Villa-Variante' });

      // Look up municipality
      const [muniRows] = await dbPool.query('SELECT id FROM municipalities WHERE slug = ? LIMIT 1', [slug]);
      const muni = muniRows[0];
      if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      // Check user has a mansion residence in this municipality
      const [resRows] = await dbPool.query(
        `SELECT pr.id, pr.room_code, pr.tile_x, pr.tile_y, gi.tool
         FROM player_residences pr
         JOIN game_items gi ON gi.municipality_id = pr.municipality_id
           AND gi.room_code = pr.room_code AND gi.x = pr.tile_x AND gi.y = pr.tile_y
           AND gi.action_type = 'place'
         WHERE pr.user_id = ? AND pr.municipality_id = ?
         ORDER BY gi.version DESC LIMIT 1`,
        [user.id, muni.id]
      );
      const residence = resRows[0];
      if (!residence) return sendJson(res, 404, { ok: false, error: 'Du hast kein Haus in dieser Gemeinde' });
      if (residence.tool !== 'mansion') {
        return sendJson(res, 422, { ok: false, error: 'Premium-Designs sind nur für Villen (Mansion) verfügbar' });
      }

      // Check role requirements
      if (entry.requires_president || entry.requires_council) {
        const [memberRows] = await dbPool.query(
          `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ? LIMIT 1`,
          [muni.id, user.id]
        );
        const role = memberRows[0]?.role || 'citizen';
        if (entry.requires_president && role !== 'owner') {
          return sendJson(res, 403, { ok: false, error: 'Nur der Gemeindepresident kann dieses Design wählen' });
        }
        if (entry.requires_council && role !== 'owner' && role !== 'council') {
          return sendJson(res, 403, { ok: false, error: 'Nur Verwaltungsmitglieder können dieses Design wählen' });
        }
      }

      // Check rank requirement
      if (entry.min_rank > 0) {
        const [rankRows] = await dbPool.query('SELECT user_rank FROM users WHERE id = ? LIMIT 1', [user.id]);
        const userRank = Number(rankRows[0]?.user_rank || 0);
        if (userRank < entry.min_rank) {
          return sendJson(res, 403, { ok: false, error: `Rang ${entry.min_rank} erforderlich (du bist Rang ${userRank})` });
        }
      }

      // Debit personal account
      try {
        await debitUserBankAccount(user.id, {
          amount: entry.price,
          type: 'villa_upgrade',
          reference: `villa_${variantRow}_${variantCol}_${muni.id}`,
          description: `Premium Villa-Design (${variantRow}/${variantCol}) in ${slug}`,
        });
      } catch (err) {
        return sendJson(res, 402, { ok: false, error: err.message || 'Nicht genug Guthaben' });
      }

      // Credit municipality treasury
      await dbPool.query(
        `UPDATE municipality_stats SET treasury = treasury + ?, updated_at = NOW() WHERE municipality_id = ?`,
        [entry.price, muni.id]
      );

      // Update variant in player_residences
      await dbPool.query(
        `UPDATE player_residences SET mansion_variant_row = ?, mansion_variant_col = ?, villa_paid = ?
         WHERE user_id = ? AND municipality_id = ?`,
        [variantRow, variantCol, entry.price, user.id, muni.id]
      );

      return sendJson(res, 200, { ok: true, data: { variant_row: variantRow, variant_col: variantCol, price: entry.price } });
    }

    // GET /api/game/municipality/:slug/residence/tenants?tile_x=&tile_y=&room_code=
    const tenantsMatch = pathname.match(/^\/api\/game\/municipality\/([^/]+)\/residence\/tenants$/i);
    if (tenantsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const slug = tenantsMatch[1];
      const qs = requestUrl.searchParams;
      const tileX = Number(qs.get('tile_x'));
      const tileY = Number(qs.get('tile_y'));
      const roomCode = (qs.get('room_code') || '').trim();
      if (!Number.isInteger(tileX) || !Number.isInteger(tileY) || !roomCode) {
        return sendJson(res, 422, { ok: false, error: 'tile_x, tile_y und room_code erforderlich' });
      }
      const [muniRows] = await dbPool.query('SELECT id FROM municipalities WHERE slug = ? LIMIT 1', [slug]);
      const muni = muniRows[0];
      if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const tenants = await getMansionTenants(muni.id, roomCode, tileX, tileY);

      // Tier-Konfiguration der Mansion zurückgeben (für Kapazitäts-Anzeige im Client)
      const [resRows] = await dbPool.query(
        `SELECT mansion_variant_row, mansion_variant_col FROM player_residences
         WHERE municipality_id = ? AND room_code = ? AND tile_x = ? AND tile_y = ? LIMIT 1`,
        [muni.id, roomCode, tileX, tileY]
      );
      const variantRow = Number(resRows[0]?.mansion_variant_row ?? 0);
      const variantCol = Number(resRows[0]?.mansion_variant_col ?? 0);
      const tierConfig = getTierConfig(variantRow, variantCol);

      return sendJson(res, 200, { ok: true, data: { tenants, tier: tierConfig, variant_row: variantRow, variant_col: variantCol } });
    }

    // POST /api/game/municipality/:slug/residence/rent-out
    const rentOutMatch = pathname.match(/^\/api\/game\/municipality\/([^/]+)\/residence\/rent-out$/i);
    if (rentOutMatch && req.method === 'POST') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const slug = rentOutMatch[1];
      const body = await readJsonBody(req);
      const { tile_x, tile_y, room_code, tenant_nickname, monthly_rent } = body;

      try {
        const result = await startRental(user.id, tenant_nickname, slug, tile_x, tile_y, room_code, monthly_rent);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        const status = err.code === 'INSUFFICIENT_BALANCE' ? 402 : 422;
        return sendJson(res, status, { ok: false, error: err.message || 'Fehler beim Erstellen des Mietvertrags' });
      }
    }

    // DELETE /api/game/municipality/:slug/residence/rent-out/:agreementId
    const cancelRentMatch = pathname.match(/^\/api\/game\/municipality\/([^/]+)\/residence\/rent-out\/(\d+)$/i);
    if (cancelRentMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const agreementId = Number(cancelRentMatch[2]);

      try {
        await endRental(agreementId, user.id);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 422, { ok: false, error: err.message || 'Kündigung fehlgeschlagen' });
      }
    }
  };
};

