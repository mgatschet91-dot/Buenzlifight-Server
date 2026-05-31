'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

async function _requireAdmin(req, res) {
  ensureDbEnabled();
  const authUser = await getAuthenticatedUser(req);
  if (!authUser) { sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' }); return null; }
  if (authUser.global_role !== 'administrator') { sendJson(res, 403, { ok: false, error: 'Nur Admins' }); return null; }
  return authUser;
}

module.exports = function createContentHandler() {
  return async function handleAdminContent(req, res, pathname) {

    // ── Changelog ─────────────────────────────────────────────────

    // GET /api/changelog (public)
    if (req.method === 'GET' && pathname === '/api/changelog') {
      ensureDbEnabled();
      const [rows] = await dbPool.query(`SELECT version, tag, message, sort_order FROM changelog_entries ORDER BY version DESC, sort_order ASC`);
      return sendJson(res, 200, { ok: true, data: { entries: rows } });
    }

    // GET /api/admin/changelog
    if (req.method === 'GET' && pathname === '/api/admin/changelog') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const [rows] = await dbPool.query(`SELECT * FROM changelog_entries ORDER BY version DESC, sort_order ASC`);
      return sendJson(res, 200, { ok: true, data: { entries: rows } });
    }

    // POST /api/admin/changelog
    if (req.method === 'POST' && pathname === '/api/admin/changelog') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const body = await readJsonBody(req);
      const { version, tag, message, sort_order } = body || {};
      if (!version || !message) return sendJson(res, 422, { ok: false, error: 'version und message sind Pflicht' });
      const safeTag = ['neu', 'fix', 'entfernt'].includes(tag) ? tag : 'neu';
      const safeSortOrder = Number(sort_order) || 0;
      const [result] = await dbPool.query(
        `INSERT INTO changelog_entries (version, tag, message, sort_order) VALUES (?, ?, ?, ?)`,
        [String(version).slice(0, 16), safeTag, String(message).slice(0, 500), safeSortOrder]
      );
      return sendJson(res, 201, { ok: true, data: { id: result.insertId } });
    }

    // PATCH + DELETE /api/admin/changelog/:id
    const changelogPatchMatch = pathname.match(/^\/api\/admin\/changelog\/(\d+)$/);
    if (changelogPatchMatch && req.method === 'PATCH') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const entryId = Number(changelogPatchMatch[1]);
      const body = await readJsonBody(req);
      const sets = [];
      const params = [];
      if (body.version !== undefined) { sets.push('version = ?'); params.push(String(body.version).slice(0, 16)); }
      if (body.tag !== undefined && ['neu', 'fix', 'entfernt'].includes(body.tag)) { sets.push('tag = ?'); params.push(body.tag); }
      if (body.message !== undefined) { sets.push('message = ?'); params.push(String(body.message).slice(0, 500)); }
      if (body.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(Number(body.sort_order) || 0); }
      if (sets.length === 0) return sendJson(res, 422, { ok: false, error: 'Keine Felder zum Updaten' });
      params.push(entryId);
      await dbPool.query(`UPDATE changelog_entries SET ${sets.join(', ')} WHERE id = ?`, params);
      return sendJson(res, 200, { ok: true, data: { updated: entryId } });
    }
    if (changelogPatchMatch && req.method === 'DELETE') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const entryId = Number(changelogPatchMatch[1]);
      await dbPool.query(`DELETE FROM changelog_entries WHERE id = ?`, [entryId]);
      return sendJson(res, 200, { ok: true, data: { deleted: entryId } });
    }

    // ── Badges ────────────────────────────────────────────────────

    // GET /api/admin/badges
    if (req.method === 'GET' && pathname === '/api/admin/badges') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const [rows] = await dbPool.query(
        `SELECT id, code, name, description, category, image_url, rarity, is_active, sort_order FROM badges ORDER BY category, sort_order, code`
      );
      return sendJson(res, 200, { ok: true, data: { badges: rows } });
    }

    // POST /api/admin/badges
    if (req.method === 'POST' && pathname === '/api/admin/badges') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const body = await readJsonBody(req);
      const code = (body.code || '').toString().trim().toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 64);
      if (!code) return sendJson(res, 422, { ok: false, error: 'Code erforderlich' });
      const name = (body.name || '').toString().trim().slice(0, 128);
      const description = (body.description || '').toString().trim() || null;
      const category = ['achievement', 'rank', 'event', 'special', 'general'].includes(body.category) ? body.category : 'general';
      const image_url = (body.image_url || '').toString().trim().slice(0, 512) || null;
      const rarity = Math.max(0, Math.min(4, Number(body.rarity) || 0));
      const sort_order = Number(body.sort_order) || 0;
      try {
        const [result] = await dbPool.query(
          `INSERT INTO badges (code, name, description, category, image_url, rarity, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [code, name, description, category, image_url, rarity, sort_order]
        );
        return sendJson(res, 200, { ok: true, data: { id: result.insertId, code, name, description, category, image_url, rarity, sort_order, is_active: 1 } });
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return sendJson(res, 409, { ok: false, error: 'Badge-Code bereits vergeben' });
        throw e;
      }
    }

    // PATCH + DELETE /api/admin/badges/:code
    const adminBadgeCodeMatch = pathname.match(/^\/api\/admin\/badges\/([A-Z0-9_]+)$/i);
    if (adminBadgeCodeMatch && req.method === 'PATCH') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const code = adminBadgeCodeMatch[1].toUpperCase();
      const body = await readJsonBody(req);
      const fields = [];
      const params = [];
      if (body.name !== undefined)        { fields.push('name = ?');        params.push(String(body.name).slice(0, 128)); }
      if (body.description !== undefined) { fields.push('description = ?'); params.push(body.description || null); }
      if (body.image_url !== undefined)   { fields.push('image_url = ?');   params.push(body.image_url || null); }
      if (body.category !== undefined && ['achievement','rank','event','special','general'].includes(body.category))
        { fields.push('category = ?'); params.push(body.category); }
      if (body.rarity !== undefined)      { fields.push('rarity = ?');      params.push(Math.max(0, Math.min(4, Number(body.rarity)))); }
      if (body.sort_order !== undefined)  { fields.push('sort_order = ?');  params.push(Number(body.sort_order)); }
      if (body.is_active !== undefined)   { fields.push('is_active = ?');   params.push(body.is_active ? 1 : 0); }
      if (!fields.length) return sendJson(res, 422, { ok: false, error: 'Keine Felder zum Aktualisieren' });
      params.push(code);
      await dbPool.query(`UPDATE badges SET ${fields.join(', ')} WHERE code = ?`, params);
      return sendJson(res, 200, { ok: true });
    }
    if (adminBadgeCodeMatch && req.method === 'DELETE') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const code = adminBadgeCodeMatch[1].toUpperCase();
      await dbPool.query(`DELETE FROM badges WHERE code = ?`, [code]);
      return sendJson(res, 200, { ok: true });
    }

  };
};
