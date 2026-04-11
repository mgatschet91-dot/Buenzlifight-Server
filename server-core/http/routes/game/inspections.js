'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');

const { awardXp, getUserXp } = require('../../../game/xp');

const {
  INSPECTION_DURATION_MS,
  INSPECTION_RADIUS,
} = require('../../../config/constants');

module.exports = function registerInspectionsRoutes(/* deps */) {
  return async function handleInspections(req, res, pathname /*, requestUrl */) {

    // POST /api/inspections/start — Neue Inspektion starten
    if (req.method === 'POST' && pathname === '/api/inspections/start') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugeordnet' });

      const body = await readJsonBody(req);
      const tileX = Number(body.tile_x);
      const tileY = Number(body.tile_y);
      const requestedMunicipalitySlug = String(body.municipality_slug || '').trim().toLowerCase();
      if (isNaN(tileX) || isNaN(tileY)) {
        return sendJson(res, 400, { ok: false, error: 'tile_x und tile_y erforderlich' });
      }

      let inspectionMunicipalityId = Number(authUser.municipality_id);
      let inspectionMunicipalitySlug = String(authUser.municipality_slug || '').toLowerCase() || null;
      let inspectionMunicipalityName = authUser.municipality_name || null;

      if (requestedMunicipalitySlug && requestedMunicipalitySlug !== inspectionMunicipalitySlug) {
        const [targetMunicipalityRows] = await dbPool.query(
          `SELECT id, slug, name FROM municipalities WHERE slug = ? LIMIT 1`,
          [requestedMunicipalitySlug]
        );
        if (targetMunicipalityRows.length === 0) {
          return sendJson(res, 404, { ok: false, error: 'Ziel-Gemeinde nicht gefunden' });
        }
        const targetMunicipality = targetMunicipalityRows[0];
        inspectionMunicipalityId = Number(targetMunicipality.id);
        inspectionMunicipalitySlug = String(targetMunicipality.slug || '').toLowerCase() || requestedMunicipalitySlug;
        inspectionMunicipalityName = targetMunicipality.name || null;
      }

      const isForeignInspection = Number(inspectionMunicipalityId) !== Number(authUser.municipality_id);

      // Prüfen ob bereits eine laufende Inspektion existiert
      const [existing] = await dbPool.query(
        `SELECT i.id, i.tile_x, i.tile_y, i.started_at, i.completes_at, i.municipality_id,
                m.slug AS municipality_slug, m.name AS municipality_name
         FROM inspections i
         LEFT JOIN municipalities m ON m.id = i.municipality_id
         WHERE user_id = ? AND status = 'searching' LIMIT 1`,
        [authUser.id]
      );
      if (existing.length > 0) {
        const ex = existing[0];
        const existingIsForeign = Number(ex.municipality_id) !== Number(authUser.municipality_id);
        const remaining = new Date(ex.completes_at).getTime() - Date.now();
        return sendJson(res, 409, {
          ok: false,
          error: 'Es läuft bereits eine Inspektion',
          data: {
            inspection_id: ex.id,
            tile_x: ex.tile_x,
            tile_y: ex.tile_y,
            remaining_ms: Math.max(0, remaining),
            completes_at: ex.completes_at,
            municipality_slug: ex.municipality_slug || null,
            municipality_name: ex.municipality_name || null,
            is_foreign: existingIsForeign,
          }
        });
      }

      const now = new Date();
      const completesAt = new Date(now.getTime() + INSPECTION_DURATION_MS);

      const [result] = await dbPool.query(
        `INSERT INTO inspections (user_id, municipality_id, tile_x, tile_y, radius, status, started_at, completes_at)
         VALUES (?, ?, ?, ?, ?, 'searching', ?, ?)`,
        [authUser.id, inspectionMunicipalityId, tileX, tileY, INSPECTION_RADIUS, now, completesAt]
      );

      return sendJson(res, 200, {
        ok: true,
        data: {
          inspection_id: result.insertId,
          tile_x: tileX,
          tile_y: tileY,
          radius: INSPECTION_RADIUS,
          started_at: now.toISOString(),
          completes_at: completesAt.toISOString(),
          duration_ms: INSPECTION_DURATION_MS,
          municipality_slug: inspectionMunicipalitySlug,
          municipality_name: inspectionMunicipalityName,
          is_foreign: isForeignInspection,
        }
      });
    }

    // GET /api/inspections/active — Laufende Inspektion des Users
    if (req.method === 'GET' && pathname === '/api/inspections/active') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `SELECT i.id, i.tile_x, i.tile_y, i.radius, i.status, i.started_at, i.completes_at, i.municipality_id,
                m.slug AS municipality_slug, m.name AS municipality_name
         FROM inspections i
         LEFT JOIN municipalities m ON m.id = i.municipality_id
         WHERE i.user_id = ? AND i.status = 'searching'
         ORDER BY i.started_at DESC LIMIT 1`,
        [authUser.id]
      );

      if (rows.length === 0) {
        return sendJson(res, 200, { ok: true, data: { inspection: null } });
      }

      const insp = rows[0];
      const isForeignInspection = Number(insp.municipality_id) !== Number(authUser.municipality_id);
      const remaining = new Date(insp.completes_at).getTime() - Date.now();

      // Auto-complete wenn Zeit abgelaufen
      if (remaining <= 0 && insp.status === 'searching') {
        await dbPool.query(
          `UPDATE inspections SET status = 'completed', completed_at = NOW() WHERE id = ?`,
          [insp.id]
        );
        insp.status = 'completed';
      }

      return sendJson(res, 200, {
        ok: true,
        data: {
          inspection: {
            id: insp.id,
            tile_x: insp.tile_x,
            tile_y: insp.tile_y,
            radius: insp.radius,
            status: insp.status,
            started_at: insp.started_at,
            completes_at: insp.completes_at,
            remaining_ms: Math.max(0, remaining),
            municipality_slug: insp.municipality_slug || null,
            municipality_name: insp.municipality_name || null,
            is_foreign: isForeignInspection,
          }
        }
      });
    }

    // GET /api/inspections/:id/results — Ergebnisse einer abgeschlossenen Inspektion
    const inspResultsMatch = pathname.match(/^\/api\/inspections\/([0-9]+)\/results$/i);
    if (inspResultsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const inspId = Number(inspResultsMatch[1]);
      const [rows] = await dbPool.query(
        `SELECT i.*, m.slug AS municipality_slug, m.name AS municipality_name
         FROM inspections i
         LEFT JOIN municipalities m ON m.id = i.municipality_id
         WHERE i.id = ? AND i.user_id = ?`,
        [inspId, authUser.id]
      );
      if (rows.length === 0) {
        return sendJson(res, 404, { ok: false, error: 'Inspektion nicht gefunden' });
      }

      const insp = rows[0];
      const remaining = new Date(insp.completes_at).getTime() - Date.now();

      // Noch nicht fertig?
      if (remaining > 0) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Inspektion noch nicht abgeschlossen',
          data: { remaining_ms: remaining }
        });
      }

      // Auto-complete
      if (insp.status === 'searching') {
        await dbPool.query(
          `UPDATE inspections SET status = 'completed', completed_at = NOW() WHERE id = ?`,
          [insp.id]
        );
      }

      // Events in der Nähe suchen (server-seitig!)
      const userXp = await getUserXp(authUser.id);
      const [events] = await dbPool.query(
        `SELECT me.id, me.event_type_id, me.status, me.severity, me.confidence,
                me.min_level, me.fix_cost, me.location_x, me.location_y,
                me.room_code, me.affected_item_id, me.building_snapshot,
                me.building_exists, me.building_verified_at,
                me.reported_by, me.resolved_by, me.spawned_at, me.expires_at,
                me.reported_at, me.resolved_at,
                et.code, et.name, et.description, et.emoji, et.category,
                et.company_type_required
         FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         WHERE me.municipality_id = ?
           AND me.status = 'detected'
           AND me.min_level <= ?
           AND me.location_x IS NOT NULL AND me.location_y IS NOT NULL
           AND ABS(me.location_x - ?) <= ?
           AND ABS(me.location_y - ?) <= ?
         ORDER BY me.severity DESC
         LIMIT 20`,
        [insp.municipality_id, userXp.level, insp.tile_x, insp.radius, insp.tile_y, insp.radius]
      );

      const parsedEvents = events.map(r => {
        let snapshot = r.building_snapshot;
        if (snapshot && typeof snapshot === 'string') {
          try { snapshot = JSON.parse(snapshot); } catch (_) {}
        }
        return { ...r, building_snapshot: snapshot };
      });

      return sendJson(res, 200, {
        ok: true,
        data: {
          inspection: {
            id: insp.id,
            tile_x: insp.tile_x,
            tile_y: insp.tile_y,
            radius: insp.radius,
            status: 'completed',
            municipality_slug: insp.municipality_slug || null,
            municipality_name: insp.municipality_name || null,
            is_foreign: Number(insp.municipality_id) !== Number(authUser.municipality_id),
          },
          events: parsedEvents,
          user_level: userXp.level,
        }
      });
    }

    // POST /api/inspections/:id/cancel — Inspektion abbrechen
    const inspCancelMatch = pathname.match(/^\/api\/inspections\/([0-9]+)\/cancel$/i);
    if (inspCancelMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const inspId = Number(inspCancelMatch[1]);
      const [rows] = await dbPool.query(
        `SELECT id, status FROM inspections WHERE id = ? AND user_id = ? AND status = 'searching'`,
        [inspId, authUser.id]
      );
      if (rows.length === 0) {
        return sendJson(res, 404, { ok: false, error: 'Keine laufende Inspektion gefunden' });
      }

      await dbPool.query(
        `UPDATE inspections SET status = 'cancelled', cancelled_at = NOW() WHERE id = ?`,
        [inspId]
      );

      return sendJson(res, 200, { ok: true, data: { cancelled: true } });
    }

  };
};
