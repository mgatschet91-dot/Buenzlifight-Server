'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

module.exports = function registerRoomModerationRoutes(deps) {
  return async function handleRoomModeration(req, res, pathname) {

    // POST /api/game/user/room/kick
    // Spieler aus dem Raum werfen (kein Ban)
    if (pathname === '/api/game/user/room/kick' && req.method === 'POST') {
      ensureDbEnabled();
      const owner = await getAuthenticatedUser(req);
      if (!owner) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const body = await readJsonBody(req);
      const targetUserId = parseInt(body.target_user_id, 10);
      if (!targetUserId || targetUserId === owner.id) {
        return sendJson(res, 422, { ok: false, error: 'Ungültige target_user_id' });
      }

      _kickUser(deps, owner.id, targetUserId, 'Du wurdest aus dem Raum geworfen.');
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/game/user/room/ban
    // Spieler bannen + sofort kicken
    if (pathname === '/api/game/user/room/ban' && req.method === 'POST') {
      ensureDbEnabled();
      const owner = await getAuthenticatedUser(req);
      if (!owner) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const body = await readJsonBody(req);
      const targetUserId = parseInt(body.target_user_id, 10);
      const reason = (body.reason || '').toString().slice(0, 255).trim() || null;
      if (!targetUserId || targetUserId === owner.id) {
        return sendJson(res, 422, { ok: false, error: 'Ungültige target_user_id' });
      }

      await dbPool.query(
        `INSERT INTO room_bans (owner_user_id, banned_user_id, reason)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE reason = VALUES(reason), created_at = NOW()`,
        [owner.id, targetUserId, reason]
      );

      _kickUser(deps, owner.id, targetUserId, 'Du wurdest von diesem Raum verbannt.');
      return sendJson(res, 200, { ok: true });
    }

    // DELETE /api/game/user/room/ban/:targetUserId
    // Ban aufheben
    const unbanMatch = pathname.match(/^\/api\/game\/user\/room\/ban\/(\d+)$/);
    if (unbanMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const owner = await getAuthenticatedUser(req);
      if (!owner) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const targetUserId = parseInt(unbanMatch[1], 10);
      await dbPool.query(
        `DELETE FROM room_bans WHERE owner_user_id = ? AND banned_user_id = ?`,
        [owner.id, targetUserId]
      );
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/game/user/room/bans
    // Eigene Ban-Liste
    if (pathname === '/api/game/user/room/bans' && req.method === 'GET') {
      ensureDbEnabled();
      const owner = await getAuthenticatedUser(req);
      if (!owner) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const [rows] = await dbPool.query(
        `SELECT rb.banned_user_id, u.nickname, rb.reason, rb.created_at
         FROM room_bans rb
         JOIN users u ON u.id = rb.banned_user_id
         WHERE rb.owner_user_id = ?
         ORDER BY rb.created_at DESC`,
        [owner.id]
      );
      return sendJson(res, 200, { ok: true, data: { bans: rows } });
    }
  };
};

// Hilfsfunktion: Ziel-Socket finden + room-kicked senden + aus dem Raum entfernen
function _kickUser(deps, ownerUserId, targetUserId, message) {
  try {
    const { wsUserSockets, wsRoomPlayers, wsRoomMetadata, wsRoomAvatars } = require('../../../ws/socketio/index');
    const io = deps?.io;
    if (!io) return;

    const sockets = wsUserSockets.get(targetUserId);
    if (!sockets) return;

    // Raum des Besitzers finden
    let targetRoomKey = null;
    for (const [rk, meta] of wsRoomMetadata.entries()) {
      if (meta.ownerUserId === ownerUserId) { targetRoomKey = rk; break; }
    }

    for (const sid of sockets) {
      const sock = io.sockets?.sockets?.get(sid);
      if (!sock) continue;

      // Nur kicken wenn der Spieler wirklich in diesem Raum ist
      if (targetRoomKey) {
        const inRoom = wsRoomPlayers.get(targetRoomKey)?.values()
          ? [...wsRoomPlayers.get(targetRoomKey).values()].some(p => p.socketId === sid)
          : false;
        if (!inRoom) continue;

        // Aus Player-Map entfernen
        const players = wsRoomPlayers.get(targetRoomKey);
        if (players) {
          for (const [pid, pdata] of players.entries()) {
            if (pdata.socketId === sid) {
              players.delete(pid);
              io.to(targetRoomKey).emit('player-left', { playerId: pid });
              const avatars = wsRoomAvatars.get(targetRoomKey);
              if (avatars?.has(pid)) {
                avatars.delete(pid);
                io.to(targetRoomKey).emit('avatar-removed', { avatarId: pid });
              }
              break;
            }
          }
        }
      }

      sock.emit('room-kicked', { message });
    }
  } catch (_e) {
    // non-critical
  }
}
