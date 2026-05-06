'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { ensureDbEnabled, dbPool } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { GLOBAL_ROLE_MODERATOR, GLOBAL_ROLE_ADMINISTRATOR } = require('../../../config/constants');
const { actionAttempts, ACTION_RATE_LIMIT, ACTION_WINDOW_MS, checkRateLimit, incrementRateLimit } = require('../../shared');
const { sanitizeText } = require('../../../shared/helpers');

const GLOBAL_CHAT_MAX_LENGTH = 2000;
const GLOBAL_CHAT_LIMIT_MAX  = 50;
const GLOBAL_CHAT_WINDOW_DAYS = 2;

function isGlobalMod(authUser) {
  const role = String(authUser?.global_role || '').toLowerCase();
  return role === GLOBAL_ROLE_MODERATOR || role === GLOBAL_ROLE_ADMINISTRATOR;
}

function isGlobalAdmin(authUser) {
  return String(authUser?.global_role || '').toLowerCase() === GLOBAL_ROLE_ADMINISTRATOR;
}

async function getUserCantonCode(userId) {
  const [rows] = await dbPool.query(
    `SELECT m.canton_code, m.canton_name
     FROM users u
     JOIN municipalities m ON m.id = u.municipality_id
     WHERE u.id = ? LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function isUserMuted(userId, scope, cantonCode) {
  const [rows] = await dbPool.query(
    `SELECT id FROM global_chat_mutes
     WHERE user_id = ?
       AND scope = ?
       AND (canton_code = ? OR canton_code IS NULL)
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [userId, scope, cantonCode || null]
  );
  return rows.length > 0;
}

async function listGlobalChatMessages(scope, cantonCode, { limit = 20, before = 0, after = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(GLOBAL_CHAT_LIMIT_MAX, Math.round(Number(limit) || 20)));
  const where = [
    'msg.scope = ?',
    `msg.created_at >= DATE_SUB(NOW(), INTERVAL ${GLOBAL_CHAT_WINDOW_DAYS} DAY)`,
    'msg.deleted_at IS NULL',
  ];
  const args = [scope];

  if (scope === 'cantonal') {
    where.push('msg.canton_code = ?');
    args.push(String(cantonCode || '').toUpperCase());
  }

  let orderBy = 'msg.id DESC';
  if (Number.isFinite(Number(after)) && Number(after) > 0) {
    where.push('msg.id > ?');
    args.push(Number(after));
    orderBy = 'msg.id ASC';
  } else if (Number.isFinite(Number(before)) && Number(before) > 0) {
    where.push('msg.id < ?');
    args.push(Number(before));
  }

  args.push(safeLimit + 1);
  const [rows] = await dbPool.query(
    `SELECT msg.id, msg.scope, msg.canton_code, msg.user_id, msg.message, msg.type,
            msg.reply_to_id, msg.is_edited, msg.edited_at, msg.created_at,
            u.nickname AS user_name,
            COALESCE(ugr.role, 'user') AS global_role,
            ud.avatar_config,
            rep.message AS reply_message,
            mm_role.role AS municipality_role,
            m_home.name AS municipality_name
     FROM global_chat_messages msg
     JOIN users u ON u.id = msg.user_id
     LEFT JOIN user_global_roles ugr ON ugr.user_id = msg.user_id
     LEFT JOIN users_data ud ON ud.user_id = msg.user_id
     LEFT JOIN global_chat_messages rep ON rep.id = msg.reply_to_id AND rep.deleted_at IS NULL
     LEFT JOIN municipality_memberships mm_role
           ON mm_role.user_id = msg.user_id AND mm_role.municipality_id = u.municipality_id
     LEFT JOIN municipalities m_home ON m_home.id = u.municipality_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT ?`,
    args
  );

  const hasMore = rows.length > safeLimit;
  const result  = hasMore ? rows.slice(0, safeLimit) : rows;
  if (orderBy === 'msg.id DESC') result.reverse();

  return { rows: result, hasMore };
}

function mapGlobalMessageToDto(row) {
  let avatarConfig = null;
  try { avatarConfig = row.avatar_config ? JSON.parse(row.avatar_config) : null; } catch {}
  return {
    id:        Number(row.id),
    scope:     row.scope,
    canton_code: row.canton_code || null,
    user: {
      id:                Number(row.user_id),
      name:              row.user_name || `User #${Number(row.user_id)}`,
      avatar_config:     avatarConfig,
      global_role:       row.global_role || 'user',
      municipality_role: row.municipality_role || null,
      municipality_name: row.municipality_name || null,
    },
    message:   row.message,
    type:      row.type || 'text',
    reply_to:  row.reply_to_id
      ? { id: Number(row.reply_to_id), message: row.reply_message || '' }
      : null,
    is_edited: Boolean(row.is_edited),
    edited_at: row.edited_at || null,
    created_at: row.created_at,
  };
}

