'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db.js');
const { getBearerToken } = require('../infra/http.js');
const { verifyToken } = require('./tokens.js');
const { normalizeGlobalRole, globalRoleFromUserRank } = require('./permissions.js');
const { sha256 } = require('../shared/helpers.js');
const { TOKEN_TTL_HOURS, GLOBAL_ROLE_USER } = require('../config/constants.js');

function getGameToken(req) {
  const bearer = getBearerToken(req);
  if (bearer) return bearer;
  const raw = req.headers['x-game-token'];
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').trim() || null;
}

async function getAuthenticatedUser(req) {
  ensureDbEnabled();
  const token = getGameToken(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const validSession = await isSessionValid(token);
  if (!validSession) return null;
  const userId = Number(payload.sub);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const user = await getUserByIdWithMunicipality(userId);
  if (!user || !user.is_active || user.is_banned) return null;
  user.global_role = await getUserGlobalRole(userId);
  return user;
}

async function getUserByEmailWithMunicipality(email) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT u.id, u.uuid, u.email, u.nickname, u.is_active, COALESCE(u.is_banned, 0) AS is_banned, u.municipality_id, m.slug AS municipality_slug, m.name AS municipality_name FROM users u LEFT JOIN municipalities m ON m.id = u.municipality_id WHERE u.email = ? LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function getUserByEmailForLogin(email) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT u.id, u.uuid, u.email, u.nickname, u.password_hash, u.password_salt, u.is_active, COALESCE(u.is_banned, 0) AS is_banned, u.municipality_id, m.slug AS municipality_slug, m.name AS municipality_name FROM users u LEFT JOIN municipalities m ON m.id = u.municipality_id WHERE u.email = ? LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function getUserByIdWithMunicipality(id) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT u.id, u.uuid, u.email, u.nickname, u.is_active, COALESCE(u.is_banned, 0) AS is_banned, u.municipality_id, u.referral_code, m.slug AS municipality_slug, m.name AS municipality_name FROM users u LEFT JOIN municipalities m ON m.id = u.municipality_id WHERE u.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function createAuthSession(userId, token, req, ttlHours = TOKEN_TTL_HOURS) {
  ensureDbEnabled();
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
  const ipAddress = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().slice(0, 45);
  const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 255);
  await dbPool.query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)`,
    [userId, tokenHash, expiresAt, ipAddress, userAgent]
  );
}

async function isSessionValid(token) {
  ensureDbEnabled();
  const tokenHash = sha256(token);
  const [rows] = await dbPool.query(
    `SELECT id FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1`,
    [tokenHash]
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function revokeSession(token) {
  ensureDbEnabled();
  const tokenHash = sha256(token);
  const [result] = await dbPool.query(
    `UPDATE auth_sessions SET revoked_at = NOW(), updated_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL`,
    [tokenHash]
  );
  return result.affectedRows || 0;
}

async function revokeAllUserSessions(userId) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return 0;
  const [result] = await dbPool.query(
    `UPDATE auth_sessions SET revoked_at = NOW(), updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL`,
    [safeUserId]
  );
  return result.affectedRows || 0;
}

async function getUserRankValue(userId) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return 0;
  try {
    const [rows] = await dbPool.query(
      `SELECT \`rank\` AS user_rank FROM users WHERE id = ? LIMIT 1`, [safeUserId]
    );
    const rank = Number(rows?.[0]?.user_rank || 0);
    if (Number.isFinite(rank) && rank > 0) return Math.max(0, Math.round(rank));
  } catch (err) {}
  try {
    const [rows] = await dbPool.query(
      `SELECT COALESCE(au.rank, 0) AS user_rank FROM users u LEFT JOIN admin_users au ON LOWER(au.email) = LOWER(u.email) WHERE u.id = ? LIMIT 1`,
      [safeUserId]
    );
    const rank = Number(rows?.[0]?.user_rank || 0);
    return Number.isFinite(rank) ? Math.max(0, Math.round(rank)) : 0;
  } catch { return 0; }
}

async function syncUserGlobalRoleFromRank(userId, fallbackRole = GLOBAL_ROLE_USER) {
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) {
    return { rank: 0, role: normalizeGlobalRole(fallbackRole) };
  }
  const rank = await getUserRankValue(safeUserId);
  const normalizedFallback = normalizeGlobalRole(fallbackRole);
  const role = rank > 0 ? globalRoleFromUserRank(rank) : normalizedFallback;
  await setUserGlobalRole(safeUserId, role);
  return { rank, role };
}

async function getUserGlobalRole(userId) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return GLOBAL_ROLE_USER;
  const synced = await syncUserGlobalRoleFromRank(safeUserId, GLOBAL_ROLE_USER);
  return normalizeGlobalRole(synced.role);
}

async function setUserGlobalRole(userId, role) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return false;
  const normalizedRole = normalizeGlobalRole(role);
  await dbPool.query(
    `INSERT INTO user_global_roles (user_id, role) VALUES (?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = CURRENT_TIMESTAMP`,
    [safeUserId, normalizedRole]
  );
  return true;
}

async function ensureAtLeastOneGlobalAdministrator() {
  ensureDbEnabled();
  const [activeRows] = await dbPool.query(
    `SELECT id FROM users WHERE is_active = 1 ORDER BY id ASC`
  );
  for (const row of Array.isArray(activeRows) ? activeRows : []) {
    const activeUserId = Number(row.id);
    if (!Number.isInteger(activeUserId) || activeUserId <= 0) continue;
    await syncUserGlobalRoleFromRank(activeUserId, GLOBAL_ROLE_USER);
  }
}

module.exports = {
  getGameToken,
  getAuthenticatedUser,
  getUserByEmailWithMunicipality,
  getUserByEmailForLogin,
  getUserByIdWithMunicipality,
  createAuthSession,
  isSessionValid,
  revokeSession,
  revokeAllUserSessions,
  getUserRankValue,
  syncUserGlobalRoleFromRank,
  getUserGlobalRole,
  setUserGlobalRole,
  ensureAtLeastOneGlobalAdministrator,
};
