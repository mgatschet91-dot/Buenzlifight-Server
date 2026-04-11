'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { canBuildInMunicipality } = require('../../../auth/permissions');

const {
  loadRoomStats,
  saveRoomStats,
  buildServerTimePayload,
  toStatsApiShape,
  toItemsStatsShape,
  getRoomItemVersion,
  getRoomItemRows,
  getRoom,
} = require('../../../game/rooms');

const {
  formatGameItemRow,
} = require('../../../game/building');

const {
  refreshGameDataMapFromItems,
  getGameMapForMunicipality,
} = require('../../../game/map');

const {
  getMunicipalityBySlug,
  getUserMunicipalityRole,
} = require('../../../game/municipality');

const {
  recomputeAuthoritativePopulationAndJobs,
} = require('../../../game/stats');

const {
  runServerDisasterTick,
  runServerBuildingUpgradeTick,
} = require('../../../game/disasters');

const {
  normalizeRoomCode,
  toJsonValue,
} = require('../../../shared/helpers');

const {
  MUNICIPALITY_ROLE_OWNER,
  MUNICIPALITY_ROLE_COUNCIL,
} = require('../../../config/constants');

const { wsRoomKey } = require('../../../ws/socketio/helpers');

const {
  markItemsConstructed,
  processConstructionSyncAndBroadcast,
  wsPublishAuthoritativeStats,
} = require('../../shared');

const { isGlobalAdmin } = require('./_shared');

