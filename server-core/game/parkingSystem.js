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

// Bussen-Aufteilung
const FINE_AMOUNT  = 80;  // CHF Gesamtbusse
const FINE_COMMUNE = 50;  // → Gemeindekasse
const FINE_COMPANY = 20;  // → Security-Firma
// 10 CHF verbleiben als Aufwandsentschädigung

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
async function handleVehicleLeft(municipalityId, tileX, tileY, slot) {
  ensureDbEnabled();
  try {
    // Parkzeit und Konfiguration laden
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

    if (!vehicle || vehicle.is_free) return; // kostenlos → nichts buchen

    const parkedAt  = new Date(vehicle.parked_at);
    const nowMs     = Date.now();
    const durationH = Math.max(0, (nowMs - parkedAt.getTime()) / 3600000); // Stunden
    if (durationH <= 0) return;

    const grossRevenue = durationH * Number(vehicle.fee_rate); // CHF (dezimal)

    // Anti-Exploit: Anteil prüfen
    const [[stats]] = await dbPool.query(
      `SELECT COALESCE(population, 0) AS population, COALESCE(jobs, 0) AS jobs
       FROM municipality_stats WHERE municipality_id = ?`,
      [municipalityId]
    );
    const demand = Math.floor((Number(stats?.jobs) || 0) * 0.30 + (Number(stats?.population) || 0) * 0.10);

    // Wie viele Autos parken gerade (inkl. dieses)?
    const [[{ parkedCount }]] = await dbPool.query(
      `SELECT COUNT(*) AS parkedCount FROM parked_vehicles WHERE municipality_id = ?`,
      [municipalityId]
    );
    const count = Math.max(1, Number(parkedCount) || 1);

    // Anteil dieses Autos am Demand (max 1.0), × 70 % zahlen tatsächlich
    const fraction      = Math.min(1, demand / count);
    const netRevenue    = Math.round(grossRevenue * fraction * 0.70);
    if (netRevenue < 1) return; // unter 1 CHF → nicht buchen

    // Treasury erhöhen
    await dbPool.query(
      `UPDATE municipality_stats SET treasury = treasury + ? WHERE municipality_id = ?`,
      [netRevenue, municipalityId]
    );

    // Ledger-Buchung
    await _ledger(municipalityId, 'parking_fee', netRevenue, {
      tileX, tileY, slot,
      durationMinutes: Math.round(durationH * 60),
      feeRateCHF:      Number(vehicle.fee_rate),
      grossCHF:        Math.round(grossRevenue * 100) / 100,
      netCHF:          netRevenue,
    });
  } catch (err) {
    logError('PARKING', 'handleVehicleLeft Fehler', { error: err?.message });
  }
}

// ── Ablauf-Tick: Abgelaufene Fahrzeuge rauswerfen (alle 60 s) ─────────────────
async function runParkingExpiryTick(broadcastToRoom) {
  ensureDbEnabled();
  try {
    // Alle Fahrzeuge die ihre leave_after_seconds überschritten haben
    const [expired] = await dbPool.query(
      `SELECT id, municipality_id, tile_x, tile_y, slot
       FROM parked_vehicles
       WHERE parked_at + INTERVAL leave_after_seconds SECOND < NOW()`
    );
    for (const v of expired) {
      try {
        await handleVehicleLeft(v.municipality_id, v.tile_x, v.tile_y, v.slot);
        await dbPool.query(
          `DELETE FROM parked_vehicles WHERE id = ?`,
          [v.id]
        );
        if (broadcastToRoom) {
          broadcastToRoom(v.municipality_id, 'vehicle-left-parking', {
            tileX: v.tile_x, tileY: v.tile_y, slot: v.slot,
          });
        }
      } catch (err) {
        logError('PARKING', 'Ablauf-Tick Einzelfahrzeug Fehler', { error: err?.message, id: v.id });
      }
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
        `SELECT id, tile_x, tile_y, slot, fine_amount
         FROM parking_violations
         WHERE municipality_id = ? AND status = 'unpaid'
         ORDER BY created_at ASC LIMIT ?`,
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

      // Batch: company_finances-Einträge per Bulk-Insert
      const financeValues = violations.map(() => `(?, ?, (SELECT balance FROM companies WHERE id = ?), 'parking_fine_provision')`).join(',');
      const financeParams = violations.flatMap(() => [company_id, FINE_COMPANY, company_id]);
      await dbPool.query(`INSERT INTO company_finances (company_id, amount, balance_after, reason) VALUES ${financeValues}`, financeParams);

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
};
