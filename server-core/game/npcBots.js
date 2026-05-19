'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db.js');
const { logError } = require('../infra/logger.js');
const { applyMunicipalityTransaction } = require('./bank.js');
const { applyStatChange } = require('./buenzli.js');
const { calcCompanyLevel } = require('../http/routes/companies/helpers.js');

// ─── Schweizer NPC-Namen ──────────────────────────────────────
const NPC_FIRST_NAMES = [
  'Hans', 'Peter', 'Kurt', 'Markus', 'Daniel', 'Thomas', 'Stefan',
  'Andreas', 'Christian', 'Michael', 'Ueli', 'Ruedi', 'Fritz', 'Werner',
  'Anna', 'Maria', 'Elisabeth', 'Heidi', 'Ursula', 'Monika', 'Sandra',
  'Claudia', 'Sonja', 'Brigitte', 'Vreni', 'Rosemarie', 'Karin',
];
const NPC_LAST_NAMES = [
  'Müller', 'Meier', 'Keller', 'Bauer', 'Zimmermann', 'Fischer',
  'Schmid', 'Schneider', 'Huber', 'Brunner', 'Steiner', 'Gerber',
  'Kaufmann', 'Graf', 'Roth', 'Frei', 'Bachmann', 'Moser', 'Walter',
  'Richter', 'Lüscher', 'Suter', 'Baumann', 'Hofer', 'Maurer',
];

function generateNpcName() {
  const first = NPC_FIRST_NAMES[Math.floor(Math.random() * NPC_FIRST_NAMES.length)];
  const last  = NPC_LAST_NAMES[Math.floor(Math.random() * NPC_LAST_NAMES.length)];
  return `${first} ${last}`;
}

// NPC-Level basierend auf XP (muss mit Frontend NPC_LEVELS übereinstimmen)
function getNpcLevelBonus(xpEarned) {
  const xp = Number(xpEarned) || 0;
  if (xp >= 1000) return 0.15; // Lv.5 Meister
  if (xp >= 500)  return 0.10; // Lv.4 Experte
  if (xp >= 200)  return 0.05; // Lv.3 Senior
  if (xp >= 50)   return 0.02; // Lv.2 Fachkraft
  return 0;                    // Lv.1 Neuling
}

// Effektivdauer eines Vertrags für einen NPC: work_duration / (efficiency * level_bonus)
function calcNpcWorkDuration(workDurationSeconds, efficiency, xpEarned = 0) {
  const baseEff = Math.max(0.1, Math.min(1.0, Number(efficiency) || 0.60));
  const levelBonus = getNpcLevelBonus(xpEarned);
  const totalEff = Math.min(1.0, baseEff + levelBonus);
  return Math.round(workDurationSeconds / totalEff);
}

