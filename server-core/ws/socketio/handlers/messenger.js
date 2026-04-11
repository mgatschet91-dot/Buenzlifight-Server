'use strict';

const { logError } = require('../../../infra/logger');
const helpers = require('../helpers');

// Lazy requires to avoid circular dependencies
const lazyRequire = (path) => () => require(path);
const getHelpers = lazyRequire('../../../shared/helpers');

/**
 * Registers messenger-related socket handlers:
 *   messenger-send, messenger-friend-request, messenger-accept-friend,
 *   messenger-deny-friend, messenger-remove-friend, messenger-start-chat,
 *   messenger-load-friends, messenger-load-requests, messenger-search
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {object} context - shared state and connection-level variables
 */
module.exports = function registerMessengerHandlers(socket, io, context) {
  const {
    state,
    rateLimiter,
    wsUserSockets,
  } = context;

  socket.on('messenger-send', async (data = {}) => {
    if (rateLimiter('messenger-send')) return;
    if (!state.socketAuthUserId) return;
    const conversationId = Number(data.conversationId || 0);
    const text = getHelpers().sanitizeText(String(data.text || ''), 2000);
    if (!conversationId || !text) return;
    try {
      const { dbPool } = require('../../../infra/db');
      const [partRows] = await dbPool.query(
        'SELECT id FROM user_messenger_participants WHERE conversation_id = ? AND user_id = ?',
        [conversationId, state.socketAuthUserId]
      );
      if (partRows.length === 0) return;
      const [ins] = await dbPool.query(
        'INSERT INTO user_messenger_messages (conversation_id, sender_id, message) VALUES (?, ?, ?)',
        [conversationId, state.socketAuthUserId, text]
      );
      await dbPool.query(
        'UPDATE user_messenger_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?',
        [conversationId, state.socketAuthUserId]
      );
      const [participants] = await dbPool.query(
        'SELECT user_id FROM user_messenger_participants WHERE conversation_id = ?',
        [conversationId]
      );
      const messagePayload = {
        id: ins.insertId,
        conversationId,
        senderId: state.socketAuthUserId,
        senderName: state.playerName,
        text,
        type: 'text',
        createdAt: new Date().toISOString(),
      };
      for (const p of participants) {
        helpers.wsEmitToUser(io, p.user_id, 'messenger-message', messagePayload, wsUserSockets);
      }
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Senden', { error: err?.message, conversationId, userId: state.socketAuthUserId });
    }
  });

  socket.on('messenger-friend-request', async (data = {}) => {
    if (rateLimiter('messenger-friend-request')) return;
    if (!state.socketAuthUserId) return;
    const receiverId = Number(data.receiverId || 0);
    if (!receiverId || receiverId === state.socketAuthUserId) return;
    try {
      const { dbPool } = require('../../../infra/db');
      const { sanitizeText } = getHelpers();
      const requestMessage = sanitizeText(String(data.message || ''), 255);

      // Prüfe ob Empfänger Freundschaftsanfragen erlaubt
      const [receiverSettings] = await dbPool.query(
        `SELECT JSON_EXTRACT(project_data, '$.allow_friend_requests') AS allow_fr
         FROM users_data WHERE user_id = ?`,
        [receiverId]
      );
      if (receiverSettings.length > 0 && receiverSettings[0].allow_fr !== null && Number(receiverSettings[0].allow_fr) === 0) {
        socket.emit('messenger-error', { error: 'Dieser Spieler akzeptiert keine Freundschaftsanfragen.' });
        return;
      }

      const [existFriend] = await dbPool.query(
        `SELECT id FROM user_friends
         WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) AND status = 'accepted'`,
        [Math.min(state.socketAuthUserId, receiverId), Math.max(state.socketAuthUserId, receiverId),
         Math.min(state.socketAuthUserId, receiverId), Math.max(state.socketAuthUserId, receiverId)]
      );
      if (existFriend.length > 0) return;
      const [existReq] = await dbPool.query(
        `SELECT id FROM user_friend_requests WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'`,
        [state.socketAuthUserId, receiverId]
      );
      if (existReq.length > 0) return;
      await dbPool.query(
        `INSERT INTO user_friend_requests (sender_id, receiver_id, status, message)
         VALUES (?, ?, 'pending', ?)
         ON DUPLICATE KEY UPDATE status = IF(status = 'denied', 'pending', status), message = VALUES(message), updated_at = NOW()`,
        [state.socketAuthUserId, receiverId, requestMessage]
      );
      const [senderRows] = await dbPool.query('SELECT id, nickname, email FROM users WHERE id = ?', [state.socketAuthUserId]);
      const sender = senderRows[0];
      const senderName = sender?.nickname || state.playerName;

      // Persistente Notification in DB (überlebt Offline)
      const { createNotificationForUser } = require('../../../game/notifications');
      await createNotificationForUser(receiverId, null, {
        type: 'friend_request',
        title: 'Freundschaftsanfrage',
        message: `${senderName} möchte dein Freund werden.${requestMessage ? ' "' + requestMessage + '"' : ''}`,
        icon: 'user-plus',
      });

      helpers.wsEmitToUser(io, receiverId, 'messenger-friend-request-received', {
        requestId: 0,
        senderId: state.socketAuthUserId,
        senderName,
        message: requestMessage,
      }, wsUserSockets);
    } catch (err) {
      logError('MESSENGER', 'Fehler bei Freundschaftsanfrage', { error: err?.message });
    }
  });

  socket.on('messenger-accept-friend', async (data = {}) => {
    if (!state.socketAuthUserId) return;
    const senderId = Number(data.senderId || 0);
    if (!senderId) return;
    try {
      const { dbPool } = require('../../../infra/db');
      const [upd] = await dbPool.query(
        `UPDATE user_friend_requests SET status = 'accepted', updated_at = NOW()
         WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'`,
        [senderId, state.socketAuthUserId]
      );
      if (upd.affectedRows === 0) return;
      const uid1 = Math.min(state.socketAuthUserId, senderId);
      const uid2 = Math.max(state.socketAuthUserId, senderId);
      await dbPool.query(
        `INSERT INTO user_friends (user_id, friend_id, status)
         VALUES (?, ?, 'accepted')
         ON DUPLICATE KEY UPDATE status = 'accepted', updated_at = NOW()`,
        [uid1, uid2]
      );
      const [convIns] = await dbPool.query(
        'INSERT INTO user_messenger_conversations (is_group) VALUES (0)'
      );
      const convId = convIns.insertId;
      await dbPool.query(
        'INSERT INTO user_messenger_participants (conversation_id, user_id) VALUES (?, ?), (?, ?)',
        [convId, state.socketAuthUserId, convId, senderId]
      );
      await dbPool.query(
        `INSERT INTO user_messenger_messages (conversation_id, sender_id, message, type)
         VALUES (?, ?, 'Ihr seid jetzt Freunde!', 'system')`,
        [convId, state.socketAuthUserId]
      );
      const [userRows] = await dbPool.query(
        'SELECT id, nickname, is_online FROM users WHERE id IN (?, ?)',
        [state.socketAuthUserId, senderId]
      );
      const userMap = {};
      for (const u of userRows) userMap[u.id] = u;
      helpers.wsEmitToUser(io, senderId, 'messenger-friend-accepted', {
        userId: state.socketAuthUserId,
        userName: userMap[state.socketAuthUserId]?.nickname || state.playerName,
        conversationId: convId,
        online: true,
      }, wsUserSockets);
      helpers.wsEmitToUser(io, state.socketAuthUserId, 'messenger-friend-accepted', {
        userId: senderId,
        userName: userMap[senderId]?.nickname || 'Spieler',
        conversationId: convId,
        online: !!wsUserSockets.has(senderId),
      }, wsUserSockets);
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Annehmen', { error: err?.message });
    }
  });

  socket.on('messenger-deny-friend', async (data = {}) => {
    if (!state.socketAuthUserId) return;
    const senderId = Number(data.senderId || 0);
    if (!senderId) return;
    try {
      const { dbPool } = require('../../../infra/db');
      await dbPool.query(
        `UPDATE user_friend_requests SET status = 'denied', updated_at = NOW()
         WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'`,
        [senderId, state.socketAuthUserId]
      );
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Ablehnen', { error: err?.message });
    }
  });

  socket.on('messenger-remove-friend', async (data = {}) => {
    if (!state.socketAuthUserId) return;
    const friendId = Number(data.friendId || 0);
    if (!friendId) return;
    try {
      const { dbPool } = require('../../../infra/db');
      const uid1 = Math.min(state.socketAuthUserId, friendId);
      const uid2 = Math.max(state.socketAuthUserId, friendId);
      await dbPool.query('DELETE FROM user_friends WHERE user_id = ? AND friend_id = ?', [uid1, uid2]);
      helpers.wsEmitToUser(io, friendId, 'messenger-friend-removed', { userId: state.socketAuthUserId }, wsUserSockets);
      helpers.wsEmitToUser(io, state.socketAuthUserId, 'messenger-friend-removed', { userId: friendId }, wsUserSockets);
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Entfernen', { error: err?.message });
    }
  });

  socket.on('messenger-start-chat', async (data = {}) => {
    if (!state.socketAuthUserId) return;
    const friendId = Number(data.friendId || 0);
    if (!friendId) return;
    try {
      const { dbPool } = require('../../../infra/db');
      const [convRows] = await dbPool.query(
        `SELECT p1.conversation_id FROM user_messenger_participants p1
         INNER JOIN user_messenger_participants p2 ON p1.conversation_id = p2.conversation_id
         INNER JOIN user_messenger_conversations c ON c.id = p1.conversation_id AND c.is_group = 0
         WHERE p1.user_id = ? AND p2.user_id = ?
         LIMIT 1`,
        [state.socketAuthUserId, friendId]
      );
      let conversationId;
      if (convRows.length > 0) {
        conversationId = convRows[0].conversation_id;
      } else {
        const [convIns] = await dbPool.query('INSERT INTO user_messenger_conversations (is_group) VALUES (0)');
        conversationId = convIns.insertId;
        await dbPool.query(
          'INSERT INTO user_messenger_participants (conversation_id, user_id) VALUES (?, ?), (?, ?)',
          [conversationId, state.socketAuthUserId, conversationId, friendId]
        );
      }
      const [messages] = await dbPool.query(
        `SELECT m.id, m.sender_id AS senderId, u.nickname AS senderName, m.message AS text, m.type, m.created_at AS createdAt
         FROM user_messenger_messages m
         LEFT JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = ? AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC LIMIT 50`,
        [conversationId]
      );
      const [friendRow] = await dbPool.query('SELECT id, nickname, is_online FROM users WHERE id = ?', [friendId]);
      socket.emit('messenger-chat-opened', {
        conversationId,
        friendId,
        friendName: friendRow[0]?.nickname || 'Spieler',
        friendOnline: !!friendRow[0]?.is_online,
        messages: messages.reverse(),
      });
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Chat-Start', { error: err?.message });
    }
  });

  socket.on('messenger-load-friends', async () => {
    if (!state.socketAuthUserId) return;
    try {
      const { dbPool } = require('../../../infra/db');
      const { toJsonValue } = getHelpers();
      const [friends] = await dbPool.query(
        `SELECT u.id, u.nickname, u.is_online, ud.avatar_config,
                CASE WHEN uf.user_id = ? THEN uf.friend_id ELSE uf.user_id END AS friend_id
         FROM user_friends uf
         INNER JOIN users u ON u.id = CASE WHEN uf.user_id = ? THEN uf.friend_id ELSE uf.user_id END
         LEFT JOIN users_data ud ON ud.user_id = u.id
         WHERE (uf.user_id = ? OR uf.friend_id = ?) AND uf.status = 'accepted'
         ORDER BY u.is_online DESC, u.nickname ASC`,
        [state.socketAuthUserId, state.socketAuthUserId, state.socketAuthUserId, state.socketAuthUserId]
      );
      const friendsWithConv = [];
      for (const f of friends) {
        const [convRow] = await dbPool.query(
          `SELECT p1.conversation_id FROM user_messenger_participants p1
           INNER JOIN user_messenger_participants p2 ON p1.conversation_id = p2.conversation_id
           INNER JOIN user_messenger_conversations c ON c.id = p1.conversation_id AND c.is_group = 0
           WHERE p1.user_id = ? AND p2.user_id = ? LIMIT 1`,
          [state.socketAuthUserId, f.id]
        );
        const ac = toJsonValue(f.avatar_config || null);
        friendsWithConv.push({
          id: f.id,
          name: f.nickname,
          online: !!f.is_online,
          figure: (ac && typeof ac === 'object' && ac.figure) ? String(ac.figure) : null,
          conversationId: convRow[0]?.conversation_id || null,
        });
      }
      socket.emit('messenger-friends-list', { friends: friendsWithConv });
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Laden der Freunde', { error: err?.message });
    }
  });

  socket.on('messenger-load-requests', async () => {
    if (!state.socketAuthUserId) return;
    try {
      const { dbPool } = require('../../../infra/db');
      const { toJsonValue } = getHelpers();
      const [requests] = await dbPool.query(
        `SELECT fr.id, fr.sender_id AS senderId, u.nickname AS senderName, fr.message, fr.created_at AS createdAt,
                ud.avatar_config
         FROM user_friend_requests fr
         INNER JOIN users u ON u.id = fr.sender_id
         LEFT JOIN users_data ud ON ud.user_id = u.id
         WHERE fr.receiver_id = ? AND fr.status = 'pending'
         ORDER BY fr.created_at DESC`,
        [state.socketAuthUserId]
      );
      const requestsWithFigure = requests.map(r => {
        const ac = toJsonValue(r.avatar_config || null);
        return {
          id: r.id,
          senderId: r.senderId,
          senderName: r.senderName,
          message: r.message,
          createdAt: r.createdAt,
          figure: (ac && typeof ac === 'object' && ac.figure) ? String(ac.figure) : null,
        };
      });
      socket.emit('messenger-requests-list', { requests: requestsWithFigure });
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Laden der Anfragen', { error: err?.message });
    }
  });

  socket.on('messenger-search', async (data = {}) => {
    if (!state.socketAuthUserId) return;
    const query = String(data.query || '').trim().slice(0, 50);
    if (query.length < 2) { socket.emit('messenger-search-results', { results: [] }); return; }
    try {
      const { dbPool } = require('../../../infra/db');
      const [results] = await dbPool.query(
        `SELECT u.id, u.nickname
         FROM users u
         LEFT JOIN users_data ud ON ud.user_id = u.id
         WHERE u.nickname LIKE ? AND u.id != ? AND u.is_active = 1
           AND COALESCE(JSON_EXTRACT(ud.project_data, '$.profile_searchable'), 1) != 0
         ORDER BY u.nickname ASC LIMIT 20`,
        [`%${getHelpers().escapeLike(query)}%`, state.socketAuthUserId]
      );
      socket.emit('messenger-search-results', {
        results: results.map(r => ({
          id: r.id,
          name: r.nickname,
        }))
      });
    } catch (err) {
      logError('MESSENGER', 'Fehler bei Suche', { error: err?.message });
    }
  });
};
