'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { createUserNotification } = require('../../../game/notifications');

async function _requireAdmin(req, res) {
  ensureDbEnabled();
  const authUser = await getAuthenticatedUser(req);
  if (!authUser) { sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' }); return null; }
  if (authUser.global_role !== 'administrator') { sendJson(res, 403, { ok: false, error: 'Nur Admins' }); return null; }
  return authUser;
}

module.exports = function createEventsHandler(deps) {
  return async function handleAdminEvents(req, res, pathname, requestUrl) {

    // GET /api/admin/events
    if (req.method === 'GET' && pathname === '/api/admin/events') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const status = requestUrl.searchParams.get('status') || 'all';
      const validStatuses = ['detected', 'reported', 'investigating', 'assigned', 'resolved', 'external_reported'];
      let statusClause = '';
      const params = [];
      if (status === 'active') statusClause = `WHERE me.status IN ('detected','reported','investigating','assigned','external_reported')`;
      else if (status !== 'all' && validStatuses.includes(status)) { statusClause = `WHERE me.status = ?`; params.push(status); }
      const [rows] = await dbPool.query(
        `SELECT me.id, me.severity, me.status, me.spawned_at, me.location_x, me.location_y,
                et.name, et.emoji, et.category, m.name AS municipality_name
         FROM municipality_events me JOIN event_types et ON et.id = me.event_type_id
         JOIN municipalities m ON m.id = me.municipality_id ${statusClause}
         ORDER BY me.spawned_at DESC LIMIT 100`, params);
      return sendJson(res, 200, { ok: true, data: { events: rows } });
    }

    // DELETE /api/admin/events/:id
    const adminDeleteEventMatch = pathname.match(/^\/api\/admin\/events\/([0-9]+)$/i);
    if (adminDeleteEventMatch && req.method === 'DELETE') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const eventId = Number(adminDeleteEventMatch[1]);
      await dbPool.query(`DELETE FROM municipality_events WHERE id = ?`, [eventId]);
      return sendJson(res, 200, { ok: true, data: { deleted: true } });
    }

    // POST /api/admin/events/push-to-verwaltung
    if (req.method === 'POST' && pathname === '/api/admin/events/push-to-verwaltung') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const body = await readJsonBody(req);
      const eventId = body.event_id ? Number(body.event_id) : null;
      if (eventId) {
        const [result] = await dbPool.query(
          `UPDATE municipality_events SET status = 'reported', reported_by = ?, reported_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'detected'`,
          [authUser.id, eventId]
        );
        if (result.affectedRows > 0) {
          await dbPool.query(`INSERT IGNORE INTO event_reports (event_id, user_id, report_type, created_at) VALUES (?, ?, 'confirm', NOW())`, [eventId, authUser.id]);
        }
        return sendJson(res, 200, { ok: true, data: { pushed: result.affectedRows } });
      } else {
        if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
        const [detectedEvents] = await dbPool.query(`SELECT id FROM municipality_events WHERE municipality_id = ? AND status = 'detected'`, [authUser.municipality_id]);
        const [result] = await dbPool.query(
          `UPDATE municipality_events SET status = 'reported', reported_by = ?, reported_at = NOW(), updated_at = NOW() WHERE municipality_id = ? AND status = 'detected'`,
          [authUser.id, authUser.municipality_id]
        );
        for (const ev of detectedEvents) {
          await dbPool.query(`INSERT IGNORE INTO event_reports (event_id, user_id, report_type, created_at) VALUES (?, ?, 'confirm', NOW())`, [ev.id, authUser.id]);
        }
        return sendJson(res, 200, { ok: true, data: { pushed: result.affectedRows } });
      }
    }

    // POST /api/admin/notice
    if (req.method === 'POST' && pathname === '/api/admin/notice') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const { wsUserSockets } = require('../../../ws/socketio/index');

      const body = await readJsonBody(req);
      const target  = String(body.target  || '').trim();
      const message = String(body.message || '').trim().slice(0, 1000);
      const title   = String(body.title   || 'Nachricht von Bünzlifight Management').trim().slice(0, 200);
      const format  = ['bold', 'italic', 'small', 'normal'].includes(body.format) ? body.format : 'normal';

      if (!message) return sendJson(res, 422, { ok: false, error: 'Nachricht darf nicht leer sein' });
      if (!['online', 'all', 'user', 'municipality'].includes(target)) {
        return sendJson(res, 422, { ok: false, error: 'Ungültiges Ziel (online/all/user/municipality)' });
      }

      const io = deps?.io;
      const noticePayload = { title, message, format, sentAt: new Date().toISOString() };

      if (target === 'online') {
        if (io) io.emit('system-notice', noticePayload);
        return sendJson(res, 200, { ok: true, data: { target, sent: wsUserSockets.size } });
      }

      if (target === 'all') {
        const [users] = await dbPool.query(`SELECT id FROM users WHERE is_banned = 0 OR is_banned IS NULL`);
        for (const u of users) {
          await createUserNotification(u.id, 'info', title, message, { icon: 'buenzli', format });
        }
        if (io) io.emit('system-notice', noticePayload);
        return sendJson(res, 200, { ok: true, data: { target, notified: users.length } });
      }

      if (target === 'user') {
        const userId = Number(body.user_id);
        if (!userId) return sendJson(res, 422, { ok: false, error: 'user_id fehlt' });
        const [uRows] = await dbPool.query(`SELECT id FROM users WHERE id = ?`, [userId]);
        if (!uRows[0]) return sendJson(res, 404, { ok: false, error: 'User nicht gefunden' });
        await createUserNotification(userId, 'info', title, message, { icon: 'buenzli', format });
        if (io) {
          const sockets = wsUserSockets.get(userId);
          if (sockets) for (const sid of sockets) io.to(sid).emit('system-notice', noticePayload);
        }
        return sendJson(res, 200, { ok: true, data: { target, user_id: userId } });
      }

      if (target === 'municipality') {
        const muniId = Number(body.municipality_id);
        if (!muniId) return sendJson(res, 422, { ok: false, error: 'municipality_id fehlt' });
        const [members] = await dbPool.query(
          `SELECT user_id FROM municipality_memberships WHERE municipality_id = ?`, [muniId]
        );
        if (!members.length) return sendJson(res, 404, { ok: false, error: 'Keine Mitglieder gefunden' });
        for (const { user_id } of members) {
          await createUserNotification(user_id, 'info', title, message, { icon: 'buenzli', format });
          if (io) {
            const sockets = wsUserSockets.get(user_id);
            if (sockets) for (const sid of sockets) io.to(sid).emit('system-notice', noticePayload);
          }
        }
        return sendJson(res, 200, { ok: true, data: { target, municipality_id: muniId, notified: members.length } });
      }
    }

  };
};