// ─── NPC einstellen ──────────────────────────────────────────
async function hireNpcBot(companyId, municipalityId, botType) {
  ensureDbEnabled();

  // Typ-Konfiguration laden
  const [[typeRow]] = await dbPool.query(
    `SELECT * FROM npc_bot_types WHERE bot_type = ?`, [botType]
  );
  if (!typeRow) throw new Error(`Unbekannter NPC-Typ: ${botType}`);

  // Max-Limit prüfen
  const [[{ count }]] = await dbPool.query(
    `SELECT COUNT(*) AS count FROM npc_bots
     WHERE company_id = ? AND bot_type = ? AND status != 'fired'`,
    [companyId, botType]
  );
  if (count >= typeRow.max_per_company) {
    throw new Error(`Maximal ${typeRow.max_per_company} ${typeRow.display_name} pro Firma erlaubt.`);
  }

  // Einstellkosten von Firmenkasse abziehen
  const [[company]] = await dbPool.query(
    `SELECT balance FROM companies WHERE id = ? AND is_active = 1`, [companyId]
  );
  if (!company) throw new Error('Firma nicht gefunden.');
  if (company.balance < typeRow.hire_cost) {
    throw new Error(`Nicht genug Geld. Einstellkosten: CHF ${typeRow.hire_cost}.`);
  }

  await dbPool.query(
    `UPDATE companies SET balance = balance - ? WHERE id = ?`,
    [typeRow.hire_cost, companyId]
  );
  await dbPool.query(
    `INSERT INTO company_finances (company_id, amount, balance_after, reason)
     VALUES (?, ?, (SELECT balance FROM companies WHERE id = ?), 'npc_hire_cost')`,
    [companyId, -typeRow.hire_cost, companyId]
  );

  const name = generateNpcName();
  // Kontrolleure arbeiten immer im Patrol-Modus (keine regulären Verträge)
  const patrolMode = (botType === 'kontrolleur') ? 1 : 0;
  const [result] = await dbPool.query(
    `INSERT INTO npc_bots
       (company_id, municipality_id, name, bot_type, salary_weekly, efficiency, status, patrol_mode)
     VALUES (?, ?, ?, ?, ?, ?, 'idle', ?)`,
    [companyId, municipalityId, name, botType, typeRow.salary_weekly, typeRow.efficiency, patrolMode]
  );

  return { id: result.insertId, name, botType, hireCost: typeRow.hire_cost };
}

// ─── NPC entlassen ───────────────────────────────────────────
async function fireNpcBot(npcBotId, companyId) {
  ensureDbEnabled();
  // Laufenden Vertrag freigeben
  await dbPool.query(
    `UPDATE company_contracts
     SET status = 'open', assigned_user_id = NULL, accepted_at = NULL, started_at = NULL,
         completable_at = NULL, work_duration_seconds = NULL
     WHERE id = (SELECT current_contract_id FROM npc_bots WHERE id = ? AND company_id = ?)
       AND status IN ('accepted','in_progress')`,
    [npcBotId, companyId]
  );
  await dbPool.query(
    `UPDATE npc_bots
     SET status = 'fired', fired_at = NOW(), current_contract_id = NULL, contract_started_at = NULL
     WHERE id = ? AND company_id = ?`,
    [npcBotId, companyId]
  );
}

// ─── Wochenlohn abziehen ──────────────────────────────────────
async function runNpcSalaryTick() {
  ensureDbEnabled();
  try {
    // Alle aktiven NPCs die seit 7 Tagen keinen Lohn bekommen haben
    const [bots] = await dbPool.query(
      `SELECT nb.id, nb.company_id, nb.salary_weekly, nb.name,
              c.balance AS company_balance
       FROM npc_bots nb
       JOIN companies c ON c.id = nb.company_id
       WHERE nb.status != 'fired'
         AND (nb.last_salary_paid_at IS NULL
              OR nb.last_salary_paid_at < DATE_SUB(NOW(), INTERVAL 7 DAY))`
    );

    for (const bot of bots) {
      if (bot.company_balance >= bot.salary_weekly) {
        // Lohn zahlen
        await dbPool.query(
          `UPDATE companies SET balance = balance - ? WHERE id = ?`,
          [bot.salary_weekly, bot.company_id]
        );
        await dbPool.query(
          `UPDATE npc_bots SET last_salary_paid_at = NOW() WHERE id = ?`, [bot.id]
        );
        await dbPool.query(
          `INSERT INTO npc_bot_salary_log (npc_bot_id, company_id, amount, reason)
           VALUES (?, ?, ?, 'weekly_salary')`,
          [bot.id, bot.company_id, -bot.salary_weekly]
        );
      } else {
        // Firma kann nicht zahlen → NPC kündigt
        await fireNpcBot(bot.id, bot.company_id);
        await dbPool.query(
          `INSERT INTO npc_bot_salary_log (npc_bot_id, company_id, amount, reason)
           VALUES (?, ?, 0, 'fired_no_funds')`,
          [bot.id, bot.company_id]
        );
      }
    }
  } catch (err) {
    logError('NPC_BOTS', 'Fehler beim Lohn-Tick', { error: err?.message });
  }
}