module.exports = function registerStatsRoutes(deps) {
  const io = deps?.io;

  return async function handleStats(req, res, pathname, requestUrl) {

    // ── Stats ──────────────────────────────────────────────────
    const municipalityStatsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/stats\/([a-z0-9-]+)$/i);
    if (municipalityStatsMatch) {
      const municipality = await getMunicipalityBySlug(municipalityStatsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const roomCode = normalizeRoomCode(municipalityStatsMatch[2]);
      if (req.method === 'POST') {
        ensureDbEnabled();
        const authUser = await getAuthenticatedUser(req);
        if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
        if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
          return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
        }
        const userRole = await getUserMunicipalityRole(authUser.id, municipality.id);
        if (userRole !== MUNICIPALITY_ROLE_OWNER && userRole !== MUNICIPALITY_ROLE_COUNCIL && !isGlobalAdmin(authUser)) {
          return sendJson(res, 403, { success: false, error: 'Nur Besitzer oder Verwaltung dürfen Steuern ändern' });
        }

        const body = await readJsonBody(req);
        const incomingTaxRate = Number(body?.taxRate);
        if (!Number.isFinite(incomingTaxRate)) {
          return sendJson(res, 422, { success: false, error: 'taxRate ist erforderlich' });
        }
        const taxRate = Math.max(0, Math.min(100, Math.round(incomingTaxRate)));

        const raw = (await loadRoomStats(municipality.id, roomCode)) || {};
        const next = { ...(raw || {}) };
        next.tax_rate = taxRate;
        next.taxRate = taxRate;

        const mapData = next.game_map_data && typeof next.game_map_data === 'object'
          ? { ...next.game_map_data }
          : {};
        const settings = mapData.settings && typeof mapData.settings === 'object'
          ? { ...mapData.settings }
          : {};
        settings.taxRate = taxRate;
        settings.effectiveTaxRate = Number.isFinite(Number(settings.effectiveTaxRate))
          ? Number(settings.effectiveTaxRate)
          : taxRate;
        mapData.settings = settings;
        next.game_map_data = mapData;

        await saveRoomStats(municipality.id, roomCode, next);
        const recomputed = await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);

        const roomKey = wsRoomKey(municipality.slug, roomCode);
        try {
          await wsPublishAuthoritativeStats(io, roomKey, String(authUser.id));
        } catch {
          // REST-Antwort nicht fehlschlagen lassen, falls WS kurz nicht verfügbar ist.
        }

        return sendJson(res, 200, { success: true, data: toStatsApiShape(recomputed) });
      }
      if (req.method === 'GET') {
        await runServerDisasterTick(municipality.id, roomCode);
        await runServerBuildingUpgradeTick(municipality.id, roomCode);
        const raw = await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);
        const shaped = toStatsApiShape(raw);
        return sendJson(res, 200, { success: true, data: shaped });
      }
    }

    const municipalityTimeMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/time\/([a-z0-9-]+)$/i);
    if (municipalityTimeMatch && req.method === 'GET') {
      const municipality = await getMunicipalityBySlug(municipalityTimeMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      return sendJson(res, 200, { success: true, data: buildServerTimePayload() });
    }

    // ── Construction sync ──────────────────────────────────────
    const municipalityItemsConstructedMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/items\/constructed$/i);
    if (municipalityItemsConstructedMatch && req.method === 'PATCH') {
      const municipality = await getMunicipalityBySlug(municipalityItemsConstructedMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        const { logInfo } = require('../../../infra/logger');
        logInfo('SECURITY', `User ${authUser.id} versuchte Construction-Sync für Gemeinde ${municipality.slug} (eigene municipality_id: ${authUser.municipality_id})`);
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const constructUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(constructUserRole) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Beobachter dürfen die Map nicht verändern' });
      }
      const body = await readJsonBody(req);
      const roomCode = normalizeRoomCode(body.room_code);
      const positions = Array.isArray(body.positions) ? body.positions : [];
      const data = await processConstructionSyncAndBroadcast({
        municipality,
        roomCode,
        positions,
        io,
        sourcePlayerId: 'construction-sync-http',
      });
      return sendJson(res, 200, {
        success: true,
        data,
      });
    }

    const municipalityItemsStatsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/items\/stats$/i);
    if (municipalityItemsStatsMatch && req.method === 'GET') {
      const municipality = await getMunicipalityBySlug(municipalityItemsStatsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const roomCode = normalizeRoomCode(requestUrl.searchParams.get('room_code') || '');
      const [rows] = await dbPool.query(
        `SELECT action_type, COUNT(*) AS count
         FROM game_items
         WHERE municipality_id = ? ${roomCode ? 'AND room_code = ?' : ''}
         GROUP BY action_type`,
        roomCode ? [municipality.id, roomCode] : [municipality.id]
      );
      const byType = {};
      for (const row of rows) byType[row.action_type] = Number(row.count);
      return sendJson(res, 200, {
        success: true,
        data: {
          total_items: Object.values(byType).reduce((s, n) => s + Number(n), 0),
          by_type: byType,
        },
      });
    }

    // ── Stats-history ──────────────────────────────────────────
    const statsHistoryMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/stats-history$/i);
    if (statsHistoryMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const municipality = await getMunicipalityBySlug(statsHistoryMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const days = Math.min(365, Math.max(1, parseInt(urlObj.searchParams.get('days') || '90', 10)));

      const [historyRows] = await dbPool.query(
        `SELECT snapshot_date AS date, population, jobs, money, income, expenses, happiness
         FROM municipality_stats_history
         WHERE municipality_id = ? AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         ORDER BY snapshot_date ASC`,
        [municipality.id, days]
      );

      return sendJson(res, 200, { ok: true, data: historyRows });
    }

    // ── Funnel: letzte 7 Tage aggregiert über alle Gemeinden ──
    if (pathname === '/api/stats/funnel' && req.method === 'GET') {
      ensureDbEnabled();
      const [rows] = await dbPool.query(`
        SELECT
          snapshot_date                       AS date,
          SUM(income)                         AS total_income,
          SUM(expenses)                       AS total_expenses,
          SUM(power_production)               AS total_power_production,
          SUM(power_consumption)              AS total_power_consumption,
          SUM(solar_production)               AS total_solar_production,
          SUM(water_production)               AS total_water_production,
          SUM(water_consumption)              AS total_water_consumption,
          SUM(population)                     AS total_population,
          COUNT(DISTINCT municipality_id)     AS municipality_count
        FROM municipality_stats_history
        WHERE snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY snapshot_date
        ORDER BY snapshot_date ASC
      `);
      return sendJson(res, 200, {
        ok: true,
        data: rows.map(r => ({
          date:                   r.date,
          total_income:           Number(r.total_income           || 0),
          total_expenses:         Number(r.total_expenses         || 0),
          total_power_production: Number(r.total_power_production || 0),
          total_power_consumption:Number(r.total_power_consumption|| 0),
          total_solar_production: Number(r.total_solar_production || 0),
          total_water_production: Number(r.total_water_production || 0),
          total_water_consumption:Number(r.total_water_consumption|| 0),
          total_population:       Number(r.total_population       || 0),
          municipality_count:     Number(r.municipality_count     || 0),
        })),
      });
    }

    // ── Ranking: Top 5 Gemeinden pro Kategorie ──
    if (pathname === '/api/stats/ranking' && req.method === 'GET') {
      ensureDbEnabled();
      const categories = [
        { key: 'population',       col: 'ms.population',        label: 'Bevölkerung',     unit: '' },
        { key: 'power_production', col: 'ms.power_production',  label: 'Stromproduktion', unit: 'MW' },
        { key: 'solar_production', col: 'ms.solar_production',  label: 'Solar',           unit: 'MW' },
        { key: 'water_production', col: 'ms.water_production',  label: 'Wasserproduktion',unit: 'm³/h' },
        { key: 'jobs',             col: 'ms.jobs',              label: 'Arbeitsplätze',   unit: '' },
        { key: 'treasury',         col: 'ms.treasury',          label: 'Gemeindekasse',   unit: 'CHF' },
      ];
      const result = {};
      for (const cat of categories) {
        const [rows] = await dbPool.query(
          `SELECT m.name, m.slug, ${cat.col} AS value
           FROM municipality_stats ms
           JOIN municipalities m ON m.id = ms.municipality_id
           WHERE ms.population > 0 AND ${cat.col} > 0
           ORDER BY ${cat.col} DESC
           LIMIT 5`
        );
        result[cat.key] = { label: cat.label, unit: cat.unit, entries: rows.map(r => ({ name: r.name, slug: r.slug, value: Number(r.value) })) };
      }
      return sendJson(res, 200, { ok: true, data: result });
    }

    // ── Regional Funnel: aggregierte Strom + Wasser über alle Gemeinden ──
    if (pathname === '/api/stats/regional' && req.method === 'GET') {
      ensureDbEnabled();
      const [rows] = await dbPool.query(`
        SELECT
          COUNT(*)                        AS municipality_count,
          SUM(population)                 AS total_population,
          SUM(jobs)                       AS total_jobs,
          SUM(power_production)           AS total_power_production,
          SUM(power_consumption)          AS total_power_consumption,
          SUM(water_production)           AS total_water_production,
          SUM(water_consumption)          AS total_water_consumption,
          SUM(water_storage_capacity)     AS total_water_storage_capacity,
          SUM(water_storage_level)        AS total_water_storage_level,
          SUM(CASE WHEN power_production < power_consumption THEN 1 ELSE 0 END) AS municipalities_power_deficit,
          SUM(CASE WHEN water_production < water_consumption THEN 1 ELSE 0 END) AS municipalities_water_deficit
        FROM municipality_stats
        WHERE population > 0
      `);
      const data = rows[0] || {};
      return sendJson(res, 200, {
        ok: true,
        data: {
          municipality_count:           Number(data.municipality_count  || 0),
          total_population:             Number(data.total_population    || 0),
          total_jobs:                   Number(data.total_jobs          || 0),
          total_power_production:       Number(data.total_power_production  || 0),
          total_power_consumption:      Number(data.total_power_consumption || 0),
          total_water_production:       Number(data.total_water_production  || 0),
          total_water_consumption:      Number(data.total_water_consumption || 0),
          total_water_storage_capacity: Number(data.total_water_storage_capacity || 0),
          total_water_storage_level:    Number(data.total_water_storage_level    || 0),
          municipalities_power_deficit: Number(data.municipalities_power_deficit || 0),
          municipalities_water_deficit: Number(data.municipalities_water_deficit || 0),
        },
      });
    }

  };
};
