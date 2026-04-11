'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { MUNICIPALITY_ROLE_COUNCIL, GLOBAL_ROLE_ADMINISTRATOR } = require('../../../config/constants');

const {
  getUserMunicipalityRole,
  getMunicipalityBySlug,
  getMunicipalityOwner,
  getMunicipalityRoleMap,
  mapChatMessageRowToDto,
  getMunicipalityChatMessageRowById,
  listMunicipalityChatMessages,
  createMunicipalityChatMessage,
  updateMunicipalityChatMessage,
  softDeleteMunicipalityChatMessage,
  listMunicipalityChatLogs,
} = require('../../../game/municipality');

const { wsRoomKey } = require('../../../ws/socketio/helpers');
const { actionAttempts, ACTION_RATE_LIMIT, ACTION_WINDOW_MS, checkRateLimit, incrementRateLimit } = require('../../shared');

function isGlobalAdmin(authUser) {
  return String(authUser?.global_role || '').toLowerCase() === GLOBAL_ROLE_ADMINISTRATOR;
}

module.exports = function registerMunicipalityChatRoutes(deps) {
  const { io } = deps;

  return async function handleMunicipalityChat(req, res, pathname, requestUrl) {

    // ================================================================
    // MUNICIPALITY CHAT
    // ================================================================

    const municipalityChatMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/chat$/i);
    if (municipalityChatMatch) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityChatMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }

      if (req.method === 'GET') {
        const limit = Math.min(100, Math.max(1, Number(requestUrl.searchParams.get('limit')) || 10));
        const before = Number(requestUrl.searchParams.get('before') || 0);
        const after = Number(requestUrl.searchParams.get('after') || 0);
        const owner = await getMunicipalityOwner(municipality.id);
        const ownerUserId = Number(owner?.id || 0);
        const roleByUserId = await getMunicipalityRoleMap(municipality.id);
        const result = await listMunicipalityChatMessages(municipality.id, { limit, before, after });
        const messages = result.rows.map((row) => mapChatMessageRowToDto(row, ownerUserId, roleByUserId));
        return sendJson(res, 200, {
          success: true,
          data: {
            messages,
            has_more: result.hasMore,
            municipality: {
              id: Number(municipality.id),
              name: municipality.name,
              slug: municipality.slug,
            },
          },
        });
      }

      if (req.method === 'POST') {
        const rlKey = `chat:${authUser.id}`;
        const rlRetry = checkRateLimit(actionAttempts, rlKey, ACTION_RATE_LIMIT, ACTION_WINDOW_MS);
        if (rlRetry > 0) return sendJson(res, 429, { success: false, error: 'Zu viele Nachrichten. Bitte warte kurz.' });
        incrementRateLimit(actionAttempts, rlKey);
        const body = await readJsonBody(req);
        const messageText = String(body.message || '').trim().slice(0, 2000);
        if (!messageText) return sendJson(res, 422, { success: false, error: 'Nachricht darf nicht leer sein' });

        let messageId;
        try {
          messageId = await createMunicipalityChatMessage({
            municipalityId: municipality.id,
            userId: authUser.id,
            message: messageText,
            replyToId: body.reply_to_id,
            ipAddress: req.socket?.remoteAddress || null,
            userAgent: req.headers['user-agent'] || null,
          });
        } catch (err) {
          console.error('[Chat POST] createMunicipalityChatMessage fehlgeschlagen:', err instanceof Error ? err.message : err);
          return sendJson(res, 500, { success: false, error: 'Nachricht konnte nicht gespeichert werden', detail: err instanceof Error ? err.message : String(err) });
        }

        let row;
        try {
          const owner = await getMunicipalityOwner(municipality.id);
          const ownerUserId = Number(owner?.id || 0);
          const roleByUserId = await getMunicipalityRoleMap(municipality.id);
          row = await getMunicipalityChatMessageRowById(municipality.id, messageId);
          if (!row) {
            console.error('[Chat POST] Nachricht nach Insert nicht gefunden: municipalityId=', municipality.id, 'messageId=', messageId);
            return sendJson(res, 500, { success: false, error: 'Interner Serverfehler', detail: 'Nachricht nach Insert nicht lesbar' });
          }
          const dto = mapChatMessageRowToDto(row, ownerUserId, roleByUserId);

          // WebSocket-Broadcast (optional – Fehler hier soll Response nicht blockieren)
          try {
            io.to(wsRoomKey(municipality.slug, 'MAIN')).emit('chat-message', {
              type: 'created',
              municipality_slug: municipality.slug,
              message: dto,
              serverTimestamp: Date.now(),
            });
          } catch (wsErr) {
            console.error('[Chat POST] WebSocket-Broadcast fehlgeschlagen:', wsErr instanceof Error ? wsErr.message : wsErr);
          }

          return sendJson(res, 200, { success: true, data: { message: dto } });
        } catch (err) {
          console.error('[Chat POST] Nachricht-Fetch/DTO fehlgeschlagen:', err instanceof Error ? err.message : err);
          return sendJson(res, 500, { success: false, error: 'Interner Serverfehler', detail: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    const municipalityChatLogsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/chat\/logs$/i);
    if (municipalityChatLogsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityChatLogsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const owner = await getMunicipalityOwner(municipality.id);
      if (Number(owner?.id || 0) !== Number(authUser.id)) {
        return sendJson(res, 403, { success: false, error: 'Nur Eigentuemer darf Chat-Logs sehen' });
      }
      const limit = Math.min(200, Math.max(1, Number(requestUrl.searchParams.get('limit')) || 100));
      const rows = await listMunicipalityChatLogs(municipality.id, limit);
      const logs = rows.map((row) => ({
        id: Number(row.id),
        message_id: Number(row.message_id),
        user: {
          id: Number(row.user_id),
          name: row.user_name || `User #${Number(row.user_id)}`,
        },
        action: row.action,
        old_content: row.old_content || null,
        new_content: row.new_content || null,
        ip_address: row.ip_address || null,
        created_at: row.created_at,
      }));
      return sendJson(res, 200, { success: true, data: { logs } });
    }

    const municipalityChatMessageMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/chat\/([0-9]+)$/i);
    if (municipalityChatMessageMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityChatMessageMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const messageId = Number(municipalityChatMessageMatch[2]);
      const row = await getMunicipalityChatMessageRowById(municipality.id, messageId);
      if (!row) return sendJson(res, 404, { success: false, error: 'Nachricht nicht gefunden' });
      const owner = await getMunicipalityOwner(municipality.id);
      const requesterRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      const canModerate = Number(owner?.id || 0) === Number(authUser.id) || requesterRole === MUNICIPALITY_ROLE_COUNCIL;
      const isOwnMessage = Number(row.user_id) === Number(authUser.id);
      if (!canModerate && !isOwnMessage) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Nachricht' });
      }

      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const newMessage = String(body.message || '').trim().slice(0, 2000);
        if (!newMessage) return sendJson(res, 422, { success: false, error: 'Nachricht darf nicht leer sein' });
        await updateMunicipalityChatMessage({
          municipalityId: municipality.id,
          messageId,
          userId: authUser.id,
          newMessage,
          ipAddress: req.socket?.remoteAddress || null,
          userAgent: req.headers['user-agent'] || null,
        });
        const updatedRow = await getMunicipalityChatMessageRowById(municipality.id, messageId);
        if (!updatedRow) {
          return sendJson(res, 500, { success: false, error: 'Interner Serverfehler' });
        }
        const ownerUserId = Number(owner?.id || 0);
        const roleByUserId = await getMunicipalityRoleMap(municipality.id);
        const dto = mapChatMessageRowToDto(updatedRow, ownerUserId, roleByUserId);
        io.to(wsRoomKey(municipality.slug, 'MAIN')).emit('chat-message', {
          type: 'edited',
          municipality_slug: municipality.slug,
          message: dto,
          serverTimestamp: Date.now(),
        });
        return sendJson(res, 200, {
          success: true,
          data: {
            message: {
              id: dto.id,
              message: dto.message,
              is_edited: dto.is_edited,
              edited_at: dto.edited_at,
            },
          },
        });
      }

      await softDeleteMunicipalityChatMessage({
        municipalityId: municipality.id,
        messageId,
        userId: authUser.id,
        ipAddress: req.socket?.remoteAddress || null,
        userAgent: req.headers['user-agent'] || null,
      });
      io.to(wsRoomKey(municipality.slug, 'MAIN')).emit('chat-message', {
        type: 'deleted',
        municipality_slug: municipality.slug,
        message_id: messageId,
        serverTimestamp: Date.now(),
      });
      return sendJson(res, 200, { success: true, data: { message: 'Nachricht gelöscht', deleted_id: messageId } });
    }

  };
};