module.exports = function registerGlobalChatRoutes(deps) {
  return async function handleGlobalChat(req, res, pathname) {
    const io = deps?.io;

    // ── GET /api/chat/global ────────────────────────────────
    if (pathname === '/api/chat/global' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const url = new URL(req.url, `http://localhost`);
      const limit  = Math.min(GLOBAL_CHAT_LIMIT_MAX, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const before = Number(url.searchParams.get('before') || 0);
      const after  = Number(url.searchParams.get('after')  || 0);
      const result = await listGlobalChatMessages('global', null, { limit, before, after });
      return sendJson(res, 200, {
        success: true,
        data: { messages: result.rows.map(mapGlobalMessageToDto), has_more: result.hasMore },
      });
    }

    // ── POST /api/chat/global ───────────────────────────────
    if (pathname === '/api/chat/global' && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      const rlKey = `gchat-global:${authUser.id}`;
      const rlRetry = checkRateLimit(actionAttempts, rlKey, ACTION_RATE_LIMIT, ACTION_WINDOW_MS);
      if (rlRetry > 0) return sendJson(res, 429, { success: false, error: 'Zu viele Nachrichten. Bitte warte kurz.' });
      incrementRateLimit(actionAttempts, rlKey);

      if (await isUserMuted(authUser.id, 'global', null)) {
        return sendJson(res, 403, { success: false, error: 'Du bist im Global-Chat gesperrt.' });
      }

      const body = await readJsonBody(req);
      const message = sanitizeText(String(body.message || ''), GLOBAL_CHAT_MAX_LENGTH);
      if (!message) return sendJson(res, 422, { success: false, error: 'Nachricht darf nicht leer sein' });

      const replyToId = body.reply_to_id ? Number(body.reply_to_id) : null;
      if (replyToId) {
        const [[replyRow]] = await dbPool.query(
          `SELECT id FROM global_chat_messages WHERE id = ? AND scope = 'global' AND deleted_at IS NULL LIMIT 1`,
          [replyToId]
        );
        if (!replyRow) return sendJson(res, 422, { success: false, error: 'Zitierte Nachricht nicht gefunden' });
      }

      const [ins] = await dbPool.query(
        `INSERT INTO global_chat_messages (scope, user_id, message, type, reply_to_id)
         VALUES ('global', ?, ?, 'text', ?)`,
        [authUser.id, message, replyToId]
      );
      const [[row]] = await dbPool.query(
        `SELECT msg.id, msg.scope, msg.canton_code, msg.user_id, msg.message, msg.type,
                msg.reply_to_id, msg.is_edited, msg.edited_at, msg.created_at,
                u.nickname AS user_name,
                COALESCE(ugr.role, 'user') AS global_role,
                ud.avatar_config,
                rep.message AS reply_message,
                mm_role.role AS municipality_role,
                m_home.name AS municipality_name
         FROM global_chat_messages msg
         JOIN users u ON u.id = msg.user_id
         LEFT JOIN user_global_roles ugr ON ugr.user_id = msg.user_id
         LEFT JOIN users_data ud ON ud.user_id = msg.user_id
         LEFT JOIN global_chat_messages rep ON rep.id = msg.reply_to_id AND rep.deleted_at IS NULL
         LEFT JOIN municipality_memberships mm_role
               ON mm_role.user_id = msg.user_id AND mm_role.municipality_id = u.municipality_id
         LEFT JOIN municipalities m_home ON m_home.id = u.municipality_id
         WHERE msg.id = ?`,
        [ins.insertId]
      );
      const dto = mapGlobalMessageToDto(row);

      try {
        io?.to('global:CHAT').emit('global-chat-message', {
          type: 'created',
          message: dto,
          serverTimestamp: Date.now(),
        });
      } catch {}

      return sendJson(res, 200, { success: true, data: { message: dto } });
    }

    // ── DELETE /api/chat/global/:id ─────────────────────────
    const globalDeleteMatch = pathname.match(/^\/api\/chat\/global\/([0-9]+)$/i);
    if (globalDeleteMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const messageId = Number(globalDeleteMatch[1]);
      const [[msgRow]] = await dbPool.query(
        `SELECT id, user_id FROM global_chat_messages WHERE id = ? AND scope = 'global' AND deleted_at IS NULL LIMIT 1`,
        [messageId]
      );
      if (!msgRow) return sendJson(res, 404, { success: false, error: 'Nachricht nicht gefunden' });
      const isOwn = Number(msgRow.user_id) === Number(authUser.id);
      if (!isOwn && !isGlobalMod(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung' });
      }
      await dbPool.query(
        `UPDATE global_chat_messages SET deleted_at = NOW(), deleted_by = ? WHERE id = ?`,
        [authUser.id, messageId]
      );
      try {
        io?.to('global:CHAT').emit('global-chat-message', {
          type: 'deleted',
          message_id: messageId,
          serverTimestamp: Date.now(),
        });
      } catch {}
      return sendJson(res, 200, { success: true, data: { deleted_id: messageId } });
    }

    // ── GET /api/chat/cantonal/:cantonCode ──────────────────
    const cantonalMatch = pathname.match(/^\/api\/chat\/cantonal\/([A-Z]{2})$/i);
    if (cantonalMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const cantonCode = cantonalMatch[1].toUpperCase();
      const userCanton = isGlobalMod(authUser) ? null : await getUserCantonCode(authUser.id);
      if (!isGlobalMod(authUser) && userCanton?.canton_code?.toUpperCase() !== cantonCode) {
        return sendJson(res, 403, { success: false, error: 'Du bist nicht Mitglied dieses Kantons' });
      }
      const url = new URL(req.url, `http://localhost`);
      const limit  = Math.min(GLOBAL_CHAT_LIMIT_MAX, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const before = Number(url.searchParams.get('before') || 0);
      const after  = Number(url.searchParams.get('after')  || 0);
      const result = await listGlobalChatMessages('cantonal', cantonCode, { limit, before, after });
      return sendJson(res, 200, {
        success: true,
        data: {
          messages: result.rows.map(mapGlobalMessageToDto),
          has_more: result.hasMore,
          canton: { code: cantonCode, name: userCanton?.canton_name || cantonCode },
        },
      });
    }

    // ── POST /api/chat/cantonal/:cantonCode ─────────────────
    if (cantonalMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const cantonCode = cantonalMatch[1].toUpperCase();
      const userCanton = await getUserCantonCode(authUser.id);
      if (userCanton?.canton_code?.toUpperCase() !== cantonCode) {
        return sendJson(res, 403, { success: false, error: 'Du bist nicht Mitglied dieses Kantons' });
      }

      const rlKey = `gchat-canton:${authUser.id}`;
      const rlRetry = checkRateLimit(actionAttempts, rlKey, ACTION_RATE_LIMIT, ACTION_WINDOW_MS);
      if (rlRetry > 0) return sendJson(res, 429, { success: false, error: 'Zu viele Nachrichten. Bitte warte kurz.' });
      incrementRateLimit(actionAttempts, rlKey);

      if (await isUserMuted(authUser.id, 'cantonal', cantonCode)) {
        return sendJson(res, 403, { success: false, error: 'Du bist im Kantonal-Chat gesperrt.' });
      }

      const body = await readJsonBody(req);
      const message = sanitizeText(String(body.message || ''), GLOBAL_CHAT_MAX_LENGTH);
      if (!message) return sendJson(res, 422, { success: false, error: 'Nachricht darf nicht leer sein' });

      const replyToId = body.reply_to_id ? Number(body.reply_to_id) : null;
      if (replyToId) {
        const [[replyRow]] = await dbPool.query(
          `SELECT id FROM global_chat_messages WHERE id = ? AND scope = 'cantonal' AND canton_code = ? AND deleted_at IS NULL LIMIT 1`,
          [replyToId, cantonCode]
        );
        if (!replyRow) return sendJson(res, 422, { success: false, error: 'Zitierte Nachricht nicht gefunden' });
      }

      const [ins] = await dbPool.query(
        `INSERT INTO global_chat_messages (scope, canton_code, user_id, message, type, reply_to_id)
         VALUES ('cantonal', ?, ?, ?, 'text', ?)`,
        [cantonCode, authUser.id, message, replyToId]
      );
      const [[row]] = await dbPool.query(
        `SELECT msg.id, msg.scope, msg.canton_code, msg.user_id, msg.message, msg.type,
                msg.reply_to_id, msg.is_edited, msg.edited_at, msg.created_at,
                u.nickname AS user_name,
                COALESCE(ugr.role, 'user') AS global_role,
                ud.avatar_config,
                rep.message AS reply_message,
                mm_role.role AS municipality_role,
                m_home.name AS municipality_name
         FROM global_chat_messages msg
         JOIN users u ON u.id = msg.user_id
         LEFT JOIN user_global_roles ugr ON ugr.user_id = msg.user_id
         LEFT JOIN users_data ud ON ud.user_id = msg.user_id
         LEFT JOIN global_chat_messages rep ON rep.id = msg.reply_to_id AND rep.deleted_at IS NULL
         LEFT JOIN municipality_memberships mm_role
               ON mm_role.user_id = msg.user_id AND mm_role.municipality_id = u.municipality_id
         LEFT JOIN municipalities m_home ON m_home.id = u.municipality_id
         WHERE msg.id = ?`,
        [ins.insertId]
      );
      const dto = mapGlobalMessageToDto(row);

      try {
        io?.to(`canton:${cantonCode}:CHAT`).emit('cantonal-chat-message', {
          type: 'created',
          canton_code: cantonCode,
          message: dto,
          serverTimestamp: Date.now(),
        });
      } catch {}

      return sendJson(res, 200, { success: true, data: { message: dto } });
    }

    // ── DELETE /api/chat/cantonal/:cantonCode/:id ───────────
    const cantonDeleteMatch = pathname.match(/^\/api\/chat\/cantonal\/([A-Z]{2})\/([0-9]+)$/i);
    if (cantonDeleteMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const cantonCode  = cantonDeleteMatch[1].toUpperCase();
      const messageId   = Number(cantonDeleteMatch[2]);
      const [[msgRow]]  = await dbPool.query(
        `SELECT id, user_id FROM global_chat_messages
         WHERE id = ? AND scope = 'cantonal' AND canton_code = ? AND deleted_at IS NULL LIMIT 1`,
        [messageId, cantonCode]
      );
      if (!msgRow) return sendJson(res, 404, { success: false, error: 'Nachricht nicht gefunden' });
      const isOwn = Number(msgRow.user_id) === Number(authUser.id);
      if (!isOwn && !isGlobalMod(authUser)) {
        const userCanton = await getUserCantonCode(authUser.id);
        const [councilRows] = await dbPool.query(
          `SELECT mm.id FROM municipality_memberships mm
           JOIN municipalities m ON m.id = mm.municipality_id
           WHERE mm.user_id = ? AND mm.role IN ('owner','council') AND m.canton_code = ?
           LIMIT 1`,
          [authUser.id, cantonCode]
        );
        if (councilRows.length === 0) {
          return sendJson(res, 403, { success: false, error: 'Keine Berechtigung' });
        }
      }
      await dbPool.query(
        `UPDATE global_chat_messages SET deleted_at = NOW(), deleted_by = ? WHERE id = ?`,
        [authUser.id, messageId]
      );
      try {
        io?.to(`canton:${cantonCode}:CHAT`).emit('cantonal-chat-message', {
          type: 'deleted',
          canton_code: cantonCode,
          message_id: messageId,
          serverTimestamp: Date.now(),
        });
      } catch {}
      return sendJson(res, 200, { success: true, data: { deleted_id: messageId } });
    }

    // ── POST /api/chat/mute ─────────────────────────────────
    if (pathname === '/api/chat/mute' && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const body       = await readJsonBody(req);
      const targetId   = Number(body.user_id || 0);
      const scope      = String(body.scope || 'global').toLowerCase();
      const cantonCode = scope === 'cantonal' ? String(body.canton_code || '').toUpperCase() : null;
      const durationH  = body.duration_hours != null ? Number(body.duration_hours) : null;
      const reason     = sanitizeText(String(body.reason || ''), 255) || null;

      if (!targetId || (scope !== 'global' && scope !== 'cantonal')) {
        return sendJson(res, 422, { success: false, error: 'Ungültige Parameter' });
      }
      if (scope === 'global' && !isGlobalMod(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung' });
      }
      if (scope === 'cantonal') {
        if (!cantonCode) return sendJson(res, 422, { success: false, error: 'canton_code fehlt' });
        if (!isGlobalMod(authUser)) {
          const [councilRows] = await dbPool.query(
            `SELECT mm.id FROM municipality_memberships mm
             JOIN municipalities m ON m.id = mm.municipality_id
             WHERE mm.user_id = ? AND mm.role IN ('owner','council') AND m.canton_code = ?
             LIMIT 1`,
            [authUser.id, cantonCode]
          );
          if (councilRows.length === 0) {
            return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diesen Kanton' });
          }
        }
      }
      const expiresAt = durationH != null ? new Date(Date.now() + durationH * 3600000) : null;
      await dbPool.query(
        `INSERT INTO global_chat_mutes (user_id, muted_by, scope, canton_code, expires_at, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [targetId, authUser.id, scope, cantonCode, expiresAt, reason]
      );
      return sendJson(res, 200, { success: true, data: { muted_user_id: targetId } });
    }

    // ── DELETE /api/chat/mute/:userId ───────────────────────
    const unmuteMatch = pathname.match(/^\/api\/chat\/mute\/([0-9]+)$/i);
    if (unmuteMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (!isGlobalMod(authUser)) return sendJson(res, 403, { success: false, error: 'Keine Berechtigung' });
      const targetId = Number(unmuteMatch[1]);
      const url = new URL(req.url, `http://localhost`);
      const scope = url.searchParams.get('scope') || 'global';
      await dbPool.query(
        `DELETE FROM global_chat_mutes WHERE user_id = ? AND scope = ?`,
        [targetId, scope]
      );
      return sendJson(res, 200, { success: true, data: { unmuted_user_id: targetId } });
    }
  };
};
