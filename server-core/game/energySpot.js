'use strict';

/**
 * Spot-Energie: Auto-Subscribe + Billing
 * ────────────────────────────────────────
 * Interval #8 (60s):
 *   1. autoSubscribeSpotEnergy()  — deckt Defizite mit Markt-Angeboten
 *   2. processSpotEnergyBilling() — rechnet jeden Vertrag einzeln ab
 *
 * Idle-Support:
 *   Wenn game_stats älter als 5 Min (kein Spieler online), wird die Strom-Balance
 *   direkt aus den platzierten Gebäuden berechnet (game_items + game_item_details).
 *   So werden auch Solar/Wind-Schwankungen bei inaktiven Gemeinden erkannt.
 */

const { dbPool, ensureDbEnabled } = require('../infra/db.js');
const { logInfo, logError } = require('../infra/logger.js');

const AUTO_SURCHARGE_PCT  = 0.20;        // +20% ohne ausgehandelten Vertrag
const STALE_THRESHOLD_MS  = 5 * 60_000; // 5 Min → Idle-Fallback

function parseStats(raw) {
  if (!raw) return {};
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return {}; }
}

// ── Idle-Fallback: Strom-Balance direkt aus Gebäuden berechnen ───────────────
async function computeIdlePowerBalance(municipalityId) {
  try {
    const [rows] = await dbPool.query(`
      SELECT
        COALESCE(SUM(GREATEST(0, gid.power_production)),  0) AS total_prod,
        COALESCE(SUM(GREATEST(0, gid.power_consumption)), 0) AS total_cons
      FROM game_items gi
      JOIN game_item_details gid ON gid.item_class = gi.classname
      WHERE gi.municipality_id = ?
        AND COALESCE(gi.state, '') != 'removed'
        AND (gid.power_production > 0 OR gid.power_consumption > 0)
    `, [municipalityId]);
    const prod = Number(rows[0]?.total_prod ?? 0);
    const cons = Number(rows[0]?.total_cons ?? 0);
    return prod - cons; // negativ = Defizit
  } catch {
    return 0; // Im Zweifel kein Defizit annehmen
  }
}

// ── Strom-Defizit einer Gemeinde ermitteln (aktiv ODER idle) ─────────────────
async function getMunicipalityDeficit(municipalityId, statsData, statsUpdatedAt) {
  const isStale = !statsUpdatedAt ||
    (Date.now() - new Date(statsUpdatedAt).getTime()) > STALE_THRESHOLD_MS;

  if (!isStale) {
    // Frische Daten aus game_stats (Spieler online)
    const stats   = parseStats(statsData);
    const balance = Number(stats.power_balance_effective ?? 0);
    return balance < 0 ? Math.abs(balance) : 0;
  }

  // Idle: Gebäude-Fallback (keine aktiven Spieler)
  const balance = await computeIdlePowerBalance(municipalityId);
  if (balance < 0) {
    logInfo('ENERGY', `Idle-Check Gemeinde ${municipalityId}: Defizit ${Math.abs(balance)} MW (aus Gebäuden)`);
  }
  return balance < 0 ? Math.abs(balance) : 0;
}

