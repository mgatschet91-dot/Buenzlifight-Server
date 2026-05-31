'use strict';

// Job 4:  Büenzli Event Tick (every 60s)
// Job 14: Büenzli Dispatch Auflösung (every 5min)

const { logInfo, logError } = require('../infra/logger.js');
const { BUENZLI_EVENT_CHECK_INTERVAL_MS } = require('../config/constants.js');

module.exports = function registerBuenzliJobs(deps) {
  const getBuenzli = () => require('../game/buenzli');

  // 4) Büenzli event tick
  const eventTickInterval = setInterval(async () => {
    try {
      await getBuenzli().runBuenzliEventTick(deps);
    } catch (err) {
      logError('INTERVAL', 'Buenzli tick error', { error: err?.message });
    }
  }, BUENZLI_EVENT_CHECK_INTERVAL_MS || 60000);

  // 14) Büenzli-Dispatch Auflösung (alle 5min)
  const dispatchInterval = setInterval(async () => {
    try {
      const { dbPool }    = require('../infra/db.js');
      const { findBuildingForEvent }       = require('../game/buenzli.js');
      const { applyMunicipalityTransaction } = require('../game/bank.js');
      const { creditUserBankAccount }      = require('../game/userBanking.js');
      const { awardXp }                    = require('../game/xp.js');

      const [pending] = await dbPool.query(
        `SELECT bd.*, m.name AS target_name, gr.room_code AS target_room_code, ms.population AS target_population
         FROM buenzli_dispatches bd
         JOIN municipalities m ON m.id = bd.target_municipality_id
         LEFT JOIN municipality_stats ms ON ms.municipality_id = bd.target_municipality_id
         LEFT JOIN game_rooms gr ON gr.municipality_id = bd.target_municipality_id AND gr.is_active = 1
         WHERE bd.status = 'searching' AND bd.arrives_at <= NOW()
         LIMIT 20`
      );

      for (const dispatch of pending) {
        try {
          const findChance    = dispatch.quiz_score >= 3 ? 0.85 : 0.60;
          const foundViolation = Math.random() < findChance;

          if (!foundViolation || (dispatch.target_population || 0) === 0) {
            await dbPool.query(`UPDATE buenzli_dispatches SET status = 'found_nothing', resolved_at = NOW() WHERE id = ?`, [dispatch.id]);
            continue;
          }

          const [eventTypes] = await dbPool.query(`SELECT * FROM event_types WHERE is_active = 1 AND category = 'ordnung' ORDER BY RAND() LIMIT 1`);
          if (eventTypes.length === 0) {
            await dbPool.query(`UPDATE buenzli_dispatches SET status = 'found_nothing', resolved_at = NOW() WHERE id = ?`, [dispatch.id]);
            continue;
          }
          const chosenType = eventTypes[0];
          const building   = await findBuildingForEvent(Number(dispatch.target_municipality_id), chosenType.id, chosenType.code);
          const severity   = Math.min(5, chosenType.severity + (dispatch.quiz_score >= 3 ? 2 : 1));
          const fixCost    = chosenType.fix_cost_min + Math.floor(Math.random() * (chosenType.fix_cost_max - chosenType.fix_cost_min + 1));
          const confidence = Math.max(0.7, Number(chosenType.base_confidence) + 0.1);
          const durationHours = chosenType.duration_hours_min + Math.floor(Math.random() * (chosenType.duration_hours_max - chosenType.duration_hours_min + 1));
          const fineAmount = Math.round(fixCost * (1 + severity * 0.3));

          const [insertResult] = await dbPool.query(
            `INSERT INTO municipality_events
             (municipality_id, event_type_id, status, severity, confidence, fix_cost, location_x, location_y, room_code, spawned_at, expires_at, external_reporter_id, escalation_level)
             VALUES (?, ?, 'external_reported', ?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR), ?, 1)`,
            [dispatch.target_municipality_id, chosenType.id, severity, confidence, fixCost, building?.x ?? null, building?.y ?? null, building?.room_code || dispatch.target_room_code || null, durationHours, dispatch.sender_user_id]
          );

          try {
            await applyMunicipalityTransaction(Number(dispatch.target_municipality_id), {
              amount: -fineAmount, type: 'buenzli_fine',
              description: `Büenzli-Inspektion: Busse für ${chosenType.name} (Severity ${severity})`,
            });
          } catch (_) {}

          try {
            await creditUserBankAccount(dispatch.sender_user_id, {
              amount: 50 + Math.round(fineAmount * 0.1), type: 'buenzli_reward',
              description: `Büenzli-Belohnung: ${chosenType.name} in ${dispatch.target_name}`,
            });
            await awardXp(dispatch.sender_user_id, 15, 'buenzli_found', `Verstoss gefunden in ${dispatch.target_name}`, 'event', insertResult.insertId);
            await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, 'ACH_BuenzliHetzer')`, [dispatch.sender_user_id]);
            const [foundCount] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM buenzli_dispatches WHERE sender_user_id = ? AND status = 'found_violation'`, [dispatch.sender_user_id]);
            if ((foundCount[0]?.cnt || 0) >= 4) await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, 'ACH_BuenzliProfi')`, [dispatch.sender_user_id]);
          } catch (_) {}

          await dbPool.query(
            `UPDATE buenzli_dispatches SET status = 'found_violation', resolved_at = NOW(), fine_amount = ?, event_id = ?, violation_type = ?, sender_rewarded = 1 WHERE id = ?`,
            [fineAmount, insertResult.insertId, chosenType.code, dispatch.id]
          );
          logInfo('BUENZLI', `Dispatch ${dispatch.id} aufgelöst: ${chosenType.code} in ${dispatch.target_name}, Busse CHF ${fineAmount}`);
        } catch (err) {
          logError('BUENZLI', `Dispatch ${dispatch.id} Auflösung fehlgeschlagen`, { error: err?.message });
        }
      }
    } catch (err) {
      logError('INTERVAL', 'Büenzli dispatch resolve error', { error: err?.message });
    }
  }, 5 * 60 * 1000);

  return [eventTickInterval, dispatchInterval];
};
