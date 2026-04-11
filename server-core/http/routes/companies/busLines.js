'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { logError } = require('../../../infra/logger');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { calcCompanyLevel } = require('./helpers');

const BUS_LINE_COLORS = ['#f59e0b', '#ef4444', '#3b82f6', '#10b981', '#9333ea', '#ec4899', '#06b6d4', '#f97316'];
const MIN_STOPS = 4;
const MAX_STOPS = 10;

/** Hilfsfunktion: Firma laden + Typ pruefen + Mitgliedschaft pruefen */
async function loadTransportCompany(companyId, userId) {
  const [rows] = await dbPool.query(
    `SELECT c.*, ct.code AS type_code, cm.role AS my_role
     FROM companies c
     JOIN company_types ct ON ct.id = c.company_type_id
     JOIN company_members cm ON cm.company_id = c.id AND cm.user_id = ?
     WHERE c.id = ? AND c.is_active = 1`,
    [userId, companyId]
  );
  if (!rows[0]) return null;
  if (rows[0].type_code !== 'transport') return null;
  rows[0].level = calcCompanyLevel(rows[0].reputation || 0);
  return rows[0];
}

module.exports = function registerBusLineRoutes(deps) {
  return async function handleBusLines(req, res, pathname, requestUrl) {

    // ─────────────────────────────────────────────────────────────
    // GET /api/companies/:id/bus-lines — Alle Linien einer Firma
    // ─────────────────────────────────────────────────────────────
    const companyLinesMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/bus-lines$/i);
    if (companyLinesMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const companyId = Number(companyLinesMatch[1]);
      const company = await loadTransportCompany(companyId, authUser.id);
      if (!company) return sendJson(res, 404, { ok: false, error: 'Transport-Firma nicht gefunden oder kein Zugriff' });

      const [lines] = await dbPool.query(
        `SELECT * FROM bus_lines WHERE company_id = ? ORDER BY created_at ASC`, [companyId]
      );
      const lineIds = lines.map(l => l.id);
      let stopsByLine = {};
      if (lineIds.length > 0) {
        const [stops] = await dbPool.query(
          `SELECT * FROM bus_line_stops WHERE bus_line_id IN (?) ORDER BY bus_line_id, sequence_order`,
          [lineIds]
        );
        for (const s of stops) {
          if (!stopsByLine[s.bus_line_id]) stopsByLine[s.bus_line_id] = [];
          stopsByLine[s.bus_line_id].push({ x: s.stop_x, y: s.stop_y, sequence_order: s.sequence_order });
        }
      }

      const result = lines.map(l => ({
        id: l.id,
        company_id: l.company_id,
        municipality_id: l.municipality_id,
        name: l.name,
        color: l.color,
        status: l.status,
        stops: stopsByLine[l.id] || [],
        created_at: l.created_at,
      }));

      const maxLines = company.level * 2;
      return sendJson(res, 200, { ok: true, data: { bus_lines: result, max_lines: maxLines, level: company.level } });
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/companies/:id/bus-lines — Neue Linie erstellen
    // ─────────────────────────────────────────────────────────────
    if (companyLinesMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const companyId = Number(companyLinesMatch[1]);
      const company = await loadTransportCompany(companyId, authUser.id);
      if (!company) return sendJson(res, 404, { ok: false, error: 'Transport-Firma nicht gefunden oder kein Zugriff' });
      if (company.my_role !== 'owner' && company.my_role !== 'manager') {
        return sendJson(res, 403, { ok: false, error: 'Nur Owner oder Manager koennen Linien erstellen' });
      }

      const body = await readJsonBody(req);
      const { name, color, stops } = body || {};
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return sendJson(res, 400, { ok: false, error: 'Name ist erforderlich' });
      }
      if (!Array.isArray(stops) || stops.length < MIN_STOPS || stops.length > MAX_STOPS) {
        return sendJson(res, 400, { ok: false, error: `Eine Linie braucht ${MIN_STOPS}-${MAX_STOPS} Haltestellen` });
      }

      // Linien-Limit pruefen
      const maxLines = company.level * 2;
      const [[{ cnt }]] = await dbPool.query(
        `SELECT COUNT(*) AS cnt FROM bus_lines WHERE company_id = ?`, [companyId]
      );
      if (cnt >= maxLines) {
        return sendJson(res, 400, { ok: false, error: `Linien-Limit erreicht (${maxLines} bei Level ${company.level})` });
      }

      // Stop-Koordinaten validieren
      for (const stop of stops) {
        if (typeof stop.x !== 'number' || typeof stop.y !== 'number' || stop.x < 0 || stop.y < 0) {
          return sendJson(res, 400, { ok: false, error: 'Ungueltige Stop-Koordinaten' });
        }
      }

      const lineColor = (typeof color === 'string' && color.startsWith('#')) ? color : BUS_LINE_COLORS[cnt % BUS_LINE_COLORS.length];
      const municipalityId = company.municipality_id;

      const conn = await dbPool.getConnection();
      try {
        await conn.beginTransaction();

        const [insertResult] = await conn.query(
          `INSERT INTO bus_lines (company_id, municipality_id, name, color) VALUES (?, ?, ?, ?)`,
          [companyId, municipalityId, name.trim(), lineColor]
        );
        const lineId = insertResult.insertId;

        const stopValues = stops.map((s, i) => [lineId, s.x, s.y, i]);
        await conn.query(
          `INSERT INTO bus_line_stops (bus_line_id, stop_x, stop_y, sequence_order) VALUES ?`,
          [stopValues]
        );

        await conn.commit();

        // Socket-Broadcast damit andere Clients die neue Linie sehen
        if (deps?.io) {
          deps.io.to(`municipality:${municipalityId}`).emit('bus-lines-updated', { municipality_id: municipalityId });
        }

        return sendJson(res, 201, {
          ok: true,
          data: {
            bus_line: {
              id: Number(lineId),
              company_id: companyId,
              municipality_id: municipalityId,
              name: name.trim(),
              color: lineColor,
              status: 'active',
              stops: stops.map((s, i) => ({ x: s.x, y: s.y, sequence_order: i })),
            },
          },
        });
      } catch (err) {
        await conn.rollback();
        logError('BUS_LINES', `Linie erstellen fehlgeschlagen: ${err.message}`);
        return sendJson(res, 500, { ok: false, error: 'Linie konnte nicht erstellt werden' });
      } finally {
        conn.release();
      }
    }

    // ─────────────────────────────────────────────────────────────
    // PATCH /api/companies/:id/bus-lines/:lineId — Linie bearbeiten
    // ─────────────────────────────────────────────────────────────
    const lineDetailMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/bus-lines\/([0-9]+)$/i);
    if (lineDetailMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const companyId = Number(lineDetailMatch[1]);
      const lineId = Number(lineDetailMatch[2]);
      const company = await loadTransportCompany(companyId, authUser.id);
      if (!company) return sendJson(res, 404, { ok: false, error: 'Transport-Firma nicht gefunden oder kein Zugriff' });
      if (company.my_role !== 'owner' && company.my_role !== 'manager') {
        return sendJson(res, 403, { ok: false, error: 'Nur Owner oder Manager koennen Linien bearbeiten' });
      }

      const [lineRows] = await dbPool.query(`SELECT * FROM bus_lines WHERE id = ? AND company_id = ?`, [lineId, companyId]);
      if (!lineRows[0]) return sendJson(res, 404, { ok: false, error: 'Linie nicht gefunden' });

      const body = await readJsonBody(req);
      const updates = [];
      const params = [];

      if (body.name && typeof body.name === 'string') { updates.push('name = ?'); params.push(body.name.trim()); }
      if (body.color && typeof body.color === 'string') { updates.push('color = ?'); params.push(body.color); }
      if (body.status === 'active' || body.status === 'disabled') { updates.push('status = ?'); params.push(body.status); }

      if (updates.length > 0) {
        params.push(lineId);
        await dbPool.query(`UPDATE bus_lines SET ${updates.join(', ')} WHERE id = ?`, params);
      }

      // Stops ersetzen (optional)
      if (Array.isArray(body.stops) && body.stops.length >= MIN_STOPS && body.stops.length <= MAX_STOPS) {
        await dbPool.query(`DELETE FROM bus_line_stops WHERE bus_line_id = ?`, [lineId]);
        const stopValues = body.stops.map((s, i) => [lineId, s.x, s.y, i]);
        await dbPool.query(
          `INSERT INTO bus_line_stops (bus_line_id, stop_x, stop_y, sequence_order) VALUES ?`,
          [stopValues]
        );
      }

      if (deps?.io) {
        deps.io.to(`municipality:${company.municipality_id}`).emit('bus-lines-updated', { municipality_id: company.municipality_id });
      }

      return sendJson(res, 200, { ok: true });
    }

    // ─────────────────────────────────────────────────────────────
    // DELETE /api/companies/:id/bus-lines/:lineId — Linie loeschen
    // ─────────────────────────────────────────────────────────────
    if (lineDetailMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const companyId = Number(lineDetailMatch[1]);
      const lineId = Number(lineDetailMatch[2]);
      const company = await loadTransportCompany(companyId, authUser.id);
      if (!company) return sendJson(res, 404, { ok: false, error: 'Transport-Firma nicht gefunden oder kein Zugriff' });
      if (company.my_role !== 'owner' && company.my_role !== 'manager') {
        return sendJson(res, 403, { ok: false, error: 'Nur Owner oder Manager koennen Linien loeschen' });
      }

      const [result] = await dbPool.query(`DELETE FROM bus_lines WHERE id = ? AND company_id = ?`, [lineId, companyId]);
      if (result.affectedRows === 0) return sendJson(res, 404, { ok: false, error: 'Linie nicht gefunden' });

      if (deps?.io) {
        deps.io.to(`municipality:${company.municipality_id}`).emit('bus-lines-updated', { municipality_id: company.municipality_id });
      }

      return sendJson(res, 200, { ok: true });
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/bus-lines/municipality/:slug — Oeffentlich: aktive Linien (Slug oder ID)
    // ─────────────────────────────────────────────────────────────
    const municipalityLinesMatch = pathname.match(/^\/api\/bus-lines\/municipality\/([a-zA-Z0-9_-]+)$/i);
    if (municipalityLinesMatch && req.method === 'GET') {
      ensureDbEnabled();
      const slugOrId = municipalityLinesMatch[1];
      let municipalityId;
      if (/^\d+$/.test(slugOrId)) {
        municipalityId = Number(slugOrId);
      } else {
        const [munRows] = await dbPool.query(`SELECT id FROM municipalities WHERE slug = ? LIMIT 1`, [slugOrId]);
        if (!munRows[0]) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
        municipalityId = munRows[0].id;
      }

      const [lines] = await dbPool.query(
        `SELECT bl.* FROM bus_lines bl
         JOIN companies c ON c.id = bl.company_id AND c.is_active = 1
         WHERE bl.municipality_id = ? AND bl.status = 'active'
         ORDER BY bl.created_at ASC`,
        [municipalityId]
      );

      const lineIds = lines.map(l => l.id);
      let stopsByLine = {};
      if (lineIds.length > 0) {
        const [stops] = await dbPool.query(
          `SELECT * FROM bus_line_stops WHERE bus_line_id IN (?) ORDER BY bus_line_id, sequence_order`,
          [lineIds]
        );
        for (const s of stops) {
          if (!stopsByLine[s.bus_line_id]) stopsByLine[s.bus_line_id] = [];
          stopsByLine[s.bus_line_id].push({ x: s.stop_x, y: s.stop_y, sequence_order: s.sequence_order });
        }
      }

      const result = lines.map(l => ({
        id: l.id,
        company_id: l.company_id,
        name: l.name,
        color: l.color,
        stops: stopsByLine[l.id] || [],
      }));

      return sendJson(res, 200, { ok: true, data: { bus_lines: result } });
    }

  };
};
