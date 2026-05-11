'use strict';

/**
 * parkingSystem.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Verwaltet das Parkgebühren-System:
 *   • handleVehicleParked   – 30 % Schwarzparker-Chance beim Einparken
 *   • handleVehicleLeft     – Gebühr beim Wegfahren berechnen + buchen
 *   • runParkingControlTick – alle 30 s: Kontrolleure büssen Schwarzparker
 *   • setParkingConfig       – Parkfeld-Konfiguration (kostenlos / Gebühr)
 *   • getParkingConfigs      – alle Configs einer Gemeinde laden
 *   • getParkingViolations   – offene Verstösse einer Gemeinde laden
 *
 * Einnahmen-Anti-Exploit:
 *   Jede Zahlung wird gegen den aktuellen Bedarf (jobs × 0.30 + pop × 0.10)
 *   geprüft. Übersteigt die Zahl gleichzeitig parkender Autos den Bedarf,
 *   zahlt nur der Bedarf-Anteil (70 % davon effektiv).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { dbPool, ensureDbEnabled } = require('../infra/db.js');
const { logError } = require('../infra/logger.js');

// ── Kennzeichen-Generierung (identisch mit Frontend-Hash) ─────────────────────
const CH_CANTONS = ['AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE','NW','OW','SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH'];
function _hashVehicle(tileX, tileY, slot, color) {
  let h = 0;
  const s = `${tileX}|${tileY}|${slot}|${color}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return Math.abs(h);
}
function _getPlate(tileX, tileY, slot, color) {
  const h = _hashVehicle(tileX, tileY, slot, color);
  const canton = CH_CANTONS[h % CH_CANTONS.length];
  const num = 100 + (Math.abs(_hashVehicle(tileX + 1, tileY + 1, slot + 1, color)) % 99900);
  return `${canton} ${num}`;
}

// Bussen-Aufteilung
const FINE_AMOUNT  = 50;  // CHF Gesamtbusse
const FINE_COMMUNE = 30;  // → Gemeindekasse
const FINE_COMPANY = 15;  // → Security-Firma (NPC-Kontrolleur)
//  5 CHF verbleiben als Aufwandsentschädigung

// ── Ledger-Eintrag schreiben ──────────────────────────────────────────────────
async function _ledger(municipalityId, type, amount, metaJson = null) {
  const [[row]] = await dbPool.query(
    `SELECT treasury, COALESCE(debt, 0) AS debt FROM municipality_stats WHERE municipality_id = ?`,
    [municipalityId]
  );
  if (!row) return;
  await dbPool.query(
    `INSERT INTO municipality_ledger
       (municipality_id, type, amount, balance_after, debt_after, meta_json, actor_user_id, source)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'system')`,
    [municipalityId, type, Math.round(amount), Number(row.treasury), Number(row.debt),
     metaJson ? JSON.stringify(metaJson) : null]
  );
}

// ── Schwarzparker-Chance beim Einparken ───────────────────────────────────────
// Nur auf bezahlten Feldern; 30 % Chance → Eintrag in parking_violations.
async function handleVehicleParked(municipalityId, tileX, tileY, slot) {
  ensureDbEnabled();
  try {
    const [[cfg]] = await dbPool.query(
      `SELECT is_free FROM parking_config WHERE municipality_id = ? AND tile_x = ? AND tile_y = ?`,
      [municipalityId, tileX, tileY]
    );
    if (cfg?.is_free) return { isViolation: false };

    const isViolation = Math.random() < 0.30;
    if (isViolation) {
      await dbPool.query(
        `INSERT IGNORE INTO parking_violations
           (municipality_id, tile_x, tile_y, slot, fine_amount, status)
         VALUES (?, ?, ?, ?, ?, 'unpaid')`,
        [municipalityId, tileX, tileY, slot, FINE_AMOUNT]
      );
    }
    return { isViolation };
  } catch (err) {
    logError('PARKING', 'handleVehicleParked Fehler', { error: err?.message });
    return { isViolation: false };
  }
}

// ── Gebühr beim Wegfahren buchen ──────────────────────────────────────────────
// Berechnet Parkdauer (parked_at → jetzt), multipliziert mit Stundenrate.
// Anti-Exploit: Einnahmen nur bis zum Bedarf der Stadt (jobs × 0.30 + pop × 0.10).
// Gebühr für ein einzelnes Fahrzeug berechnen (ohne DB-Schreibzugriff).
// Gibt netRevenue zurück oder 0 wenn kostenlos / keine Dauer.
async function _calcFee(municipalityId, tileX, tileY, slot, parkedAt, isFree, feeRate, demand, count) {
  if (isFree) return 0;
  const durationH = Math.max(0, (Date.now() - new Date(parkedAt).getTime()) / 3600000);
  if (durationH <= 0) return 0;
  const gross    = durationH * Number(feeRate);
  const fraction = Math.min(1, demand / Math.max(1, count));
  return Math.max(1, Math.round(gross * fraction * 0.70));
}

async function handleVehicleLeft(municipalityId, tileX, tileY, slot) {
  ensureDbEnabled();
  try {
    const [[vehicle]] = await dbPool.query(
      `SELECT pv.parked_at,
              COALESCE(pc.is_free, 0)    AS is_free,
              COALESCE(pc.fee_rate, 3.0) AS fee_rate
       FROM parked_vehicles pv
       LEFT JOIN parking_config pc
         ON pc.municipality_id = pv.municipality_id
        AND pc.tile_x = pv.tile_x AND pc.tile_y = pv.tile_y
       WHERE pv.municipality_id = ? AND pv.tile_x = ? AND pv.tile_y = ? AND pv.slot = ?`,
      [municipalityId, tileX, tileY, slot]
    );
    if (!vehicle || vehicle.is_free) return;

    const [[stats]] = await dbPool.query(
      `SELECT COALESCE(population,0) AS population, COALESCE(jobs,0) AS jobs
       FROM municipality_stats WHERE municipality_id = ?`, [municipalityId]
    );
    const demand = Math.floor((Number(stats?.jobs)||0)*0.30 + (Number(stats?.population)||0)*0.10);
    const [[{ parkedCount }]] = await dbPool.query(
      `SELECT COUNT(*) AS parkedCount FROM parked_vehicles WHERE municipality_id = ?`, [municipalityId]
    );
    const netRevenue = await _calcFee(
      municipalityId, tileX, tileY, slot,
      vehicle.parked_at, vehicle.is_free, vehicle.fee_rate,
      demand, Number(parkedCount) || 1
    );
    if (netRevenue <= 0) return;

    await dbPool.query(
      `UPDATE municipality_stats SET treasury = treasury + ? WHERE municipality_id = ?`,
      [netRevenue, municipalityId]
    );
    await _ledger(municipalityId, 'parking_fee', netRevenue, {
      tileX, tileY, slot,
      durationMinutes: Math.round((Date.now() - new Date(vehicle.parked_at).getTime()) / 60000),
      feeRateCHF: Number(vehicle.fee_rate),
      netCHF: netRevenue,
    });
  } catch (err) {
    logError('PARKING', 'handleVehicleLeft Fehler', { error: err?.message });
  }
}

// ── Ablauf-Tick: Abgelaufene Fahrzeuge rauswerfen (alle 60 s) ─────────────────
// Schreibt pro Gemeinde EINEN gebündelten Ledger-Eintrag statt einen pro Auto.
async function runParkingExpiryTick(broadcastToRoom) {
  ensureDbEnabled();
  try {
    const [expired] = await dbPool.query(
      `SELECT pv.id, pv.municipality_id, pv.tile_x, pv.tile_y, pv.slot, pv.parked_at,
              COALESCE(pc.is_free, 0)    AS is_free,
              COALESCE(pc.fee_rate, 3.0) AS fee_rate
       FROM parked_vehicles pv
       LEFT JOIN parking_config pc
         ON pc.municipality_id = pv.municipality_id
        AND pc.tile_x = pv.tile_x AND pc.tile_y = pv.tile_y
       WHERE pv.parked_at + INTERVAL pv.leave_after_seconds SECOND < NOW()`
    );
    if (expired.length === 0) return;

    // Anti-Exploit-Daten einmal pro Gemeinde laden
    const municipalityIds = [...new Set(expired.map(v => v.municipality_id))];
    const demandMap = new Map();
    for (const mid of municipalityIds) {
      const [[stats]] = await dbPool.query(
        `SELECT COALESCE(population,0) AS population, COALESCE(jobs,0) AS jobs,
                (SELECT COUNT(*) FROM parked_vehicles WHERE municipality_id = ?) AS parkedCount
         FROM municipality_stats WHERE municipality_id = ?`, [mid, mid]
      );
      const demand = Math.floor((Number(stats?.jobs)||0)*0.30 + (Number(stats?.population)||0)*0.10);
      demandMap.set(mid, { demand, count: Math.max(1, Number(stats?.parkedCount)||1) });
    }

    // Gebühren berechnen + IDs sammeln
    const revenueByMunicipality = new Map(); // municipalityId → { total, cars }
    const ids = [];
    for (const v of expired) {
      try {
        const { demand, count } = demandMap.get(v.municipality_id);
        const net = await _calcFee(
          v.municipality_id, v.tile_x, v.tile_y, v.slot,
          v.parked_at, v.is_free, v.fee_rate, demand, count
        );
        if (net > 0) {
          const entry = revenueByMunicipality.get(v.municipality_id) || { total: 0, cars: 0 };
          entry.total += net;
          entry.cars  += 1;
          revenueByMunicipality.set(v.municipality_id, entry);
        }
        ids.push(v.id);
        if (broadcastToRoom) {
          broadcastToRoom(v.municipality_id, 'vehicle-left-parking', {
            tileX: v.tile_x, tileY: v.tile_y, slot: v.slot,
          });
        }
      } catch (err) {
        logError('PARKING', 'Ablauf-Tick Einzelfahrzeug Fehler', { error: err?.message, id: v.id });
      }
    }

    // Fahrzeuge löschen
    if (ids.length > 0) {
      await dbPool.query(
        `DELETE FROM parked_vehicles WHERE id IN (${ids.map(() => '?').join(',')})`, ids
      );
    }

    // Pro Gemeinde: Treasury + ein gebündelter Ledger-Eintrag
    for (const [mid, { total, cars }] of revenueByMunicipality) {
      await dbPool.query(
        `UPDATE municipality_stats SET treasury = treasury + ? WHERE municipality_id = ?`,
        [total, mid]
      );
      await _ledger(mid, 'parking_fee', total, { cars, netCHF: total });
    }
  } catch (err) {
    logError('PARKING', 'runParkingExpiryTick Fehler', { error: err?.message });
  }
}

// ── Kontrolleur-Tick: Schwarzparker büssen (alle 30 s) ────────────────────────
async function runParkingControlTick(broadcastToRoom) {
  ensureDbEnabled();
  try {
    const [firms] = await dbPool.query(
      `SELECT c.id AS company_id, c.municipality_id, c.name AS company_name,
              COUNT(nb.id) AS kontrolleur_count
       FROM companies c
       JOIN company_types ct ON ct.id = c.company_type_id
       JOIN npc_bots nb ON nb.company_id = c.id AND nb.bot_type = 'kontrolleur' AND nb.status != 'fired'
       WHERE ct.code = 'parkraum_security' AND c.is_active = 1
       GROUP BY c.id`
    );

    for (const firm of firms) {
      const { company_id, municipality_id, company_name, kontrolleur_count } = firm;
      const maxPerTick = kontrolleur_count * 2;

      const [violations] = await dbPool.query(
        `SELECT pv.id, pv.tile_x, pv.tile_y, pv.slot, pv.fine_amount,
                pveh.color AS vehicle_color
         FROM parking_violations pv
         LEFT JOIN parked_vehicles pveh
           ON pveh.municipality_id = pv.municipality_id
          AND pveh.tile_x = pv.tile_x AND pveh.tile_y = pv.tile_y AND pveh.slot = pv.slot
         WHERE pv.municipality_id = ? AND pv.status = 'unpaid'
         ORDER BY pv.created_at ASC LIMIT ?`,
        [municipality_id, maxPerTick]
      );

      if (violations.length === 0) continue;

      // Batch: alle Verstösse auf einmal als 'fined' markieren
      const ids = violations.map(v => v.id);
      const placeholders = ids.map(() => '?').join(',');
      await dbPool.query(
        `UPDATE parking_violations SET status = 'fined', security_company_id = ?, fined_at = NOW() WHERE id IN (${placeholders})`,
        [company_id, ...ids]
      );

      // Batch: Gemeindekasse einmal erhöhen (FINE_COMMUNE × Anzahl)
      const totalCommune = FINE_COMMUNE * violations.length;
      await dbPool.query(
        `UPDATE municipality_stats SET treasury = treasury + ? WHERE municipality_id = ?`,
        [totalCommune, municipality_id]
      );

      // Batch: Security-Firma einmal erhöhen
      const totalCompany = FINE_COMPANY * violations.length;
      await dbPool.query(`UPDATE companies SET balance = balance + ? WHERE id = ?`, [totalCompany, company_id]);

      // Batch: company_finances-Einträge per Bulk-Insert (mit Kennzeichen als description)
      const financeValues = violations.map(() => `(?, ?, (SELECT balance FROM companies WHERE id = ?), 'parking_fine_provision', ?)`).join(',');
      const financeParams = violations.flatMap(v => {
        const plate = v.vehicle_color ? _getPlate(v.tile_x, v.tile_y, v.slot, v.vehicle_color) : null;
        return [company_id, FINE_COMPANY, company_id, plate ? `🚗 ${plate}` : null];
      });
      await dbPool.query(`INSERT INTO company_finances (company_id, amount, balance_after, reason, description) VALUES ${financeValues}`, financeParams);

      // Ledger-Einträge (1 pro Verstoss für Nachvollziehbarkeit)
      for (const v of violations) {
        await _ledger(municipality_id, 'parking_fine', FINE_COMMUNE, {
          violationId: v.id, tileX: v.tile_x, tileY: v.tile_y, slot: v.slot,
          companyId: company_id, companyName: company_name,
          totalFine: v.fine_amount, companyShare: FINE_COMPANY,
        });

        if (broadcastToRoom) {
          broadcastToRoom(municipality_id, 'parking-fine-issued', {
            tileX: v.tile_x, tileY: v.tile_y, slot: v.slot,
            fineAmount: v.fine_amount, companyName: company_name,
            communeShare: FINE_COMMUNE, companyShare: FINE_COMPANY,
          });
        }
      }
    }

    // Abgelaufene Verstösse entfernen (> 10 min, Auto längst weg)
    await dbPool.query(
      `DELETE FROM parking_violations WHERE status = 'unpaid' AND created_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)`
    );
  } catch (err) {
    logError('PARKING', 'runParkingControlTick Fehler', { error: err?.message });
  }
}

// ── Manuelle Kontrolle durch Parkraum-Security-Mitarbeiter ───────────────────
// Gibt zurück: { ok, hasViolation, userPayout, companyPayout, communePayout, error }
const FINE_MANUAL_COMMUNE = 25;  // → Gemeindekasse
const FINE_MANUAL_COMPANY = 10;  // → Firma
const FINE_MANUAL_USER    = 15;  // → User der gefunden hat
// Total: 50 CHF

async function manualKontrolle(tileX, tileY, slot, userId) {
  ensureDbEnabled();
  try {
    // User muss Mitglied irgendeiner aktiven parkraum_security-Firma sein
    const [[membership]] = await dbPool.query(
      `SELECT cm.company_id, c.name AS company_name, c.municipality_id
       FROM company_members cm
       JOIN companies c ON c.id = cm.company_id
       JOIN company_types ct ON ct.id = c.company_type_id
       WHERE cm.user_id = ? AND ct.code = 'parkraum_security' AND c.is_active = 1
       LIMIT 1`,
      [userId]
    );
    if (!membership) return { ok: false, error: 'Nicht Mitglied einer Parkraum-Security-Firma' };

    const municipalityId = membership.municipality_id;

    // Offenen Verstoss auf diesem Slot suchen (in der Gemeinde der Firma)
    const [[violation]] = await dbPool.query(
      `SELECT id, fine_amount FROM parking_violations
       WHERE municipality_id = ? AND tile_x = ? AND tile_y = ? AND slot = ? AND status = 'unpaid'
       LIMIT 1`,
      [municipalityId, tileX, tileY, slot]
    );

    if (!violation) return { ok: true, hasViolation: false };

    // Farbe lesen bevor das Fahrzeug gelöscht wird (für Kennzeichen)
    const [[vehicle]] = await dbPool.query(
      `SELECT color FROM parked_vehicles WHERE municipality_id = ? AND tile_x = ? AND tile_y = ? AND slot = ? LIMIT 1`,
      [municipalityId, tileX, tileY, slot]
    );
    const plate = vehicle?.color ? _getPlate(tileX, tileY, slot, vehicle.color) : null;

    // Verstoss als gebüsst markieren, User als Finder eintragen
    await dbPool.query(
      `UPDATE parking_violations
       SET status = 'fined', security_company_id = ?, fined_at = NOW(),
           found_by_user_id = ?, user_payout = ?
       WHERE id = ?`,
      [membership.company_id, userId, FINE_MANUAL_USER, violation.id]
    );

    // Fahrzeug wegschicken (fährt nach Busse weg)
    await dbPool.query(
      `DELETE FROM parked_vehicles WHERE municipality_id = ? AND tile_x = ? AND tile_y = ? AND slot = ?`,
      [municipalityId, tileX, tileY, slot]
    );

    // Gemeindekasse
    await dbPool.query(
      `UPDATE municipality_stats SET treasury = treasury + ? WHERE municipality_id = ?`,
      [FINE_MANUAL_COMMUNE, municipalityId]
    );
    await _ledger(municipalityId, 'parking_fine_manual', FINE_MANUAL_COMMUNE, {
      violationId: violation.id, tileX, tileY, slot,
      companyId: membership.company_id, foundByUserId: userId,
    });

    // Firma
    await dbPool.query(`UPDATE companies SET balance = balance + ? WHERE id = ?`, [FINE_MANUAL_COMPANY, membership.company_id]);
    await dbPool.query(
      `INSERT INTO company_finances (company_id, amount, balance_after, reason, description)
       VALUES (?, ?, (SELECT balance FROM companies WHERE id = ?), 'parking_fine_provision', ?)`,
      [membership.company_id, FINE_MANUAL_COMPANY, membership.company_id, plate ? `🚗 ${plate}` : `Tile ${tileX}/${tileY} Slot ${slot}`]
    );

    // User-Bankkonto
    const { creditUserBankAccount } = require('./userBanking');
    await creditUserBankAccount(userId, {
      amount: FINE_MANUAL_USER,
      type: 'parking_fine_finder',
      meta: { tileX, tileY, slot, companyName: membership.company_name, violationId: violation.id },
    });

    return {
      ok: true,
      hasViolation: true,
      municipalityId: municipalityId,
      userPayout:    FINE_MANUAL_USER,
      companyPayout: FINE_MANUAL_COMPANY,
      communePayout: FINE_MANUAL_COMMUNE,
      companyName:   membership.company_name,
    };
  } catch (err) {
    logError('PARKING', 'manualKontrolle Fehler', { error: err?.message });
    return { ok: false, error: 'Interner Fehler' };
  }
}

// ── Konfiguration setzen ──────────────────────────────────────────────────────
async function setParkingConfig(municipalityId, tileX, tileY, isFree, feeRate) {
  ensureDbEnabled();
  await dbPool.query(
    `INSERT INTO parking_config (municipality_id, tile_x, tile_y, is_free, fee_rate)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE is_free = VALUES(is_free), fee_rate = VALUES(fee_rate)`,
    [municipalityId, tileX, tileY, isFree ? 1 : 0, feeRate]
  );
}

async function getParkingConfigs(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT tile_x, tile_y, is_free, fee_rate FROM parking_config WHERE municipality_id = ?`,
    [municipalityId]
  );
  return rows;
}

async function getParkingViolations(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT tile_x, tile_y, slot, status FROM parking_violations
     WHERE municipality_id = ? AND status = 'unpaid'`,
    [municipalityId]
  );
  return rows;
}

module.exports = {
  handleVehicleParked,
  handleVehicleLeft,
  runParkingExpiryTick,
  runParkingControlTick,
  setParkingConfig,
  getParkingConfigs,
  getParkingViolations,
  manualKontrolle,
};
