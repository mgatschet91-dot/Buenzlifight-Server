'use strict';

const crypto = require('crypto');
const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { HARD_CODED_BUILDING_STATS } = require('../../../config/constants');
const { wsRoomPlayers } = require('../../../ws/socketio/index');

async function _requireAdmin(req, res) {
  ensureDbEnabled();
  const authUser = await getAuthenticatedUser(req);
  if (!authUser) { sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' }); return null; }
  if (authUser.global_role !== 'administrator') { sendJson(res, 403, { ok: false, error: 'Nur Admins' }); return null; }
  return authUser;
}

module.exports = function createSystemHandler(deps) {
  return async function handleAdminSystem(req, res, pathname, requestUrl) {

    // ── Gemeinden + Rooms ─────────────────────────────────────────

    if (req.method === 'GET' && pathname === '/api/admin/municipalities') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const q = requestUrl.searchParams.get('q') || '';
      const params = [];
      let where = '1=1';
      if (q) {
        const { escapeLike } = require('../../../shared/helpers');
        const like = `%${escapeLike(q.trim())}%`;
        where += ` AND (m.name LIKE ? OR m.slug LIKE ?)`;
        params.push(like, like);
      }
      const [rows] = await dbPool.query(
        `SELECT m.id, m.name, m.slug, m.canton_code, COALESCE(mc.cnt, 0) AS members_count
         FROM municipalities m
         LEFT JOIN (SELECT municipality_id, COUNT(*) AS cnt FROM users GROUP BY municipality_id) mc ON mc.municipality_id = m.id
         WHERE ${where} ORDER BY m.name ASC`, params);
      return sendJson(res, 200, { ok: true, data: { municipalities: rows } });
    }

    if (req.method === 'POST' && pathname === '/api/admin/rooms/rename') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
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
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const municipalityId = Number(requestUrl.searchParams.get('municipality_id') || 0);
      if (!municipalityId) return sendJson(res, 400, { ok: false, error: 'municipality_id erforderlich' });
      const [rows] = await dbPool.query(`SELECT id, room_code, city_name, player_count, is_active, created_at FROM game_rooms WHERE municipality_id = ? ORDER BY room_code ASC`, [municipalityId]);
      return sendJson(res, 200, { ok: true, data: { rooms: rows } });
    }

    // ── Frontend Errors ───────────────────────────────────────────

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
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const [rows] = await dbPool.query(
        `SELECT id, message, stack, component_stack, url, user_id, municipality_slug, count, first_seen, last_seen
         FROM frontend_errors ORDER BY last_seen DESC LIMIT 100`
      );
      return sendJson(res, 200, { ok: true, data: { errors: rows } });
    }

    if (req.method === 'DELETE' && pathname.match(/^\/api\/admin\/frontend-errors\/([0-9]+)$/i)) {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const errorId = Number(pathname.match(/\/([0-9]+)$/)[1]);
      await dbPool.query(`DELETE FROM frontend_errors WHERE id = ?`, [errorId]);
      return sendJson(res, 200, { ok: true, data: { deleted: true } });
    }

    // ── Stats ─────────────────────────────────────────────────────

    if (req.method === 'GET' && pathname === '/api/admin/stats') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const safeCount = async (sql) => { try { const [[row]] = await dbPool.query(sql); return Object.values(row)[0] || 0; } catch { return 0; } };
      const user_count = await safeCount(`SELECT COUNT(*) AS c FROM users`);
      const municipality_count = await safeCount(`SELECT COUNT(*) AS c FROM municipalities`);
      const event_count = await safeCount(`SELECT COUNT(*) AS c FROM municipality_events WHERE status IN ('detected','reported','assigned')`);
      const company_count = await safeCount(`SELECT COUNT(*) AS c FROM companies WHERE is_active = 1`);
      let online_count = 0;
      for (const roomPlayers of wsRoomPlayers.values()) online_count += roomPlayers.size;
      return sendJson(res, 200, { ok: true, data: { users: user_count, municipalities: municipality_count, active_events: event_count, companies: company_count, online_users: online_count, uptime: Math.round(process.uptime()) } });
    }

    // ── Debug: Power ──────────────────────────────────────────────

    if (req.method === 'GET' && pathname === '/api/admin/debug/power') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const municipalityId = Number(requestUrl.searchParams.get('municipality_id') || authUser.municipality_id || 0);
      if (!municipalityId) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugewiesen' });

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
      const bestRoom = roomsWithCounts[0];
      const roomCode = requestUrl.searchParams.get('room_code') || bestRoom?.room_code || 'MAIN';

      const [distinctTools] = await dbPool.query(
        `SELECT tool, action_type, COUNT(*) as cnt FROM game_items WHERE municipality_id = ? AND room_code = ? GROUP BY tool, action_type ORDER BY cnt DESC LIMIT 50`,
        [municipalityId, roomCode]
      );
      const [rows] = await dbPool.query(
        `SELECT id, action_type, tool, x, y, metadata FROM game_items WHERE municipality_id = ? AND room_code = ? AND (action_type = 'place' OR action_type = 'zone')`,
        [municipalityId, roomCode]
      );
      const { isNonEconomicTool, fetchItemDetails, inferCategoryFromTool } = require('../../../game/building');
      const _detailsList = await fetchItemDetails();
      const detailsByTool = new Map((Array.isArray(_detailsList) ? _detailsList : []).map((d) => [String(d.tool || '').toLowerCase(), d]));
      const HARDCODED_POWER_PROD = { solar_panel: 60, wind_turbine: 80 };
      const POWER_PLANT_OUTPUT = [0, 80, 180, 350, 620, 1000];
      const powerBuildings = [];
      const consumptionBuildings = [];
      let totalProduction = 0;
      let totalConsumption = 0;

      for (const row of rows) {
        let meta = {};
        try { meta = row.metadata ? (typeof row.metadata === 'object' ? row.metadata : JSON.parse(row.metadata)) : {}; } catch { meta = {}; }
        const rawTool = row.action_type === 'zone'
          ? String(meta.buildingType ?? meta.building_type ?? '').toLowerCase()
          : String(row.tool || '').toLowerCase();
        const tool = rawTool;
        if (!tool) continue;
        if (isNonEconomicTool(tool)) continue;
        if (row.action_type === 'zone' && !tool) continue;
        const level = Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1))));
        const constructionProgress = Number(meta.constructionProgress ?? meta.construction_progress ?? 100);
        const isConstructed = constructionProgress >= 100 || meta.constructed === true;
        const isAbandoned = meta.abandoned === true;
        if (!isConstructed || isAbandoned) continue;
        const _hcs = HARD_CODED_BUILDING_STATS.get(tool);
        const det = detailsByTool.get(tool);
        const hardcodedStats = {
          maxPop: det?.max_pop || _hcs?.maxPop || 0,
          maxJobs: det?.max_jobs || _hcs?.maxJobs || 0,
          powerConsumptionBase: det?.power_consumption_base || _hcs?.powerConsumptionBase || 0,
        };
        const metaPopRaw = Number(meta.population ?? meta.residents ?? meta.capacity_population);
        const metaJobsRaw = Number(meta.jobs ?? meta.workers ?? meta.capacity_jobs);
        const pop = (Number.isFinite(metaPopRaw) && metaPopRaw > 0) ? Math.round(metaPopRaw) : Math.round(Math.max(0, Number(hardcodedStats.maxPop)) * level * 0.8);
        const job = (Number.isFinite(metaJobsRaw) && metaJobsRaw > 0) ? Math.round(metaJobsRaw) : Math.round(Math.max(0, Number(hardcodedStats.maxJobs)) * level * 0.8);

        const isPowerProducer = tool.includes('power_plant') || tool.includes('solar_panel') || tool.includes('wind_turbine');
        if (isPowerProducer) {
          const metaPowerProd = Number(meta.powerProduction ?? meta.power_production);
          const hardcodedProd = HARDCODED_POWER_PROD[tool] || 0;
          const effectiveProd = (Number.isFinite(metaPowerProd) && metaPowerProd > 0) ? metaPowerProd : hardcodedProd;
          let prod = 0;
          if (effectiveProd > 0) prod = Math.round(effectiveProd * level);
          else if (tool.includes('power_plant')) prod = POWER_PLANT_OUTPUT[level] || 100;
          totalProduction += prod;
          powerBuildings.push({ tool, level, x: row.x, y: row.y, production: prod, source: effectiveProd > 0 ? (Number.isFinite(metaPowerProd) && metaPowerProd > 0 ? 'meta' : 'hardcoded') : 'power_plant_table', note: '×dynFactor zur Laufzeit' });
        }

        const category = inferCategoryFromTool(tool, '');
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
          cons = Math.max(1, Math.round(pop * 0.002 * (1 + (level - 1) * 0.15) * _dayNightFactor));
        } else if (category === 'commercial') {
          cons = Math.max(1, Math.round(job * 0.004 * (1 + (level - 1) * 0.15) * _dayNightFactor));
        } else if (category === 'industrial') {
          cons = Math.max(1, Math.round(job * 0.008 * (1 + (level - 1) * 0.15) * _dayNightFactor));
        } else if (hardcodedStats?.powerConsumptionBase > 0) {
          cons = Math.round(hardcodedStats.powerConsumptionBase * level * _dayNightFactor);
        } else {
          if (pop > 0) cons = Math.max(1, Math.round(pop * 0.002 * _dayNightFactor));
          else if (job > 0) cons = Math.max(1, Math.round(job * 0.004 * _dayNightFactor));
          else cons = 1;
        }
        if (cons > 0) { totalConsumption += cons; consumptionBuildings.push({ tool, level, consumption: cons }); }
      }

      consumptionBuildings.sort((a, b) => b.consumption - a.consumption);
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
        available_rooms: roomsWithCounts, distinct_tools: distinctTools,
        total_place_buildings: rows.length, power_buildings_found: powerBuildings.length,
        total_production_base_mw: totalProduction, total_consumption_base_mw: totalConsumption,
        note: 'Ohne Wetter/Saisonmultiplikator — Live-Werte leicht höher/niedriger',
        buildings: powerBuildings, consumption_summary: consumptionSummary, timestamp: Date.now(),
      }});
    }

    // ── Live-Sessions ─────────────────────────────────────────────

    if (req.method === 'GET' && pathname === '/api/admin/sessions') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const { wsRoomPlayers: roomPlayers, wsRoomMetadata, wsUserSockets: userSockets } = require('../../../ws/socketio/index');
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
      const [onlineRows] = await dbPool.query(
        `SELECT u.id, u.nickname, u.last_online_at FROM users u WHERE u.is_online = 1 ORDER BY u.last_online_at DESC LIMIT 100`
      );
      return sendJson(res, 200, { ok: true, data: { sessions, onlineDb: onlineRows, total: sessions.length } });
    }

    if (pathname.match(/^\/api\/admin\/sessions\/kick$/i) && req.method === 'POST') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const body = await readJsonBody(req);
      const { socketId } = body;
      const io = deps?.io;
      const sock = io?.sockets?.sockets?.get(socketId);
      if (sock) { sock.emit('force-disconnect', { reason: 'Admin-Kick' }); sock.disconnect(true); }
      return sendJson(res, 200, { ok: true, data: { kicked: !!sock } });
    }

    // ── Transaktionen ─────────────────────────────────────────────

    if (req.method === 'GET' && pathname === '/api/admin/transactions') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const limit = Math.min(Number(requestUrl.searchParams.get('limit') || 100), 500);
      const typeFilter = requestUrl.searchParams.get('type') || '';
      const minAmount = Number(requestUrl.searchParams.get('min') || 0);
      let sql = `
        SELECT bt.id, uba.user_id, bt.type, bt.direction, bt.amount, bt.balance_after,
               bt.description, bt.reference, bt.created_at, u.nickname
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
      const [types] = await dbPool.query(`SELECT DISTINCT type FROM bank_transactions ORDER BY type`);
      return sendJson(res, 200, { ok: true, data: { transactions: rows, types: types.map(t => t.type) } });
    }

    // ── Ranking ───────────────────────────────────────────────────

    if (req.method === 'GET' && pathname === '/api/admin/ranking') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
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

    // ── Server-Aktionen ───────────────────────────────────────────

    if (req.method === 'POST' && pathname === '/api/admin/actions/broadcast') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const body = await readJsonBody(req);
      const { message, title, type = 'info' } = body;
      if (!message) return sendJson(res, 422, { ok: false, error: 'message fehlt' });
      const io = deps?.io;
      if (io) io.emit('admin-broadcast', { title: title || 'Server-Nachricht', message, type, timestamp: Date.now() });
      return sendJson(res, 200, { ok: true, data: { sent: true } });
    }

    if (req.method === 'POST' && pathname === '/api/admin/actions/clear-cache') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const { invalidateRoomItemsCache } = require('../../../jobs/intervals');
      const { roomRuntimeCache } = require('../../../game/rooms');
      let cleared = 0;
      for (const [, entry] of roomRuntimeCache.entries()) {
        if (entry.municipalityId && entry.roomCode) { invalidateRoomItemsCache(entry.municipalityId, entry.roomCode); cleared++; }
      }
      return sendJson(res, 200, { ok: true, data: { cleared } });
    }

    if (req.method === 'POST' && pathname === '/api/admin/actions/kick-all') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
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

    if (req.method === 'GET' && pathname === '/api/admin/actions/server-info') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const { roomRuntimeCache } = require('../../../game/rooms');
      const mem = process.memoryUsage();
      const { wsRoomPlayers: roomPlayers } = require('../../../ws/socketio/index');
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

    // ── Gemeinde-Rollen ───────────────────────────────────────────

    if (req.method === 'GET' && pathname === '/api/admin/municipality-members') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
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

    if (req.method === 'POST' && pathname === '/api/admin/municipality-role') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
      const body = await readJsonBody(req);
      const { municipality_id, user_id, role } = body;
      if (!municipality_id || !user_id || !role) return sendJson(res, 400, { ok: false, error: 'municipality_id, user_id und role erforderlich' });
      const validRoles = ['owner', 'council', 'citizen', 'observer'];
      if (!validRoles.includes(role)) return sendJson(res, 400, { ok: false, error: `Ungültige Rolle. Erlaubt: ${validRoles.join(', ')}` });
      const [[userRow]] = await dbPool.query(`SELECT id, nickname, municipality_id FROM users WHERE id = ?`, [user_id]);
      if (!userRow) return sendJson(res, 404, { ok: false, error: 'User nicht gefunden' });
      if (userRow.municipality_id !== municipality_id) {
        await dbPool.query(`UPDATE users SET municipality_id = ? WHERE id = ?`, [municipality_id, user_id]);
      }
      await dbPool.query(
        `INSERT INTO municipality_memberships (municipality_id, user_id, role, joined_at, created_at)
         VALUES (?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE role = VALUES(role)`,
        [municipality_id, user_id, role]
      );
      if (role === 'owner') {
        await dbPool.query(
          `UPDATE municipality_memberships SET role = 'council'
           WHERE municipality_id = ? AND user_id != ? AND role = 'owner'`,
          [municipality_id, user_id]
        );
      }
      return sendJson(res, 200, { ok: true, data: { message: `${userRow.nickname} ist jetzt ${role} in der Gemeinde` } });
    }

    if (req.method === 'DELETE' && pathname === '/api/admin/municipality-role') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;
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

    // ── Datenbank-Backup ──────────────────────────────────────────

    if (req.method === 'GET' && pathname === '/api/admin/backup') {
      const authUser = await _requireAdmin(req, res); if (!authUser) return;

      const archiver = require('archiver');
      const { Readable } = require('stream');
      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const sqlFilename = `backup_${ts}.sql`;
      const zipFilename = `backup_${ts}.zip`;

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
        const [[createRow]] = await dbPool.query(`SHOW CREATE TABLE \`${table}\``);
        const createSql = createRow['Create Table'] || createRow[Object.keys(createRow)[1]];
        lines.push(`DROP TABLE IF EXISTS \`${table}\`;`);
        lines.push(createSql + ';');
        lines.push('');
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

  };
};
