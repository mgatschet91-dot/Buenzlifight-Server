'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');

// ─── Konstanten ───────────────────────────────────────────────────────────────

const TENSION_DECAY_PER_HOUR = 2;       // Spannung sinkt automatisch pro Stunde
const TENSION_PER_ATTACK = 20;          // Spannung steigt pro Angriff
const TENSION_WAR_THRESHOLD = 70;       // Ab hier: Ausnahmezustand möglich

const ATTACK_COSTS = {
  fake_news:      3000,
  power_cut:      5000,
  hack:           7000,
  recruit_firms:  6000,
  trade_stop:     4000,
};

// Event-Codes die bei Angriffen injiziert werden (aus event_types Tabelle)
const ATTACK_EVENT_MAP = {
  fake_news:    'corruption',
  power_cut:    'power_outage',
  hack:         'tax_abuse',
  recruit_firms: null,         // kein Event, direkte Firmen-Logik
  trade_stop:   null,          // kein Event, direkte Partnership-Logik
};

// ─── Relations-Helpers ────────────────────────────────────────────────────────

// Immer: kleinere ID = municipality_a, grössere = municipality_b (kanonische Reihenfolge)
function canonicalPair(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}

async function getOrCreateRelation(idA, idB) {
  ensureDbEnabled();
  const [a, b] = canonicalPair(Number(idA), Number(idB));
  const [rows] = await dbPool.query(
    `SELECT * FROM municipality_relations WHERE municipality_a = ? AND municipality_b = ? LIMIT 1`,
    [a, b]
  );
  if (rows[0]) return rows[0];

  await dbPool.query(
    `INSERT IGNORE INTO municipality_relations (municipality_a, municipality_b, tension_score)
     VALUES (?, ?, 0)`,
    [a, b]
  );
  const [inserted] = await dbPool.query(
    `SELECT * FROM municipality_relations WHERE municipality_a = ? AND municipality_b = ? LIMIT 1`,
    [a, b]
  );
  return inserted[0];
}

async function getRelation(idA, idB) {
  ensureDbEnabled();
  const [a, b] = canonicalPair(Number(idA), Number(idB));
  const [rows] = await dbPool.query(
    `SELECT * FROM municipality_relations WHERE municipality_a = ? AND municipality_b = ? LIMIT 1`,
    [a, b]
  );
  return rows[0] || null;
}

async function getTensionPhase(score) {
  if (score >= TENSION_WAR_THRESHOLD) return 'krieg';
  if (score >= 40) return 'konflikt';
  return 'ruhig';
}

// ─── Angriff ausführen ────────────────────────────────────────────────────────

