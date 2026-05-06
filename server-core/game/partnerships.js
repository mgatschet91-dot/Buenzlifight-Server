'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { normalizeDirection, normalizePartnershipStatus } = require('../shared/helpers');

// ── Tier-Konfiguration ────────────────────────────────────────────────────────
// Jede Stufe definiert: Name, Tages-Einkommen, Mindest-Verbindungstage, Mindest-Investition

const TIER_CONFIG = {
  1: { name: 'Bekannt',          label: '🤝',  daily: 100,  minDays: 0,  minInvested: 0     },
  2: { name: 'Freundschaftlich', label: '🌟',  daily: 250,  minDays: 3,  minInvested: 0     },
  3: { name: 'Strategisch',      label: '🏆',  daily: 500,  minDays: 6,  minInvested: 10000 },
  4: { name: 'Alliiert',         label: '👑',  daily: 1000, minDays: 12, minInvested: 50000 },
};

const MAX_TIER = 4;

/**
 * Gibt die Tier-Infos zurück inkl. Fortschritt zur nächsten Stufe.
 */
function computeTierProgress(tier, connectedAt, tierInvested) {
  const current = TIER_CONFIG[tier] || TIER_CONFIG[1];
  const next     = TIER_CONFIG[tier + 1] || null;

  const connectedDays = connectedAt
    ? Math.floor((Date.now() - new Date(connectedAt).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const canUpgrade = next
    ? connectedDays >= next.minDays && (tierInvested || 0) >= next.minInvested
    : false;

  return {
    tier,
    tierName:    current.name,
    tierLabel:   current.label,
    dailyIncome: current.daily,
    next: next
      ? {
          tier:        tier + 1,
          name:        next.name,
          label:       next.label,
          minDays:     next.minDays,
          minInvested: next.minInvested,
          daysLeft:    Math.max(0, next.minDays - connectedDays),
          investLeft:  Math.max(0, next.minInvested - (tierInvested || 0)),
          ready:       canUpgrade,
        }
      : null,
    connectedDays,
    tierInvested: tierInvested || 0,
  };
}

// ── Upsert ────────────────────────────────────────────────────────────────────

async function upsertPartnership({
  municipalityId,
  partnerMunicipalityId,
  status,
  direction,
  tradeIncome,
  connectionBonusPaid,
  discoveredAt,
  connectedAt,
}) {
  ensureDbEnabled();
  await dbPool.query(
    `INSERT INTO game_partnerships
      (municipality_id, partner_municipality_id, status, direction, trade_income, connection_bonus_paid, discovered_at, connected_at, tier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      direction = COALESCE(VALUES(direction), direction),
      trade_income = VALUES(trade_income),
      connection_bonus_paid = VALUES(connection_bonus_paid),
      discovered_at = COALESCE(discovered_at, VALUES(discovered_at)),
      connected_at = COALESCE(VALUES(connected_at), connected_at),
      updated_at = CURRENT_TIMESTAMP`,
    [
      municipalityId,
      partnerMunicipalityId,
      normalizePartnershipStatus(status),
      normalizeDirection(direction),
      Number(tradeIncome || 0),
      connectionBonusPaid ? 1 : 0,
      discoveredAt,
      connectedAt,
    ]
  );
}

// ── Tier upgraden ─────────────────────────────────────────────────────────────

/**
 * Prüft alle connected-Partnerschaften und upgraded Tiers wo die Bedingungen erfüllt sind.
 * Aktualisiert ausserdem trade_income auf den Tier-Wert.
 * Wird täglich aufgerufen.
 */
async function processTierUpgrades() {
  ensureDbEnabled();

  // Alle connected-Partnerschaften mit Tier < MAX laden
  let rows;
  try {
    [rows] = await dbPool.query(
      `SELECT id, municipality_id, partner_municipality_id, tier, tier_invested, connected_at
       FROM game_partnerships
       WHERE status = 'connected' AND tier < ?`,
      [MAX_TIER]
    );
  } catch {
    // Spalten noch nicht vorhanden (Migration noch nicht gelaufen)
    return { upgraded: 0 };
  }

  let upgraded = 0;

  for (const row of rows) {
    const currentTier = Number(row.tier || 1);
    const next = TIER_CONFIG[currentTier + 1];
    if (!next) continue;

    const connectedDays = row.connected_at
      ? Math.floor((Date.now() - new Date(row.connected_at).getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    const invested = Number(row.tier_invested || 0);

    if (connectedDays >= next.minDays && invested >= next.minInvested) {
      const newTier = currentTier + 1;
      const newDaily = TIER_CONFIG[newTier].daily;
      await dbPool.query(
        `UPDATE game_partnerships
         SET tier = ?, trade_income = ?, tier_upgraded_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [newTier, newDaily, row.id]
      );
      upgraded++;
    } else {
      // trade_income immer mit aktuellem Tier synchronisieren (falls manuell geändert)
      const correctDaily = TIER_CONFIG[currentTier].daily;
      await dbPool.query(
        `UPDATE game_partnerships SET trade_income = ? WHERE id = ? AND trade_income != ?`,
        [correctDaily, row.id, correctDaily]
      );
    }
  }

  // Neu verbundene (Tier noch 0 oder NULL) auf Tier 1 setzen
  try {
    await dbPool.query(
      `UPDATE game_partnerships
       SET tier = 1, trade_income = 100
       WHERE status = 'connected' AND (tier IS NULL OR tier = 0)`
    );
  } catch { /* ignore */ }

  return { upgraded };
}

// ── Tier investieren ──────────────────────────────────────────────────────────

/**
 * Gemeinde investiert Betrag in eine Partnerschaft (für Tier 3/4 Anforderung).
 * Zieht Geld aus der treasury ab.
 */
async function investInPartnership(municipalityId, partnerMunicipalityId, amount) {
  ensureDbEnabled();
  const safeAmount = Math.max(0, Math.round(Number(amount) || 0));
  if (safeAmount <= 0) throw new Error('Betrag muss grösser als 0 sein');

  const { applyMunicipalityTransaction } = require('./bank');

  // Geld abbuchen
  await applyMunicipalityTransaction(municipalityId, {
    amount: -safeAmount,
    type: 'partnership_investment',
    meta: { partnerMunicipalityId },
    source: 'user',
  });

  // tier_invested erhöhen (beide Richtungen)
  await dbPool.query(
    `UPDATE game_partnerships
     SET tier_invested = tier_invested + ?, updated_at = NOW()
     WHERE municipality_id = ? AND partner_municipality_id = ? AND status = 'connected'`,
    [safeAmount, municipalityId, partnerMunicipalityId]
  );

  const [rows] = await dbPool.query(
    `SELECT tier, tier_invested, connected_at FROM game_partnerships
     WHERE municipality_id = ? AND partner_municipality_id = ? LIMIT 1`,
    [municipalityId, partnerMunicipalityId]
  );
  if (!rows[0]) throw new Error('Partnerschaft nicht gefunden');

  return computeTierProgress(
    Number(rows[0].tier || 1),
    rows[0].connected_at,
    Number(rows[0].tier_invested || 0)
  );
}

// ── Read ──────────────────────────────────────────────────────────────────────

async function getPartnershipRow(municipalityId, partnerMunicipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT *
     FROM game_partnerships
     WHERE municipality_id = ? AND partner_municipality_id = ?
     LIMIT 1`,
    [municipalityId, partnerMunicipalityId]
  );
  return rows[0] || null;
}

async function listPartnershipRows(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT
      p.id, p.status, p.direction, p.trade_income, p.connection_bonus_paid,
      p.discovered_at, p.connected_at,
      p.tier, p.tier_upgraded_at, p.tier_invested,
      m.id AS partner_id, m.name AS partner_name, m.slug AS partner_slug, m.canton_code AS partner_canton
     FROM game_partnerships p
     INNER JOIN municipalities m ON m.id = p.partner_municipality_id
     WHERE p.municipality_id = ?
     ORDER BY p.tier DESC, m.name ASC`,
    [municipalityId]
  );
  return Array.isArray(rows) ? rows : [];
}

// ── DTO ───────────────────────────────────────────────────────────────────────

function toPartnershipDto(row) {
  const tier     = Number(row.tier || 1);
  const invested = Number(row.tier_invested || 0);
  const tierProgress = computeTierProgress(tier, row.connected_at, invested);

  return {
    id: Number(row.id),
    partner: {
      id:         Number(row.partner_id),
      name:       row.partner_name,
      slug:       row.partner_slug,
      canton:     row.partner_canton || undefined,
      population: row.partner_population != null ? Number(row.partner_population) : 0,
    },
    status:               row.status === 'connected' ? 'connected' : 'discovered',
    direction:            normalizeDirection(row.direction) || 'north',
    trade_income:         Number(row.trade_income || 0),
    connection_bonus_paid: Boolean(row.connection_bonus_paid),
    discovered_at:        row.discovered_at || null,
    connected_at:         row.connected_at || null,
    // Tier-Daten
    tier,
    tier_name:        tierProgress.tierName,
    tier_label:       tierProgress.tierLabel,
    tier_upgraded_at: row.tier_upgraded_at || null,
    tier_invested:    invested,
    tier_progress:    tierProgress,
  };
}

// ── Requests ──────────────────────────────────────────────────────────────────

async function listPartnershipRequestsForMunicipality(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT
      r.id, r.from_municipality_id, r.to_municipality_id, r.status, r.message, r.created_at, r.responded_at,
      fm.name AS from_name, fm.slug AS from_slug, fm.canton_code AS from_canton,
      tm.name AS to_name, tm.slug AS to_slug
     FROM game_partnership_requests r
     INNER JOIN municipalities fm ON fm.id = r.from_municipality_id
     INNER JOIN municipalities tm ON tm.id = r.to_municipality_id
     WHERE r.from_municipality_id = ? OR r.to_municipality_id = ?
     ORDER BY r.created_at DESC`,
    [municipalityId, municipalityId]
  );
  return Array.isArray(rows) ? rows : [];
}

async function getPartnershipRequestById(requestId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT * FROM game_partnership_requests WHERE id = ? LIMIT 1`,
    [requestId]
  );
  return rows[0] || null;
}

function toPartnershipRequestDto(row, fromOwner) {
  return {
    id: Number(row.id),
    from_municipality: {
      id:         Number(row.from_municipality_id),
      name:       row.from_name != null ? row.from_name : String(row.from_municipality_id || ''),
      slug:       row.from_slug != null ? row.from_slug : '',
      canton:     row.from_canton || undefined,
      population: 0,
      owner:      fromOwner ? { id: Number(fromOwner.id), nickname: fromOwner.nickname } : null,
    },
    to_municipality: {
      id:   Number(row.to_municipality_id),
      name: row.to_name != null ? row.to_name : String(row.to_municipality_id || ''),
      slug: row.to_slug != null ? row.to_slug : '',
    },
    status:       ['accepted', 'declined', 'pending'].includes(String(row.status)) ? row.status : 'pending',
    message:      row.message || undefined,
    created_at:   row.created_at,
    responded_at: row.responded_at || undefined,
  };
}

// ── Daily Trade Income Payout ─────────────────────────────────────────────────

/**
 * Schreibt tägliche Handelseinnahmen für alle connected Partnerschaften gut.
 * Idle-ready: läuft unabhängig ob Spieler online ist.
 * Zahlt max. 1× pro 24h pro Partnerschaft (tracked via last_trade_payout_at).
 */
async function processTradeIncomePayouts() {
  ensureDbEnabled();

  // Alle connected Partnerschaften die heute noch nicht ausgezahlt wurden (Kalendertag)
  let rows;
  try {
    [rows] = await dbPool.query(
      `SELECT p.id, p.municipality_id, p.partner_municipality_id,
              p.trade_income, p.tier,
              m.name AS municipality_name,
              pm.name AS partner_name
       FROM game_partnerships p
       INNER JOIN municipalities m  ON m.id  = p.municipality_id
       INNER JOIN municipalities pm ON pm.id = p.partner_municipality_id
       WHERE p.status = 'connected'
         AND p.trade_income > 0
         AND (p.last_trade_payout_at IS NULL OR DATE(p.last_trade_payout_at) < CURDATE())`
    );
  } catch {
    // Spalte noch nicht vorhanden (Migration noch nicht gelaufen)
    return { paid: 0, totalAmount: 0 };
  }

  if (!rows || rows.length === 0) return { paid: 0, totalAmount: 0 };

  const { applyMunicipalityTransaction } = require('./bank');

  let paid = 0;
  let totalAmount = 0;

  for (const row of rows) {
    const amount = Number(row.trade_income || 0);
    if (amount <= 0) continue;

    try {
      const tierNames = { 1: 'Bekannt', 2: 'Freundschaftlich', 3: 'Strategisch', 4: 'Alliiert' };
      const tierName = tierNames[Number(row.tier || 1)] || `Tier ${row.tier}`;
      await applyMunicipalityTransaction(row.municipality_id, {
        amount,
        type: 'trade_income',
        description: `Handelseinnahmen von ${row.partner_name} (${tierName})`,
        meta: {
          partnerMunicipalityId: row.partner_municipality_id,
          partnerName: row.partner_name,
          tier: row.tier,
        },
        source: 'system',
      });

      await dbPool.query(
        `UPDATE game_partnerships SET last_trade_payout_at = NOW() WHERE id = ?`,
        [row.id]
      );

      paid++;
      totalAmount += amount;
    } catch (err) {
      // Einzelner Fehler soll nicht alles blockieren
      require('../infra/logger').logError('PARTNERSHIP', `Trade payout fehlgeschlagen für Partnership ${row.id}`, { error: err?.message });
    }
  }

  return { paid, totalAmount };
}

// ── Export-Kapazität ──────────────────────────────────────────────────────────

// Gebäudetypen und ihre Export-Slots
const EXPORT_SLOT_CONFIG = {
  factory_small:  1,
  factory_medium: 2,
  factory_large:  3,
  warehouse:      1,
};

// Slots → Multiplikator
function slotsToMultiplier(slots) {
  if (slots === 0) return 0.1;
  if (slots <= 2)  return 0.5;
  if (slots <= 5)  return 0.8;
  return 1.0;
}

/**
 * Berechnet Export-Kapazität einer Gemeinde anhand ihrer Gebäude.
 * Gibt { slots, multiplier } zurück.
 */
async function computeExportCapacity(municipalityId) {
  ensureDbEnabled();
  const validTools = Object.keys(EXPORT_SLOT_CONFIG);
  const placeholders = validTools.map(() => '?').join(',');
  // Kein action_type-Filter — Fabriken können 'place' oder andere action_types haben
  const [rows] = await dbPool.query(
    `SELECT tool, COUNT(*) AS cnt
     FROM game_items
     WHERE municipality_id = ? AND tool IN (${placeholders})
     GROUP BY tool`,
    [municipalityId, ...validTools]
  );
  let slots = 0;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const s = EXPORT_SLOT_CONFIG[row.tool];
    if (s) slots += s * Number(row.cnt || 1);
  }
  return { slots, multiplier: slotsToMultiplier(slots) };
}

// ── Diplomatische Aktionen ────────────────────────────────────────────────────

const DIPLOMATIC_ACTIONS = {
  emergency_aid:    { cost: 5000, cooldownDays: 7,  label: 'Notfallhilfe' },
  city_festival:    { cost: 2000, cooldownDays: 30, label: 'Städtefest'   },
  labor_migration:  { cost: 3000, cooldownDays: 14, label: 'Arbeitsmigration' },
};

/**
 * Führt eine diplomatische Aktion gegen einen Partner aus.
 * Prüft Cooldown, zieht Kosten ab, speichert Aktion.
 */
async function executeDiplomaticAction(municipalityId, partnerMunicipalityId, actionType) {
  ensureDbEnabled();
  const action = DIPLOMATIC_ACTIONS[actionType];
  if (!action) throw new Error(`Unbekannte Aktion: ${actionType}`);

  // Prüfe ob Partnerschaft existiert und verbunden ist
  const [pRows] = await dbPool.query(
    `SELECT id, tier FROM game_partnerships
     WHERE municipality_id = ? AND partner_municipality_id = ? AND status = 'connected'
     LIMIT 1`,
    [municipalityId, partnerMunicipalityId]
  );
  if (!pRows[0]) throw new Error('Keine aktive Partnerschaft mit dieser Gemeinde');

  // Mindest-Tier für Aktionen: Tier 2
  if (Number(pRows[0].tier || 1) < 2) {
    throw new Error('Diplomatische Aktionen erfordern mindestens Tier 2 (Freundschaftlich)');
  }

  // Cooldown prüfen
  const cooldownMs = action.cooldownDays * 24 * 60 * 60 * 1000;
  const [lastRows] = await dbPool.query(
    `SELECT executed_at FROM game_partnership_actions
     WHERE from_municipality_id = ? AND to_municipality_id = ? AND action_type = ?
     ORDER BY executed_at DESC LIMIT 1`,
    [municipalityId, partnerMunicipalityId, actionType]
  );
  if (lastRows[0]) {
    const elapsed = Date.now() - new Date(lastRows[0].executed_at).getTime();
    if (elapsed < cooldownMs) {
      const daysLeft = Math.ceil((cooldownMs - elapsed) / (1000 * 60 * 60 * 24));
      throw new Error(`Cooldown: noch ${daysLeft} Tag(e) warten für ${action.label}`);
    }
  }

  const { applyMunicipalityTransaction, getBankStatus } = require('./bank');

  // Geld prüfen + abbuchen
  const bank = await getBankStatus(municipalityId);
  if (bank.treasury < action.cost) {
    throw new Error(`Nicht genug Geld. Benötigt: ${action.cost} CHF, vorhanden: ${bank.treasury} CHF`);
  }
  await applyMunicipalityTransaction(municipalityId, {
    amount: -action.cost,
    type: 'diplomatic_action',
    meta: { actionType, partnerMunicipalityId, label: action.label },
    source: 'user',
  });

  // Bei Notfallhilfe: Betrag an Partner überweisen
  if (actionType === 'emergency_aid') {
    try {
      await applyMunicipalityTransaction(partnerMunicipalityId, {
        amount: action.cost,
        type: 'emergency_aid_received',
        meta: { fromMunicipalityId: municipalityId },
        source: 'system',
      });
    } catch { /* Partner-Gutschrift optional */ }
  }

  // Aktion speichern
  const expiresAt = actionType === 'city_festival'
    ? new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h Effekt
    : null;

  await dbPool.query(
    `INSERT INTO game_partnership_actions
      (from_municipality_id, to_municipality_id, action_type, cost, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [municipalityId, partnerMunicipalityId, actionType, action.cost, expiresAt]
  );

  // Cooldown-Info für alle Aktionen zurückgeben
  return await getActionCooldowns(municipalityId, partnerMunicipalityId);
}

/**
 * Gibt Cooldown-Status für alle Aktionen zwischen zwei Gemeinden zurück.
 */
async function getActionCooldowns(municipalityId, partnerMunicipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT action_type, MAX(executed_at) AS last_at
     FROM game_partnership_actions
     WHERE from_municipality_id = ? AND to_municipality_id = ?
     GROUP BY action_type`,
    [municipalityId, partnerMunicipalityId]
  );
  const cooldowns = {};
  for (const [type, cfg] of Object.entries(DIPLOMATIC_ACTIONS)) {
    const row = rows.find(r => r.action_type === type);
    const lastAt = row ? new Date(row.last_at) : null;
    const cooldownMs = cfg.cooldownDays * 24 * 60 * 60 * 1000;
    const elapsed = lastAt ? Date.now() - lastAt.getTime() : Infinity;
    const ready = elapsed >= cooldownMs;
    cooldowns[type] = {
      label:       cfg.label,
      cost:        cfg.cost,
      cooldownDays: cfg.cooldownDays,
      ready,
      daysLeft:    ready ? 0 : Math.ceil((cooldownMs - elapsed) / (1000 * 60 * 60 * 24)),
      lastAt:      lastAt ? lastAt.toISOString() : null,
    };
  }
  return cooldowns;
}

module.exports = {
  TIER_CONFIG,
  DIPLOMATIC_ACTIONS,
  processTradeIncomePayouts,
  EXPORT_SLOT_CONFIG,
  computeTierProgress,
  computeExportCapacity,
  slotsToMultiplier,
  upsertPartnership,
  getPartnershipRow,
  listPartnershipRows,
  toPartnershipDto,
  listPartnershipRequestsForMunicipality,
  getPartnershipRequestById,
  toPartnershipRequestDto,
  processTierUpgrades,
  investInPartnership,
  executeDiplomaticAction,
  getActionCooldowns,
};
