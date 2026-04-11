'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { pushDiscordEvent } = require('../shared/discord');

async function createUserNotification(userId, notificationType, title, message, payload) {
  ensureDbEnabled();
  if (!userId) return;
  await dbPool.query(
    `INSERT INTO user_notifications (user_id, notification_type, title, message, payload, is_read)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [userId, notificationType, title, message, payload ? JSON.stringify(payload) : null]
  );
  pushDiscordEvent(notificationType, { title, message, payload, userId });
}

async function createNotificationForAllMembers(municipalityId, { type, title, message, icon, amount }) {
  ensureDbEnabled();
  if (!dbPool || !municipalityId) return;
  try {
    const [members] = await dbPool.query(
      `SELECT user_id FROM municipality_memberships WHERE municipality_id = ?`,
      [municipalityId]
    );
    if (!members || members.length === 0) return;
    const values = members.map((m) => [
      m.user_id,
      municipalityId,
      type || 'info',
      title,
      message,
      icon || 'info',
      amount ?? null,
    ]);
    await dbPool.query(
      `INSERT INTO user_notifications (user_id, municipality_id, notification_type, title, message, icon, amount) VALUES ?`,
      [values]
    );
  } catch (err) {
    console.error('[Notifications] Fehler beim Erstellen:', err.message);
  }
}

async function createNotificationForUser(userId, municipalityId, { type, title, message, icon, amount }) {
  ensureDbEnabled();
  if (!dbPool || !userId) return;
  try {
    await dbPool.query(
      `INSERT INTO user_notifications (user_id, municipality_id, notification_type, title, message, icon, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, municipalityId ?? null, type || 'info', title, message, icon || 'info', amount ?? null]
    );
  } catch (err) {
    console.error('[Notifications] Fehler beim Erstellen:', err.message);
  }
}

module.exports = {
  createUserNotification,
  createNotificationForAllMembers,
  createNotificationForUser,
};