async function executeAttack({ attackerId, targetId, attackType, minigameScore }) {
  ensureDbEnabled();

  const cost = ATTACK_COSTS[attackType];
  if (!cost) throw new Error('INVALID_ATTACK_TYPE');

  // Treasury-Check des Angreifers
  const [treasuryRows] = await dbPool.query(
    `SELECT treasury FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
    [attackerId]
  );
  if (!treasuryRows[0]) throw new Error('ATTACKER_NOT_FOUND');
  if (Number(treasuryRows[0].treasury) < cost) throw new Error('INSUFFICIENT_FUNDS');

  // Cooldown: 6h pro Angreifer-Ziel-Kombination
  const relation = await getOrCreateRelation(attackerId, targetId);
  if (relation.last_attack_by === attackerId && relation.last_attack_at) {
    const hoursSince = (Date.now() - new Date(relation.last_attack_at).getTime()) / 3600000;
    if (hoursSince < 6) throw new Error('ATTACK_COOLDOWN');
  }

  // Verteidigung des Ziels berechnen (Polizei-Coverage + Security-Score)
  const [defRows] = await dbPool.query(
    `SELECT security FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
    [targetId]
  );
  const defenseScore = Number(defRows[0]?.security || 0); // 0-100

  // Trefferchance: minigameScore - (defenseScore * 0.4)
  // Bei minigame=100 und defense=100 → 60% Trefferchance
  const hitChance = Math.max(10, Math.min(95, minigameScore - (defenseScore * 0.4)));
  const roll = Math.random() * 100;
  const result = roll <= hitChance ? 'hit' : 'blocked';

  // CHF abbuchen beim Angreifer
  await dbPool.query(
    `UPDATE municipality_stats SET treasury = treasury - ? WHERE municipality_id = ?`,
    [cost, attackerId]
  );

  let targetEventId = null;
  let damageDealt = 0;

  if (result === 'hit') {
    // Stärke des Angriffs: minigameScore bestimmt severity (1-3)
    const severity = minigameScore >= 80 ? 3 : minigameScore >= 50 ? 2 : 1;
    damageDealt = Math.round(cost * 0.8 * (severity / 3));

    const eventCode = ATTACK_EVENT_MAP[attackType];
    if (eventCode) {
      targetEventId = await injectEventIntoTarget(targetId, eventCode, severity, attackerId);
    } else if (attackType === 'trade_stop') {
      await applyTradeStop(attackerId, targetId);
    } else if (attackType === 'recruit_firms') {
      await applyRecruitFirms(attackerId, targetId);
    }
  }

  // Relations-Spannung erhöhen
  const [a, b] = canonicalPair(attackerId, targetId);
  await dbPool.query(
    `INSERT INTO municipality_relations (municipality_a, municipality_b, tension_score, last_attack_at, last_attack_by)
     VALUES (?, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       tension_score = LEAST(100, tension_score + ?),
       last_attack_at = NOW(),
       last_attack_by = ?`,
    [a, b, TENSION_PER_ATTACK, attackerId, TENSION_PER_ATTACK, attackerId]
  );

  // Angriff loggen
  const [logResult] = await dbPool.query(
    `INSERT INTO municipality_attacks
       (attacker_id, target_id, attack_type, minigame_score, result, cost_paid, damage_dealt, target_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [attackerId, targetId, attackType, minigameScore, result, cost, damageDealt, targetEventId]
  );

  // Ausnahmezustand prüfen
  await checkAndTriggerEmergency(targetId, attackerId);

  // Benachrichtigung an Ziel senden
  await sendAttackNotification(targetId, attackerId, attackType, result);

  return {
    result,
    cost_paid: cost,
    damage_dealt: damageDealt,
    attack_id: logResult.insertId,
  };
}

// ─── Event ins Ziel injizieren ────────────────────────────────────────────────

async function injectEventIntoTarget(targetId, eventCode, severity, attackerId) {
  const [etRows] = await dbPool.query(
    `SELECT id, fix_cost FROM event_types WHERE code = ? AND is_active = 1 LIMIT 1`,
    [eventCode]
  );
  if (!etRows[0]) return null;

  const [result] = await dbPool.query(
    `INSERT INTO municipality_events
       (municipality_id, room_code, event_type_id, status, severity, confidence, actual_real,
        reported_at, metadata)
     VALUES (?, 'MAIN', ?, 'external_reported', ?, 100, 1, NOW(),
       JSON_OBJECT('triggered_by', 'attack', 'attacker_municipality_id', ?))`,
    [targetId, etRows[0].id, severity, attackerId]
  );
  return result.insertId;
}

// ─── Handelsstopp ────────────────────────────────────────────────────────────

async function applyTradeStop(attackerId, targetId) {
  // Partnership zwischen A und B auf 'suspended' setzen für 2h
  await dbPool.query(
    `UPDATE game_partnerships
     SET status = 'suspended', suspended_until = DATE_ADD(NOW(), INTERVAL 2 HOUR)
     WHERE (municipality_id = ? AND partner_municipality_id = ?)
        OR (municipality_id = ? AND partner_municipality_id = ?)`,
    [attackerId, targetId, targetId, attackerId]
  );
}

// ─── Firma abwerben ───────────────────────────────────────────────────────────

async function applyRecruitFirms(attackerId, targetId) {
  // Zufällige kleine Firma im Ziel suchen und deaktivieren
  const [firms] = await dbPool.query(
    `SELECT id FROM companies
     WHERE municipality_id = ? AND is_active = 1
     ORDER BY RAND() LIMIT 1`,
    [targetId]
  );
  if (!firms[0]) return;
  await dbPool.query(
    `UPDATE companies SET is_active = 0 WHERE id = ?`,
    [firms[0].id]
  );
}

// ─── Ausnahmezustand prüfen ───────────────────────────────────────────────────

async function checkAndTriggerEmergency(targetId, attackerId) {
  const relation = await getRelation(attackerId, targetId);
  if (!relation || relation.tension_score < TENSION_WAR_THRESHOLD) return;

  // Stats des Ziels prüfen
  const [statRows] = await dbPool.query(
    `SELECT citizen_satisfaction, security FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
    [targetId]
  );
  if (!statRows[0]) return;

  const happiness = Number(statRows[0].citizen_satisfaction || 50);
  if (happiness > 40) return; // Ziel ist noch stabil

  // Offene Events zählen
  const [eventRows] = await dbPool.query(
    `SELECT COUNT(*) AS cnt FROM municipality_events
     WHERE municipality_id = ? AND status IN ('detected','reported','external_reported')`,
    [targetId]
  );
  if (Number(eventRows[0].cnt) < 3) return;

  // Ausnahmezustand aktivieren (2h)
  await dbPool.query(
    `INSERT INTO municipality_emergency (municipality_id, is_active, triggered_at, triggered_by, ends_at)
     VALUES (?, 1, NOW(), ?, DATE_ADD(NOW(), INTERVAL 2 HOUR))
     ON DUPLICATE KEY UPDATE
       is_active = 1,
       triggered_at = NOW(),
       triggered_by = ?,
       ends_at = DATE_ADD(NOW(), INTERVAL 2 HOUR)`,
    [targetId, attackerId, attackerId]
  );
}

