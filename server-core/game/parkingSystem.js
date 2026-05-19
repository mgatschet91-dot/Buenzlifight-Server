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

// ── Kontrolleur-NPC In-Memory-State ──────────────────────────────────────────
// Map<roomKey, Map<npcId, NpcState>> — analog zu crimeRoomState in disasters.js
const kontrolleurRoomState = new Map();
// Pro Firma: wann war die letzte Patrouille (ms timestamp)
const _companyLastPatrol = new Map();
// Pro Firma: läuft gerade eine Patrouille?
const _companyActiveNpc = new Map(); // companyId → npcId
let _nextKontrolleurId = 1;

// Patrouille alle 10 Minuten (± 2 Min Jitter damit nicht alle gleichzeitig)
const PATROL_INTERVAL_MS = 10 * 60 * 1000;

function _kontrolleurRoomKey(municipalityId, roomCode) {
  return `${municipalityId}:${roomCode || 'MAIN'}`;
}

function _getKontrolleurMap(municipalityId, roomCode) {
  const key = _kontrolleurRoomKey(municipalityId, roomCode);
  if (!kontrolleurRoomState.has(key)) kontrolleurRoomState.set(key, new Map());
  return kontrolleurRoomState.get(key);
}

// Alle aktiven Kontrolleur-NPCs einer Room als Array zurückgeben (für Broadcast)
function getKontrolleurNpcStates(municipalityId, roomCode) {
  const key = _kontrolleurRoomKey(municipalityId, roomCode);
  const npcMap = kontrolleurRoomState.get(key);
  if (!npcMap || npcMap.size === 0) return [];
  return Array.from(npcMap.values()).map(n => ({
    id: n.id, x: n.x, y: n.y, state: n.state,
    targetX: n.targetX, targetY: n.targetY,
    companyId: n.companyId,
  }));
}

// ── Busse für einen einzelnen Kontrolleur-NPC ausstellen ─────────────────────
async function _issueFineForNpc(npc, broadcastToRoom) {
  const tileX = npc.targetX;
  const tileY = npc.targetY;
  const slot  = npc.targetSlot;

  // Fahrzeug noch vorhanden?
  const [[vehicle]] = await dbPool.query(
    `SELECT color FROM parked_vehicles
     WHERE municipality_id = ? AND tile_x = ? AND tile_y = ? AND slot = ? LIMIT 1`,
    [npc.municipalityId, tileX, tileY, slot]
  );
  if (!vehicle) return; // Auto bereits weggefahren

  // Spot noch gebührenpflichtig?
  const [[cfg]] = await dbPool.query(
    `SELECT is_free FROM parking_config WHERE municipality_id = ? AND tile_x = ? AND tile_y = ?`,
    [npc.municipalityId, tileX, tileY]
  );
  if (!cfg || cfg.is_free) return; // Spot ist jetzt kostenlos

  // Violation dynamisch anlegen (analog zu handleVehicleParked)
  const [insResult] = await dbPool.query(
    `INSERT IGNORE INTO parking_violations
       (municipality_id, tile_x, tile_y, slot, fine_amount, status)
     VALUES (?, ?, ?, ?, ?, 'unpaid')`,
    [npc.municipalityId, tileX, tileY, slot, FINE_AMOUNT]
  );
  const violationId = insResult.insertId || null;

  await dbPool.query(
    `UPDATE parking_violations SET status = 'fined', security_company_id = ?, fined_at = NOW()
     WHERE municipality_id = ? AND tile_x = ? AND tile_y = ? AND slot = ? AND status = 'unpaid'`,
    [npc.companyId, npc.municipalityId, tileX, tileY, slot]
  );
  await dbPool.query(
    `UPDATE municipality_stats SET treasury = treasury + ? WHERE municipality_id = ?`,
    [FINE_COMMUNE, npc.municipalityId]
  );
  await dbPool.query(
    `UPDATE companies SET balance = balance + ? WHERE id = ?`,
    [FINE_COMPANY, npc.companyId]
  );

  const plate = vehicle.color ? _getPlate(tileX, tileY, slot, vehicle.color) : null;

  await dbPool.query(
    `INSERT INTO company_finances (company_id, amount, balance_after, reason, description)
     VALUES (?, ?, (SELECT balance FROM companies WHERE id = ?), 'parking_fine_provision', ?)`,
    [npc.companyId, FINE_COMPANY, npc.companyId, plate ? `🚗 ${plate}` : null]
  );

  await _ledger(npc.municipalityId, 'parking_fine', FINE_COMMUNE, {
    violationId, tileX, tileY, slot,
    companyId: npc.companyId, companyName: npc.companyName,
    totalFine: FINE_AMOUNT, companyShare: FINE_COMPANY,
  });

  // XP und Busse-Zähler für den Kontrolleur-Bot
  if (npc.botId) {
    await dbPool.query(
      `UPDATE npc_bots SET xp_earned = xp_earned + 5, contracts_completed = contracts_completed + 1 WHERE id = ?`,
      [npc.botId]
    ).catch(() => {});
  }

  // Fahrzeug nach Busse entfernen (fährt weg)
  await dbPool.query(
    `DELETE FROM parked_vehicles WHERE municipality_id = ? AND tile_x = ? AND tile_y = ? AND slot = ?`,
    [npc.municipalityId, tileX, tileY, slot]
  );

  if (broadcastToRoom) {
    broadcastToRoom(npc.municipalityId, 'vehicle-left-parking', { tileX, tileY, slot });
    broadcastToRoom(npc.municipalityId, 'parking-fine-issued', {
      tileX, tileY, slot,
      fineAmount: FINE_AMOUNT, companyName: npc.companyName,
      communeShare: FINE_COMMUNE, companyShare: FINE_COMPANY,
    });
  }
}