// ─── Haupt-NPC-Arbeitstick ────────────────────────────────────
// Läuft alle 60s via intervals.js
// 1. Fertige Verträge abschliessen
// 2. Idle NPCs neuen Verträgen zuweisen
async function runNpcBotTick() {
  ensureDbEnabled();
  try {
    // ── 1. Fertige Verträge abschliessen ─────────────────────
    // completable_at direkt im SQL prüfen — kein JS-Zeitvergleich nötig
    const [working] = await dbPool.query(
      `SELECT nb.id AS bot_id, nb.company_id, nb.efficiency, nb.contracts_completed, nb.xp_earned,
              cc.id AS contract_id, cc.payment, cc.difficulty, cc.municipality_id, cc.event_id,
              cc.work_duration_seconds, nb.contract_started_at
       FROM npc_bots nb
       JOIN company_contracts cc ON cc.id = nb.current_contract_id
       WHERE nb.status = 'working'
         AND cc.status = 'in_progress'
         AND cc.completable_at <= NOW()`
    );

    for (const bot of working) {

      // ── Steuern & Zufriedenheitsmultiplikator berechnen ──
      let taxRate = 10;
      let satisfaction = 50;
      if (bot.municipality_id) {
        const [[ms]] = await dbPool.query(
          `SELECT tax_rate, citizen_satisfaction FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
          [bot.municipality_id]
        );
        if (ms) {
          taxRate = Number(ms.tax_rate) || 10;
          satisfaction = Math.max(0, Math.min(100, Number(ms.citizen_satisfaction) || 50));
        }
      }
      const businessTaxRate = Math.max(0, Number((taxRate * 0.32).toFixed(2)));
      const taxAmount = Math.round(bot.payment * businessTaxRate / 100);
      const baseNetPayment = bot.payment - taxAmount;
      const satisfactionMultiplier = Math.round((0.6 + satisfaction / 250) * 100) / 100;
      const netPayment = Math.round(baseNetPayment * satisfactionMultiplier);

      // Vertrag abschliessen
      await dbPool.query(
        `UPDATE company_contracts SET status = 'completed', completed_at = NOW() WHERE id = ?`,
        [bot.contract_id]
      );
      // Zugehöriges Municipality-Event auf resolved setzen + Stats anpassen
      if (bot.event_id) {
        const [[evRow]] = await dbPool.query(
          `SELECT me.status, et.stat_impact, et.stat_fix_bonus
           FROM municipality_events me
           JOIN event_types et ON et.id = me.event_type_id
           WHERE me.id = ? AND me.status NOT IN ('resolved','expired','false_alarm','failed')`,
          [bot.event_id]
        );
        await dbPool.query(
          `UPDATE municipality_events SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
           WHERE id = ? AND status NOT IN ('resolved','expired','false_alarm','failed')`,
          [bot.event_id]
        );
        if (evRow?.stat_impact && bot.municipality_id) {
          await applyStatChange(bot.municipality_id, evRow.stat_impact, evRow.stat_fix_bonus || 0, 'event_fixed', 'event', bot.event_id);
        }
      }
      await dbPool.query(
        `UPDATE companies SET balance = balance + ?, reputation = reputation + ?,
                total_contracts = total_contracts + 1, total_revenue = total_revenue + ?
         WHERE id = ?`,
        [netPayment, bot.difficulty * 2, bot.payment, bot.company_id]
      );

      const [[companyAfter]] = await dbPool.query(`SELECT balance, reputation, level FROM companies WHERE id = ?`, [bot.company_id]);
      const balanceAfter = companyAfter ? companyAfter.balance : 0;

      // Level neu berechnen (fehlte bisher — Progress Bar blieb stehen)
      if (companyAfter) {
        const newLevel = calcCompanyLevel(companyAfter.reputation || 0);
        if (newLevel > (companyAfter.level || 1)) {
          await dbPool.query(`UPDATE companies SET level = ? WHERE id = ?`, [newLevel, bot.company_id]);
        }
      }

      await dbPool.query(
        `INSERT INTO company_finances (company_id, amount, balance_after, reason, description, ref_type, ref_id)
         VALUES (?, ?, ?, 'contract_payment', ?, 'contract', ?)`,
        [bot.company_id, netPayment, balanceAfter,
         `NPC-Auftrag #${bot.contract_id} (${businessTaxRate}% Steuer: ${taxAmount} CHF, Zufriedenheit ×${satisfactionMultiplier})`,
         bot.contract_id]
      );

      // Steuer an Gemeindekasse
      if (taxAmount > 0 && bot.municipality_id) {
        await applyMunicipalityTransaction(bot.municipality_id, {
          amount: taxAmount,
          type: 'company_tax',
          meta: { companyId: bot.company_id, contractId: bot.contract_id, grossPayment: bot.payment, taxRate, businessTaxRate, taxAmount },
          source: 'system',
        });
        await dbPool.query(
          `INSERT INTO company_finances (company_id, amount, balance_after, reason, description, ref_type, ref_id)
           VALUES (?, ?, ?, 'tax_payment', ?, 'contract', ?)`,
          [bot.company_id, -taxAmount, balanceAfter, `Firmensteuer ${businessTaxRate}% auf NPC-Auftrag #${bot.contract_id}`, bot.contract_id]
        );
      }

      await dbPool.query(
        `UPDATE npc_bots
         SET status = 'idle', current_contract_id = NULL, contract_started_at = NULL,
             contracts_completed = contracts_completed + 1,
             xp_earned = xp_earned + ?
         WHERE id = ?`,
        [bot.difficulty * 5, bot.bot_id]
      );
    }

    // ── 2. Idle NPCs → offene Verträge zuweisen (Patrol-NPCs überspringen) ───
    const [idleBots] = await dbPool.query(
      `SELECT nb.id AS bot_id, nb.company_id, nb.bot_type, nb.efficiency, nb.xp_earned,
              c.company_type_id
       FROM npc_bots nb
       JOIN companies c ON c.id = nb.company_id
       WHERE nb.status = 'idle' AND nb.patrol_mode = 0`
    );

    for (const bot of idleBots) {
      // Offenen Vertrag für diese Firma suchen
      const [[contract]] = await dbPool.query(
        `SELECT cc.id, cc.difficulty, cc.work_duration_seconds
         FROM company_contracts cc
         WHERE cc.company_id = ? AND cc.status = 'open'
         ORDER BY cc.difficulty ASC
         LIMIT 1`,
        [bot.company_id]
      );
      if (!contract) continue;

      // Vertrag annehmen und NPC zuweisen
      const workDuration = calcNpcWorkDuration(contract.work_duration_seconds || 1800, bot.efficiency, bot.xp_earned);
      await dbPool.query(
        `UPDATE company_contracts
         SET status = 'in_progress', accepted_at = NOW(), started_at = NOW(),
             work_duration_seconds = ?,
             completable_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
         WHERE id = ?`,
        [workDuration, workDuration, contract.id]
      );
      await dbPool.query(
        `UPDATE npc_bots
         SET status = 'working', current_contract_id = ?, contract_started_at = NOW()
         WHERE id = ?`,
        [contract.id, bot.bot_id]
      );
    }
  } catch (err) {
    logError('NPC_BOTS', 'Fehler beim NPC-Bot-Tick', { error: err?.message });
  }
}

