'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { getMunicipalityMoney } = require('../../../game/rooms');
const { awardXp } = require('../../../game/xp');
const { applyMunicipalityTransaction } = require('../../../game/bank');
const { creditUserBankAccount } = require('../../../game/userBanking');
const { createUserNotification } = require('../../../game/notifications');
const { resolveBuenzliEvent, applyStatChange } = require('../../../game/buenzli');
const {
  EXTERNAL_REPORT_PAYOUT_RATIO,
  EXTERNAL_REPORT_PAYOUT_MIN,
  EXTERNAL_REPORT_PAYOUT_MAX,
} = require('./helpers');

module.exports = function registerWorkTaskRoutes(deps) {
  const io = deps?.io || null;
  const { createNotificationForAllMembers } = require('../../../game/notifications.js');
  return async function handleWorkTasks(req, res, pathname, requestUrl) {

    // ================================================================
    // VERWALTUNG ENDPOINTS
    // ================================================================

    // GET /api/verwaltung/meldungen
    if (req.method === 'GET' && pathname === '/api/verwaltung/meldungen') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugeordnet' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin', 'council'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung/Gemeinderat hat Zugang' });
      }

      const statusFilter = requestUrl.searchParams.get('status') || 'reported,assigned,external_reported';
      const validStatuses = ['reported', 'investigating', 'assigned', 'resolved', 'expired', 'failed', 'false_alarm', 'external_reported', 'disputed'];
      const statuses = statusFilter.split(',').filter(s => validStatuses.includes(s));
      if (statuses.length === 0) return sendJson(res, 400, { ok: false, error: 'Ungültiger Status-Filter' });
      const placeholders = statuses.map(() => '?').join(',');

      const [rows] = await dbPool.query(
        `SELECT me.id, me.event_type_id, me.status, me.severity, me.confidence, me.fix_cost,
                me.location_x, me.location_y, me.room_code,
                me.affected_item_id, me.building_snapshot, me.building_exists,
                me.reported_by, me.assigned_company_id, me.resolved_by,
                me.spawned_at, me.expires_at, me.reported_at, me.resolved_at,
                me.external_reporter_id, me.external_deadline, me.escalation_level,
                me.dispute_until, me.evidence_score,
                et.code, et.name, et.description, et.emoji, et.category,
                et.stat_impact, et.stat_damage, et.stat_fix_bonus,
                et.company_type_required,
                u_reporter.nickname AS reporter_nickname,
                u_ext.nickname AS external_reporter_nickname,
                c.name AS assigned_company_name, ct.emoji AS company_emoji
         FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         LEFT JOIN users u_reporter ON u_reporter.id = me.reported_by
         LEFT JOIN users u_ext ON u_ext.id = me.external_reporter_id
         LEFT JOIN companies c ON c.id = me.assigned_company_id
         LEFT JOIN company_types ct ON ct.id = c.company_type_id
         WHERE me.municipality_id = ? AND me.status IN (${placeholders})
         ORDER BY
           FIELD(me.status, 'external_reported', 'disputed', 'reported', 'detected', 'investigating', 'assigned', 'resolved', 'expired', 'failed', 'false_alarm'),
           me.severity DESC, me.spawned_at DESC
         LIMIT 100`,
        [authUser.municipality_id, ...statuses]
      );

      const events = rows.map(r => {
        let snapshot = r.building_snapshot;
        if (snapshot && typeof snapshot === 'string') {
          try { snapshot = JSON.parse(snapshot); } catch (_) {}
        }
        return { ...r, building_snapshot: snapshot };
      });

      const [stats] = await dbPool.query(
        `SELECT * FROM municipality_stats WHERE municipality_id = ?`, [authUser.municipality_id]
      );

      const [companies] = await dbPool.query(
        `SELECT c.id, c.name, c.level, c.reputation, ct.code AS type_code, ct.name AS type_name, ct.emoji AS type_emoji,
                ct.can_fix_categories
         FROM companies c
         JOIN company_types ct ON ct.id = c.company_type_id
         WHERE c.municipality_id = ? AND c.is_active = 1
         ORDER BY c.reputation DESC`,
        [authUser.municipality_id]
      );
      const companiesFormatted = companies.map(c => ({
        ...c,
        can_fix_categories: typeof c.can_fix_categories === 'string' ? JSON.parse(c.can_fix_categories) : (c.can_fix_categories || []),
      }));

      return sendJson(res, 200, {
        ok: true,
        data: { events, stats: stats[0] || null, companies: companiesFormatted },
      });
    }

    // POST /api/verwaltung/beauftragen — Verwaltung beauftragt Firma
    if (req.method === 'POST' && pathname === '/api/verwaltung/beauftragen') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin', 'council'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung darf Aufträge vergeben' });
      }

      const body = await readJsonBody(req);
      const eventId = Number(body.event_id);
      const companyId = Number(body.company_id);
      if (!eventId || !companyId) return sendJson(res, 400, { ok: false, error: 'event_id und company_id erforderlich' });

      const [events] = await dbPool.query(
        `SELECT me.*, et.category, et.name AS event_name FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         WHERE me.id = ? AND me.municipality_id = ? AND me.status IN ('detected','reported','external_reported')`, [eventId, authUser.municipality_id]
      );
      if (events.length === 0) return sendJson(res, 404, { ok: false, error: 'Event nicht gefunden oder bereits bearbeitet' });
      const event = events[0];

      const [companyRows] = await dbPool.query(
        `SELECT c.*, ct.can_fix_categories, ct.code AS type_code FROM companies c
         JOIN company_types ct ON ct.id = c.company_type_id
         WHERE c.id = ? AND c.is_active = 1`, [companyId]
      );
      if (companyRows.length === 0) return sendJson(res, 404, { ok: false, error: 'Firma nicht gefunden' });

      const company = companyRows[0];
      const canFix = typeof company.can_fix_categories === 'string'
        ? JSON.parse(company.can_fix_categories)
        : (company.can_fix_categories || []);
      if (!canFix.includes(event.category)) {
        return sendJson(res, 400, {
          ok: false,
          error: `Diese Firma (${company.type_code}) kann keine Events der Kategorie "${event.category}" bearbeiten`,
        });
      }

      const [existingContract] = await dbPool.query(
        `SELECT id FROM company_contracts WHERE event_id = ?`, [eventId]
      );
      if (existingContract.length > 0) return sendJson(res, 400, { ok: false, error: 'Für dieses Event existiert bereits ein Auftrag' });

      const payment = event.fix_cost || event.severity * 500;
      const deadlineHrs = { 1: 6, 2: 12, 3: 24, 4: 48, 5: 72 };
      const deadline = new Date(Date.now() + (deadlineHrs[event.severity] || 24) * 60 * 60 * 1000);
      const xpReward = event.severity * 10;

      await applyMunicipalityTransaction(authUser.municipality_id, {
        amount: -payment,
        type: 'company_contract',
        meta: { eventId, companyId, eventName: event.event_name },
        actorUserId: authUser.id,
        source: 'user',
      });

      const [result] = await dbPool.query(
        `INSERT INTO company_contracts (company_id, event_id, municipality_id, status, payment, difficulty, xp_reward, deadline_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
        [companyId, eventId, authUser.municipality_id, payment, event.severity, xpReward, deadline]
      );

      await dbPool.query(
        `UPDATE municipality_events SET status = 'assigned', assigned_company_id = ?, updated_at = NOW() WHERE id = ?`,
        [companyId, eventId]
      );

      const [companyOwner] = await dbPool.query(
        `SELECT user_id FROM company_members WHERE company_id = ? AND role = 'owner' LIMIT 1`, [companyId]
      );
      if (companyOwner[0]) {
        await createUserNotification(
          companyOwner[0].user_id, 'contract_created',
          'Neuer Auftrag für deine Firma!',
          `Die Verwaltung hat "${event.event_name}" an deine Firma delegiert. Bezahlung: ${payment} CHF.`,
          { event_id: eventId, contract_id: result.insertId, payment }
        );
      }

      return sendJson(res, 200, {
        ok: true,
        data: { contract_id: result.insertId, payment, xp_reward: xpReward, event_name: event.event_name },
      });
    }

    // POST /api/verwaltung/selbst-beheben — Verwaltung behebt Event direkt (zahlt aus Gemeindekasse)
    if (req.method === 'POST' && pathname === '/api/verwaltung/selbst-beheben') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin', 'council'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung darf Events direkt beheben' });
      }

      const body = await readJsonBody(req);
      const eventId = Number(body.event_id);
      if (!eventId) return sendJson(res, 400, { ok: false, error: 'event_id erforderlich' });

      try {
        const result = await resolveBuenzliEvent(eventId, authUser.id);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // POST /api/verwaltung/selbst-beheben-alle — Alle offenen Events direkt beheben (Gemeindekasse)
    if (req.method === 'POST' && pathname === '/api/verwaltung/selbst-beheben-alle') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin', 'council'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung darf Events direkt beheben' });
      }

      const [openEvents] = await dbPool.query(
        `SELECT me.id FROM municipality_events me WHERE me.municipality_id = ? AND me.status = 'reported' LIMIT 20`,
        [authUser.municipality_id]
      );

      let resolved_count = 0;
      let total_cost = 0;
      const failed = [];

      for (const ev of openEvents) {
        try {
          const result = await resolveBuenzliEvent(ev.id, authUser.id);
          resolved_count++;
          total_cost += result.cost || 0;
        } catch {
          failed.push(ev.id);
        }
      }

      return sendJson(res, 200, { ok: true, data: { resolved_count, total_cost, failed } });
    }

    // POST /api/verwaltung/notfallreparatur — Abgelaufenes Event nachträglich beheben (2x Kosten)
    if (req.method === 'POST' && pathname === '/api/verwaltung/notfallreparatur') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin', 'council'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung darf Notfallreparaturen durchführen' });
      }

      const body = await readJsonBody(req);
      const eventId = Number(body.event_id);
      if (!eventId) return sendJson(res, 400, { ok: false, error: 'event_id erforderlich' });

      try {
        const [events] = await dbPool.query(
          `SELECT me.*, et.stat_impact, et.stat_fix_bonus, et.stat_damage,
                  et.name AS event_name, et.xp_reward_fix, et.coin_reward_fix
           FROM municipality_events me
           JOIN event_types et ON et.id = me.event_type_id
           WHERE me.id = ? AND me.municipality_id = ?`, [eventId, authUser.municipality_id]
        );
        if (events.length === 0) return sendJson(res, 404, { ok: false, error: 'Event nicht gefunden' });
        const event = events[0];

        if (event.status !== 'expired') {
          return sendJson(res, 400, { ok: false, error: `Notfallreparatur nur für abgelaufene Events (Status: ${event.status})` });
        }

        const emergencyCost = Math.round(event.fix_cost * 2);
        const treasury = await getMunicipalityMoney(authUser.municipality_id);
        if (treasury < emergencyCost) {
          return sendJson(res, 400, {
            ok: false,
            error: `Nicht genug Geld für Notfallreparatur (${emergencyCost.toLocaleString()} CHF nötig, Kasse: ${treasury.toLocaleString()} CHF)`
          });
        }

        await applyMunicipalityTransaction(authUser.municipality_id, {
          amount: -emergencyCost,
          type: 'emergency_repair',
          meta: { eventId, eventName: event.event_name, fixCost: event.fix_cost },
          actorUserId: authUser.id,
          source: 'user',
        });

        await dbPool.query(
          `UPDATE municipality_events SET status = 'resolved', resolved_by = ?, resolved_at = NOW(), updated_at = NOW() WHERE id = ?`,
          [authUser.id, eventId]
        );

        await dbPool.query(
          `UPDATE event_reports SET is_correct = 1 WHERE event_id = ? AND is_correct IS NULL`,
          [eventId]
        );

        if (event.stat_impact && event.stat_fix_bonus) {
          await applyStatChange(event.municipality_id, event.stat_impact, event.stat_fix_bonus,
            'emergency_fix', 'event', eventId);
        }

        const xpReward = Math.round((event.xp_reward_fix || 0) * 0.5);
        if (xpReward > 0) {
          await awardXp(authUser.id, xpReward, 'emergency_fix',
            `Notfallreparatur: ${event.event_name}`, 'event', eventId);
        }

        return sendJson(res, 200, {
          ok: true,
          data: {
            event_id: eventId,
            cost: emergencyCost,
            original_cost: event.fix_cost,
            stat_recovered: event.stat_impact ? event.stat_fix_bonus : 0,
            xp_earned: xpReward,
            message: `Notfallreparatur erfolgreich! Kosten: ${emergencyCost.toLocaleString()} CHF (2x)`
          }
        });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // POST /api/verwaltung/schutzschild — Schutzschild kaufen (1/3/7 Tage)
    if (req.method === 'POST' && pathname === '/api/verwaltung/schutzschild') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Owner/Admin dürfen ein Schutzschild kaufen' });
      }

      const body = await readJsonBody(req);
      const days = Number(body.days);
      const SHIELD_PRICES = { 1: 2000, 3: 5000, 7: 10000 };
      if (![1, 3, 7].includes(days)) {
        return sendJson(res, 400, { ok: false, error: 'Ungültige Dauer. Erlaubt: 1, 3 oder 7 Tage.' });
      }

      const cost = SHIELD_PRICES[days];
      const treasury = await getMunicipalityMoney(authUser.municipality_id);
      if (treasury < cost) {
        return sendJson(res, 400, {
          ok: false,
          error: `Nicht genug Geld (${cost.toLocaleString()} CHF nötig, Kasse: ${treasury.toLocaleString()} CHF)`
        });
      }

      const [currentShield] = await dbPool.query(
        `SELECT shield_active_until FROM municipality_stats WHERE municipality_id = ?`,
        [authUser.municipality_id]
      );
      const now = new Date();
      let startFrom = now;
      if (currentShield[0]?.shield_active_until && new Date(currentShield[0].shield_active_until) > now) {
        startFrom = new Date(currentShield[0].shield_active_until);
      }
      const newEnd = new Date(startFrom.getTime() + days * 24 * 60 * 60 * 1000);

      await applyMunicipalityTransaction(authUser.municipality_id, {
        amount: -cost,
        type: 'shield',
        meta: { days, shieldEnd: newEnd.toISOString() },
        actorUserId: authUser.id,
        source: 'user',
      });

      await dbPool.query(
        `UPDATE municipality_stats SET shield_active_until = ?, updated_at = NOW() WHERE municipality_id = ?`,
        [newEnd, authUser.municipality_id]
      );

      return sendJson(res, 200, {
        ok: true,
        data: {
          shield_active_until: newEnd.toISOString(),
          cost,
          days,
          extended: startFrom > now,
          message: startFrom > now
            ? `Schutzschild um ${days} Tage verlängert bis ${newEnd.toLocaleDateString('de-CH')}`
            : `Schutzschild für ${days} Tage aktiviert!`
        }
      });
    }

    // GET /api/verwaltung/schutzschild — Aktuellen Schild-Status abfragen
    if (req.method === 'GET' && pathname === '/api/verwaltung/schutzschild') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [rows] = await dbPool.query(
        `SELECT shield_active_until FROM municipality_stats WHERE municipality_id = ?`,
        [authUser.municipality_id]
      );
      const shieldUntil = rows[0]?.shield_active_until || null;
      const isActive = shieldUntil && new Date(shieldUntil) > new Date();

      return sendJson(res, 200, {
        ok: true,
        data: {
          shield_active: !!isActive,
          shield_active_until: shieldUntil,
          prices: { 1: 2000, 3: 5000, 7: 10000 }
        }
      });
    }

    // POST /api/verwaltung/external-response — Reaktion auf externen Report (accept/dispute)
    if (req.method === 'POST' && pathname === '/api/verwaltung/external-response') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin', 'council'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung darf auf externe Meldungen reagieren' });
      }

      const body = await readJsonBody(req);
      const eventId = Number(body.event_id);
      const action = body.action;
      if (!eventId || !['accept', 'dispute'].includes(action)) {
        return sendJson(res, 400, { ok: false, error: 'event_id und action (accept/dispute) erforderlich' });
      }

      try {
        const [events] = await dbPool.query(
          `SELECT me.*, et.name AS event_name, et.stat_impact, et.stat_damage, et.stat_fix_bonus,
                  et.base_confidence, me.external_reporter_id, me.confidence, me.actual_real
           FROM municipality_events me JOIN event_types et ON et.id = me.event_type_id
           WHERE me.id = ? AND me.municipality_id = ?`, [eventId, authUser.municipality_id]
        );
        if (events.length === 0) return sendJson(res, 404, { ok: false, error: 'Event nicht gefunden' });
        const event = events[0];

        if (event.status !== 'external_reported') {
          return sendJson(res, 400, { ok: false, error: `Nur external_reported Events (aktuell: ${event.status})` });
        }

        if (action === 'accept') {
          await dbPool.query(
            `UPDATE municipality_events SET status = 'reported', updated_at = NOW() WHERE id = ?`, [eventId]
          );
          let payoutAmount = 0;
          let payoutApplied = false;
          let payoutError = null;
          if (event.external_reporter_id) {
            await awardXp(event.external_reporter_id, 20, 'external_report_accepted',
              `Externer Report akzeptiert: ${event.event_name}`, 'event', eventId);

            payoutAmount = Math.max(
              EXTERNAL_REPORT_PAYOUT_MIN,
              Math.min(
                EXTERNAL_REPORT_PAYOUT_MAX,
                Math.round((Number(event.fix_cost || 0) * EXTERNAL_REPORT_PAYOUT_RATIO) || 0)
              )
            );
            try {
              await applyMunicipalityTransaction(event.municipality_id, {
                amount: -payoutAmount,
                type: 'external_report_reward',
                meta: {
                  eventId,
                  eventName: event.event_name,
                  reporterUserId: event.external_reporter_id,
                  acceptedByUserId: authUser.id,
                },
                actorUserId: authUser.id,
                source: 'user',
              });
              await creditUserBankAccount(event.external_reporter_id, {
                amount: payoutAmount,
                type: 'reward',
                reference: `external-report:${eventId}`,
                description: `Belohnung für externen Report: ${event.event_name}`,
                meta: {
                  eventId,
                  municipalityId: event.municipality_id,
                  acceptedByUserId: authUser.id,
                },
              });
              payoutApplied = true;
            } catch (rewardErr) {
              payoutError = rewardErr?.message || 'Belohnung konnte nicht ausgezahlt werden';
            }

            await createUserNotification(event.external_reporter_id, 'report_accepted',
              'Dein Report wurde akzeptiert!',
              payoutApplied
                ? `Die Gemeinde hat deinen Report "${event.event_name}" akzeptiert. Du hast ${payoutAmount.toLocaleString()} CHF erhalten.`
                : `Die Gemeinde hat deinen Report "${event.event_name}" akzeptiert und kümmert sich darum.`,
              {
                event_id: eventId,
                payout_amount: payoutAmount,
                payout_applied: payoutApplied,
                ...(payoutError ? { payout_error: payoutError } : {}),
              });
          }
          return sendJson(res, 200, {
            ok: true,
            data: {
              action: 'accepted',
              event_id: eventId,
              new_status: 'reported',
              payout_amount: payoutAmount,
              payout_applied: payoutApplied,
              ...(payoutError ? { payout_error: payoutError } : {}),
            },
          });

        } else if (action === 'dispute') {
          let evidenceScore = 0;
          if (event.external_reporter_id) {
            const [inspections] = await dbPool.query(
              `SELECT COUNT(*) AS cnt FROM inspections
               WHERE user_id = ? AND status = 'completed' AND completes_at >= DATE_SUB(NOW(), INTERVAL 2 HOUR)`,
              [event.external_reporter_id]
            );
            if (inspections[0]?.cnt > 0) evidenceScore += 50;
          }
          if (event.actual_real === 1) evidenceScore += 40;
          if (Number(event.confidence) >= 0.8) evidenceScore += 10;

          const disputeHours = event.severity >= 3 ? 2 : event.severity >= 2 ? 4 : 6;
          await dbPool.query(
            `UPDATE municipality_events
             SET status = 'disputed', dispute_until = DATE_ADD(NOW(), INTERVAL ? HOUR),
                 evidence_score = ?, updated_at = NOW()
             WHERE id = ?`,
            [disputeHours, evidenceScore, eventId]
          );

          if (event.external_reporter_id) {
            await createUserNotification(event.external_reporter_id, 'report_disputed',
              'Einspruch gegen deinen Report!',
              `Die Gemeinde hat Einspruch gegen "${event.event_name}" eingelegt. Untersuchung läuft (${disputeHours}h).`,
              { event_id: eventId, dispute_hours: disputeHours });
          }

          return sendJson(res, 200, {
            ok: true,
            data: {
              action: 'disputed', event_id: eventId, evidence_score: evidenceScore,
              dispute_hours: disputeHours, new_status: 'disputed',
              message: `Einspruch eingelegt. Untersuchung dauert ${disputeHours}h. Evidence-Score: ${evidenceScore}/100`
            }
          });
        }
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // GET /api/verwaltung/stats-history — Statistik-Verlauf für Verwaltung
    if (req.method === 'GET' && pathname === '/api/verwaltung/stats-history') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const days = Math.min(Number(requestUrl.searchParams.get('days') || 14), 30);
      const [rows] = await dbPool.query(
        `SELECT stat_name, old_value, new_value, change_amount, reason, ref_type, ref_id, created_at
         FROM municipality_stats_log
         WHERE municipality_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         ORDER BY created_at DESC LIMIT 200`,
        [authUser.municipality_id, days]
      );
      return sendJson(res, 200, { ok: true, data: { history: rows } });
    }

    // POST /api/verwaltung/polizei-schicken — Polizei zu Event schicken (resolved + XP + Kosten)
    if (req.method === 'POST' && pathname === '/api/verwaltung/polizei-schicken') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin', 'council'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung/Gemeinderat darf Polizei schicken' });
      }

      const body = await readJsonBody(req);
      const eventId = Number(body.event_id);
      if (!eventId) return sendJson(res, 400, { ok: false, error: 'event_id erforderlich' });

      try {
        // Event laden mit event_type Daten
        const [events] = await dbPool.query(
          `SELECT me.*, et.code AS event_code, et.name AS event_name,
                  et.stat_impact, et.stat_fix_bonus, et.xp_reward_fix
           FROM municipality_events me
           JOIN event_types et ON et.id = me.event_type_id
           WHERE me.id = ? AND me.municipality_id = ?`,
          [eventId, authUser.municipality_id]
        );
        if (events.length === 0) {
          return sendJson(res, 404, { ok: false, error: 'Event nicht gefunden' });
        }
        const event = events[0];

        // Status-Check
        if (!['reported', 'external_reported'].includes(event.status)) {
          return sendJson(res, 400, {
            ok: false,
            error: `Event muss Status 'reported' oder 'external_reported' haben (aktuell: ${event.status})`
          });
        }

        // Kosten berechnen: severity * 100
        const cost = event.severity * 100;

        // Treasury prüfen
        const treasury = await getMunicipalityMoney(authUser.municipality_id);
        if (treasury < cost) {
          return sendJson(res, 400, {
            ok: false,
            error: `Nicht genug Geld in der Gemeindekasse (${cost} CHF noetig, Kasse: ${treasury.toLocaleString()} CHF)`
          });
        }

        // Treasury abziehen
        await applyMunicipalityTransaction(authUser.municipality_id, {
          amount: -cost,
          type: 'police_dispatch',
          meta: { eventId, eventName: event.event_name, severity: event.severity },
          actorUserId: authUser.id,
          source: 'user',
        });

        // Event resolven
        await dbPool.query(
          `UPDATE municipality_events SET status = 'resolved', resolved_at = NOW(), resolved_by = ?, updated_at = NOW() WHERE id = ?`,
          [authUser.id, eventId]
        );

        // stat_fix_bonus anwenden
        if (event.stat_impact && event.stat_fix_bonus) {
          await applyStatChange(authUser.municipality_id, event.stat_impact, event.stat_fix_bonus,
            'police_dispatch', 'event', eventId);
        }

        // XP-Reward an User
        const xpReward = event.xp_reward_fix || 0;
        let xpResult = null;
        if (xpReward > 0) {
          xpResult = await awardXp(authUser.id, xpReward, 'police_dispatch',
            `Polizei geschickt: ${event.event_name}`, 'event', eventId);
        }

        // Naechste Polizei-Station finden
        let policeStation = null;
        if (event.location_x != null && event.location_y != null && event.room_code) {
          const [stations] = await dbPool.query(
            `SELECT x, y FROM game_items WHERE room_code = ? AND tool = 'police_station' AND action_type = 'place'
             ORDER BY ABS(x - ?) + ABS(y - ?) LIMIT 1`,
            [event.room_code, event.location_x, event.location_y]
          );
          if (stations.length > 0) {
            policeStation = { x: stations[0].x, y: stations[0].y };
          }
        }

        return sendJson(res, 200, {
          ok: true,
          data: {
            event_id: eventId,
            event_name: event.event_name,
            cost,
            xp: xpResult,
            policeStation,
          },
        });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // POST /api/verwaltung/cantonal-investigation/resolve — Untersuchung vorzeitig beilegen
    if (req.method === 'POST' && pathname === '/api/verwaltung/cantonal-investigation/resolve') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugeordnet' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Bürgermeister/Admin dürfen die Untersuchung beilegen' });
      }

      const [statsRows] = await dbPool.query(
        `SELECT cantonal_investigation_until, cantonal_investigation_stage
         FROM municipality_stats WHERE municipality_id = ?`,
        [authUser.municipality_id]
      );
      const stats = statsRows[0];
      if (!stats) return sendJson(res, 404, { ok: false, error: 'Gemeindedaten nicht gefunden' });

      const isActive = stats.cantonal_investigation_until &&
        new Date(stats.cantonal_investigation_until) > new Date();
      if (!isActive) {
        return sendJson(res, 400, { ok: false, error: 'Keine aktive kantonale Untersuchung' });
      }

      const [[openEventsRow]] = await dbPool.query(
        `SELECT COUNT(*) AS cnt FROM municipality_events
         WHERE municipality_id = ? AND status = 'reported'`,
        [authUser.municipality_id]
      );
      if ((openEventsRow?.cnt || 0) > 0) {
        return sendJson(res, 400, {
          ok: false,
          error: `Zuerst alle offenen Events beheben (${openEventsRow.cnt} offen).`,
        });
      }

      const RESOLUTION_COSTS = { 1: 5000, 2: 10000, 3: 20000 };
      const stage = stats.cantonal_investigation_stage || 1;
      const cost = RESOLUTION_COSTS[stage] || 5000;

      const treasury = await getMunicipalityMoney(authUser.municipality_id);
      if (treasury < cost) {
        return sendJson(res, 400, {
          ok: false,
          error: `Nicht genug Geld in der Gemeindekasse (${cost.toLocaleString('de-CH')} CHF nötig, Kasse: ${Math.floor(treasury).toLocaleString('de-CH')} CHF)`,
        });
      }

      await applyMunicipalityTransaction(authUser.municipality_id, {
        amount: -cost,
        type: 'cantonal_resolution',
        meta: { stage },
        actorUserId: authUser.id,
        source: 'user',
      });

      // Cooldown: until auf +24h setzen (stage=0), damit Pass 1 nicht sofort neu triggert
      await dbPool.query(
        `UPDATE municipality_stats
         SET cantonal_investigation_until = DATE_ADD(NOW(), INTERVAL 24 HOUR),
             cantonal_investigation_since = NULL,
             cantonal_investigation_stage = 0,
             updated_at = NOW()
         WHERE municipality_id = ?`,
        [authUser.municipality_id]
      );

      // Stat-Recovery: Beilegen gibt Transparenz + alle Stats einen Schub (je nach Stage)
      const statBoost = stage * 10; // Stufe 1→+10, Stufe 2→+20, Stufe 3→+30
      const { applyStatChange } = require('../../../game/buenzli.js');
      for (const stat of ['transparency', 'security', 'attractiveness', 'cleanliness', 'infrastructure']) {
        await applyStatChange(authUser.municipality_id, stat, statBoost, 'cantonal_settled', 'investigation', null);
      }

      await createNotificationForAllMembers(authUser.municipality_id, {
        type: 'cantonal_investigation_resolved',
        title: 'Kantonale Untersuchung beigelegt',
        message: `Die Untersuchung wurde offiziell beigelegt (CHF ${cost.toLocaleString('de-CH')} bezahlt). Alle Stats +${statBoost}. Schutzfrist: 24h.`,
        icon: 'checkmark',
        amount: -cost,
      });

      if (io) {
        try {
          const { wsRoomMetadata } = require('../../../ws/socketio/index.js');
          for (const [roomKey, meta] of wsRoomMetadata.entries()) {
            if (Number(meta.municipalityId) === Number(authUser.municipality_id)) {
              io.to(roomKey).emit('stats-authoritative', {
                cantonal_investigation_until: null,
                cantonal_investigation_since: null,
                cantonal_investigation_stage: 0,
                serverTimestamp: Date.now(),
              });
              break;
            }
          }
        } catch (_) {}
      }

      return sendJson(res, 200, {
        ok: true,
        data: { resolved: true, cost, stage, message: `Untersuchung erfolgreich beigelegt (CHF ${cost.toLocaleString('de-CH')})` },
      });
    }

  };
};
