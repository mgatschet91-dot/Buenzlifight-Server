'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { debitUserBankAccount, creditUserBankAccount } = require('./userBanking');
const { applyMunicipalityTransaction } = require('./bank');
const { getMansionStats } = require('../config/mansionStats');

function getTierConfig(variantRow, variantCol) {
  return getMansionStats(variantRow, variantCol);
}

async function getMansionTenants(municipalityId, roomCode, tileX, tileY) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT mra.id, mra.tenant_id, mra.monthly_rent, mra.started_at, mra.next_due_at, mra.missed_payments,
            u.nickname AS tenant_nickname
     FROM mansion_rental_agreements mra
     JOIN users u ON u.id = mra.tenant_id
     WHERE mra.municipality_id = ? AND mra.room_code = ? AND mra.tile_x = ? AND mra.tile_y = ?
       AND mra.status = 'active'`,
    [municipalityId, roomCode, tileX, tileY]
  );
  return rows.map(r => ({
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    tenant_nickname: r.tenant_nickname,
    monthly_rent: Number(r.monthly_rent),
    started_at: r.started_at,
    next_due_at: r.next_due_at,
    missed_payments: Number(r.missed_payments),
  }));
}

async function startRental(ownerUserId, tenantNickname, slug, tileX, tileY, roomCode, monthlyRent) {
  ensureDbEnabled();
  const safeOwner = Number(ownerUserId);
  const safeTileX = Number(tileX);
  const safeTileY = Number(tileY);
  const safeRent = Math.round(Number(monthlyRent));
  const safeRoomCode = String(roomCode || '').trim();

  if (!Number.isInteger(safeOwner) || safeOwner <= 0) throw new Error('Ungültige Besitzer-ID');
  if (!Number.isInteger(safeTileX) || !Number.isInteger(safeTileY)) throw new Error('Ungültige Tile-Koordinaten');
  if (!safeRoomCode) throw new Error('room_code erforderlich');
  if (safeRent <= 0) throw new Error('Ungültiger Mietpreis');

  // Gemeinde laden
  const [muniRows] = await dbPool.query('SELECT id FROM municipalities WHERE slug = ? LIMIT 1', [slug]);
  const muni = muniRows[0];
  if (!muni) throw new Error('Gemeinde nicht gefunden');
  const municipalityId = Number(muni.id);

  // Mansion + Besitzer prüfen
  const [resRows] = await dbPool.query(
    `SELECT pr.id, pr.mansion_variant_row, pr.mansion_variant_col
     FROM player_residences pr
     WHERE pr.user_id = ? AND pr.municipality_id = ? AND pr.room_code = ? AND pr.tile_x = ? AND pr.tile_y = ?
     LIMIT 1`,
    [safeOwner, municipalityId, safeRoomCode, safeTileX, safeTileY]
  );
  if (!resRows[0]) throw new Error('Du bist nicht der Besitzer dieser Mansion');
  const variantRow = Number(resRows[0].mansion_variant_row ?? 0);
  const variantCol = Number(resRows[0].mansion_variant_col ?? 0);
  const tier = getTierConfig(variantRow, variantCol);

  // Preis in Range prüfen
  if (safeRent < tier.minRent || safeRent > tier.maxRent) {
    throw new Error(`Mietpreis muss zwischen ${tier.minRent} und ${tier.maxRent} Fr liegen`);
  }

  // Mieter-Nickname auflösen
  const [tenantRows] = await dbPool.query('SELECT id FROM users WHERE nickname = ? LIMIT 1', [tenantNickname]);
  if (!tenantRows[0]) throw new Error('Benutzer nicht gefunden');
  const tenantId = Number(tenantRows[0].id);

  // Kein Self-Rent
  if (tenantId === safeOwner) throw new Error('Du kannst nicht dein eigenes Zimmer mieten');

  // Mieter muss Gemeinde-Mitglied sein
  const [memberRows] = await dbPool.query(
    'SELECT 1 FROM municipality_memberships WHERE municipality_id = ? AND user_id = ? LIMIT 1',
    [municipalityId, tenantId]
  );
  if (!memberRows[0]) throw new Error('Der Benutzer ist kein Mitglied dieser Gemeinde');

  // Kapazität prüfen
  const [countRows] = await dbPool.query(
    `SELECT COUNT(*) AS cnt FROM mansion_rental_agreements
     WHERE municipality_id = ? AND room_code = ? AND tile_x = ? AND tile_y = ? AND status = 'active'`,
    [municipalityId, safeRoomCode, safeTileX, safeTileY]
  );
  if (Number(countRows[0].cnt) >= tier.maxTenants) {
    throw new Error(`Diese Mansion hat keinen freien Platz mehr (max ${tier.maxTenants} Mieter)`);
  }

  // Mieter hat bereits Mietvertrag in dieser Gemeinde (UNIQUE uq_tenant_muni)
  const [existingRows] = await dbPool.query(
    `SELECT 1 FROM mansion_rental_agreements
     WHERE tenant_id = ? AND municipality_id = ? AND status = 'active' LIMIT 1`,
    [tenantId, municipalityId]
  );
  if (existingRows[0]) throw new Error('Dieser Benutzer hat bereits einen aktiven Mietvertrag in dieser Gemeinde');

  // Erste Zahlung sofort einziehen
  await debitUserBankAccount(tenantId, {
    amount: safeRent,
    type: 'rental_payment',
    reference: `rent_${municipalityId}_${safeRoomCode}_${safeTileX}_${safeTileY}`,
    description: `Miete an ${slug} Mansion`,
  });

  const ownerShare = Math.round(safeRent * 0.85);
  const taxShare = safeRent - ownerShare;

  await creditUserBankAccount(safeOwner, {
    amount: ownerShare,
    type: 'rental_income',
    reference: `rent_income_${municipalityId}_${safeRoomCode}`,
    description: `Mieteinnahmen (85%) von ${tenantNickname}`,
  });

  await applyMunicipalityTransaction(municipalityId, {
    amount: taxShare,
    type: 'rental_tax',
    description: `Mietsteuer (15%) für Mansion ${safeRoomCode} (${safeTileX}/${safeTileY})`,
  });

  // Vertrag eintragen
  const [insertResult] = await dbPool.query(
    `INSERT INTO mansion_rental_agreements
     (municipality_id, room_code, tile_x, tile_y, owner_id, tenant_id, monthly_rent, next_due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))`,
    [municipalityId, safeRoomCode, safeTileX, safeTileY, safeOwner, tenantId, safeRent]
  );

  // Population in game_items hochsetzen (Besitzer + Mieter)
  await dbPool.query(
    `UPDATE game_items SET metadata = JSON_SET(COALESCE(metadata, '{}'), '$.population',
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.population')), 1) + 1)
     WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND tool = 'mansion' AND action_type = 'place'`,
    [municipalityId, safeRoomCode, safeTileX, safeTileY]
  );

  return {
    agreement_id: Number(insertResult.insertId),
    tenant_id: tenantId,
    monthly_rent: safeRent,
    owner_share: ownerShare,
    tax_share: taxShare,
  };
}

async function endRental(agreementId, requestingUserId) {
  ensureDbEnabled();
  const safeId = Number(agreementId);
  const safeUser = Number(requestingUserId);

  const [rows] = await dbPool.query(
    `SELECT id, owner_id, tenant_id FROM mansion_rental_agreements WHERE id = ? AND status = 'active' LIMIT 1`,
    [safeId]
  );
  const agreement = rows[0];
  if (!agreement) throw new Error('Mietvertrag nicht gefunden oder bereits beendet');

  if (Number(agreement.owner_id) !== safeUser && Number(agreement.tenant_id) !== safeUser) {
    throw new Error('Keine Berechtigung — nur Vermieter oder Mieter können kündigen');
  }

  await dbPool.query(
    `UPDATE mansion_rental_agreements SET status = 'cancelled' WHERE id = ?`,
    [safeId]
  );

  // Population in game_items runtersetzen (mindestens 1 = Besitzer bleibt immer)
  await dbPool.query(
    `UPDATE game_items gi
     JOIN mansion_rental_agreements mra ON mra.id = ?
     SET gi.metadata = JSON_SET(COALESCE(gi.metadata, '{}'), '$.population',
       GREATEST(1, COALESCE(JSON_UNQUOTE(JSON_EXTRACT(gi.metadata, '$.population')), 1) - 1))
     WHERE gi.municipality_id = mra.municipality_id AND gi.room_code = mra.room_code
       AND gi.x = mra.tile_x AND gi.y = mra.tile_y AND gi.tool = 'mansion' AND gi.action_type = 'place'`,
    [safeId]
  );
}

async function processMonthlyRentals() {
  ensureDbEnabled();

  const [dueRows] = await dbPool.query(
    `SELECT mra.id, mra.tenant_id, mra.owner_id, mra.municipality_id,
            mra.room_code, mra.tile_x, mra.tile_y, mra.monthly_rent, mra.missed_payments
     FROM mansion_rental_agreements mra
     WHERE mra.status = 'active' AND mra.next_due_at <= NOW()
     LIMIT 100`
  );

  for (const row of dueRows) {
    const agreementId = Number(row.id);
    const tenantId = Number(row.tenant_id);
    const ownerId = Number(row.owner_id);
    const municipalityId = Number(row.municipality_id);
    const rent = Number(row.monthly_rent);

    try {
      await debitUserBankAccount(tenantId, {
        amount: rent,
        type: 'rental_payment',
        reference: `rent_monthly_${agreementId}`,
        description: `Monatliche Miete`,
      });

      const ownerShare = Math.round(rent * 0.85);
      const taxShare = rent - ownerShare;

      await creditUserBankAccount(ownerId, {
        amount: ownerShare,
        type: 'rental_income',
        reference: `rent_income_${agreementId}`,
        description: `Mieteinnahmen (85%)`,
      });

      await applyMunicipalityTransaction(municipalityId, {
        amount: taxShare,
        type: 'rental_tax',
        description: `Mietsteuer (15%) Vertrag #${agreementId}`,
      });

      await dbPool.query(
        `UPDATE mansion_rental_agreements
         SET last_paid_at = NOW(), next_due_at = DATE_ADD(NOW(), INTERVAL 30 DAY), missed_payments = 0
         WHERE id = ?`,
        [agreementId]
      );
    } catch (_err) {
      // Zahlung fehlgeschlagen (z.B. kein Guthaben)
      const newMissed = Number(row.missed_payments) + 1;
      if (newMissed >= 3) {
        await dbPool.query(
          `UPDATE mansion_rental_agreements SET status = 'cancelled', missed_payments = ? WHERE id = ?`,
          [newMissed, agreementId]
        );
      } else {
        await dbPool.query(
          `UPDATE mansion_rental_agreements
           SET missed_payments = ?, next_due_at = DATE_ADD(NOW(), INTERVAL 30 DAY)
           WHERE id = ?`,
          [newMissed, agreementId]
        );
      }
    }
  }
}

module.exports = {
  getTierConfig,
  getMansionTenants,
  startRental,
  endRental,
  processMonthlyRentals,
};