// ─── NPC-Liste einer Firma ────────────────────────────────────
async function getCompanyNpcBots(companyId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT nb.*, nbt.display_name, nbt.emoji, nbt.hire_cost, nbt.max_per_company,
            cc.id AS contract_id_active, cc.status AS contract_status,
            cc.work_duration_seconds, nb.contract_started_at, cc.completable_at,
            ROUND(nb.efficiency * 100) AS efficiency_pct
     FROM npc_bots nb
     JOIN npc_bot_types nbt ON nbt.bot_type = nb.bot_type
     LEFT JOIN company_contracts cc ON cc.id = nb.current_contract_id
     WHERE nb.company_id = ? AND nb.status != 'fired'
     ORDER BY nb.hired_at ASC`,
    [companyId]
  );
  // Fortschritt berechnen
  return rows.map((r) => {
    let progress = null;
    if (r.status === 'working' && r.contract_started_at && r.work_duration_seconds) {
      const elapsed = (Date.now() - new Date(r.contract_started_at).getTime()) / 1000;
      progress = Math.min(100, Math.round((elapsed / r.work_duration_seconds) * 100));
    }
    return { ...r, work_progress_pct: progress };
  });
}

// ─── Server-seitige Werkhof-Patrol-Reparatur ──────────────────
// Läuft alle 2min via intervals.js
// – Nur tagsüber (07:00–22:00 Schweizer Zeit)
// – Repariert pro Tick eines der beschädigtsten Gebäude um +25 Punkte (max 100)
// – Langsamer als ein menschlicher Spieler (Truck = sofort 100%)
// – Vergütet Patrol-NPC mit +3 XP und +1 patrol_repairs
async function runServerWerkhofRepairTick(io) {
  ensureDbEnabled();
  try {
    // ── Schweizer Tageszeit prüfen (CET=UTC+1 / CEST=UTC+2) ──
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMonth = now.getUTCMonth() + 1; // 1–12
    // Vereinfachte DST: Apr–Okt = UTC+2, Rest = UTC+1
    const swissOffset = (utcMonth >= 4 && utcMonth <= 10) ? 2 : 1;
    const swissHour = (utcHour + swissOffset) % 24;
    if (swissHour < 7 || swissHour >= 22) return; // Nachtruhe

    // ── Alle Gemeinden mit aktivem Werkhof-Patrol-NPC laden ──
    const [patrols] = await dbPool.query(
      `SELECT nb.id AS bot_id, nb.company_id,
              c.municipality_id,
              m.slug AS municipality_slug,
              COALESCE(gr.room_code, 'MAIN') AS room_code
       FROM npc_bots nb
       JOIN companies c ON c.id = nb.company_id
       JOIN company_types ct ON ct.id = c.company_type_id
       JOIN municipalities m ON m.id = c.municipality_id
       LEFT JOIN game_rooms gr ON gr.municipality_id = c.municipality_id AND gr.is_active = 1
       WHERE nb.patrol_mode = 1 AND nb.status != 'fired'
         AND ct.code = 'werkhof'`
    );

    for (const patrol of patrols) {
      let repairedItem = null;
      let broadcastMeta = null;
      let repairCost = 0;

      // ── Priorität 1: Verlassene oder brennende Gebäude ──
      const [[abandonedItem]] = await dbPool.query(
        `SELECT gi.id, gi.x, gi.y, gi.tool, gi.metadata,
                COALESCE(gid.build_cost, 100) AS build_cost
         FROM game_items gi
         LEFT JOIN game_item_details gid ON gid.tool = gi.tool
         WHERE gi.municipality_id = ?
           AND gi.room_code = ?
           AND (JSON_EXTRACT(gi.metadata, '$.abandoned') = true
                OR JSON_EXTRACT(gi.metadata, '$.onFire') = true)
         LIMIT 1`,
        [patrol.municipality_id, patrol.room_code]
      );

      if (abandonedItem) {
        const meta = typeof abandonedItem.metadata === 'string'
          ? JSON.parse(abandonedItem.metadata || '{}')
          : (abandonedItem.metadata || {});
        const now = Date.now();
        const newMeta = {
          ...meta,
          abandoned: false,
          onFire: false,
          fireProgress: 0,
          constructed: false,
          constructionProgress: 60,
          constructionStartedAt: now,
          age: 0,
        };
        await dbPool.query(
          `UPDATE game_items SET metadata = ? WHERE id = ?`,
          [JSON.stringify(newMeta), abandonedItem.id]
        );
        repairCost = Math.max(50, Math.round(Number(abandonedItem.build_cost) * 0.75)); // 1.5× teurer als manuelle Reparatur (50%)
        broadcastMeta = newMeta;
        repairedItem = { ...abandonedItem, broadcastMeta };
      } else {
        // ── Priorität 2: Gebäude mit condition < 90% ──
        const [[condItem]] = await dbPool.query(
          `SELECT id, x, y, tool,
                  CAST(JSON_EXTRACT(metadata, '$.condition') AS UNSIGNED) AS cond
           FROM game_items
           WHERE municipality_id = ?
             AND room_code = ?
             AND JSON_EXTRACT(metadata, '$.condition') IS NOT NULL
             AND CAST(JSON_EXTRACT(metadata, '$.condition') AS UNSIGNED) < 90
             AND CAST(JSON_EXTRACT(metadata, '$.condition') AS UNSIGNED) > 5
           ORDER BY CAST(JSON_EXTRACT(metadata, '$.condition') AS UNSIGNED) ASC
           LIMIT 1`,
          [patrol.municipality_id, patrol.room_code]
        );

        if (condItem) {
          const cond = Number(condItem.cond) || 0;
          // Je kaputterein Gebäude, desto kleiner der Schritt → mehr Ticks nötig
          // 89% → +30/Tick (1 Tick), 50% → +23/Tick (3 Ticks), 10% → +16/Tick (6 Ticks)
          const repairIncrement = Math.max(8, 15 + Math.floor((cond / 90) * 15));
          const newCondition = Math.min(100, cond + repairIncrement);
          await dbPool.query(
            `UPDATE game_items SET metadata = JSON_SET(metadata, '$.condition', ?) WHERE id = ?`,
            [newCondition, condItem.id]
          );
          // 89% → ~22 CHF/Tick, 50% → ~100 CHF/Tick, 10% → ~180 CHF/Tick
          repairCost = Math.round((100 - cond) * 2);
          broadcastMeta = { condition: newCondition };
          repairedItem = condItem;
        }
      }

      if (!repairedItem) continue; // Nichts zu reparieren

      // ── Kosten aus Gemeindekasse ──
      if (repairCost > 0) {
        await applyMunicipalityTransaction(patrol.municipality_id, {
          amount: -repairCost,
          type: 'werkhof_repair',
          source: 'system',
          allowOverdraft: true,
          meta: JSON.stringify({ bot_id: patrol.bot_id, building_id: repairedItem.id }),
        });
      }

      // ── XP + Reparatur-Zähler für Patrol-NPC ──
      await dbPool.query(
        `UPDATE npc_bots SET xp_earned = xp_earned + 3, patrol_repairs = patrol_repairs + 1 WHERE id = ?`,
        [patrol.bot_id]
      );

      // ── Broadcast an verbundene Clients ──
      if (io && patrol.municipality_slug) {
        const wsHelpers = require('../ws/socketio/helpers');
        const roomKey = wsHelpers.wsRoomKey(patrol.municipality_slug, patrol.room_code);
        io.to(roomKey).emit('buildings-authoritative', {
          changes: [{
            id: repairedItem.id,
            tileX: repairedItem.x,
            tileY: repairedItem.y,
            tool: repairedItem.tool,
            metadata: broadcastMeta,
            changeType: 'werkhof_server_repair',
          }],
          serverTimestamp: Date.now(),
        });
      }
    }
  } catch (err) {
    logError('NPC_BOTS', 'Fehler beim Werkhof-Patrol-Reparatur-Tick', { error: err?.message });
  }
}

module.exports = {
  hireNpcBot,
  fireNpcBot,
  runNpcBotTick,
  runNpcSalaryTick,
  getCompanyNpcBots,
  generateNpcName,
  runServerWerkhofRepairTick,
};
