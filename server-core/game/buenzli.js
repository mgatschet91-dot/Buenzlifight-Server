'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db.js');
const { logError } = require('../infra/logger.js');
const {
  BUENZLI_EVENTS_ENABLED,
  BUENZLI_EVENTS_PER_DAY_MIN,
  BUENZLI_EVENTS_PER_DAY_MAX,
  FOREIGN_REPORT_COIN_MULTIPLIER,
  FOREIGN_REPORT_XP_MULTIPLIER,
  FOREIGN_REPORT_PENALTY_MULTIPLIER,
} = require('../config/constants.js');
const { pushDiscordEvent } = require('../shared/discord.js');

let buenzliLastGenerateTime = 0;
const BUENZLI_GENERATION_INTERVAL_MS = 4 * 3600 * 1000; // Alle 4 Stunden neue Events

async function applyStatChange(municipalityId, statName, changeAmount, reason, refType = null, refId = null) {
  ensureDbEnabled();
  const validStats = ['security', 'attractiveness', 'cleanliness', 'infrastructure', 'transparency'];
  if (!validStats.includes(statName)) return;

  await dbPool.query(
    `INSERT IGNORE INTO municipality_stats (municipality_id) VALUES (?)`,
    [municipalityId]
  );

  const [current] = await dbPool.query(
    `SELECT \`${statName}\` AS val FROM municipality_stats WHERE municipality_id = ?`,
    [municipalityId]
  );
  const oldValue = current[0]?.val ?? 50;
  const newValue = Math.max(0, Math.min(100, oldValue + changeAmount));

  if (newValue !== oldValue) {
    await dbPool.query(
      `UPDATE municipality_stats SET \`${statName}\` = ?, updated_at = NOW() WHERE municipality_id = ?`,
      [newValue, municipalityId]
    );
    await dbPool.query(
      `INSERT INTO municipality_stats_log
       (municipality_id, stat_name, old_value, new_value, change_amount, reason, ref_type, ref_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [municipalityId, statName, oldValue, newValue, changeAmount, reason, refType, refId]
    );
  }

  const [allStats] = await dbPool.query(
    `SELECT security, attractiveness, cleanliness, infrastructure, transparency FROM municipality_stats WHERE municipality_id = ?`,
    [municipalityId]
  );
  if (allStats.length > 0) {
    const s = allStats[0];
    const avg = Math.round((s.security + s.attractiveness + s.cleanliness + s.infrastructure + s.transparency) / 5);
    await dbPool.query(
      `UPDATE municipality_stats SET citizen_satisfaction = ?, updated_at = NOW() WHERE municipality_id = ?`,
      [avg, municipalityId]
    );
  }
}

async function findBuildingForEvent(municipalityId, eventTypeId, eventTypeCode = null) {
  ensureDbEnabled();

  // Strassenbasierte Events: Road-Tile neben einem bewohnten Gebaeude
  // (Buenzli soll dort spawnen wo auch Leute/NPCs sind)
  const ROAD_EVENTS = ['illegal_parking', 'dog_unleashed', 'sunday_noise', 'bbq_smoke', 'laundry_sunday', 'lawn_overgrown', 'recycling_violation', 'fence_too_high'];
  if (ROAD_EVENTS.includes(eventTypeCode)) {
    // Finde ein aktives (nicht verlassenes, fertig gebautes) Gebaeude mit Einwohnern
    const [buildings] = await dbPool.query(
      `SELECT gi.x, gi.y, gi.room_code FROM game_items gi
       WHERE gi.municipality_id = ? AND gi.action_type IN ('zone', 'place')
         AND gi.tool NOT IN ('road', 'bridge', 'grass', 'water', 'tree', 'empty', 'furni')
         AND (gi.metadata IS NULL
              OR (JSON_EXTRACT(gi.metadata, '$.abandoned') IS NULL
                  OR JSON_EXTRACT(gi.metadata, '$.abandoned') = false))
         AND (gi.metadata IS NULL
              OR JSON_EXTRACT(gi.metadata, '$.constructionProgress') IS NULL
              OR JSON_EXTRACT(gi.metadata, '$.constructionProgress') >= 100)
       ORDER BY RAND() LIMIT 5`,
      [municipalityId]
    );
    // Finde eine Strasse neben einem der Gebaeude
    for (const bld of buildings) {
      const [roads] = await dbPool.query(
        `SELECT x, y, room_code FROM game_items
         WHERE municipality_id = ? AND tool = 'road' AND action_type = 'place'
           AND ABS(CAST(x AS SIGNED) - CAST(? AS SIGNED)) <= 2
           AND ABS(CAST(y AS SIGNED) - CAST(? AS SIGNED)) <= 2
         ORDER BY RAND() LIMIT 1`,
        [municipalityId, bld.x, bld.y]
      );
      if (roads.length > 0) {
        const r = roads[0];
        return {
          item_id: null,
          room_code: r.room_code,
          x: r.x,
          y: r.y,
          snapshot: {
            tool: 'road',
            x: r.x,
            y: r.y,
            level: 1,
            metadata: null,
            captured_at: new Date().toISOString(),
          },
        };
      }
    }
    return null;
  }

  const [mappings] = await dbPool.query(
    `SELECT building_tool, priority FROM event_type_building_map
     WHERE event_type_id = ? ORDER BY priority DESC`,
    [eventTypeId]
  );
  if (mappings.length === 0) return null;

  const tools = mappings.map((m) => m.building_tool);
  const placeholders = tools.map(() => '?').join(',');
  const [buildings] = await dbPool.query(
    `SELECT gi.id, gi.room_code, gi.tool, gi.x, gi.y, gi.metadata
     FROM game_items gi
     WHERE gi.municipality_id = ? AND gi.action_type IN ('place', 'zone')
       AND gi.tool IN (${placeholders})
       AND gi.applied_at <= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       AND (gi.metadata IS NULL
            OR (JSON_EXTRACT(gi.metadata, '$.abandoned') IS NULL
                OR JSON_EXTRACT(gi.metadata, '$.abandoned') = false))
       AND (gi.metadata IS NULL
            OR JSON_EXTRACT(gi.metadata, '$.constructionProgress') IS NULL
            OR JSON_EXTRACT(gi.metadata, '$.constructionProgress') >= 100)
       AND gi.id NOT IN (
         SELECT affected_item_id FROM municipality_events
         WHERE municipality_id = ? AND affected_item_id IS NOT NULL
           AND status IN ('detected','reported','investigating','assigned')
       )
     ORDER BY RAND() LIMIT 1`,
    [municipalityId, ...tools, municipalityId]
  );
  if (buildings.length === 0) return null;

  const b = buildings[0];
  let meta = null;
  try {
    meta = typeof b.metadata === 'string' ? JSON.parse(b.metadata) : b.metadata;
  } catch (_) {}
  return {
    item_id: b.id,
    room_code: b.room_code,
    x: b.x,
    y: b.y,
    snapshot: {
      tool: b.tool,
      x: b.x,
      y: b.y,
      level: meta?.level || 1,
      metadata: meta,
      captured_at: new Date().toISOString(),
    },
  };
}

async function verifyBuildingExists(eventId) {
  ensureDbEnabled();
  const [events] = await dbPool.query(
    `SELECT me.id, me.affected_item_id, me.municipality_id, me.room_code, me.location_x, me.location_y,
            me.building_snapshot, me.status
     FROM municipality_events me WHERE me.id = ?`,
    [eventId]
  );
  if (events.length === 0) return null;
  const ev = events[0];
  if (!ev.affected_item_id) return { exists: null, event: ev };

  const [items] = await dbPool.query(
    `SELECT id, tool, x, y, metadata FROM game_items
     WHERE id = ? AND municipality_id = ? AND action_type = 'place'`,
    [ev.affected_item_id, ev.municipality_id]
  );
  const exists = items.length > 0;

  await dbPool.query(
    `UPDATE municipality_events SET building_exists = ?, building_verified_at = NOW(), updated_at = NOW() WHERE id = ?`,
    [exists ? 1 : 0, eventId]
  );

  if (!exists && ['detected', 'reported'].includes(ev.status)) {
    await dbPool.query(
      `UPDATE municipality_events SET status = 'resolved', resolved_at = NOW(),
              updated_at = NOW() WHERE id = ? AND status IN ('detected','reported')`,
      [eventId]
    );
  }

  return { exists, event: ev, building: items[0] || null };
}

async function generateBuenzliEventsForMunicipality(municipalityId) {
  ensureDbEnabled();

  const [activeEvents] = await dbPool.query(
    `SELECT COUNT(*) AS cnt FROM municipality_events
     WHERE municipality_id = ? AND status IN ('detected','reported','investigating','assigned')`,
    [municipalityId]
  );
  const currentActive = activeEvents[0]?.cnt || 0;
  if (currentActive >= BUENZLI_EVENTS_PER_DAY_MAX) return 0;

  let cantonalActive = false;
  try {
    const [cantonalCheck] = await dbPool.query(
      `SELECT cantonal_investigation_until FROM municipality_stats WHERE municipality_id = ?`,
      [municipalityId]
    );
    cantonalActive =
      cantonalCheck[0]?.cantonal_investigation_until &&
      new Date(cantonalCheck[0].cantonal_investigation_until) > new Date();
  } catch (_) {}

  // Pro 4h-Zyklus: 1-3 Events (statt 4-10 taeglich)
  const CYCLE_MIN = 1;
  const CYCLE_MAX = 3;
  const maxNew = Math.max(0, BUENZLI_EVENTS_PER_DAY_MAX - currentActive);
  let baseGenerate = CYCLE_MIN + Math.floor(Math.random() * (CYCLE_MAX - CYCLE_MIN + 1));
  if (cantonalActive) baseGenerate = Math.min(baseGenerate * 2, CYCLE_MAX * 2);
  const toGenerate = Math.min(maxNew, baseGenerate);
  if (toGenerate <= 0) return 0;

  const [eventTypes] = await dbPool.query(`SELECT * FROM event_types WHERE is_active = 1`);
  if (eventTypes.length === 0) return 0;

  const totalWeight = eventTypes.reduce((sum, et) => sum + (et.spawn_weight || 1), 0);
  let generatedCount = 0;

  for (let i = 0; i < toGenerate; i++) {
    let rng = Math.random() * totalWeight;
    let chosen = eventTypes[0];
    for (const et of eventTypes) {
      rng -= et.spawn_weight || 1;
      if (rng <= 0) {
        chosen = et;
        break;
      }
    }

    const durationHours =
      chosen.duration_hours_min +
      Math.floor(Math.random() * (chosen.duration_hours_max - chosen.duration_hours_min + 1));
    const expiresAt = new Date(Date.now() + durationHours * 3600000);

    let confidence = Number(chosen.base_confidence);
    if (confidence < 1.0) {
      confidence = Math.max(0.2, confidence + (Math.random() * 0.3 - 0.15));
    }
    const actualReal = confidence >= 0.9 ? 1 : Math.random() < confidence ? 1 : 0;

    const fixCost =
      chosen.fix_cost_min +
      Math.floor(Math.random() * (chosen.fix_cost_max - chosen.fix_cost_min + 1));

    const building = await findBuildingForEvent(municipalityId, chosen.id, chosen.code);

    await dbPool.query(
      `INSERT INTO municipality_events
       (municipality_id, room_code, event_type_id, status, severity, confidence, actual_real,
        min_level, fix_cost, location_x, location_y, affected_item_id,
        building_snapshot, building_exists, building_verified_at,
        expires_at, spawned_at)
       VALUES (?, ?, ?, 'detected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW())`,
      [
        municipalityId,
        building?.room_code || null,
        chosen.id,
        Math.min(5, chosen.severity + (cantonalActive ? 1 : 0)),
        confidence,
        actualReal,
        chosen.min_level,
        fixCost,
        building?.x ?? null,
        building?.y ?? null,
        building?.item_id ?? null,
        building ? JSON.stringify(building.snapshot) : null,
        building ? 1 : null,
        expiresAt,
      ]
    );
    generatedCount++;
  }

  const today = new Date().toISOString().slice(0, 10);
  await dbPool.query(
    `INSERT INTO event_generation_log (municipality_id, generation_date, events_generated) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE events_generated = events_generated + VALUES(events_generated)`,
    [municipalityId, today, generatedCount]
  );

  return generatedCount;
}

async function expireBuenzliEvents() {
  ensureDbEnabled();

  // Events in leeren Gemeinden (ohne Mitglieder) still ablaufen lassen — KEIN Stat-Schaden
  const [orphanResult] = await dbPool.query(
    `UPDATE municipality_events me SET me.status = 'expired', me.updated_at = NOW()
     WHERE me.status IN ('detected','reported','investigating','assigned')
       AND NOT EXISTS (SELECT 1 FROM municipality_memberships mm WHERE mm.municipality_id = me.municipality_id LIMIT 1)`
  );

  const [buildingEvents] = await dbPool.query(
    `SELECT me.id, me.affected_item_id, me.municipality_id
     FROM municipality_events me
     WHERE me.affected_item_id IS NOT NULL
       AND me.status IN ('detected','reported','investigating','assigned')
       AND (me.building_verified_at IS NULL OR me.building_verified_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE))`
  );
  for (const ev of buildingEvents) {
    try {
      await verifyBuildingExists(ev.id);
    } catch (_) {}
  }

  const [result] = await dbPool.query(
    `UPDATE municipality_events SET status = 'expired', updated_at = NOW()
     WHERE status IN ('detected','reported') AND expires_at <= NOW()`
  );
  const expired = result.affectedRows || 0;
  if (expired > 0) {
    const [expiredEvents] = await dbPool.query(
      `SELECT me.id, me.municipality_id, me.event_type_id, et.stat_impact, et.stat_damage
       FROM municipality_events me
       JOIN event_types et ON et.id = me.event_type_id
       WHERE me.status = 'expired' AND me.updated_at >= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
         AND et.stat_impact IS NOT NULL`
    );

    const shieldCache = {};
    const dailyDamageCache = {};
    const DAILY_DEBUFF_CAP = 15;

    for (const ev of expiredEvents) {
      const mId = ev.municipality_id;

      if (shieldCache[mId] === undefined) {
        const [sh] = await dbPool.query(
          `SELECT shield_active_until FROM municipality_stats WHERE municipality_id = ?`,
          [mId]
        );
        const shieldUntil = sh[0]?.shield_active_until;
        shieldCache[mId] = shieldUntil && new Date(shieldUntil) > new Date();
      }
      if (shieldCache[mId]) continue;

      const capKey = `${mId}:${ev.stat_impact}`;
      if (dailyDamageCache[capKey] === undefined) {
        const [todayDmg] = await dbPool.query(
          `SELECT COALESCE(SUM(ABS(change_amount)), 0) AS total_dmg
           FROM municipality_stats_log
           WHERE municipality_id = ? AND stat_name = ? AND change_amount < 0
             AND reason = 'event_expired' AND created_at >= CURDATE()`,
          [mId, ev.stat_impact]
        );
        dailyDamageCache[capKey] = todayDmg[0]?.total_dmg || 0;
      }

      if (dailyDamageCache[capKey] >= DAILY_DEBUFF_CAP) continue;

      const remaining = DAILY_DEBUFF_CAP - dailyDamageCache[capKey];
      const actualDamage = Math.max(ev.stat_damage, -remaining);
      await applyStatChange(mId, ev.stat_impact, actualDamage, 'event_expired', 'event', ev.id);
      dailyDamageCache[capKey] += Math.abs(actualDamage);
    }
  }

  const [ignoredExternals] = await dbPool.query(
    `SELECT me.id, me.municipality_id, me.severity, me.external_reporter_id, me.escalation_level,
            et.stat_impact, et.stat_damage, et.name AS event_name
     FROM municipality_events me
     JOIN event_types et ON et.id = me.event_type_id
     WHERE me.status = 'external_reported' AND me.external_deadline <= NOW()`
  );
  const { awardXp } = require('./xp.js');
  const { createUserNotification } = require('./notifications.js');

  for (const ev of ignoredExternals) {
    const newSeverity = Math.min(5, ev.severity + 1);
    const newEscLevel = Math.min(2, ev.escalation_level + 1);
    await dbPool.query(
      `UPDATE municipality_events
       SET status = 'reported', severity = ?, escalation_level = ?, updated_at = NOW()
       WHERE id = ?`,
      [newSeverity, newEscLevel, ev.id]
    );
    await applyStatChange(ev.municipality_id, 'transparency', -(ev.severity * 2), 'external_ignored', 'event', ev.id);
    if (ev.stat_impact && ev.stat_impact !== 'transparency') {
      await applyStatChange(
        ev.municipality_id,
        ev.stat_impact,
        Math.round(ev.stat_damage * 0.5),
        'external_ignored',
        'event',
        ev.id
      );
    }
    if (ev.external_reporter_id) {
      const xpBonus = 15 + ev.severity * 5;
      await awardXp(ev.external_reporter_id, xpBonus, 'external_report_ignored', `Gemeinde ignorierte Report: ${ev.event_name} (Eskalation!)`, 'event', ev.id);
      await createUserNotification(ev.external_reporter_id, 'report_escalated', 'Gemeinde hat deinen Report ignoriert!', `Dein Report "${ev.event_name}" wurde ignoriert. Severity: ${newSeverity}. Du erhaeltst ${xpBonus} Bonus-XP.`, { event_id: ev.id, xp_bonus: xpBonus });
    }
  }

  const [resolvedDisputes] = await dbPool.query(
    `SELECT me.id, me.municipality_id, me.evidence_score, me.external_reporter_id,
            me.severity, et.name AS event_name
     FROM municipality_events me
     JOIN event_types et ON et.id = me.event_type_id
     WHERE me.status = 'disputed' AND me.dispute_until <= NOW()`
  );
  for (const ev of resolvedDisputes) {
    const score = ev.evidence_score || 0;
    if (score >= 60) {
      await dbPool.query(
        `UPDATE municipality_events SET status = 'reported', updated_at = NOW() WHERE id = ?`,
        [ev.id]
      );
      await applyStatChange(ev.municipality_id, 'transparency', -ev.severity, 'dispute_lost', 'event', ev.id);
      if (ev.external_reporter_id) {
        const xpBonus = 25 + ev.severity * 5;
        await awardXp(ev.external_reporter_id, xpBonus, 'dispute_won', `Einspruch abgelehnt: ${ev.event_name}`, 'event', ev.id);
        await createUserNotification(ev.external_reporter_id, 'dispute_won', 'Einspruch abgelehnt — du hattest recht!', `Der Einspruch gegen "${ev.event_name}" wurde abgelehnt (Evidence: ${score}/100). Bonus: ${xpBonus} XP!`, { event_id: ev.id });
      }
    } else {
      await dbPool.query(
        `UPDATE municipality_events SET status = 'false_alarm', updated_at = NOW() WHERE id = ?`,
        [ev.id]
      );
      if (ev.external_reporter_id) {
        const xpPenalty = -(10 + ev.severity * 3);
        await awardXp(ev.external_reporter_id, xpPenalty, 'dispute_lost', `Falschmeldung: ${ev.event_name}`, 'event', ev.id);
        await dbPool.query(
          `UPDATE event_reports SET foreign_cooldown_until = DATE_ADD(NOW(), INTERVAL 12 HOUR)
           WHERE event_id = ? AND user_id = ?`,
          [ev.id, ev.external_reporter_id]
        );
        await createUserNotification(ev.external_reporter_id, 'dispute_lost', 'Einspruch akzeptiert — Falschmeldung!', `Dein Report "${ev.event_name}" war falsch (Evidence: ${score}/100). 12h Cooldown.`, { event_id: ev.id });
      }
    }
  }

  await checkCantonalInvestigation();
  return expired;
}

async function checkCantonalInvestigation() {
  ensureDbEnabled();
  const { createNotificationForAllMembers } = require('./notifications.js');
  try {
    const [candidates] = await dbPool.query(
      `SELECT ms.municipality_id, ms.transparency, ms.cantonal_investigation_until,
              m.name AS municipality_name, m.canton_name
       FROM municipality_stats ms
       JOIN municipalities m ON m.id = ms.municipality_id
       WHERE ms.cantonal_investigation_until IS NULL OR ms.cantonal_investigation_until < NOW()`
    );
    for (const muni of candidates) {
      if (muni.cantonal_investigation_until && new Date(muni.cantonal_investigation_until) > new Date()) continue;
      let shouldInvestigate = false;
      let reason = '';

      const [ignoredCount] = await dbPool.query(
        `SELECT COUNT(*) AS cnt FROM municipality_events
         WHERE municipality_id = ? AND escalation_level >= 1
           AND updated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
        [muni.municipality_id]
      );
      if ((ignoredCount[0]?.cnt || 0) >= 3) {
        shouldInvestigate = true;
        reason = `${ignoredCount[0].cnt} ignorierte externe Reports in 7 Tagen`;
      }
      if (!shouldInvestigate && muni.transparency < 25) {
        shouldInvestigate = true;
        reason = `Transparenz kritisch niedrig: ${muni.transparency}/100`;
      }

      if (shouldInvestigate) {
        const durationHours = 48 + Math.floor(Math.random() * 25);
        const until = new Date(Date.now() + durationHours * 3600000);
        await dbPool.query(
          `UPDATE municipality_stats SET cantonal_investigation_until = ?, updated_at = NOW()
           WHERE municipality_id = ?`,
          [until, muni.municipality_id]
        );
        await createNotificationForAllMembers(muni.municipality_id, {
          type: 'cantonal_investigation',
          title: 'Kantonale Untersuchung eingeleitet!',
          message: `Der Kanton ${muni.canton_name || 'Bern'} hat eine Untersuchung gegen eure Gemeinde eingeleitet (${reason}). Dauer: ${Math.round(durationHours)}h. Event-Rate verdoppelt!`,
        });
        pushDiscordEvent('cantonal_investigation', {
          municipality_id: muni.municipality_id,
          municipality_name: muni.municipality_name,
          canton: muni.canton_name || 'Bern',
          reason,
          duration_hours: durationHours,
          message: `Kanton ${muni.canton_name || 'Bern'} hat Untersuchung gegen ${muni.municipality_name} eingeleitet! Grund: ${reason}.`,
        });
      }
    }

    const [activeInvestigations] = await dbPool.query(
      `SELECT municipality_id FROM municipality_stats
       WHERE cantonal_investigation_until IS NOT NULL AND cantonal_investigation_until > NOW()`
    );
    for (const inv of activeInvestigations) {
      const [recentPenalty] = await dbPool.query(
        `SELECT COUNT(*) AS cnt FROM municipality_stats_log
         WHERE municipality_id = ? AND reason = 'cantonal_ongoing'
           AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
        [inv.municipality_id]
      );
      if ((recentPenalty[0]?.cnt || 0) === 0) {
        await applyStatChange(inv.municipality_id, 'transparency', -1, 'cantonal_ongoing', 'investigation', inv.municipality_id);
        await applyStatChange(inv.municipality_id, 'attractiveness', -1, 'cantonal_ongoing', 'investigation', inv.municipality_id);
      }
    }
  } catch (err) {
    logError('CANTONAL', 'Kantonale Untersuchung Check Fehler', { error: err?.message || String(err) });
  }
}

async function reportBuenzliEvent(eventId, userId, reportType = 'confirm', comment = null) {
  ensureDbEnabled();
  const { getUserXp, awardXp } = require('./xp.js');
  const { createUserNotification } = require('./notifications.js');
  const { applyMunicipalityTransaction } = require('./bank.js');

  const [events] = await dbPool.query(
    `SELECT me.*, et.xp_reward_report, et.xp_penalty_wrong, et.stat_impact, et.stat_fix_bonus,
            et.code AS event_code, et.name AS event_name, et.base_confidence,
            et.coin_reward_report, et.coin_municipality_report, et.severity
     FROM municipality_events me
     JOIN event_types et ON et.id = me.event_type_id
     WHERE me.id = ?`,
    [eventId]
  );
  if (events.length === 0) throw new Error('Event nicht gefunden');
  const event = events[0];

  if (!['detected', 'reported'].includes(event.status)) {
    throw new Error('Event kann nicht mehr gemeldet werden');
  }

  const userXp = await getUserXp(userId);
  if (userXp.level < event.min_level) {
    throw new Error(`Level ${event.min_level} erforderlich (du bist Level ${userXp.level})`);
  }

  const [userRow] = await dbPool.query(`SELECT municipality_id FROM users WHERE id = ?`, [userId]);
  const userMunicipalityId = userRow[0]?.municipality_id || null;
  const isForeignReport = userMunicipalityId && userMunicipalityId !== event.municipality_id;

  if (isForeignReport) {
    const [recentForeign] = await dbPool.query(
      `SELECT COUNT(*) AS cnt FROM event_reports er
       JOIN municipality_events me ON me.id = er.event_id
       WHERE er.user_id = ? AND er.is_foreign = 1
         AND me.municipality_id = ? AND er.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
      [userId, event.municipality_id]
    );
    if ((recentForeign[0]?.cnt || 0) >= 3) {
      throw new Error('Tageslimit erreicht: Max 3 externe Reports pro Tag pro Gemeinde');
    }
    const [cooldownCheck] = await dbPool.query(
      `SELECT foreign_cooldown_until FROM event_reports
       WHERE user_id = ? AND foreign_cooldown_until > NOW() ORDER BY foreign_cooldown_until DESC LIMIT 1`,
      [userId]
    );
    if (cooldownCheck.length > 0 && cooldownCheck[0].foreign_cooldown_until) {
      const until = new Date(cooldownCheck[0].foreign_cooldown_until);
      const hoursLeft = Math.ceil((until.getTime() - Date.now()) / 3600000);
      throw new Error(`Cooldown aktiv: Du kannst erst in ${hoursLeft}h wieder extern melden (Falschmeldung)`);
    }
  }

  await dbPool.query(
    `INSERT INTO event_reports (event_id, user_id, report_type, comment, user_level, is_foreign)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE report_type = VALUES(report_type), comment = VALUES(comment), is_foreign = VALUES(is_foreign)`,
    [eventId, userId, reportType, comment, userXp.level, isForeignReport ? 1 : 0]
  );

  if (event.status === 'detected') {
    if (isForeignReport) {
      const deadlineHours = event.severity >= 4 ? 12 : event.severity >= 3 ? 18 : 24;
      await dbPool.query(
        `UPDATE municipality_events
         SET status = 'external_reported', reported_by = ?, reported_at = NOW(),
             external_reporter_id = ?, external_deadline = DATE_ADD(NOW(), INTERVAL ? HOUR),
             updated_at = NOW()
         WHERE id = ?`,
        [userId, userId, deadlineHours, eventId]
      );
    } else {
      await dbPool.query(
        `UPDATE municipality_events SET status = 'reported', reported_by = ?, reported_at = NOW(), updated_at = NOW() WHERE id = ?`,
        [userId, eventId]
      );
    }
  }

  let xpResult = null;
  let coinsAwarded = 0;
  let penaltyCost = 0;

  if (reportType === 'investigate' && event.base_confidence < 1.0) {
    const isCorrect = event.actual_real === 1;
    const baseXp = isCorrect ? event.xp_reward_report * 2 : -(event.xp_penalty_wrong || 0);
    const xpAmount = isCorrect && isForeignReport ? baseXp * FOREIGN_REPORT_XP_MULTIPLIER : baseXp;
    xpResult = await awardXp(
      userId,
      xpAmount,
      isCorrect ? 'corruption_correct' : 'corruption_wrong',
      `Investigation: ${event.event_name} - ${isCorrect ? 'korrekt' : 'Fehlalarm'}${isForeignReport ? ' (Fremdgemeinde)' : ''}`,
      'event',
      eventId
    );
    await dbPool.query(
      `UPDATE event_reports SET is_correct = ?, xp_awarded = ? WHERE event_id = ? AND user_id = ?`,
      [isCorrect ? 1 : 0, xpAmount, eventId, userId]
    );
    if (!isCorrect) {
      await dbPool.query(
        `UPDATE municipality_events SET status = 'false_alarm', updated_at = NOW() WHERE id = ?`,
        [eventId]
      );
      try {
        await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, 'ACH_FalseAlarm')`, [userId]);
      } catch (_) {}
    } else {
      coinsAwarded = (event.coin_reward_report || 0) * (isForeignReport ? FOREIGN_REPORT_COIN_MULTIPLIER * 2 : 3);
      try {
        await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, 'ACH_Corruption')`, [userId]);
      } catch (_) {}
    }
  } else {
    const baseXp = event.xp_reward_report;
    const xpAmount = isForeignReport ? baseXp * FOREIGN_REPORT_XP_MULTIPLIER : baseXp;
    xpResult = await awardXp(
      userId,
      xpAmount,
      isForeignReport ? 'event_report_foreign' : 'event_report',
      isForeignReport ? `Fremdgemeinde-Meldung ans Amt: ${event.event_name}` : `Event gemeldet: ${event.event_name}`,
      'event',
      eventId
    );
    coinsAwarded = (event.coin_reward_report || 0) * (isForeignReport ? FOREIGN_REPORT_COIN_MULTIPLIER : 1);
  }

  let newUserCoins = null;

  if (isForeignReport) {
    const penalty = Math.round(event.fix_cost * (FOREIGN_REPORT_PENALTY_MULTIPLIER - 1));
    penaltyCost = penalty;
    if (penalty > 0) {
      await dbPool.query(
        `UPDATE municipality_events SET fix_cost = fix_cost + ?, updated_at = NOW() WHERE id = ?`,
        [penalty, eventId]
      );
    }
    try {
      await applyMunicipalityTransaction(event.municipality_id, {
        amount: -penalty,
        type: 'event_penalty',
        meta: { eventId, eventName: event.event_name },
        actorUserId: userId,
        source: 'system',
        allowOverdraft: true,
      });
    } catch (_) {
      logError('ECONOMY', `Strafgebühr konnte nicht abgezogen werden: ${penalty}`, {
        municipalityId: event.municipality_id,
      });
    }
    const deadlineHoursNotif = event.severity >= 4 ? 12 : event.severity >= 3 ? 18 : 24;
    const [muniAdminsExt] = await dbPool.query(
      `SELECT user_id FROM municipality_memberships WHERE municipality_id = ? AND role IN ('owner','admin','council')`,
      [event.municipality_id]
    );
    for (const admin of muniAdminsExt) {
      await createUserNotification(
        admin.user_id,
        'external_report',
        'Externe Meldung eingegangen!',
        `Ein Bürger einer anderen Gemeinde hat "${event.event_name}" gemeldet. Strafgebühr: ${penalty} CHF. Ihr habt ${deadlineHoursNotif}h Zeit zu reagieren (Akzeptieren oder Einspruch). Bei Ignorieren: Stat-Malus + Eskalation!`,
        { event_id: eventId, penalty, reporter_municipality_id: userMunicipalityId, severity: event.severity, deadline_hours: deadlineHoursNotif }
      );
    }
  } else {
    const [muniAdmins] = await dbPool.query(
      `SELECT user_id FROM municipality_memberships WHERE municipality_id = ? AND role IN ('owner','admin') AND user_id != ?`,
      [event.municipality_id, userId]
    );
    for (const admin of muniAdmins) {
      await createUserNotification(
        admin.user_id,
        'event_reported',
        'Neue Meldung in deiner Gemeinde',
        `"${event.event_name}" wurde von einem Bürger gemeldet. Bitte kümmere dich darum.`,
        { event_id: eventId, severity: event.severity }
      );
    }
  }

  const [reportCount] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM event_reports WHERE user_id = ?`, [userId]);
  const cnt = reportCount[0]?.cnt || 0;
  const reportBadges = { 1: 'ACH_Report1', 10: 'ACH_Report10', 50: 'ACH_Report50' };
  if (reportBadges[cnt]) {
    try {
      await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, ?)`, [userId, reportBadges[cnt]]);
    } catch (_) {}
  }

  return {
    event,
    xp: xpResult,
    report_type: reportType,
    is_foreign_report: isForeignReport,
    penalty: penaltyCost,
    coins: { user: coinsAwarded, user_balance: newUserCoins },
  };
}

async function resolveBuenzliEvent(eventId, userId, opts = {}) {
  ensureDbEnabled();
  const { awardXp } = require('./xp.js');
  const { createUserNotification } = require('./notifications.js');
  const { applyMunicipalityTransaction } = require('./bank.js');

  const [events] = await dbPool.query(
    `SELECT me.*, et.xp_reward_fix, et.stat_impact, et.stat_fix_bonus,
            et.name AS event_name, et.coin_reward_fix
     FROM municipality_events me
     JOIN event_types et ON et.id = me.event_type_id
     WHERE me.id = ?`,
    [eventId]
  );
  if (events.length === 0) throw new Error('Event nicht gefunden');
  const event = events[0];

  if (!['reported', 'investigating', 'assigned', 'external_reported'].includes(event.status)) {
    throw new Error('Event kann nicht behoben werden (aktueller Status: ' + event.status + ')');
  }

  let buildingCheck = null;
  if (event.affected_item_id) {
    buildingCheck = await verifyBuildingExists(eventId);
    if (buildingCheck && !buildingCheck.exists) {
      return {
        event,
        xp: null,
        cost: 0,
        coins: { user: 0, user_balance: null },
        auto_resolved: true,
        message: 'Event wurde automatisch gelöst: Gebäude wurde abgerissen',
      };
    }
  }

  if (!opts.skipTreasury) {
    await applyMunicipalityTransaction(event.municipality_id, {
      amount: -event.fix_cost,
      type: 'event_fix',
      meta: { eventId, eventName: event.event_name },
      actorUserId: userId,
      source: 'user',
    });
  }

  await dbPool.query(
    `UPDATE municipality_events SET status = 'resolved', resolved_by = ?, resolved_at = NOW(),
            building_verified_at = NOW(), building_exists = ?, updated_at = NOW() WHERE id = ?`,
    [userId, buildingCheck ? 1 : null, eventId]
  );

  await dbPool.query(
    `UPDATE event_reports SET is_correct = 1 WHERE event_id = ? AND is_correct IS NULL`,
    [eventId]
  );

  if (event.stat_impact) {
    await applyStatChange(event.municipality_id, event.stat_impact, event.stat_fix_bonus, 'event_fixed', 'event', eventId);
  }

  const xpResult = await awardXp(userId, event.xp_reward_fix, 'event_fix', `Event behoben: ${event.event_name}`, 'event', eventId);

  let newUserCoins = null;

  const [fixCount] = await dbPool.query(
    `SELECT COUNT(*) AS cnt FROM municipality_events WHERE resolved_by = ? AND status = 'resolved'`,
    [userId]
  );
  const cnt = fixCount[0]?.cnt || 0;
  const fixBadges = { 1: 'ACH_Fix1', 25: 'ACH_Fix25' };
  if (fixBadges[cnt]) {
    try {
      await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, ?)`, [userId, fixBadges[cnt]]);
    } catch (_) {}
  }

  return {
    event,
    xp: xpResult,
    cost: event.fix_cost,
    building: buildingCheck?.building || null,
    coins: { user: coinsUser, user_balance: newUserCoins },
  };
}