// ── Kontrolleur-NPC-Tick: Bewegung + Busse ausstellen (alle 3 s) ──────────────
async function tickKontrolleurNpcs(broadcastToRoom) {
  if (kontrolleurRoomState.size === 0) return;
  try {
    for (const [roomKey, npcMap] of kontrolleurRoomState) {
      for (const [id, npc] of npcMap) {
        if (npc.state === 'driving') {
          // 1 Schritt pro Tick in Richtung Ziel (zuerst X, dann Y)
          if (npc.x !== npc.targetX) {
            npc.x += npc.x < npc.targetX ? 1 : -1;
          } else if (npc.y !== npc.targetY) {
            npc.y += npc.y < npc.targetY ? 1 : -1;
          }
          if (npc.x === npc.targetX && npc.y === npc.targetY) {
            npc.state = 'inspecting';
            npc.ticksInState = 0;
          }
        } else if (npc.state === 'inspecting') {
          npc.ticksInState = (npc.ticksInState || 0) + 1;
          if (npc.ticksInState >= 2) {
            // Busse für aktuellen Spot ausstellen
            try {
              await _issueFineForNpc(npc, broadcastToRoom);
            } catch (err) {
              logError('PARKING', 'Kontrolleur-NPC Busse-Fehler', { error: err?.message, npcId: id });
            }
            // Nächsten Spot aus der Queue holen
            const next = npc.pendingSpots && npc.pendingSpots.length > 0
              ? npc.pendingSpots.shift()
              : null;
            if (next) {
              npc.targetX = next.tileX;
              npc.targetY = next.tileY;
              npc.targetSlot = next.slot;
              npc.state = 'driving';
              npc.ticksInState = 0;
            } else {
              // Alle Spots abgearbeitet → Patrouille beendet
              _companyActiveNpc.delete(npc.companyId);
              npcMap.delete(id);
            }
          }
        }
      }
      if (npcMap.size === 0) kontrolleurRoomState.delete(roomKey);
    }
  } catch (err) {
    logError('PARKING', 'tickKontrolleurNpcs Fehler', { error: err?.message });
  }
}

