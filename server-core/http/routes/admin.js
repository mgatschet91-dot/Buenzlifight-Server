'use strict';

const crypto = require('crypto');
const { sendJson, readJsonBody } = require('../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../infra/db');
const { getAuthenticatedUser } = require('../../auth/middleware');
const { escapeLike } = require('../../shared/helpers');
const { wsRoomPlayers } = require('../../ws/socketio/index');
const { awardXp } = require('../../game/xp');
const { createUserNotification } = require('../../game/notifications');

module.exports = function registerAdminRoutes(deps) {
  const { wsUserSockets } = require('../../ws/socketio/index');

  return async function handleAdmin(req, res, pathname, requestUrl) {

    if (req.method === 'GET' && pathname === '/api/admin/users') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
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

    const adminBanMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/ban$/i);
    if (adminBanMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const userId = Number(adminBanMatch[1]);
      if (userId === authUser.id) return sendJson(res, 400, { ok: false, error: 'Du kannst dich nicht selbst bannen' });
      await dbPool.query(`UPDATE users SET is_banned = 1, updated_at = NOW() WHERE id = ?`, [userId]);
      await dbPool.query(`UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL`, [userId]);
      return sendJson(res, 200, { ok: true, data: { banned: true } });
    }

    const adminUnbanMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/unban$/i);
    if (adminUnbanMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const userId = Number(adminUnbanMatch[1]);
      await dbPool.query(`UPDATE users SET is_banned = 0, updated_at = NOW() WHERE id = ?`, [userId]);
      return sendJson(res, 200, { ok: true, data: { unbanned: true } });
    }

    if (req.method === 'GET' && pathname === '/api/admin/events') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const status = requestUrl.searchParams.get('status') || 'all';
      const validStatuses = ['detected', 'reported', 'investigating', 'assigned', 'resolved', 'external_reported'];
      let statusClause = '';
      const params = [];
      if (status === 'active') statusClause = `WHERE me.status IN ('detected','reported','investigating','assigned','external_reported')`;
      else if (status !== 'all' && validStatuses.includes(status)) { statusClause = `WHERE me.status = ?`; params.push(status); }
      const [rows] = await dbPool.query(
        `SELECT me.id, me.severity, me.status, me.spawned_at, me.location_x, me.location_y,
                et.name, et.emoji, et.category, m.name AS municipality_name
         FROM municipality_events me JOIN event_types et ON et.id = me.event_type_id
         JOIN municipalities m ON m.id = me.municipality_id ${statusClause}
         ORDER BY me.spawned_at DESC LIMIT 100`, params);
      return sendJson(res, 200, { ok: true, data: { events: rows } });
    }

    const adminDeleteEventMatch = pathname.match(/^\/api\/admin\/events\/([0-9]+)$/i);
    if (adminDeleteEventMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const eventId = Number(adminDeleteEventMatch[1]);
      await dbPool.query(`DELETE FROM municipality_events WHERE id = ?`, [eventId]);
      return sendJson(res, 200, { ok: true, data: { deleted: true } });
    }

    if (req.method === 'POST' && pathname === '/api/admin/events/push-to-verwaltung') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const body = await readJsonBody(req);
      const eventId = body.event_id ? Number(body.event_id) : null;
      if (eventId) {
        const [result] = await dbPool.query(
          `UPDATE municipality_events SET status = 'reported', reported_by = ?, reported_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'detected'`,
          [authUser.id, eventId]
        );
        if (result.affectedRows > 0) {
          await dbPool.query(`INSERT IGNORE INTO event_reports (event_id, user_id, report_type, created_at) VALUES (?, ?, 'confirm', NOW())`, [eventId, authUser.id]);
        }
        return sendJson(res, 200, { ok: true, data: { pushed: result.affectedRows } });
      } else {
        if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
        const [detectedEvents] = await dbPool.query(`SELECT id FROM municipality_events WHERE municipality_id = ? AND status = 'detected'`, [authUser.municipality_id]);
        const [result] = await dbPool.query(
          `UPDATE municipality_events SET status = 'reported', reported_by = ?, reported_at = NOW(), updated_at = NOW() WHERE municipality_id = ? AND status = 'detected'`,
          [authUser.id, authUser.municipality_id]
        );
        for (const ev of detectedEvents) {
          await dbPool.query(`INSERT IGNORE INTO event_reports (event_id, user_id, report_type, created_at) VALUES (?, ?, 'confirm', NOW())`, [ev.id, authUser.id]);
        }
        return sendJson(res, 200, { ok: true, data: { pushed: result.affectedRows } });
      }
    }

    const adminChangeMuniMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/municipality$/i);
    if (adminChangeMuniMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
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

    if (req.method === 'GET' && pathname === '/api/admin/municipalities') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const q = requestUrl.searchParams.get('q') || '';
      const params = [];
      let where = '1=1';
      if (q) { where += ` AND m.name LIKE ?`; params.push(`%${escapeLike(q)}%`); }
      params.push(200);
      const [rows] = await dbPool.query(
        `SELECT m.id, m.name, m.slug, m.canton_code, COALESCE(mc.cnt, 0) AS members_count
         FROM municipalities m
         LEFT JOIN (SELECT municipality_id, COUNT(*) AS cnt FROM users GROUP BY municipality_id) mc ON mc.municipality_id = m.id
         WHERE ${where} ORDER BY m.name ASC LIMIT ?`, params);
      return sendJson(res, 200, { ok: true, data: { municipalities: rows } });
    }

    if (req.method === 'POST' && pathname === '/api/admin/rooms/rename') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const body = await readJsonBody(req);
      const municipalityId = Number(body.municipality_id);
      const roomCode = String(body.room_code || 'MAIN').trim();
      const newCityName = String(body.city_name || '').trim();
      if (!municipalityId || !newCityName) return sendJson(res, 400, { ok: false, error: 'municipality_id und city_name erforderlich' });
      const [result] = await dbPool.query(`UPDATE game_rooms SET city_name = ?, updated_at = CURRENT_TIMESTAMP WHERE municipality_id = ? AND room_code = ?`, [newCityName, municipalityId, roomCode]);
      if (result.affectedRows === 0) return sendJson(res, 404, { ok: false, error: 'Room nicht gefunden' });
      return sendJson(res, 200, { ok: true, data: { renamed: true, city_name: newCityName } });
    }

    if (req.method === 'GET' && pathname === '/api/admin/rooms') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const municipalityId = Number(requestUrl.searchParams.get('municipality_id') || 0);
      if (!municipalityId) return sendJson(res, 400, { ok: false, error: 'municipality_id erforderlich' });
      const [rows] = await dbPool.query(`SELECT id, room_code, city_name, player_count, is_active, created_at FROM game_rooms WHERE municipality_id = ? ORDER BY room_code ASC`, [municipalityId]);
      return sendJson(res, 200, { ok: true, data: { rooms: rows } });
    }

    if (req.method === 'POST' && pathname === '/api/admin/frontend-errors') {
      ensureDbEnabled();
      try {
        const body = await readJsonBody(req);
        const message = String(body?.message || '').slice(0, 2000);
        const stack = body?.stack ? String(body.stack).slice(0, 8000) : null;
        const componentStack = body?.componentStack ? String(body.componentStack).slice(0, 8000) : null;
        const url = body?.url ? String(body.url).slice(0, 512) : null;
        const userId = body?.userId ? Number(body.userId) || null : null;
        const municipalitySlug = body?.municipalitySlug ? String(body.municipalitySlug).slice(0, 255) : null;
        const browser = body?.browser ? String(body.browser).slice(0, 512) : null;
        if (!message) return sendJson(res, 400, { ok: false, error: 'message erforderlich' });
        const messageHash = crypto.createHash('md5').update(message + (url || '')).digest('hex').slice(0, 16);
        await dbPool.query(
          `INSERT INTO frontend_errors (message_hash, message, stack, component_stack, url, user_id, municipality_slug, browser, count, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())
           ON DUPLICATE KEY UPDATE count = count + 1, last_seen = NOW(), stack = VALUES(stack), component_stack = VALUES(component_stack)`,
          [messageHash, message, stack, componentStack, url, userId, municipalitySlug, browser]
        );
      } catch (_) { /* nie fehlschlagen lassen */ }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/admin/frontend-errors') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const [rows] = await dbPool.query(
        `SELECT id, message, stack, component_stack, url, user_id, municipality_slug, count, first_seen, last_seen
         FROM frontend_errors ORDER BY last_seen DESC LIMIT 100`
      );
      return sendJson(res, 200, { ok: true, data: { errors: rows } });
    }

    if (req.method === 'DELETE' && pathname.match(/^\/api\/admin\/frontend-errors\/([0-9]+)$/i)) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const errorId = Number(pathname.match(/\/([0-9]+)$/)[1]);
      await dbPool.query(`DELETE FROM frontend_errors WHERE id = ?`, [errorId]);
      return sendJson(res, 200, { ok: true, data: { deleted: true } });
    }

    if (req.method === 'GET' && pathname === '/api/admin/debug/power') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      // Eigene Gemeinde des Admins verwenden (kein Parameter nötig)
      const municipalityId = Number(requestUrl.searchParams.get('municipality_id') || authUser.municipality_id || 0);
      if (!municipalityId) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugewiesen' });

      // Alle Rooms + Gebäude-Anzahl pro Room (auto-detect welcher Room aktiv ist)
      const [roomsWithCounts] = await dbPool.query(
        `SELECT gr.room_code, gr.city_name, gr.player_count,
                COALESCE(gi.item_count, 0) AS item_count
         FROM game_rooms gr
         LEFT JOIN (
           SELECT room_code, COUNT(*) AS item_count
           FROM game_items WHERE municipality_id = ? AND action_type = 'place'
           GROUP BY room_code
         ) gi ON gi.room_code = gr.room_code
         WHERE gr.municipality_id = ?
         ORDER BY item_count DESC, gr.room_code ASC`,
        [municipalityId, municipalityId]
      );
      // Room mit den meisten Gebäuden automatisch wählen
      const bestRoom = roomsWithCounts[0];
      const roomCode = requestUrl.searchParams.get('room_code') || bestRoom?.room_code || 'MAIN';

      // Alle distinct tool-Namen im gewählten Room (Diagnose ob 'power_plant' wirklich so heisst)
      const [distinctTools] = await dbPool.query(
        `SELECT tool, action_type, COUNT(*) as cnt FROM game_items WHERE municipality_id = ? AND room_code = ? GROUP BY tool, action_type ORDER BY cnt DESC LIMIT 50`,
        [municipalityId, roomCode]
      );
      // Wie stats.js: BEIDE action_types laden (place = gesetzte Gebäude, zone = gewachsene Gebäude)
      const [rows] = await dbPool.query(
        `SELECT id, action_type, tool, x, y, metadata FROM game_items WHERE municipality_id = ? AND room_code = ? AND (action_type = 'place' OR action_type = 'zone')`,
        [municipalityId, roomCode]
      );
      const { HARD_CODED_BUILDING_STATS } = require('../../config/constants');
      const { isNonEconomicTool, fetchItemDetails } = require('../../game/building');
      // Gebäude-Details aus DB laden (DB-Werte bevorzugen, HARD_CODED_BUILDING_STATS als Fallback)
      const _detailsList = await fetchItemDetails();
      const detailsByTool = new Map((Array.isArray(_detailsList) ? _detailsList : []).map((d) => [String(d.tool || '').toLowerCase(), d]));
      const HARDCODED_POWER_PROD = { solar_panel: 60, wind_turbine: 80 };
      const POWER_PLANT_OUTPUT = [0, 80, 180, 350, 620, 1000];
      const powerBuildings = []; // Strom-Produzenten
      const consumptionBuildings = []; // Top-Verbraucher (für Debug-Ansicht)
      let totalProduction = 0;
      let totalConsumption = 0;
      for (const row of rows) {
        let meta = {};
        try { meta = row.metadata ? (typeof row.metadata === 'object' ? row.metadata : JSON.parse(row.metadata)) : {}; } catch { meta = {}; }
        // Zone-Items: Tool aus Metadata lesen (wie stats.js) — nur wenn Gebäude gewachsen ist
        const rawTool = row.action_type === 'zone'
          ? String(meta.buildingType ?? meta.building_type ?? '').toLowerCase()
          : String(row.tool || '').toLowerCase();
        const tool = rawTool;
        if (!tool) continue;
        if (isNonEconomicTool(tool)) continue; // Bäume, Wasser, Strassen etc. → kein Stromverbrauch
        // Zonen ohne gewachsenes Gebäude überspringen
        if (row.action_type === 'zone' && !tool) continue;
        const level = Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1))));
        const constructionProgress = Number(meta.constructionProgress ?? meta.construction_progress ?? 100);
        const isConstructed = constructionProgress >= 100 || meta.constructed === true;
        const isAbandoned = meta.abandoned === true;
        if (!isConstructed || isAbandoned) continue;
        // DB-Werte bevorzugen (nach Migration 069 + Seed), Fallback auf HARD_CODED_BUILDING_STATS
        const _hcs = HARD_CODED_BUILDING_STATS.get(tool);
        const det = detailsByTool.get(tool);
        const hardcodedStats = {
          maxPop: det?.max_pop || _hcs?.maxPop || 0,
          maxJobs: det?.max_jobs || _hcs?.maxJobs || 0,
          powerConsumptionBase: det?.power_consumption_base || _hcs?.powerConsumptionBase || 0,
        };
        // meta.population bevorzugen (wie stats.js), Fallback auf hardcoded maxPop
        const metaPopRaw = Number(meta.population ?? meta.residents ?? meta.capacity_population);
        const metaJobsRaw = Number(meta.jobs ?? meta.workers ?? meta.capacity_jobs);
        const pop = (Number.isFinite(metaPopRaw) && metaPopRaw > 0)
          ? Math.round(metaPopRaw)
          : Math.round(Math.max(0, Number(hardcodedStats.maxPop)) * level * 0.8);
        const job = (Number.isFinite(metaJobsRaw) && metaJobsRaw > 0)
          ? Math.round(metaJobsRaw)
          : Math.round(Math.max(0, Number(hardcodedStats.maxJobs)) * level * 0.8);
        const lvlFactor = 1 + (level - 1) * 0.15;

        // --- Produktion ---
        const isPowerProducer = tool.includes('power_plant') || tool.includes('solar_panel') || tool.includes('wind_turbine');
        if (isPowerProducer) {
          const metaPowerProd = Number(meta.powerProduction ?? meta.power_production);
          const hardcodedProd = HARDCODED_POWER_PROD[tool] || 0;
          const effectiveProd = (Number.isFinite(metaPowerProd) && metaPowerProd > 0) ? metaPowerProd : hardcodedProd;
          let prod = 0;
          if (effectiveProd > 0) {
            prod = Math.round(effectiveProd * level);
          } else if (tool.includes('power_plant')) {
            prod = POWER_PLANT_OUTPUT[level] || 100;
          }
          totalProduction += prod;
          powerBuildings.push({ tool, level, x: row.x, y: row.y, production: prod, source: effectiveProd > 0 ? (Number.isFinite(metaPowerProd) && metaPowerProd > 0 ? 'meta' : 'hardcoded') : 'power_plant_table', note: '×dynFactor zur Laufzeit' });
        }

        // --- Verbrauch (gleiche Logik wie stats.js) ---
        const { inferCategoryFromTool } = require('../../game/building');
        const dbCategory = ''; // nicht verfügbar im Debug-Endpoint
        const category = inferCategoryFromTool(tool, dbCategory);
        const currentHour = new Date().getHours();
        const isDay = currentHour >= 6 && currentHour < 20;
        let _dayNightFactor = 1.0;
        if (!isDay) {
          if (category === 'residential')     _dayNightFactor = 1.20;
          else if (category === 'commercial') _dayNightFactor = 0.65;
          else if (category === 'industrial') _dayNightFactor = 0.70;
          else                                _dayNightFactor = 0.90;
        }
        let cons = 0;
        const metaPowerCons = Number(meta.powerConsumption ?? meta.power_consumption);
        if (Number.isFinite(metaPowerCons) && metaPowerCons > 0) {
          cons = Math.round(metaPowerCons * _dayNightFactor);
        } else if (category === 'residential') {
          const lf = 1 + (level - 1) * 0.15;
          cons = Math.max(1, Math.round(pop * 0.002 * lf * _dayNightFactor));
        } else if (category === 'commercial') {
          const lf = 1 + (level - 1) * 0.15;
          cons = Math.max(1, Math.round(job * 0.004 * lf * _dayNightFactor));
        } else if (category === 'industrial') {
          const lf = 1 + (level - 1) * 0.15;
          cons = Math.max(1, Math.round(job * 0.008 * lf * _dayNightFactor));
        } else if (hardcodedStats?.powerConsumptionBase > 0) {
          cons = Math.round(hardcodedStats.powerConsumptionBase * level * _dayNightFactor);
        } else {
          if (pop > 0) cons = Math.max(1, Math.round(pop * 0.002 * _dayNightFactor));
          else if (job > 0) cons = Math.max(1, Math.round(job * 0.004 * _dayNightFactor));
          else cons = 1;
        }
        if (cons > 0) {
          totalConsumption += cons;
          consumptionBuildings.push({ tool, level, consumption: cons });
        }
      }
      // Top-Verbraucher sortiert
      consumptionBuildings.sort((a, b) => b.consumption - a.consumption);
      // Zusammenfassung nach Tool
      const consumptionByTool = {};
      for (const b of consumptionBuildings) {
        if (!consumptionByTool[b.tool]) consumptionByTool[b.tool] = { tool: b.tool, count: 0, total_mw: 0, avg_level: 0 };
        consumptionByTool[b.tool].count++;
        consumptionByTool[b.tool].total_mw += b.consumption;
        consumptionByTool[b.tool].avg_level += b.level;
      }
      const consumptionSummary = Object.values(consumptionByTool)
        .map(e => ({ ...e, avg_level: Math.round(e.avg_level / e.count * 10) / 10 }))
        .sort((a, b) => b.total_mw - a.total_mw)
        .slice(0, 15);
      return sendJson(res, 200, { ok: true, data: {
        municipality_id: municipalityId, room_code: roomCode,
        available_rooms: roomsWithCounts,
        distinct_tools: distinctTools,
        total_place_buildings: rows.length,
        power_buildings_found: powerBuildings.length,
        total_production_base_mw: totalProduction,
        total_consumption_base_mw: totalConsumption,
        note: 'Ohne Wetter/Saisonmultiplikator — Live-Werte leicht höher/niedriger',
        buildings: powerBuildings,
        consumption_summary: consumptionSummary,
        timestamp: Date.now(),
      }});
    }

    if (req.method === 'GET' && pathname === '/api/admin/stats') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const safeCount = async (sql) => { try { const [[row]] = await dbPool.query(sql); return Object.values(row)[0] || 0; } catch { return 0; } };
      const user_count = await safeCount(`SELECT COUNT(*) AS c FROM users`);
      const municipality_count = await safeCount(`SELECT COUNT(*) AS c FROM municipalities`);
      const event_count = await safeCount(`SELECT COUNT(*) AS c FROM municipality_events WHERE status IN ('detected','reported','assigned')`);
      const company_count = await safeCount(`SELECT COUNT(*) AS c FROM companies WHERE is_active = 1`);
      let online_count = 0;
      for (const roomPlayers of wsRoomPlayers.values()) online_count += roomPlayers.size;
      return sendJson(res, 200, { ok: true, data: { users: user_count, municipalities: municipality_count, active_events: event_count, companies: company_count, online_users: online_count, uptime: Math.round(process.uptime()) } });
    }

    // ── Changelog CRUD (Admin) ─────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/admin/changelog') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const [rows] = await dbPool.query(`SELECT * FROM changelog_entries ORDER BY version DESC, sort_order ASC`);
      return sendJson(res, 200, { ok: true, data: { entries: rows } });
    }

    if (req.method === 'POST' && pathname === '/api/admin/changelog') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
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

    const changelogPatchMatch = pathname.match(/^\/api\/admin\/changelog\/(\d+)$/);
    if (changelogPatchMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
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
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const entryId = Number(changelogPatchMatch[1]);
      await dbPool.query(`DELETE FROM changelog_entries WHERE id = ?`, [entryId]);
      return sendJson(res, 200, { ok: true, data: { deleted: entryId } });
    }

    // ── Changelog PUBLIC (kein Auth) ───────────────────────────────
    if (req.method === 'GET' && pathname === '/api/changelog') {
      ensureDbEnabled();
      const [rows] = await dbPool.query(`SELECT version, tag, message, sort_order FROM changelog_entries ORDER BY version DESC, sort_order ASC`);
      return sendJson(res, 200, { ok: true, data: { entries: rows } });
    }

    // ── Admin Notice: Nachricht senden ─────────────────────────────
    if (req.method === 'POST' && pathname === '/api/admin/notice') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });

      const body = await readJsonBody(req);
      const target  = String(body.target  || '').trim(); // 'online' | 'all' | 'user' | 'municipality'
      const message = String(body.message || '').trim().slice(0, 1000);
      const title   = String(body.title   || 'Nachricht von Bünzlifight Management').trim().slice(0, 200);
      const format  = ['bold', 'italic', 'small', 'normal'].includes(body.format) ? body.format : 'normal';

      if (!message) return sendJson(res, 422, { ok: false, error: 'Nachricht darf nicht leer sein' });
      if (!['online', 'all', 'user', 'municipality'].includes(target)) {
        return sendJson(res, 422, { ok: false, error: 'Ungültiges Ziel (online/all/user/municipality)' });
      }

      const io = deps?.io;
      const noticePayload = { title, message, format, sentAt: new Date().toISOString() };

      if (target === 'online') {
        // Sofort an alle verbundenen Sockets
        if (io) io.emit('system-notice', noticePayload);
        return sendJson(res, 200, { ok: true, data: { target, sent: wsUserSockets.size } });
      }

      if (target === 'all') {
        // Persistent für alle User
        const [users] = await dbPool.query(`SELECT id FROM users WHERE is_banned = 0 OR is_banned IS NULL`);
        for (const u of users) {
          await createUserNotification(u.id, 'info', title, message, { icon: 'buenzli', format });
        }
        // Auch live an alle Online
        if (io) io.emit('system-notice', noticePayload);
        return sendJson(res, 200, { ok: true, data: { target, notified: users.length } });
      }

      if (target === 'user') {
        const userId = Number(body.user_id);
        if (!userId) return sendJson(res, 422, { ok: false, error: 'user_id fehlt' });
        const [uRows] = await dbPool.query(`SELECT id FROM users WHERE id = ?`, [userId]);
        if (!uRows[0]) return sendJson(res, 404, { ok: false, error: 'User nicht gefunden' });
        await createUserNotification(userId, 'info', title, message, { icon: 'buenzli', format });
        // Live falls online
        if (io) {
          const sockets = wsUserSockets.get(userId);
          if (sockets) for (const sid of sockets) io.to(sid).emit('system-notice', noticePayload);
        }
        return sendJson(res, 200, { ok: true, data: { target, user_id: userId } });
      }

      if (target === 'municipality') {
        const muniId = Number(body.municipality_id);
        if (!muniId) return sendJson(res, 422, { ok: false, error: 'municipality_id fehlt' });
        const [members] = await dbPool.query(
          `SELECT user_id FROM municipality_memberships WHERE municipality_id = ?`, [muniId]
        );
        if (!members.length) return sendJson(res, 404, { ok: false, error: 'Keine Mitglieder gefunden' });
        for (const { user_id } of members) {
          await createUserNotification(user_id, 'info', title, message, { icon: 'buenzli', format });
          if (io) {
            const sockets = wsUserSockets.get(user_id);
            if (sockets) for (const sid of sockets) io.to(sid).emit('system-notice', noticePayload);
          }
        }
        return sendJson(res, 200, { ok: true, data: { target, municipality_id: muniId, notified: members.length } });
      }
    }

    // ── User Detail (für Admin-Edit) ───────────────────────────────
    const adminUserDetailMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/detail$/i);
    if (adminUserDetailMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
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
      return sendJson(res, 200, { ok: true, data: {
        ...user,
        balance: bank ? Number(bank.balance) : null,
        treasury, debt, population,
      }});
    }

    // ── Geld geben (persönliches Konto) ───────────────────────────
    const adminGiveMoneyMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/give-money$/i);
    if (adminGiveMoneyMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
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

    // ── Gemeindekasse auffüllen ────────────────────────────────────
    const adminGiveTreasuryMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/give-treasury$/i);
    if (adminGiveTreasuryMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
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

    // ── Badges: Liste aller Badges ────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/admin/badges') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const [rows] = await dbPool.query(
        `SELECT id, code, name, description, category, image_url, rarity, is_active, sort_order FROM badges ORDER BY category, sort_order, code`
      );
      return sendJson(res, 200, { ok: true, data: { badges: rows } });
    }

    // ── Badges: Badge erstellen ────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/admin/badges') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
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

    // ── Badges: Badge bearbeiten ───────────────────────────────────
    const adminBadgeCodeMatch = pathname.match(/^\/api\/admin\/badges\/([A-Z0-9_]+)$/i);
    if (adminBadgeCodeMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
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
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const code = adminBadgeCodeMatch[1].toUpperCase();
      await dbPool.query(`DELETE FROM badges WHERE code = ?`, [code]);
      return sendJson(res, 200, { ok: true });
    }

    // ── Badges: User-Badges laden ──────────────────────────────────
    const adminUserBadgesMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/badges$/i);
    if (adminUserBadgesMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
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

    // ── Badges: Badge an User vergeben ────────────────────────────
    if (adminUserBadgesMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const userId = Number(adminUserBadgesMatch[1]);
      const body = await readJsonBody(req);
      const code = (body.badge_code || '').toString().trim().toUpperCase();
      if (!code) return sendJson(res, 422, { ok: false, error: 'badge_code erforderlich' });
      await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, ?)`, [userId, code]);
      return sendJson(res, 200, { ok: true });
    }

    // ── Badges: Badge von User entziehen ──────────────────────────
    const adminUserBadgeRevokeMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/badges\/([A-Z0-9_]+)$/i);
    if (adminUserBadgeRevokeMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const userId = Number(adminUserBadgeRevokeMatch[1]);
      const code = adminUserBadgeRevokeMatch[2].toUpperCase();
      await dbPool.query(`DELETE FROM user_badges WHERE user_id = ? AND badge_code = ?`, [userId, code]);
      return sendJson(res, 200, { ok: true });
    }

    // ── XP setzen ─────────────────────────────────────────────────
    const adminSetXpMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/set-xp$/i);
    if (adminSetXpMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const userId = Number(adminSetXpMatch[1]);
      const body = await readJsonBody(req);
      const xp = Math.max(0, Math.round(Number(body.xp || 0)));
      const { XP_LEVEL_CAP } = require('../../config/constants');
      const level = Math.min(Math.floor(Math.sqrt(xp / 100)) + 1, XP_LEVEL_CAP);
      await dbPool.query(
        `INSERT INTO user_xp (user_id, total_xp, level) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE total_xp = VALUES(total_xp), level = VALUES(level)`,
        [userId, xp, level]
      );
      return sendJson(res, 200, { ok: true, data: { xp, level } });
    }

    // ══════════════════════════════════════════════════════════════
    // LIVE-SESSIONS
    // ══════════════════════════════════════════════════════════════
    if (req.method === 'GET' && pathname === '/api/admin/sessions') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const { wsRoomPlayers: roomPlayers, wsRoomMetadata, wsUserSockets: userSockets } = require('../../ws/socketio/index');
      const io = deps?.io;
      const sessions = [];
      for (const [roomKey, players] of roomPlayers.entries()) {
        const meta = wsRoomMetadata?.get(roomKey);
        for (const [, pdata] of players.entries()) {
          const sock = io?.sockets?.sockets?.get(pdata.socketId);
          sessions.push({
            userId: pdata.userId || null,
            nickname: pdata.nickname || pdata.name || null,
            socketId: pdata.socketId,
            roomKey,
            municipalitySlug: meta?.municipalitySlug || null,
            municipalityName: meta?.municipalityName || null,
            roomCode: meta?.roomCode || null,
            connectedSince: sock?.handshake?.time || null,
          });
        }
      }
      // Online-User-Count aus DB
      const [onlineRows] = await dbPool.query(
        `SELECT u.id, u.nickname, u.last_online_at FROM users u WHERE u.is_online = 1 ORDER BY u.last_online_at DESC LIMIT 100`
      );
      return sendJson(res, 200, { ok: true, data: { sessions, onlineDb: onlineRows, total: sessions.length } });
    }

    // Kick einzelne Session
    const adminKickMatch = pathname.match(/^\/api\/admin\/sessions\/kick$/i);
    if (adminKickMatch && req.method === 'POST') {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const body = await readJsonBody(req);
      const { socketId } = body;
      const io = deps?.io;
      const sock = io?.sockets?.sockets?.get(socketId);
      if (sock) {
        sock.emit('force-disconnect', { reason: 'Admin-Kick' });
        sock.disconnect(true);
      }
      return sendJson(res, 200, { ok: true, data: { kicked: !!sock } });
    }

    // ══════════════════════════════════════════════════════════════
    // TRANSAKTIONEN
    // ══════════════════════════════════════════════════════════════
    if (req.method === 'GET' && pathname === '/api/admin/transactions') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const limit = Math.min(Number(requestUrl.searchParams.get('limit') || 100), 500);
      const typeFilter = requestUrl.searchParams.get('type') || '';
      const minAmount = Number(requestUrl.searchParams.get('min') || 0);
      let sql = `
        SELECT bt.id, uba.user_id, bt.type, bt.direction, bt.amount, bt.balance_after,
               bt.description, bt.reference, bt.created_at,
               u.nickname
        FROM bank_transactions bt
        LEFT JOIN user_bank_accounts uba ON uba.id = bt.account_id
        LEFT JOIN users u ON u.id = uba.user_id
        WHERE ABS(bt.amount) >= ?
      `;
      const params = [minAmount];
      if (typeFilter) { sql += ` AND bt.type = ?`; params.push(typeFilter); }
      sql += ` ORDER BY bt.created_at DESC LIMIT ?`;
      params.push(limit);
      const [rows] = await dbPool.query(sql, params);
      // Distinct types für Filter-Dropdown
      const [types] = await dbPool.query(`SELECT DISTINCT type FROM bank_transactions ORDER BY type`);
      return sendJson(res, 200, { ok: true, data: { transactions: rows, types: types.map(t => t.type) } });
    }

    // ══════════════════════════════════════════════════════════════
    // GEMEINDEN-RANKING
    // ══════════════════════════════════════════════════════════════
    if (req.method === 'GET' && pathname === '/api/admin/ranking') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const sortBy = requestUrl.searchParams.get('sort') || 'population';
      const validSorts = ['population', 'treasury', 'jobs', 'members'];
      const col = validSorts.includes(sortBy) ? sortBy : 'population';
      const orderCol = col === 'members' ? 'members_count' : `ms.${col}`;
      const [rows] = await dbPool.query(`
        SELECT m.id, m.name, m.slug, m.canton_code,
               COALESCE(ms.population, 0) AS population,
               COALESCE(ms.treasury, 0)   AS treasury,
               COALESCE(ms.jobs, 0)       AS jobs,
               COUNT(DISTINCT u.id)       AS members_count,
               MAX(u.last_online_at)      AS last_active
        FROM municipalities m
        LEFT JOIN municipality_stats ms ON ms.municipality_id = m.id
        LEFT JOIN users u ON u.municipality_id = m.id
        GROUP BY m.id, m.name, m.slug, m.canton_code, ms.population, ms.treasury, ms.jobs
        ORDER BY ${orderCol} DESC
        LIMIT 50
      `);
      return sendJson(res, 200, { ok: true, data: { municipalities: rows } });
    }

    // ══════════════════════════════════════════════════════════════
    // SERVER-AKTIONEN
    // ══════════════════════════════════════════════════════════════
    if (req.method === 'POST' && pathname === '/api/admin/actions/broadcast') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const body = await readJsonBody(req);
      const { message, title, type = 'info' } = body;
      if (!message) return sendJson(res, 422, { ok: false, error: 'message fehlt' });
      const io = deps?.io;
      if (io) {
        io.emit('admin-broadcast', { title: title || 'Server-Nachricht', message, type, timestamp: Date.now() });
      }
      return sendJson(res, 200, { ok: true, data: { sent: true } });
    }

    if (req.method === 'POST' && pathname === '/api/admin/actions/clear-cache') {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const { invalidateRoomItemsCache } = require('../../jobs/intervals');
      const { roomRuntimeCache } = require('../../game/rooms');
      let cleared = 0;
      for (const [, entry] of roomRuntimeCache.entries()) {
        if (entry.municipalityId && entry.roomCode) {
          invalidateRoomItemsCache(entry.municipalityId, entry.roomCode);
          cleared++;
        }
      }
      return sendJson(res, 200, { ok: true, data: { cleared } });
    }

    if (req.method === 'POST' && pathname === '/api/admin/actions/kick-all') {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const body = await readJsonBody(req);
      const { reason = 'Server-Wartung' } = body;
      const io = deps?.io;
      let kicked = 0;
      if (io) {
        for (const [, sock] of io.sockets.sockets.entries()) {
          sock.emit('force-disconnect', { reason });
          sock.disconnect(true);
          kicked++;
        }
      }
      return sendJson(res, 200, { ok: true, data: { kicked } });
    }

    // ── Gemeinde-Rollen: Mitglieder einer Gemeinde abrufen ──────────────────
    if (req.method === 'GET' && pathname === '/api/admin/municipality-members') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const muniId = Number(requestUrl.searchParams.get('municipality_id') || 0);
      if (!muniId) return sendJson(res, 400, { ok: false, error: 'municipality_id fehlt' });
      const [rows] = await dbPool.query(
        `SELECT mm.user_id, mm.role, mm.joined_at, u.nickname
         FROM municipality_memberships mm
         JOIN users u ON u.id = mm.user_id
         WHERE mm.municipality_id = ?
         ORDER BY FIELD(mm.role,'owner','council','citizen','observer'), u.nickname`,
        [muniId]
      );
      return sendJson(res, 200, { ok: true, data: { members: rows } });
    }

    // ── Gemeinde-Rolle setzen (add oder update) ─────────────────────────────
    if (req.method === 'POST' && pathname === '/api/admin/municipality-role') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const body = await readJsonBody(req);
      const { municipality_id, user_id, role } = body;
      if (!municipality_id || !user_id || !role) return sendJson(res, 400, { ok: false, error: 'municipality_id, user_id und role erforderlich' });
      const validRoles = ['owner', 'council', 'citizen', 'observer'];
      if (!validRoles.includes(role)) return sendJson(res, 400, { ok: false, error: `Ungültige Rolle. Erlaubt: ${validRoles.join(', ')}` });
      // Prüfe ob User existiert und zur Gemeinde gehört
      const [[userRow]] = await dbPool.query(`SELECT id, nickname, municipality_id FROM users WHERE id = ?`, [user_id]);
      if (!userRow) return sendJson(res, 404, { ok: false, error: 'User nicht gefunden' });
      // Wenn User nicht Mitglied, erst zur Gemeinde hinzufügen
      if (userRow.municipality_id !== municipality_id) {
        await dbPool.query(`UPDATE users SET municipality_id = ? WHERE id = ?`, [municipality_id, user_id]);
      }
      // Upsert Mitgliedschaft mit neuer Rolle
      await dbPool.query(
        `INSERT INTO municipality_memberships (municipality_id, user_id, role, joined_at, created_at)
         VALUES (?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE role = VALUES(role)`,
        [municipality_id, user_id, role]
      );
      // Falls owner: alten owner auf council setzen
      if (role === 'owner') {
        await dbPool.query(
          `UPDATE municipality_memberships SET role = 'council'
           WHERE municipality_id = ? AND user_id != ? AND role = 'owner'`,
          [municipality_id, user_id]
        );
      }
      return sendJson(res, 200, { ok: true, data: { message: `${userRow.nickname} ist jetzt ${role} in der Gemeinde` } });
    }

    // ── Gemeinde-Mitglied entfernen ──────────────────────────────────────────
    if (req.method === 'DELETE' && pathname === '/api/admin/municipality-role') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const body = await readJsonBody(req);
      const { municipality_id, user_id } = body;
      if (!municipality_id || !user_id) return sendJson(res, 400, { ok: false, error: 'municipality_id und user_id erforderlich' });
      const [[mem]] = await dbPool.query(`SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`, [municipality_id, user_id]);
      if (!mem) return sendJson(res, 404, { ok: false, error: 'Mitgliedschaft nicht gefunden' });
      if (mem.role === 'owner') return sendJson(res, 400, { ok: false, error: 'Präsident kann nicht einfach entfernt werden — erst Rolle ändern' });
      await dbPool.query(`DELETE FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`, [municipality_id, user_id]);
      await dbPool.query(`UPDATE users SET municipality_id = NULL WHERE id = ? AND municipality_id = ?`, [user_id, municipality_id]);
      return sendJson(res, 200, { ok: true, data: { message: 'Mitglied entfernt' } });
    }

    // ══════════════════════════════════════════════════════════════
    // DATENBANK-BACKUP (SQL + ZIP)
    // ══════════════════════════════════════════════════════════════
    if (req.method === 'GET' && pathname === '/api/admin/backup') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });

      const archiver = require('archiver');
      const { Readable } = require('stream');

      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const sqlFilename = `backup_${ts}.sql`;
      const zipFilename = `backup_${ts}.zip`;

      // SQL-Dump komplett im Speicher aufbauen
      const lines = [];
      lines.push(`-- Buenzlifight DB Backup`);
      lines.push(`-- Erstellt: ${now.toISOString()}`);
      lines.push(`-- Server: ${process.env.DB_HOST || 'localhost'}`);
      lines.push('');
      lines.push('SET FOREIGN_KEY_CHECKS=0;');
      lines.push('SET SQL_MODE="NO_AUTO_VALUE_ON_ZERO";');
      lines.push('SET NAMES utf8mb4;');
      lines.push('');

      const [tables] = await dbPool.query('SHOW TABLES');
      const tableNames = tables.map(r => Object.values(r)[0]);

      for (const table of tableNames) {
        lines.push(`-- --------------------------------------------------------`);
        lines.push(`-- Tabelle: \`${table}\``);
        lines.push(`-- --------------------------------------------------------`);
        lines.push('');

        // CREATE TABLE
        const [[createRow]] = await dbPool.query(`SHOW CREATE TABLE \`${table}\``);
        const createSql = createRow['Create Table'] || createRow[Object.keys(createRow)[1]];
        lines.push(`DROP TABLE IF EXISTS \`${table}\`;`);
        lines.push(createSql + ';');
        lines.push('');

        // Daten als INSERT
        const [rows] = await dbPool.query(`SELECT * FROM \`${table}\``);
        if (rows.length > 0) {
          const cols = Object.keys(rows[0]).map(c => `\`${c}\``).join(', ');
          const escapeVal = v => {
            if (v === null || v === undefined) return 'NULL';
            if (typeof v === 'number') return String(v);
            if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
            if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
            return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
          };
          const chunks = [];
          for (let i = 0; i < rows.length; i += 500) chunks.push(rows.slice(i, i + 500));
          for (const chunk of chunks) {
            const vals = chunk.map(row => `(${Object.values(row).map(escapeVal).join(', ')})`).join(',\n  ');
            lines.push(`INSERT INTO \`${table}\` (${cols}) VALUES`);
            lines.push(`  ${vals};`);
          }
          lines.push('');
        }
      }

      lines.push('SET FOREIGN_KEY_CHECKS=1;');
      const sqlContent = lines.join('\n');

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', err => { console.error('[backup] archiver error:', err); if (!res.headersSent) res.end(); });
      archive.pipe(res);
      archive.append(Readable.from([sqlContent]), { name: sqlFilename });
      await archive.finalize();
      return;
    }

    if (req.method === 'GET' && pathname === '/api/admin/actions/server-info') {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const { roomRuntimeCache } = require('../../game/rooms');
      const mem = process.memoryUsage();
      const { wsRoomPlayers: roomPlayers } = require('../../ws/socketio/index');
      let activeSessions = 0;
      for (const [, players] of roomPlayers.entries()) activeSessions += players.size;
      return sendJson(res, 200, { ok: true, data: {
        uptime: process.uptime(),
        memHeapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        memHeapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        memRssMB: Math.round(mem.rss / 1024 / 1024),
        activeRooms: roomRuntimeCache.size,
        activeSessions,
        nodeVersion: process.version,
        pid: process.pid,
      }});
    }

  };
};