// ── 1. Auto-Subscribe ─────────────────────────────────────────────────────────
async function autoSubscribeSpotEnergy() {
  ensureDbEnabled();

  // Nur Gemeinden mit aktiviertem Auto-Kauf; game_stats updated_at für Idle-Erkennung
  const [munis] = await dbPool.query(`
    SELECT ms.municipality_id, gs.stats_data, gs.updated_at AS stats_updated_at
    FROM municipality_stats ms
    LEFT JOIN game_stats gs ON gs.municipality_id = ms.municipality_id
    WHERE ms.auto_market_buy_enabled = 1
  `);

  for (const muni of munis) {
    const muniId = muni.municipality_id;
    try {
      const deficit = await getMunicipalityDeficit(muniId, muni.stats_data, muni.stats_updated_at);

      const [active] = await dbPool.query(`
        SELECT id, spot_max_mw, auto_subscribed
        FROM energy_trade_contracts
        WHERE buyer_municipality_id = ? AND status = 'active' AND contract_type = 'spot'
      `, [muniId]);

      // Kein Defizit → Auto-Verträge kündigen
      if (deficit === 0) {
        for (const c of active.filter(c => c.auto_subscribed === 1)) {
          await dbPool.query(
            `UPDATE energy_trade_contracts SET status = 'terminated', terminated_at = NOW() WHERE id = ?`,
            [c.id]
          );
          logInfo('ENERGY', `Auto-Vertrag ${c.id} gekündigt — kein Defizit (Gemeinde ${muniId})`);
        }
        continue;
      }

      const coveredMw = active.reduce((s, c) => s + Number(c.spot_max_mw ?? 0), 0);
      const uncovered = Math.max(0, deficit - coveredMw);
      if (uncovered <= 0) continue;

      // Gemeinde-Owner als Käufer
      const [ownerRows] = await dbPool.query(`
        SELECT user_id FROM municipality_memberships
        WHERE municipality_id = ? AND role = 'owner' LIMIT 1
      `, [muniId]);
      if (!ownerRows[0]) continue;
      const buyerUserId = ownerRows[0].user_id;

      // Günstigste Angebote — noch kein aktiver Vertrag mit dieser Gemeinde
      const [offers] = await dbPool.query(`
        SELECT eso.*
        FROM energy_spot_offers eso
        WHERE eso.status = 'active'
          AND eso.seller_municipality_id != ?
          AND NOT EXISTS (
            SELECT 1 FROM energy_trade_contracts etc
            WHERE etc.seller_municipality_id = eso.seller_municipality_id
              AND etc.buyer_municipality_id  = ?
              AND etc.status = 'active'
              AND etc.contract_type = 'spot'
          )
        ORDER BY eso.price_per_mw_hour ASC
        LIMIT 10
      `, [muniId, muniId]);

      if (offers.length === 0) {
        logInfo('ENERGY', `Gemeinde ${muniId}: ${uncovered} MW ungedeckt — kein Angebot am Markt → Standard-Import`);
        continue;
      }

      // Angebote kombinieren bis Defizit gedeckt (günstigste zuerst)
      let remaining = uncovered;
      for (const offer of offers) {
        if (remaining <= 0) break;
        const mwToSub        = Math.min(remaining, Number(offer.max_mw));
        const effectivePrice = Math.round(Number(offer.price_per_mw_hour) * (1 + AUTO_SURCHARGE_PCT) * 10000) / 10000;

        await dbPool.query(`
          INSERT INTO energy_trade_contracts
            (seller_municipality_id, buyer_municipality_id, mw_amount, price_per_mw,
             contract_type, spot_max_mw, seller_user_id, buyer_user_id, auto_subscribed)
          VALUES (?, ?, ?, ?, 'spot', ?, ?, ?, 1)
        `, [offer.seller_municipality_id, muniId,
            mwToSub, effectivePrice,
            mwToSub, offer.seller_user_id, buyerUserId]);

        logInfo('ENERGY',
          `Auto-Abo: ${mwToSub} MW | Käufer=${muniId} ← Anbieter=${offer.seller_municipality_id}` +
          ` | ${effectivePrice} CHF/MW/h (+20%)`
        );
        remaining -= mwToSub;
      }

      if (remaining > 0) {
        logInfo('ENERGY', `Gemeinde ${muniId}: ${remaining} MW ungedeckt → Standard-Import`);
      }
    } catch (err) {
      logError('ENERGY', `Auto-Subscribe Fehler Gemeinde ${muniId}`, { error: err?.message });
    }
  }
}

