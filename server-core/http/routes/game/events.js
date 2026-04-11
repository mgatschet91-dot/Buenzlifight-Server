'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

const { awardXp, getUserXp } = require('../../../game/xp');

const {
  reportBuenzliEvent,
  resolveBuenzliEvent,
  findBuildingForEvent,
} = require('../../../game/buenzli');

const { applyMunicipalityTransaction } = require('../../../game/bank');
const { creditUserBankAccount } = require('../../../game/userBanking');
const { logInfo, logError } = require('../../../infra/logger');

module.exports = function registerEventsRoutes(/* deps */) {
  return async function handleEvents(req, res, pathname, requestUrl) {

    // ── Buenzli events ─────────────────────────────────────────

    if (req.method === 'GET' && pathname === '/api/events') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugeordnet' });
      const userXp = await getUserXp(authUser.id);

      // Fremde Gemeinde besuchen? → nur detected Events zeigen
      const visitingMuniId = Number(requestUrl.searchParams.get('visiting_municipality_id') || 0);
      const targetMuniId = visitingMuniId && visitingMuniId !== authUser.municipality_id
        ? visitingMuniId : authUser.municipality_id;
      const isVisiting = targetMuniId !== authUser.municipality_id;

      const statusFilter = requestUrl.searchParams.get('status') || (isVisiting ? 'detected' : 'detected');
      const validStatuses = isVisiting
        ? ['detected']
        : ['detected', 'reported', 'investigating', 'assigned', 'resolved', 'expired', 'failed', 'false_alarm', 'external_reported', 'disputed'];
      const statuses = statusFilter.split(',').filter(s => validStatuses.includes(s));
      if (statuses.length === 0) return sendJson(res, 400, { ok: false, error: 'Ungültiger Status-Filter' });
      const placeholders = statuses.map(() => '?').join(',');
      const [rows] = await dbPool.query(
        `SELECT me.id, me.event_type_id, me.status, me.severity, me.confidence,
                me.min_level, me.fix_cost, me.location_x, me.location_y,
                me.room_code, me.affected_item_id, me.building_snapshot,
                me.building_exists, me.building_verified_at,
                me.reported_by, me.resolved_by, me.spawned_at, me.expires_at,
                me.reported_at, me.resolved_at,
                et.code, et.name, et.description, et.emoji, et.category,
                et.company_type_required
         FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         WHERE me.municipality_id = ? AND me.status IN (${placeholders})
           AND me.min_level <= ?
         ORDER BY me.severity DESC, me.spawned_at DESC
         LIMIT 50`,
        [targetMuniId, ...statuses, userXp.level]
      );
      const events = rows.map(r => {
        let snapshot = r.building_snapshot;
        if (snapshot && typeof snapshot === 'string') {
          try { snapshot = JSON.parse(snapshot); } catch (_) {}
        }
        return { ...r, building_snapshot: snapshot };
      });
      return sendJson(res, 200, { ok: true, data: { events, user_level: userXp.level, is_visiting: isVisiting } });
    }

    if (req.method === 'GET' && pathname === '/api/events/types') {
      ensureDbEnabled();
      const [rows] = await dbPool.query(`SELECT * FROM event_types WHERE is_active = 1 ORDER BY category, severity`);
      return sendJson(res, 200, { ok: true, data: { event_types: rows } });
    }

    if (req.method === 'GET' && pathname === '/api/events/stats') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugeordnet' });
      const [stats] = await dbPool.query(
        `SELECT * FROM municipality_stats WHERE municipality_id = ?`, [authUser.municipality_id]
      );
      if (stats.length === 0) return sendJson(res, 200, { ok: true, data: { stats: null } });
      return sendJson(res, 200, { ok: true, data: { stats: stats[0] } });
    }

    const eventReportMatch = pathname.match(/^\/api\/events\/([0-9]+)\/report$/i);
    if (eventReportMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const eventId = Number(eventReportMatch[1]);
      const body = await readJsonBody(req);
      const reportType = body.report_type || 'confirm';
      const comment = body.comment || null;
      const inspectionId = body.inspection_id ? Number(body.inspection_id) : null;

      // Server-seitige Inspektions-Verifizierung
      if (inspectionId) {
        const [inspRows] = await dbPool.query(
          `SELECT i.*, me.location_x AS event_x, me.location_y AS event_y
           FROM inspections i
           LEFT JOIN municipality_events me ON me.id = ?
           WHERE i.id = ? AND i.user_id = ?`,
          [eventId, inspectionId, authUser.id]
        );
        if (inspRows.length === 0) {
          return sendJson(res, 403, { ok: false, error: 'Ungültige Inspektion' });
        }
        const insp = inspRows[0];
        if (new Date(insp.completes_at).getTime() > Date.now()) {
          return sendJson(res, 403, { ok: false, error: 'Inspektion noch nicht abgeschlossen' });
        }
        if (insp.status === 'cancelled') {
          return sendJson(res, 403, { ok: false, error: 'Inspektion wurde abgebrochen' });
        }
        // Proximity-Check: Event muss im Radius der Inspektion liegen
        if (insp.event_x !== null && insp.event_y !== null) {
          const dx = Math.abs(insp.event_x - insp.tile_x);
          const dy = Math.abs(insp.event_y - insp.tile_y);
          if (dx > insp.radius || dy > insp.radius) {
            return sendJson(res, 403, { ok: false, error: 'Event liegt ausserhalb des Inspektions-Radius' });
          }
        }
      }

      try {
        const result = await reportBuenzliEvent(eventId, authUser.id, reportType, comment);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    const eventResolveMatch = pathname.match(/^\/api\/events\/([0-9]+)\/resolve$/i);
    if (eventResolveMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const eventId = Number(eventResolveMatch[1]);
      try {
        const result = await resolveBuenzliEvent(eventId, authUser.id);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // ── Büenzli-Verstoss buchen (Client meldet Fund) ──────────
    if (req.method === 'POST' && pathname === '/api/game/buenzli-violation') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const body = await readJsonBody(req);
      const { event_id, violation_type, amount, description } = body || {};

      if (!violation_type || typeof amount !== 'number' || amount >= 0) {
        return sendJson(res, 400, { ok: false, error: 'Ungültige Daten' });
      }

      // Betrag begrenzen: max -3000 CHF pro Verstoss
      const safeAmount = Math.max(-3000, Math.min(-10, Math.round(amount)));

      // Validiere Event wenn angegeben
      let eventInfo = null;
      if (event_id) {
        const [events] = await dbPool.query(
          `SELECT me.id, me.status, me.severity, et.code AS eventType, et.name AS eventName
           FROM municipality_events me
           JOIN event_types et ON et.id = me.event_type_id
           WHERE me.id = ? AND me.municipality_id = ?`,
          [event_id, authUser.municipality_id]
        );
        if (events.length > 0) eventInfo = events[0];
      }

      // Rate-Limit: Max 1 Buchung pro Event pro 60s
      if (event_id) {
        const [recent] = await dbPool.query(
          `SELECT id FROM municipality_ledger
           WHERE municipality_id = ? AND type IN ('buenzli_fine','buenzli_penalty')
             AND meta_json LIKE ? AND ts > DATE_SUB(NOW(), INTERVAL 60 SECOND)
           LIMIT 1`,
          [authUser.municipality_id, `%"event_id":${event_id}%`]
        );
        if (recent.length > 0) {
          return sendJson(res, 429, { ok: false, error: 'Bereits kürzlich gebucht' });
        }
      }

      const ledgerType = violation_type === 'big' ? 'buenzli_penalty' : 'buenzli_fine';

      const result = await applyMunicipalityTransaction(authUser.municipality_id, {
        amount: safeAmount,
        type: ledgerType,
        meta: {
          event_id: event_id || null,
          event_type: eventInfo?.eventType || null,
          event_name: eventInfo?.eventName || null,
          description: (description || '').slice(0, 120),
          violation_type,
        },
        actorUserId: authUser.id,
        source: 'system',
        allowOverdraft: true,
      });

      logInfo('BUENZLI', `Verstoss gebucht: ${ledgerType} ${safeAmount} CHF`, {
        municipalityId: authUser.municipality_id,
        eventId: event_id,
        description,
      });

      return sendJson(res, 200, { ok: true, data: { booked: true, amount: safeAmount, treasury: result.treasury } });
    }

    // ── Büenzli Quiz: Cooldown-Status abrufen ────────────────────
    if (req.method === 'GET' && pathname === '/api/game/buenzli-quiz-status') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const [rows] = await dbPool.query(
        `SELECT buenzli_quiz_failed_at FROM users WHERE id = ?`, [authUser.id]
      );
      const failedAt = rows[0]?.buenzli_quiz_failed_at ? new Date(rows[0].buenzli_quiz_failed_at) : null;
      const COOLDOWN_MS = 12 * 60 * 60 * 1000;
      const remaining = failedAt ? Math.max(0, COOLDOWN_MS - (Date.now() - failedAt.getTime())) : 0;
      return sendJson(res, 200, { ok: true, data: { cooldown_remaining_ms: remaining } });
    }

    // ── Büenzli Quiz: Fail speichern (12h Cooldown) ──────────────
    if (req.method === 'POST' && pathname === '/api/game/buenzli-quiz-fail') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      await dbPool.query(
        `UPDATE users SET buenzli_quiz_failed_at = NOW() WHERE id = ?`, [authUser.id]
      );
      return sendJson(res, 200, { ok: true });
    }

    // ── Aktive Gemeinden (für Büenzli-Hetzen Zielauswahl) ────────
    if (req.method === 'GET' && pathname === '/api/game/active-municipalities') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugeordnet' });

      const [rows] = await dbPool.query(
        `SELECT ms.municipality_id, m.name, ms.population
         FROM municipality_stats ms
         JOIN municipalities m ON m.id = ms.municipality_id
         WHERE ms.population > 0
           AND ms.municipality_id != ?
         ORDER BY m.name`,
        [authUser.municipality_id]
      );

      return sendJson(res, 200, { ok: true, data: { municipalities: rows } });
    }

    // ── Büenzli auf Nachbargemeinde hetzen (neues Dispatch-System) ──
    if (req.method === 'POST' && pathname === '/api/game/buenzli-hetzen') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugeordnet' });

      const body = await readJsonBody(req);
      const { target_municipality_id, quiz_score, buenzli_server_id } = body || {};

      if (!target_municipality_id || typeof quiz_score !== 'number') {
        return sendJson(res, 400, { ok: false, error: 'Ungültige Daten: target_municipality_id und quiz_score erforderlich' });
      }
      if (quiz_score < 2) {
        return sendJson(res, 400, { ok: false, error: 'Quiz nicht bestanden — mindestens 2 von 3 Fragen müssen richtig sein' });
      }
      if (Number(target_municipality_id) === Number(authUser.municipality_id)) {
        return sendJson(res, 400, { ok: false, error: 'Du kannst keinen Büenzli auf deine eigene Gemeinde hetzen' });
      }

      // Ziel-Gemeinde existiert und hat Population > 0?
      const [targetRows] = await dbPool.query(
        `SELECT ms.municipality_id, ms.population, m.name, gr.room_code
         FROM municipality_stats ms
         JOIN municipalities m ON m.id = ms.municipality_id
         LEFT JOIN game_rooms gr ON gr.municipality_id = ms.municipality_id AND gr.is_active = 1
         WHERE ms.municipality_id = ? AND ms.population > 0`,
        [target_municipality_id]
      );
      if (targetRows.length === 0) {
        return sendJson(res, 400, { ok: false, error: 'Ziel-Gemeinde nicht gefunden oder hat keine Einwohner' });
      }
      const targetMuni = targetRows[0];

      // Cooldown: Max 1 aktiver Dispatch pro User (noch kein Ergebnis)
      const [cooldownRows] = await dbPool.query(
        `SELECT COUNT(*) AS cnt FROM buenzli_dispatches
         WHERE sender_user_id = ? AND status = 'searching'`,
        [authUser.id]
      );
      if ((cooldownRows[0]?.cnt || 0) > 0) {
        return sendJson(res, 429, { ok: false, error: 'Der Büenzli ist noch unterwegs — warte auf sein Ergebnis bevor du einen neuen losschickst' });
      }
      // Zusätzlich: max 1 Hetzen pro Stunde auf dieselbe Gemeinde
      const [sameMuniRows] = await dbPool.query(
        `SELECT COUNT(*) AS cnt FROM buenzli_dispatches
         WHERE sender_user_id = ? AND target_municipality_id = ?
           AND dispatched_at > NOW() - INTERVAL 1 HOUR`,
        [authUser.id, target_municipality_id]
      );
      if ((sameMuniRows[0]?.cnt || 0) > 0) {
        return sendJson(res, 429, { ok: false, error: 'Cooldown — du kannst diese Gemeinde nur einmal pro Stunde inspizieren' });
      }

      try {
        const arrivesAt = new Date(Date.now() + 60 * 60 * 1000); // 1 Stunde
        const [result] = await dbPool.query(
          `INSERT INTO buenzli_dispatches
             (sender_user_id, sender_municipality_id, target_municipality_id, quiz_score, arrives_at)
           VALUES (?, ?, ?, ?, ?)`,
          [authUser.id, authUser.municipality_id, target_municipality_id, quiz_score, arrivesAt]
        );

        // Sofort 5 XP für das Losschicken
        await awardXp(authUser.id, 5, 'buenzli_dispatched', `Büenzli nach ${targetMuni.name} geschickt`, 'event', result.insertId);

        logInfo('BUENZLI', `Büenzli dispatched → ${targetMuni.name}`, {
          userId: authUser.id, dispatchId: result.insertId,
          targetMunicipalityId: target_municipality_id, quizScore: quiz_score,
        });

        return sendJson(res, 200, {
          ok: true,
          data: {
            dispatch_id: result.insertId,
            arrives_at: arrivesAt.toISOString(),
            target_name: targetMuni.name,
            message: `Der Büenzli ist unterwegs nach ${targetMuni.name}. Ergebnis in ca. 1 Stunde.`,
          },
        });
      } catch (err) {
        logError('BUENZLI', `Büenzli-Dispatch Fehler: ${err.message}`, { userId: authUser.id });
        return sendJson(res, 500, { ok: false, error: 'Fehler beim Hetzen des Büenzli' });
      }
    }

    // ── Büenzli Dispatch Status abrufen ──────────────────────────
    if (req.method === 'GET' && pathname === '/api/game/buenzli-dispatches') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const [rows] = await dbPool.query(
        `SELECT bd.*, m.name AS target_name
         FROM buenzli_dispatches bd
         JOIN municipalities m ON m.id = bd.target_municipality_id
         WHERE bd.sender_user_id = ?
         ORDER BY bd.dispatched_at DESC LIMIT 20`,
        [authUser.id]
      );
      return sendJson(res, 200, { ok: true, data: { dispatches: rows } });
    }

  };
};
