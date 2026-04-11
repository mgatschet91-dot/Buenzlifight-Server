'use strict';

const { sendJson } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

module.exports = function registerReporterRoutes(deps) {
  return async function handleReporter(req, res, pathname, requestUrl) {

    // ================================================================
    // REPORTER
    // ================================================================

    if (req.method === 'GET' && pathname === '/api/reports/my') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `SELECT * FROM (
           SELECT er.id AS report_id, er.report_type, er.comment, er.is_correct, er.xp_awarded, er.created_at AS reported_at,
                  me.id AS event_id, me.status AS event_status, me.severity, me.fix_cost,
                  me.location_x, me.location_y, me.resolved_at,
                  et.name AS event_name, et.emoji, et.category, et.code AS event_code,
                  m.name AS municipality_name
           FROM event_reports er
           JOIN municipality_events me ON me.id = er.event_id
           JOIN event_types et ON et.id = me.event_type_id
           JOIN municipalities m ON m.id = me.municipality_id
           WHERE er.user_id = ?
           UNION
           SELECT 0 AS report_id, 'confirm' AS report_type, NULL AS comment,
                  CASE WHEN me.status = 'resolved' THEN 1 WHEN me.status = 'false_alarm' THEN 0 ELSE NULL END AS is_correct,
                  0 AS xp_awarded, me.reported_at AS reported_at,
                  me.id AS event_id, me.status AS event_status, me.severity, me.fix_cost,
                  me.location_x, me.location_y, me.resolved_at,
                  et.name AS event_name, et.emoji, et.category, et.code AS event_code,
                  m.name AS municipality_name
           FROM municipality_events me
           JOIN event_types et ON et.id = me.event_type_id
           JOIN municipalities m ON m.id = me.municipality_id
           WHERE me.reported_by = ? AND NOT EXISTS (
             SELECT 1 FROM event_reports er2 WHERE er2.event_id = me.id AND er2.user_id = ?
           )
         ) combined ORDER BY reported_at DESC LIMIT 50`,
        [authUser.id, authUser.id, authUser.id]
      );

      const [summary] = await dbPool.query(
        `SELECT
           COUNT(*) AS total_reports,
           SUM(CASE WHEN is_correct = 1 OR event_status = 'resolved' THEN 1 ELSE 0 END) AS correct_reports,
           SUM(CASE WHEN is_correct = 0 OR event_status = 'false_alarm' THEN 1 ELSE 0 END) AS wrong_reports,
           SUM(CASE WHEN is_correct IS NULL AND event_status NOT IN ('resolved','false_alarm','expired') THEN 1 ELSE 0 END) AS pending_reports,
           SUM(CASE WHEN xp_earned > 0 THEN xp_earned ELSE 0 END) AS total_xp_earned
         FROM (
           SELECT er.is_correct, me.status AS event_status, er.xp_awarded AS xp_earned
           FROM event_reports er
           JOIN municipality_events me ON me.id = er.event_id
           WHERE er.user_id = ?
           UNION
           SELECT
             CASE WHEN me.status = 'resolved' THEN 1 WHEN me.status = 'false_alarm' THEN 0 ELSE NULL END AS is_correct,
             me.status AS event_status, 0 AS xp_earned
           FROM municipality_events me
           WHERE me.reported_by = ? AND NOT EXISTS (
             SELECT 1 FROM event_reports er2 WHERE er2.event_id = me.id AND er2.user_id = ?
           )
         ) combined`,
        [authUser.id, authUser.id, authUser.id]
      );

      return sendJson(res, 200, {
        ok: true,
        data: { reports: rows, summary: summary[0] || { total_reports: 0, correct_reports: 0, wrong_reports: 0, pending_reports: 0, total_xp_earned: 0 } },
      });
    }

  };
};