async function runBuenzliEventTick() {
  if (!dbPool || !BUENZLI_EVENTS_ENABLED) return;
  try {
    // Immer expire-check
    await expireBuenzliEvents();

    // Neue Events alle 4 Stunden generieren (nicht nur 1x/Tag)
    const now = Date.now();
    if (now - buenzliLastGenerateTime < BUENZLI_GENERATION_INTERVAL_MS) return;

    const [municipalities] = await dbPool.query(
      `SELECT m.id FROM municipalities m
       WHERE m.is_active = 1
         AND EXISTS (
           SELECT 1 FROM municipality_memberships mm
           WHERE mm.municipality_id = m.id
             AND mm.role = 'owner'
             AND mm.created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
           LIMIT 1
         )`
    );
    let totalGenerated = 0;
    for (const muni of municipalities) {
      try {
        totalGenerated += await generateBuenzliEventsForMunicipality(muni.id);
      } catch (err) {
        logError('BUENZLI', `Event-Generierung fehlgeschlagen für Gemeinde ${muni.id}`, { error: err?.message });
      }
    }
    buenzliLastGenerateTime = now;
  } catch (err) {
    logError('BUENZLI', 'Event-Tick Fehler', { error: err?.message || String(err) });
  }
}

async function getBuenzliNpcPositions(municipalityId, roomCode) {
  ensureDbEnabled();
  try {
    const [rows] = await dbPool.query(
      `SELECT me.id, me.location_x AS x, me.location_y AS y, me.severity, me.status,
              me.fix_cost AS fixCost, et.code AS eventType
       FROM municipality_events me
       JOIN event_types et ON et.id = me.event_type_id
       WHERE me.municipality_id = ? AND me.room_code = ?
         AND me.location_x IS NOT NULL
         AND me.status IN ('detected', 'reported', 'external_reported')
       ORDER BY me.severity DESC, me.spawned_at DESC
       LIMIT 3`,
      [municipalityId, roomCode]
    );
    return rows.map(r => ({
      id: r.id,
      x: r.x,
      y: r.y,
      eventType: r.eventType,
      severity: r.severity,
      status: r.status,
      fixCost: r.fixCost,
    }));
  } catch (err) {
    logError('BUENZLI', 'getBuenzliNpcPositions Fehler', { error: err?.message, municipalityId, roomCode });
    return [];
  }
}

module.exports = {
  applyStatChange,
  findBuildingForEvent,
  verifyBuildingExists,
  generateBuenzliEventsForMunicipality,
  expireBuenzliEvents,
  checkCantonalInvestigation,
  reportBuenzliEvent,
  resolveBuenzliEvent,
  runBuenzliEventTick,
  getBuenzliNpcPositions,
};