// ── 2. Billing ────────────────────────────────────────────────────────────────
async function processSpotEnergyBilling() {
  ensureDbEnabled();

  // Alle Käufer-Gemeinden mit aktiven Spot-Verträgen
  const [buyerMunis] = await dbPool.query(`
    SELECT DISTINCT buyer_municipality_id
    FROM energy_trade_contracts
    WHERE status = 'active' AND contract_type = 'spot'
      AND seller_user_id IS NOT NULL AND buyer_user_id IS NOT NULL
  `);

  for (const { buyer_municipality_id: buyerMuniId } of buyerMunis) {
    try {
      // Aktuelles Defizit (aktiv oder idle)
      const [gsRows] = await dbPool.query(
        `SELECT stats_data, updated_at FROM game_stats WHERE municipality_id = ? ORDER BY updated_at DESC LIMIT 1`,
        [buyerMuniId]
      );
      const deficitTotal = await getMunicipalityDeficit(
        buyerMuniId,
        gsRows[0]?.stats_data,
        gsRows[0]?.updated_at
      );
      if (deficitTotal <= 0) continue;

      // Alle aktiven Spot-Verträge — günstigste zuerst für faire Verteilung
      const [contracts] = await dbPool.query(`
        SELECT etc.*,
          sm.name AS seller_name,
          bm.name AS buyer_name
        FROM energy_trade_contracts etc
        JOIN municipalities sm ON sm.id = etc.seller_municipality_id
        JOIN municipalities bm ON bm.id = etc.buyer_municipality_id
        WHERE etc.buyer_municipality_id = ?
          AND etc.status = 'active'
          AND etc.contract_type = 'spot'
          AND etc.seller_user_id IS NOT NULL
          AND etc.buyer_user_id  IS NOT NULL
        ORDER BY etc.price_per_mw ASC
      `, [buyerMuniId]);

      // Defizit aufteilen: günstigste zuerst, Rest weitergeben
      let remainingDeficit = deficitTotal;

      for (const contract of contracts) {
        if (remainingDeficit <= 0) break;

        const actualMw  = Math.min(remainingDeficit, Number(contract.spot_max_mw ?? 0));
        if (actualMw <= 0) continue;

        const priceHour = Number(contract.price_per_mw ?? 2.0);
        const isAuto    = contract.auto_subscribed === 1;
        const costChf   = Math.round(actualMw * priceHour / 60 * 100) / 100;
        if (costChf < 0.01) { remainingDeficit -= actualMw; continue; }

        const conn = await dbPool.getConnection();
        try {
          await conn.beginTransaction();

          // Käufer: Gemeindekasse
          const [buyerMs] = await conn.query(
            `SELECT treasury, debt FROM municipality_stats WHERE municipality_id = ? FOR UPDATE`,
            [buyerMuniId]
          );
          if (!buyerMs[0]) { await conn.rollback(); continue; }

          const buyerTreasury = Number(buyerMs[0].treasury);
          const buyerDebt     = Number(buyerMs[0].debt);
          const newBuyerTreasury = Math.round(Math.max(0, buyerTreasury - costChf) * 100) / 100;
          const newBuyerDebt     = buyerTreasury - costChf < 0
            ? Math.round((buyerDebt + Math.abs(buyerTreasury - costChf)) * 100) / 100
            : buyerDebt;

          // Verkäufer: Gemeindekasse
          const [sellerMs] = await conn.query(
            `SELECT treasury, debt FROM municipality_stats WHERE municipality_id = ? FOR UPDATE`,
            [contract.seller_municipality_id]
          );
          if (!sellerMs[0]) { await conn.rollback(); continue; }

          const sellerTreasury    = Number(sellerMs[0].treasury);
          const sellerDebt        = Number(sellerMs[0].debt);
          const newSellerTreasury = Math.round((sellerTreasury + costChf) * 100) / 100;

          const surchargeNote = isAuto ? ' (+20% Sofort-Gebühr)' : '';
          const meta = JSON.stringify({
            contract_id:          contract.id,
            actual_mw:            actualMw,
            deficit_total_mw:     deficitTotal,
            price_per_mw_hour:    priceHour,
            auto_subscribed:      isAuto,
            seller_municipality:  contract.seller_name,
            buyer_municipality:   contract.buyer_name,
          });

          // Abbuchung Käufer-Gemeindekasse
          await conn.query(
            `UPDATE municipality_stats SET treasury = ?, debt = ?, updated_at = NOW() WHERE municipality_id = ?`,
            [newBuyerTreasury, newBuyerDebt, buyerMuniId]
          );
          await conn.query(`
            INSERT INTO municipality_ledger
              (municipality_id, type, amount, balance_after, debt_after, meta_json, actor_user_id, source)
            VALUES (?, 'energy_spot_buy', ?, ?, ?, ?, NULL, 'system')`,
            [buyerMuniId, costChf, newBuyerTreasury, newBuyerDebt, meta]
          );

          // Gutschrift Verkäufer-Gemeindekasse
          await conn.query(
            `UPDATE municipality_stats SET treasury = ?, updated_at = NOW() WHERE municipality_id = ?`,
            [newSellerTreasury, contract.seller_municipality_id]
          );
          await conn.query(`
            INSERT INTO municipality_ledger
              (municipality_id, type, amount, balance_after, debt_after, meta_json, actor_user_id, source)
            VALUES (?, 'energy_spot_sell', ?, ?, ?, ?, NULL, 'system')`,
            [contract.seller_municipality_id, costChf, newSellerTreasury, sellerDebt, meta]
          );

          // Billing-Log (vollständige SQL-Nachvollziehbarkeit)
          await conn.query(`
            INSERT INTO energy_spot_billing_log
              (contract_id,
               buyer_municipality_id,  seller_municipality_id,
               buyer_municipality_name, seller_municipality_name,
               buyer_user_id, seller_user_id,
               deficit_total_mw, actual_mw, price_per_mw_hour, amount_chf, auto_subscribed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [contract.id,
             buyerMuniId,          contract.seller_municipality_id,
             contract.buyer_name,  contract.seller_name,
             contract.buyer_user_id, contract.seller_user_id,
             deficitTotal, actualMw, priceHour, costChf, isAuto ? 1 : 0]
          );

          await conn.commit();

          logInfo('ENERGY',
            `Billing | Vertrag ${contract.id}` +
            ` | ${contract.buyer_name} → ${contract.seller_name}` +
            ` | ${actualMw}/${deficitTotal} MW | Fr.${costChf}${isAuto ? ' [Auto+20%]' : ''}`
          );

          remainingDeficit -= actualMw;
        } catch (err) {
          await conn.rollback();
          logError('ENERGY', `Billing Fehler Vertrag ${contract.id}`, { error: err?.message });
        } finally {
          conn.release();
        }
      }

      if (remainingDeficit > 0) {
        logInfo('ENERGY', `Gemeinde ${buyerMuniId}: ${remainingDeficit} MW ungedeckt → Standard-Import`);
      }
    } catch (err) {
      logError('ENERGY', `Billing Fehler Gemeinde ${buyerMuniId}`, { error: err?.message });
    }
  }
}

module.exports = { processSpotEnergyBilling, autoSubscribeSpotEnergy };