// ─── Benachrichtigung ─────────────────────────────────────────────────────────

async function sendAttackNotification(targetId, attackerId, attackType, result) {
  try {
    const [attackerRows] = await dbPool.query(
      `SELECT name FROM municipalities WHERE id = ? LIMIT 1`,
      [attackerId]
    );
    const attackerName = attackerRows[0]?.name || `Gemeinde #${attackerId}`;

    const typeLabels = {
      fake_news: 'Fake-News-Kampagne',
      power_cut: 'Stromabschaltung',
      hack: 'Hackerangriff',
      recruit_firms: 'Firmen-Abwerbung',
      trade_stop: 'Handelsstopp',
    };

    const label = typeLabels[attackType] || attackType;
    const msg = result === 'hit'
      ? `⚔️ ${attackerName} hat euch angegriffen: ${label}`
      : `🛡️ Angriff von ${attackerName} (${label}) wurde abgewehrt!`;

    // Owner/Council der Ziel-Gemeinde benachrichtigen
    const [memberRows] = await dbPool.query(
      `SELECT user_id FROM municipality_memberships
       WHERE municipality_id = ? AND role IN ('owner','council')`,
      [targetId]
    );
    for (const { user_id } of memberRows) {
      await dbPool.query(
        `INSERT INTO user_notifications (user_id, municipality_id, notification_type, title, message, is_read)
         VALUES (?, ?, 'war_attack', 'Gemeinde-Angriff', ?, 0)`,
        [user_id, targetId, msg]
      );
    }
  } catch (_) {}
}

// ─── Decay-Tick (alle 60min aufgerufen) ──────────────────────────────────────

async function runRelationDecayTick() {
  ensureDbEnabled();
  // Spannung sinkt automatisch über Zeit
  await dbPool.query(
    `UPDATE municipality_relations
     SET tension_score = GREATEST(0, tension_score - ?)
     WHERE tension_score > 0`,
    [TENSION_DECAY_PER_HOUR]
  );

  // Abgelaufene Ausnahmezustände deaktivieren
  await dbPool.query(
    `UPDATE municipality_emergency SET is_active = 0
     WHERE is_active = 1 AND ends_at <= NOW()`
  );
}

// ─── Getter für Frontend ──────────────────────────────────────────────────────

async function getMunicipalityWarStatus(municipalityId) {
  ensureDbEnabled();

  // Alle Relations dieser Gemeinde
  const [relations] = await dbPool.query(
    `SELECT r.*,
       CASE WHEN r.municipality_a = ? THEN r.municipality_b ELSE r.municipality_a END AS other_id,
       m.name AS other_name
     FROM municipality_relations r
     JOIN municipalities m ON m.id = (CASE WHEN r.municipality_a = ? THEN r.municipality_b ELSE r.municipality_a END)
     WHERE r.municipality_a = ? OR r.municipality_b = ?
     ORDER BY r.tension_score DESC`,
    [municipalityId, municipalityId, municipalityId, municipalityId]
  );

  // Ausnahmezustand
  const [emergency] = await dbPool.query(
    `SELECT * FROM municipality_emergency WHERE municipality_id = ? LIMIT 1`,
    [municipalityId]
  );

  // Letzte 5 Angriffe (ein- und ausgehend)
  const [recentAttacks] = await dbPool.query(
    `SELECT a.*,
       ma.name AS attacker_name,
       mt.name AS target_name
     FROM municipality_attacks a
     JOIN municipalities ma ON ma.id = a.attacker_id
     JOIN municipalities mt ON mt.id = a.target_id
     WHERE a.attacker_id = ? OR a.target_id = ?
     ORDER BY a.created_at DESC
     LIMIT 5`,
    [municipalityId, municipalityId]
  );

  return {
    relations: (relations || []).map(r => ({
      other_id: Number(r.other_id),
      other_name: r.other_name,
      tension_score: Number(r.tension_score),
      phase: r.tension_score >= 70 ? 'krieg' : r.tension_score >= 40 ? 'konflikt' : 'ruhig',
      last_attack_at: r.last_attack_at,
    })),
    emergency: emergency[0]?.is_active ? {
      is_active: true,
      triggered_at: emergency[0].triggered_at,
      ends_at: emergency[0].ends_at,
    } : null,
    recent_attacks: recentAttacks || [],
  };
}

async function getAttackCosts() {
  return ATTACK_COSTS;
}

module.exports = {
  getOrCreateRelation,
  getRelation,
  getTensionPhase,
  executeAttack,
  runRelationDecayTick,
  getMunicipalityWarStatus,
  getAttackCosts,
  ATTACK_COSTS,
  TENSION_WAR_THRESHOLD,
};
