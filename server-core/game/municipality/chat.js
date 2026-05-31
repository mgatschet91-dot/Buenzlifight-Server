'use strict';

const { dbPool, ensureDbEnabled } = require('../../infra/db');
const { MUNICIPALITY_ROLE_COUNCIL } = require('../../config/constants');
const { normalizeMunicipalityRole } = require('../../auth/permissions');
const { toJsonValue, normalizeInventoryItemCode, normalizeInventoryQuantity } = require('../../shared/helpers');

// ── Chat DTO ──────────────────────────────────────────────────────

function mapChatMessageRowToDto(row, ownerUserId, roleByUserId = null) {
  const userId = Number(row.user_id);
  const mappedRole = roleByUserId instanceof Map ? normalizeMunicipalityRole(roleByUserId.get(userId)) : null;
  const userRole = userId === Number(ownerUserId) ? 'owner' : mappedRole === MUNICIPALITY_ROLE_COUNCIL ? 'admin' : 'member';
  return {
    id: Number(row.id),
    user: { id: userId, name: row.user_name || `User #${userId}`, avatar_config: null, role: userRole, is_municipality_owner: userId === Number(ownerUserId) },
    message: String(row.message || ''),
    type: ['text', 'system', 'announcement'].includes(String(row.type || 'text')) ? String(row.type || 'text') : 'text',
    reply_to: row.reply_to_id ? { id: Number(row.reply_to_id), message: String(row.reply_to_message || '') } : null,
    is_edited: Boolean(row.is_edited),
    created_at: row.created_at,
    edited_at: row.edited_at || null,
  };
}

// No-ops (Schema via SQL-Migrationen)
async function ensureMunicipalityChatTables() {}
async function ensureUsersDataTable() {}
async function ensureUserInventoryTable() {}

// ── Avatar ────────────────────────────────────────────────────────

async function getUserAvatarConfig(userId) {
  ensureDbEnabled();
  const { wsSanitizeAvatarConfig } = require('../../ws/socketio/helpers');
  const [rows] = await dbPool.query(`SELECT avatar_config FROM users_data WHERE user_id = ? LIMIT 1`, [Number(userId)]);
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  return wsSanitizeAvatarConfig(toJsonValue(row?.avatar_config || null) || {});
}

async function upsertUserAvatarConfig(userId, avatarConfig) {
  ensureDbEnabled();
  const { wsSanitizeAvatarConfig } = require('../../ws/socketio/helpers');
  const existing = await getUserAvatarConfig(userId);
  const incoming = avatarConfig && typeof avatarConfig === 'object' ? avatarConfig : {};
  const merged = { ...existing, ...incoming };
  if (incoming.figure == null || String(incoming.figure || '').trim() === '') merged.figure = existing.figure;
  const sanitized = wsSanitizeAvatarConfig(merged);
  await dbPool.query(
    `INSERT INTO users_data (user_id, avatar_config, project_data) VALUES (?, ?, NULL)
     ON DUPLICATE KEY UPDATE avatar_config = VALUES(avatar_config), updated_at = CURRENT_TIMESTAMP`,
    [Number(userId), JSON.stringify(sanitized)]
  );
  return sanitized;
}

// ── Inventory ─────────────────────────────────────────────────────

async function upsertUserInventoryItem(userId, itemCode, quantity, metadata = null) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  const normalizedCode = normalizeInventoryItemCode(itemCode);
  const normalizedQty = normalizeInventoryQuantity(quantity);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0 || !normalizedCode) return null;

  if (normalizedQty <= 0) {
    await dbPool.query(`DELETE FROM user_inventory WHERE user_id = ? AND item_code = ?`, [safeUserId, normalizedCode]);
    return { item_code: normalizedCode, quantity: 0, metadata: null, removed: true };
  }

  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : null;
  await dbPool.query(
    `INSERT INTO user_inventory (user_id, item_code, quantity, metadata) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE quantity = VALUES(quantity), metadata = VALUES(metadata), updated_at = CURRENT_TIMESTAMP`,
    [safeUserId, normalizedCode, normalizedQty, safeMetadata ? JSON.stringify(safeMetadata) : null]
  );
  return { item_code: normalizedCode, quantity: normalizedQty, metadata: safeMetadata, removed: false };
}

