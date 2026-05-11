'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { logInfo } = require('../../../infra/logger');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { canBuildInMunicipality } = require('../../../auth/permissions');

const {
  toItemsStatsShape,
  getRoom,
  getRoomItemRows,
  getRoomItemRowsForChunk,
  getRoomItemVersion,
  deleteRoomItems,
  importRoomItems,
  syncRoomItems,
  loadRoomStats,
} = require('../../../game/rooms');

const { invalidateRoomItemsCache } = require('../../../jobs/intervals');

const {
  formatGameItemRow,
  fetchItemDetails,
} = require('../../../game/building');

const { touchMunicipalityActivity } = require('../../../game/municipality');

const {
  ensureServerGeneratedRoomMap,
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

const { wsRoomKey } = require('../../../ws/socketio/helpers');

const {
  wsPublishAuthoritativeStats,
} = require('../../shared');

const { isGlobalAdmin } = require('./_shared');

module.exports = function registerItemsRoutes(deps) {
  const io = deps?.io;

  return async function handleItems(req, res, pathname, requestUrl) {

    // ── Items CRUD ─────────────────────────────────────────────
    const itemsRoomMatch = pathname.match(/^\/api\/game\/items\/([a-z0-9-]+)\/([a-z0-9-]+)$/i);
    if (itemsRoomMatch) {
      ensureDbEnabled();
      const municipalitySlug = itemsRoomMatch[1].toLowerCase();
      const roomCode = normalizeRoomCode(itemsRoomMatch[2]);
      const municipality = await getMunicipalityBySlug(municipalitySlug);
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      if (!roomCode) return sendJson(res, 422, { ok: false, error: 'roomCode ungültig' });

      if (req.method === 'GET') {
        const authUser = await getAuthenticatedUser(req);
        if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

        const rawCx = requestUrl.searchParams.get('cx');
        const rawCy = requestUrl.searchParams.get('cy');
        const rawChunkSize = requestUrl.searchParams.get('chunk_size');
        const isChunkRequest = rawCx !== null && rawCy !== null;

        await ensureServerGeneratedRoomMap(municipality, roomCode);
        // Teure Ticks nur beim Full-Load, nicht bei Chunk-Requests
        if (!isChunkRequest) {
          await runServerDisasterTick(municipality.id, roomCode);
          await runServerBuildingUpgradeTick(municipality.id, roomCode);
        }
        const room = await getRoom(municipality.id, roomCode);
        const roomState = toJsonValue(room?.game_state);
        const isNavigatorPublic = Boolean(roomCode.startsWith('PUB') || roomState?.navigator_public === true);
        const effectiveCityName = String(room?.city_name || municipality.name || roomCode);
        const rawStats = await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);
        const version = await getRoomItemVersion(municipality.id, roomCode);
        const mapRow = await getGameMapForMunicipality(municipality.id);
        const effectiveGridSize = isNavigatorPublic
          ? Math.max(6, Math.min(12, Math.round(Number(roomState?.room_size || 8))))
          : Number(mapRow?.grid_size || 50);

        let rows;
        if (isChunkRequest) {
          const cx = Math.max(0, parseInt(rawCx, 10) || 0);
          const cy = Math.max(0, parseInt(rawCy, 10) || 0);
          const chunkSize = Math.max(8, Math.min(64, parseInt(rawChunkSize, 10) || 20));
          rows = await getRoomItemRowsForChunk(municipality.id, roomCode, cx, cy, chunkSize);
        } else {
          rows = await getRoomItemRows(municipality.id, roomCode);
        }

        const formatted = rows.map(formatGameItemRow);
        const waterBodies = toJsonValue(mapRow?.water_bodies) || [];
        const stats = toItemsStatsShape(rawStats, waterBodies);
        return sendJson(res, 200, {
          ok: true,
          data: {
            room_code: roomCode,
            municipality_slug: municipality.slug,
            municipality_name: municipality.name,
            grid_size: effectiveGridSize,
            version,
            room_version: version,
            item_count: formatted.length,
            items: formatted,
            stats,
            city_name: effectiveCityName,
          },
        });
      }

      if (req.method === 'DELETE') {
        const authUser = await getAuthenticatedUser(req);
        if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
        if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
          return sendJson(res, 403, { ok: false, error: 'Keine Berechtigung für diese Gemeinde' });
        }
        const delUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
        if (!canBuildInMunicipality(delUserRole) && !isGlobalAdmin(authUser)) {
          return sendJson(res, 403, { ok: false, error: 'Beobachter dürfen die Map nicht verändern' });
        }
        const deleted = await deleteRoomItems(municipality.id, roomCode);
        invalidateRoomItemsCache(municipality.id, roomCode);
        await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
        return sendJson(res, 200, { ok: true, data: { deleted } });
      }
    }

    const itemsImportMatch = pathname.match(/^\/api\/game\/items\/([a-z0-9-]+)\/([a-z0-9-]+)\/import$/i);
    if (req.method === 'POST' && itemsImportMatch) {
      ensureDbEnabled();
      const municipalitySlug = itemsImportMatch[1].toLowerCase();
      const roomCode = normalizeRoomCode(itemsImportMatch[2]);
      const municipality = await getMunicipalityBySlug(municipalitySlug);
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { ok: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const importUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(importUserRole) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { ok: false, error: 'Beobachter dürfen die Map nicht verändern' });
      }
      const body = await readJsonBody(req);
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items) return sendJson(res, 422, { ok: false, error: 'items muss ein Array sein' });
      if (items.length > 5000) return sendJson(res, 422, { ok: false, error: 'Maximal 5000 Items erlaubt' });
      const result = await importRoomItems(
        municipality.id,
        roomCode,
        (body.client_id || 'system').toString(),
        authUser.id,
        items
      );
      invalidateRoomItemsCache(municipality.id, roomCode);
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
      return sendJson(res, 200, {
        ok: true,
        data: {
          deleted_old: result.deletedOld,
          total_imported: result.totalImported,
          new_version: result.newVersion,
        },
      });
    }

    const itemsRegenerateMatch = pathname.match(/^\/api\/game\/items\/([a-z0-9-]+)\/([a-z0-9-]+)\/regenerate$/i);
    if (req.method === 'POST' && itemsRegenerateMatch) {
      ensureDbEnabled();
      const municipalitySlug = itemsRegenerateMatch[1].toLowerCase();
      const roomCode = normalizeRoomCode(itemsRegenerateMatch[2]);
      const municipality = await getMunicipalityBySlug(municipalitySlug);
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      if (!roomCode) return sendJson(res, 422, { ok: false, error: 'roomCode ungültig' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { ok: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }

      const deleted = await deleteRoomItems(municipality.id, roomCode);
      invalidateRoomItemsCache(municipality.id, roomCode);
      const generated = await ensureServerGeneratedRoomMap(municipality, roomCode);
      const version = await getRoomItemVersion(municipality.id, roomCode);
      const rows = await getRoomItemRows(municipality.id, roomCode);
      const roomKey = wsRoomKey(municipality.slug, roomCode);
      try {
        await wsPublishAuthoritativeStats(io, roomKey, 'server-core-regenerate');
      } catch {
        // API-Antwort nicht fehlschlagen lassen.
      }
      return sendJson(res, 200, {
        ok: true,
        data: {
          deleted,
          generated: Boolean(generated?.generated),
          item_count: Array.isArray(rows) ? rows.length : 0,
          version,
          room_code: roomCode,
          municipality_slug: municipality.slug,
        },
      });
    }

    const itemsSyncMatch = pathname.match(/^\/api\/game\/items\/([a-z0-9-]+)\/([a-z0-9-]+)\/sync$/i);
    if (req.method === 'POST' && itemsSyncMatch) {
      ensureDbEnabled();
      const municipalitySlug = itemsSyncMatch[1].toLowerCase();
      const roomCode = normalizeRoomCode(itemsSyncMatch[2]);
      const municipality = await getMunicipalityBySlug(municipalitySlug);
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        logInfo('SECURITY', `User ${authUser.id} versuchte Items-Sync für Gemeinde ${municipality.slug} (eigene municipality_id: ${authUser.municipality_id})`);
        return sendJson(res, 403, { ok: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const syncUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(syncUserRole) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { ok: false, error: 'Beobachter dürfen die Map nicht verändern' });
      }
      const body = await readJsonBody(req);
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items) return sendJson(res, 422, { ok: false, error: 'items muss ein Array sein' });
      if (items.length > 5000) return sendJson(res, 422, { ok: false, error: 'Maximal 5000 Items erlaubt' });

      // Canton-restriction check: reject syncs that contain canton-locked tools
      try {
        const [cantonRows] = await dbPool.query(
          'SELECT canton_code FROM municipalities WHERE id = ? LIMIT 1',
          [municipality.id]
        );
        const municipalityCantonCode = cantonRows[0]?.canton_code || null;
        const distinctTools = [...new Set(items.map((i) => i.tool || i.furni_classname).filter(Boolean))];
        if (distinctTools.length > 0) {
          const [restrictedRows] = await dbPool.query(
            `SELECT tool FROM game_item_details WHERE tool IN (?) AND canton_code IS NOT NULL`,
            [distinctTools]
          );
          for (const r of restrictedRows) {
            const [detailRows] = await dbPool.query(
              'SELECT canton_code FROM game_item_details WHERE tool = ? LIMIT 1',
              [r.tool]
            );
            const requiredCanton = detailRows[0]?.canton_code;
            if (requiredCanton && requiredCanton !== municipalityCantonCode) {
              return sendJson(res, 403, {
                ok: false,
                error: `Das Gebäude "${r.tool}" ist nur für Gemeinden des Kantons ${requiredCanton} verfügbar.`,
              });
            }
          }
        }
      } catch (_) {}

      const result = await syncRoomItems(
        municipality.id,
        roomCode,
        (body.client_id || 'system').toString(),
        authUser.id,
        items
      );
      invalidateRoomItemsCache(municipality.id, roomCode);
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
      touchMunicipalityActivity(municipality.id, authUser.id).catch(() => {});
      return sendJson(res, 200, { ok: true, data: result });
    }

    // ── Legacy item aliases ────────────────────────────────────
    // Laravel-kompatible Aliase für bestehendes mapGame
    const legacyItemsGetMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/items\/([a-z0-9-]+)$/i);
    if (legacyItemsGetMatch && req.method === 'GET') {
      const legacyAuthUser = await getAuthenticatedUser(req);
      if (!legacyAuthUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      req.url = `/api/game/items/${legacyItemsGetMatch[1]}/${legacyItemsGetMatch[2]}`;
      // Rekursion vermeiden: direkt gleich behandeln
      const municipality = await getMunicipalityBySlug(legacyItemsGetMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      const roomCode = normalizeRoomCode(legacyItemsGetMatch[2]);

      const legacyRawCx = requestUrl.searchParams.get('cx');
      const legacyRawCy = requestUrl.searchParams.get('cy');
      const legacyRawChunkSize = requestUrl.searchParams.get('chunk_size');
      const isLegacyChunkRequest = legacyRawCx !== null && legacyRawCy !== null;
      const isLegacyMetaOnly = requestUrl.searchParams.get('meta_only') === '1';

      // Chunk-Requests: teure Full-Scans überspringen (jeder Chunk würde sonst alle Items laden)
      if (!isLegacyChunkRequest && !isLegacyMetaOnly) {
        await ensureServerGeneratedRoomMap(municipality, roomCode);
        await runServerDisasterTick(municipality.id, roomCode);
        await runServerBuildingUpgradeTick(municipality.id, roomCode);
      }
      const room = await getRoom(municipality.id, roomCode);
      const roomState = toJsonValue(room?.game_state);
      const isNavigatorPublic = Boolean(roomCode.startsWith('PUB') || roomState?.navigator_public === true);
      const effectiveCityName = String(room?.city_name || municipality.name || roomCode);
      // Chunk-Requests: gecachte Stats verwenden statt alle Items neu zu scannen
      const rawStats = (isLegacyChunkRequest || isLegacyMetaOnly)
        ? (await loadRoomStats(municipality.id, roomCode) || {})
        : await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);
      const version = await getRoomItemVersion(municipality.id, roomCode);
      const mapRow = await getGameMapForMunicipality(municipality.id);
      const effectiveGridSize = isNavigatorPublic
        ? Math.max(6, Math.min(12, Math.round(Number(roomState?.room_size || 8))))
        : Number(mapRow?.grid_size || 50);

      let legacyRows;
      if (isLegacyMetaOnly) {
        legacyRows = []; // Meta-Only: keine Items laden, nur Metadata zurückgeben
      } else if (isLegacyChunkRequest) {
        const cx = Math.max(0, parseInt(legacyRawCx, 10) || 0);
        const cy = Math.max(0, parseInt(legacyRawCy, 10) || 0);
        const chunkSize = Math.max(8, Math.min(64, parseInt(legacyRawChunkSize, 10) || 20));
        legacyRows = await getRoomItemRowsForChunk(municipality.id, roomCode, cx, cy, chunkSize);
      } else {
        legacyRows = await getRoomItemRows(municipality.id, roomCode);
      }
      const formatted = legacyRows.map(formatGameItemRow);
      const waterBodies = toJsonValue(mapRow?.water_bodies) || [];
      const stats = toItemsStatsShape(rawStats, waterBodies);
      return sendJson(res, 200, {
        success: true,
        data: {
          room_code: roomCode,
          municipality_slug: municipality.slug,
          municipality_name: municipality.name,
          grid_size: effectiveGridSize,
          version,
          room_version: version,
          item_count: formatted.length,
          items: formatted,
          stats,
          city_name: effectiveCityName,
          meta_only: isLegacyMetaOnly || undefined,
        },
      });
    }
    if (legacyItemsGetMatch && req.method === 'DELETE') {
      const municipality = await getMunicipalityBySlug(legacyItemsGetMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        logInfo('SECURITY', `User ${authUser.id} versuchte Items-Delete für Gemeinde ${municipality.slug} (eigene municipality_id: ${authUser.municipality_id})`);
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const delUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(delUserRole) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Beobachter dürfen die Map nicht verändern' });
      }
      const roomCode = normalizeRoomCode(legacyItemsGetMatch[2]);
      const deleted = await deleteRoomItems(municipality.id, roomCode);
      invalidateRoomItemsCache(municipality.id, roomCode);
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
      return sendJson(res, 200, { success: true, data: { deleted } });
    }

    const legacyImportMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/items\/import$/i);
    if (legacyImportMatch && req.method === 'POST') {
      const municipality = await getMunicipalityBySlug(legacyImportMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        logInfo('SECURITY', `User ${authUser.id} versuchte Items-Import für Gemeinde ${municipality.slug} (eigene municipality_id: ${authUser.municipality_id})`);
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const importUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(importUserRole) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Beobachter dürfen die Map nicht verändern' });
      }
      const body = await readJsonBody(req);
      const roomCode = normalizeRoomCode(body.room_code);
      const items = Array.isArray(body.items) ? body.items : null;
      if (!roomCode || !items) return sendJson(res, 422, { success: false, error: 'room_code/items ungültig' });
      const result = await importRoomItems(municipality.id, roomCode, (body.client_id || 'system').toString(), authUser.id, items);
      invalidateRoomItemsCache(municipality.id, roomCode);
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
      return sendJson(res, 200, {
        success: true,
        data: {
          deleted_old: result.deletedOld,
          total_imported: result.totalImported,
          new_version: result.newVersion,
        },
      });
    }

    const legacyRegenerateMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/items\/([a-z0-9-]+)\/regenerate$/i);
    if (legacyRegenerateMatch && req.method === 'POST') {
      const municipality = await getMunicipalityBySlug(legacyRegenerateMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const roomCode = normalizeRoomCode(legacyRegenerateMatch[2]);
      if (!roomCode) return sendJson(res, 422, { success: false, error: 'roomCode ungültig' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }

      const deleted = await deleteRoomItems(municipality.id, roomCode);
      invalidateRoomItemsCache(municipality.id, roomCode);
      const generated = await ensureServerGeneratedRoomMap(municipality, roomCode);
      const version = await getRoomItemVersion(municipality.id, roomCode);
      const rows = await getRoomItemRows(municipality.id, roomCode);
      const roomKey = wsRoomKey(municipality.slug, roomCode);
      try {
        await wsPublishAuthoritativeStats(io, roomKey, 'server-core-regenerate');
      } catch {
        // API-Antwort nicht fehlschlagen lassen.
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          deleted,
          generated: Boolean(generated?.generated),
          item_count: Array.isArray(rows) ? rows.length : 0,
          version,
          room_code: roomCode,
          municipality_slug: municipality.slug,
        },
      });
    }

    const legacySyncMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/items\/sync$/i);
    if (legacySyncMatch && req.method === 'POST') {
      const municipality = await getMunicipalityBySlug(legacySyncMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        logInfo('SECURITY', `User ${authUser.id} versuchte Legacy-Sync für Gemeinde ${municipality.slug} (eigene municipality_id: ${authUser.municipality_id})`);
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const legSyncUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(legSyncUserRole) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Beobachter dürfen die Map nicht verändern' });
      }
      const body = await readJsonBody(req);
      const roomCode = normalizeRoomCode(body.room_code);
      const items = Array.isArray(body.items) ? body.items : null;
      if (!roomCode || !items) return sendJson(res, 422, { success: false, error: 'room_code/items ungültig' });
      const result = await syncRoomItems(municipality.id, roomCode, (body.client_id || 'system').toString(), authUser.id, items);
      invalidateRoomItemsCache(municipality.id, roomCode);
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
      return sendJson(res, 200, { success: true, data: result });
    }

  };
};