// ── Kontrolleur-Tick: Patrouille alle ~10 Minuten starten ────────────────────
async function runParkingControlTick(broadcastToRoom) {
  ensureDbEnabled();
  try {
    const [firms] = await dbPool.query(
      `SELECT c.id AS company_id, c.municipality_id, c.name AS company_name,
              COALESCE(MAX(gr.room_code), 'MAIN') AS room_code
       FROM companies c
       JOIN company_types ct ON ct.id = c.company_type_id
       LEFT JOIN game_rooms gr ON gr.municipality_id = c.municipality_id AND gr.is_active = 1
       WHERE ct.code = 'parkraum_security' AND c.is_active = 1
         AND EXISTS (SELECT 1 FROM npc_bots nb WHERE nb.company_id = c.id AND nb.bot_type = 'kontrolleur' AND nb.status != 'fired' AND nb.patrol_mode = 1)
       GROUP BY c.id`
    );

    const now = Date.now();

    for (const firm of firms) {
      const { company_id, municipality_id, company_name, room_code } = firm;

      // Läuft gerade eine Patrouille für diese Firma? → überspringen
      if (_companyActiveNpc.has(company_id)) continue;

      // Intervall prüfen: zufälliger Jitter ±2 Min damit nicht alle gleichzeitig starten
      const last = _companyLastPatrol.get(company_id) ?? 0;
      const jitter = (Math.random() * 4 - 2) * 60 * 1000; // ±2 Min
      if (now - last < PATROL_INTERVAL_MS + jitter) continue;

      // Alle aktuell parkenden Fahrzeuge auf bezahlpflichtigen Spots laden
      const [parkedOnPaid] = await dbPool.query(
        `SELECT pv.tile_x, pv.tile_y, pv.slot
         FROM parked_vehicles pv
         JOIN parking_config pc
           ON pc.municipality_id = pv.municipality_id
          AND pc.tile_x = pv.tile_x AND pc.tile_y = pv.tile_y
         WHERE pv.municipality_id = ? AND pc.is_free = 0
         ORDER BY pv.tile_x, pv.tile_y, pv.slot`,
        [municipality_id]
      );

      if (parkedOnPaid.length === 0) {
        // Kein Fahrzeug → Timer trotzdem setzen (sonst sofortiger Retry)
        _companyLastPatrol.set(company_id, now);
        continue;
      }

      // Ersten Spot als Startziel, Rest in pendingSpots-Queue
      const first = parkedOnPaid[0];
      const pending = parkedOnPaid.slice(1).map(v => ({ tileX: v.tile_x, tileY: v.tile_y, slot: v.slot }));

      // Bot-ID für XP-Vergabe holen
      const [[botRow]] = await dbPool.query(
        `SELECT id FROM npc_bots WHERE company_id = ? AND bot_type = 'kontrolleur' AND status != 'fired' AND patrol_mode = 1 LIMIT 1`,
        [company_id]
      );

      // Spawn ~3-5 Tiles vom ersten Spot entfernt
      const offsetX = (Math.random() < 0.5 ? 1 : -1) * (3 + Math.floor(Math.random() * 3));
      const npcMap = _getKontrolleurMap(municipality_id, room_code);
      const id = _nextKontrolleurId++;

      npcMap.set(id, {
        id,
        botId: botRow?.id ?? null,
        companyId: company_id,
        companyName: company_name,
        municipalityId: municipality_id,
        x: Math.max(0, first.tile_x + offsetX),
        y: first.tile_y,
        targetX: first.tile_x,
        targetY: first.tile_y,
        targetSlot: first.slot,
        pendingSpots: pending,
        state: 'driving',
        ticksInState: 0,
      });

      _companyActiveNpc.set(company_id, id);
      _companyLastPatrol.set(company_id, now);
    }
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
  tickKontrolleurNpcs,
  getKontrolleurNpcStates,
  setParkingConfig,
  getParkingConfigs,
  getParkingViolations,
  manualKontrolle,
};