async function adjustUserInventoryItem(userId, itemCode, delta, metadata = null) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  const normalizedCode = normalizeInventoryItemCode(itemCode);
  const normalizedDelta = Math.round(Number(delta || 0));
  if (!Number.isInteger(safeUserId) || safeUserId <= 0 || !normalizedCode || !Number.isFinite(normalizedDelta)) return null;

  const [rows] = await dbPool.query(`SELECT quantity, metadata FROM user_inventory WHERE user_id = ? AND item_code = ? LIMIT 1`, [safeUserId, normalizedCode]);
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  const nextQty = Math.max(0, normalizeInventoryQuantity(row?.quantity || 0) + normalizedDelta);

  let nextMetadata = toJsonValue(row?.metadata);
  if (metadata && typeof metadata === 'object') nextMetadata = { ...(nextMetadata && typeof nextMetadata === 'object' ? nextMetadata : {}), ...metadata };

  return upsertUserInventoryItem(safeUserId, normalizedCode, nextQty, nextMetadata);
}

// ── Chat Messages CRUD ────────────────────────────────────────────

async function getMunicipalityChatMessageRowById(municipalityId, messageId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT m.id, m.municipality_id, m.user_id, m.message, m.type, m.reply_to_id, m.is_edited, m.created_at, m.edited_at,
            u.nickname AS user_name, r.message AS reply_to_message
     FROM municipality_chat_messages m
     INNER JOIN users u ON u.id = m.user_id
     LEFT JOIN municipality_chat_messages r ON r.id = m.reply_to_id
     WHERE m.municipality_id = ? AND m.id = ? LIMIT 1`,
    [municipalityId, messageId]
  );
  return rows[0] || null;
}

async function listMunicipalityChatMessages(municipalityId, { limit = 10, before = null, after = null } = {}) {
  ensureDbEnabled();
  const safeLimit = Math.max(1, Math.min(50, Math.round(Number(limit || 50))));
  const where = ['m.municipality_id = ?', 'm.created_at >= DATE_SUB(NOW(), INTERVAL 2 DAY)', 'm.deleted_at IS NULL'];
  const args = [municipalityId];
  let orderBy = 'm.id DESC';
  if (Number.isFinite(Number(before)) && Number(before) > 0) { where.push('m.id < ?'); args.push(Number(before)); }
  if (Number.isFinite(Number(after)) && Number(after) > 0) { where.push('m.id > ?'); args.push(Number(after)); orderBy = 'm.id ASC'; }
  args.push(safeLimit + 1);
  const [rows] = await dbPool.query(
    `SELECT m.id, m.user_id, m.message, m.type, m.reply_to_id, m.is_edited, m.created_at, m.edited_at,
            u.nickname AS user_name, r.message AS reply_to_message
     FROM municipality_chat_messages m
     INNER JOIN users u ON u.id = m.user_id
     LEFT JOIN municipality_chat_messages r ON r.id = m.reply_to_id
     WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`,
    args
  );
  const list = Array.isArray(rows) ? rows : [];
  const hasMore = list.length > safeLimit;
  return { rows: hasMore ? list.slice(0, safeLimit) : list, hasMore };
}

async function createMunicipalityChatMessage({ municipalityId, userId, message, replyToId = null, ipAddress = null, userAgent = null }) {
  ensureDbEnabled();
  let resolvedReplyTo = null;
  if (Number.isFinite(Number(replyToId)) && Number(replyToId) > 0) {
    const [replyRows] = await dbPool.query(`SELECT id FROM municipality_chat_messages WHERE municipality_id = ? AND id = ? LIMIT 1`, [municipalityId, Number(replyToId)]);
    if (Array.isArray(replyRows) && replyRows.length > 0) resolvedReplyTo = Number(replyToId);
  }
  const [result] = await dbPool.query(
    `INSERT INTO municipality_chat_messages (municipality_id, user_id, message, type, reply_to_id, is_edited, edited_at) VALUES (?, ?, ?, 'text', ?, 0, NULL)`,
    [municipalityId, userId, String(message || '').slice(0, 4000), resolvedReplyTo]
  );
  const messageId = Number(result.insertId || 0);
  if (messageId > 0) {
    await dbPool.query(
      `INSERT INTO municipality_chat_logs (message_id, user_id, action, old_content, new_content, ip_address, user_agent, metadata) VALUES (?, ?, 'created', NULL, ?, ?, ?, NULL)`,
      [messageId, userId, String(message || '').slice(0, 4000), ipAddress, userAgent ? String(userAgent).slice(0, 1000) : null]
    );
  }
  return messageId;
}

async function updateMunicipalityChatMessage({ municipalityId, messageId, userId, newMessage, ipAddress = null, userAgent = null }) {
  ensureDbEnabled();
  const prev = await getMunicipalityChatMessageRowById(municipalityId, messageId);
  if (!prev) return { updated: 0, previous: null };
  await dbPool.query(`UPDATE municipality_chat_messages SET message = ?, is_edited = 1, edited_at = NOW(), updated_at = CURRENT_TIMESTAMP WHERE municipality_id = ? AND id = ? AND deleted_at IS NULL`, [String(newMessage || '').slice(0, 4000), municipalityId, messageId]);
  await dbPool.query(`INSERT INTO municipality_chat_logs (message_id, user_id, action, old_content, new_content, ip_address, user_agent, metadata) VALUES (?, ?, 'edited', ?, ?, ?, ?, NULL)`, [messageId, userId, String(prev.message || ''), String(newMessage || '').slice(0, 4000), ipAddress, userAgent ? String(userAgent).slice(0, 1000) : null]);
  return { updated: 1, previous: prev };
}

async function softDeleteMunicipalityChatMessage({ municipalityId, messageId, userId, ipAddress = null, userAgent = null }) {
  ensureDbEnabled();
  const prev = await getMunicipalityChatMessageRowById(municipalityId, messageId);
  if (!prev) return { deleted: 0, previous: null };
  await dbPool.query(`INSERT INTO municipality_chat_logs (message_id, user_id, action, old_content, new_content, ip_address, user_agent, metadata) VALUES (?, ?, 'deleted', ?, NULL, ?, ?, NULL)`, [messageId, userId, String(prev.message || ''), ipAddress, userAgent ? String(userAgent).slice(0, 1000) : null]);
  await dbPool.query(`DELETE FROM municipality_chat_messages WHERE municipality_id = ? AND id = ?`, [municipalityId, messageId]);
  return { deleted: 1, previous: prev };
}

async function listMunicipalityChatLogs(municipalityId, limit = 100) {
  ensureDbEnabled();
  const safeLimit = Math.max(1, Math.min(500, Math.round(Number(limit || 100))));
  const [rows] = await dbPool.query(
    `SELECT l.id, l.message_id, l.user_id, l.action, l.old_content, l.new_content, l.ip_address, l.created_at, u.nickname AS user_name
     FROM municipality_chat_logs l
     INNER JOIN municipality_chat_messages m ON m.id = l.message_id
     INNER JOIN users u ON u.id = l.user_id
     WHERE m.municipality_id = ? ORDER BY l.id DESC LIMIT ?`,
    [municipalityId, safeLimit]
  );
  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  mapChatMessageRowToDto,
  ensureMunicipalityChatTables, ensureUsersDataTable, ensureUserInventoryTable,
  getUserAvatarConfig, upsertUserAvatarConfig,
  upsertUserInventoryItem, adjustUserInventoryItem,
  getMunicipalityChatMessageRowById, listMunicipalityChatMessages,
  createMunicipalityChatMessage, updateMunicipalityChatMessage,
  softDeleteMunicipalityChatMessage, listMunicipalityChatLogs,
};
