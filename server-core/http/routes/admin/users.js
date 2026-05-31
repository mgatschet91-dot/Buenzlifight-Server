'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { escapeLike } = require('../../../shared/helpers');
const { XP_LEVEL_CAP } = require('../../../config/constants');

async function _requireAdmin(req, res) {
  ensureDbEnabled();
  const authUser = await getAuthenticatedUser(req);
  if (!authUser) { sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' }); return null; }
  if (authUser.global_role !== 'administrator') { sendJson(res, 403, { ok: false, error: 'Nur Admins' }); return null; }
  return authUser;
}

module.exports = function createUsersHandler() {
  return async function handleAdminUsers(req, res, pathname, requestUrl) {

    // GET /api/admin/users
    if (req.method === 'GET' && pathname === '/api/admin/users') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const search = requestUrl.searchParams.get('q') || '';
      const limit = Math.min(Number(requestUrl.searchParams.get('limit') || 50), 200);
      let query = `SELECT u.id, u.nickname, u.email, u.municipality_id, u.created_at,
                          COALESCE(u.is_banned, 0) AS is_banned,
                          COALESCE(ux.level, 1) AS level, COALESCE(ux.total_xp, 0) AS xp,
                          m.name AS municipality_name
                   FROM users u
                   LEFT JOIN user_xp ux ON ux.user_id = u.id
                   LEFT JOIN municipalities m ON m.id = u.municipality_id`;
      const params = [];
      if (search) {
        query += ` WHERE u.nickname LIKE ? OR u.email LIKE ?`;
        const escaped = escapeLike(search);
        params.push(`%${escaped}%`, `%${escaped}%`);
      }
      query += ` ORDER BY u.id DESC LIMIT ?`;
      params.push(limit);
      const [rows] = await dbPool.query(query, params);
      return sendJson(res, 200, { ok: true, data: { users: rows } });
    }

    // POST /api/admin/users/:id/ban
    const adminBanMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/ban$/i);
    if (adminBanMatch && req.method === 'POST') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const userId = Number(adminBanMatch[1]);
      if (userId === authUser.id) return sendJson(res, 400, { ok: false, error: 'Du kannst dich nicht selbst bannen' });
      await dbPool.query(`UPDATE users SET is_banned = 1, updated_at = NOW() WHERE id = ?`, [userId]);
      await dbPool.query(`UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL`, [userId]);
      return sendJson(res, 200, { ok: true, data: { banned: true } });
    }

    // POST /api/admin/users/:id/unban
    const adminUnbanMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/unban$/i);
    if (adminUnbanMatch && req.method === 'POST') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const userId = Number(adminUnbanMatch[1]);
      await dbPool.query(`UPDATE users SET is_banned = 0, updated_at = NOW() WHERE id = ?`, [userId]);
      return sendJson(res, 200, { ok: true, data: { unbanned: true } });
    }

    // POST /api/admin/users/:id/municipality
    const adminChangeMuniMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/municipality$/i);
    if (adminChangeMuniMatch && req.method === 'POST') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const userId = Number(adminChangeMuniMatch[1]);
      const body = await readJsonBody(req);
      const newMunicipalityId = body.municipality_id !== undefined ? (body.municipality_id === null ? null : Number(body.municipality_id)) : undefined;
      if (newMunicipalityId === undefined) return sendJson(res, 400, { ok: false, error: 'municipality_id erforderlich' });
      if (newMunicipalityId !== null) {
        const [[muni]] = await dbPool.query(`SELECT id, name FROM municipalities WHERE id = ?`, [newMunicipalityId]);
        if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      }
      const oldMuniId = await (async () => { const [[u]] = await dbPool.query(`SELECT municipality_id FROM users WHERE id = ?`, [userId]); return u ? u.municipality_id : null; })();
      await dbPool.query(`UPDATE users SET municipality_id = ?, updated_at = NOW() WHERE id = ?`, [newMunicipalityId, userId]);
      if (oldMuniId && oldMuniId !== newMunicipalityId) await dbPool.query(`DELETE FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`, [oldMuniId, userId]);
      if (newMunicipalityId) await dbPool.query(`INSERT IGNORE INTO municipality_memberships (municipality_id, user_id, role, joined_at, created_at) VALUES (?, ?, 'citizen', NOW(), NOW())`, [newMunicipalityId, userId]);
      return sendJson(res, 200, { ok: true, data: { updated: true, municipality_id: newMunicipalityId } });
    }

    // GET /api/admin/users/:id/detail
    const adminUserDetailMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/detail$/i);
    if (adminUserDetailMatch && req.method === 'GET') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const userId = Number(adminUserDetailMatch[1]);
      const [[user]] = await dbPool.query(
        `SELECT u.id, u.nickname, u.email, u.municipality_id, COALESCE(u.is_banned,0) AS is_banned,
                COALESCE(ux.level,1) AS level, COALESCE(ux.total_xp,0) AS xp,
                m.name AS municipality_name, m.slug AS municipality_slug
         FROM users u
         LEFT JOIN user_xp ux ON ux.user_id = u.id
         LEFT JOIN municipalities m ON m.id = u.municipality_id
         WHERE u.id = ?`, [userId]);
      if (!user) return sendJson(res, 404, { ok: false, error: 'User nicht gefunden' });
      const [[bank]] = await dbPool.query(`SELECT balance FROM user_bank_accounts WHERE user_id = ? LIMIT 1`, [userId]);
      let treasury = null, debt = null, population = null;
      if (user.municipality_id) {
        const [[ms]] = await dbPool.query(`SELECT treasury, debt, population FROM municipality_stats WHERE municipality_id = ?`, [user.municipality_id]);
        if (ms) { treasury = Number(ms.treasury); debt = Number(ms.debt); population = Number(ms.population); }
      }
      return sendJson(res, 200, { ok: true, data: { ...user, balance: bank ? Number(bank.balance) : null, treasury, debt, population } });
    }

    // POST /api/admin/users/:id/give-money
    const adminGiveMoneyMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/give-money$/i);
    if (adminGiveMoneyMatch && req.method === 'POST') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const userId = Number(adminGiveMoneyMatch[1]);
      const body = await readJsonBody(req);
      const amount = Math.round(Number(body.amount || 0) * 100) / 100;
      if (!amount || amount === 0) return sendJson(res, 422, { ok: false, error: 'amount erforderlich (kann negativ sein)' });
      const [[acc]] = await dbPool.query(`SELECT id, balance FROM user_bank_accounts WHERE user_id = ? LIMIT 1 FOR UPDATE`, [userId]);
      if (!acc) return sendJson(res, 404, { ok: false, error: 'Kein Bankkonto gefunden' });
      const newBalance = Math.round((Number(acc.balance) + amount) * 100) / 100;
      await dbPool.query(`UPDATE user_bank_accounts SET balance = ?, updated_at = NOW() WHERE id = ?`, [newBalance, acc.id]);
      await dbPool.query(
        `INSERT INTO bank_transactions (account_id, direction, type, amount, balance_after, reference, description, meta_json)
         VALUES (?, ?, 'admin_gift', ?, ?, NULL, ?, NULL)`,
        [acc.id, amount >= 0 ? 'credit' : 'debit', Math.abs(amount), newBalance, `Admin ${amount >= 0 ? '+' : ''}${amount} CHF`]
      );
      return sendJson(res, 200, { ok: true, data: { balance: newBalance } });
    }

    // POST /api/admin/users/:id/give-treasury
    const adminGiveTreasuryMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/give-treasury$/i);
    if (adminGiveTreasuryMatch && req.method === 'POST') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const userId = Number(adminGiveTreasuryMatch[1]);
      const body = await readJsonBody(req);
      const amount = Math.round(Number(body.amount || 0) * 100) / 100;
      if (!amount || amount === 0) return sendJson(res, 422, { ok: false, error: 'amount erforderlich (kann negativ sein)' });
      const [[user]] = await dbPool.query(`SELECT municipality_id FROM users WHERE id = ?`, [userId]);
      if (!user?.municipality_id) return sendJson(res, 400, { ok: false, error: 'User hat keine Gemeinde' });
      const muniId = user.municipality_id;
      const [[ms]] = await dbPool.query(`SELECT treasury, debt FROM municipality_stats WHERE municipality_id = ? FOR UPDATE`, [muniId]);
      if (!ms) return sendJson(res, 404, { ok: false, error: 'Gemeinde-Stats nicht gefunden' });
      const newTreasury = Math.round((Number(ms.treasury) + amount) * 100) / 100;
      const newDebt = amount < 0 && newTreasury < 0
        ? Math.round((Number(ms.debt) + Math.abs(newTreasury)) * 100) / 100
        : Number(ms.debt);
      const safeTreasury = Math.max(0, newTreasury);
      await dbPool.query(`UPDATE municipality_stats SET treasury = ?, debt = ?, updated_at = NOW() WHERE municipality_id = ?`, [safeTreasury, newDebt, muniId]);
      await dbPool.query(
        `INSERT INTO municipality_ledger (municipality_id, type, amount, balance_after, debt_after, meta_json, actor_user_id, source)
         VALUES (?, 'admin_gift', ?, ?, ?, ?, ?, 'admin')`,
        [muniId, amount, safeTreasury, newDebt, JSON.stringify({ admin_id: authUser.id }), authUser.id]
      );
      return sendJson(res, 200, { ok: true, data: { treasury: safeTreasury, debt: newDebt } });
    }

    // POST /api/admin/users/:id/set-xp
    const adminSetXpMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/set-xp$/i);
    if (adminSetXpMatch && req.method === 'POST') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const userId = Number(adminSetXpMatch[1]);
      const body = await readJsonBody(req);
      const xp = Math.max(0, Math.round(Number(body.xp || 0)));
      const level = Math.min(Math.floor(Math.sqrt(xp / 100)) + 1, XP_LEVEL_CAP);
      await dbPool.query(
        `INSERT INTO user_xp (user_id, total_xp, level) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE total_xp = VALUES(total_xp), level = VALUES(level)`,
        [userId, xp, level]
      );
      return sendJson(res, 200, { ok: true, data: { xp, level } });
    }

    // GET /api/admin/users/:id/badges
    const adminUserBadgesMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/badges$/i);
    if (adminUserBadgesMatch && req.method === 'GET') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const userId = Number(adminUserBadgesMatch[1]);
      const [rows] = await dbPool.query(
        `SELECT ub.badge_code AS code, b.name, b.description, COALESCE(b.image_url, '') AS image_url, b.rarity, b.category, ub.acquired_at
         FROM user_badges ub
         LEFT JOIN badges b ON b.code = ub.badge_code
         WHERE ub.user_id = ?
         ORDER BY b.rarity DESC, ub.acquired_at DESC`,
        [userId]
      );
      return sendJson(res, 200, { ok: true, data: { badges: rows } });
    }

    // POST /api/admin/users/:id/badges
    if (adminUserBadgesMatch && req.method === 'POST') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const userId = Number(adminUserBadgesMatch[1]);
      const body = await readJsonBody(req);
      const code = (body.badge_code || '').toString().trim().toUpperCase();
      if (!code) return sendJson(res, 422, { ok: false, error: 'badge_code erforderlich' });
      await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, ?)`, [userId, code]);
      return sendJson(res, 200, { ok: true });
    }

    // DELETE /api/admin/users/:id/badges/:code
    const adminUserBadgeRevokeMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/badges\/([A-Z0-9_]+)$/i);
    if (adminUserBadgeRevokeMatch && req.method === 'DELETE') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const userId = Number(adminUserBadgeRevokeMatch[1]);
      const code = adminUserBadgeRevokeMatch[2].toUpperCase();
      await dbPool.query(`DELETE FROM user_badges WHERE user_id = ? AND badge_code = ?`, [userId, code]);
      return sendJson(res, 200, { ok: true });
    }

  };
};
