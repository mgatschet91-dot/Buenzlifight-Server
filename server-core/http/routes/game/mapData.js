'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { logInfo } = require('../../../infra/logger');
const { ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { canBuildInMunicipality } = require('../../../auth/permissions');

const {
  fetchItemDetails,
  fetchItemCatalogVersion,
  fetchCatalogPages,
} = require('../../../game/building');

const {
  getGameMapForMunicipality,
  upsertGameMapForMunicipality,
} = require('../../../game/map');

const {
  getMunicipalityBySlug,
  getUserMunicipalityRole,
} = require('../../../game/municipality');

const {
  toJsonValue,
} = require('../../../shared/helpers');

const {
  fetchRivers,
} = require('../../shared');

const { isGlobalAdmin } = require('./_shared');

module.exports = function registerMapDataRoutes(/* deps */) {
  return async function handleMapData(req, res, pathname, requestUrl) {

    // ── Game-data rivers ───────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/game-data/rivers') {
      ensureDbEnabled();
      const cantonQuery = requestUrl.searchParams.get('canton');
      const municipalitySlugQuery = requestUrl.searchParams.get('municipality_slug');
      let canton = cantonQuery || null;
      let municipality = null;
      if (!canton && municipalitySlugQuery) {
        municipality = await getMunicipalityBySlug(municipalitySlugQuery.trim().toLowerCase());
        if (municipality) canton = municipality.canton_code;
      }
      const rivers = await fetchRivers(canton);
      return sendJson(res, 200, {
        ok: true,
        canton: canton ? canton.toUpperCase() : null,
        municipality: municipality ? {
          id: municipality.id,
          slug: municipality.slug,
          name: municipality.name,
          canton_code: municipality.canton_code,
        } : null,
        rivers,
      });
    }

    // ── Item details ───────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/game/item-details') {
      ensureDbEnabled();
      const details = await fetchItemDetails(null);
      const catalogVersion = await fetchItemCatalogVersion();
      const catalogPages = await fetchCatalogPages();
      return sendJson(res, 200, {
        ok: true,
        catalog_version: catalogVersion,
        items: details,
        count: details.length,
        catalog_pages: catalogPages,
      });
    }

    const itemDetailsMatch = pathname.match(/^\/api\/game\/item-details\/([^/]+)$/i);
    if (req.method === 'GET' && itemDetailsMatch) {
      ensureDbEnabled();
      const tool = decodeURIComponent(itemDetailsMatch[1]);
      const detail = await fetchItemDetails(tool);
      if (!detail) return sendJson(res, 404, { ok: false, error: 'Item-Detail nicht gefunden' });
      const catalogVersion = await fetchItemCatalogVersion();
      return sendJson(res, 200, { ok: true, catalog_version: catalogVersion, item: detail });
    }

    // ── Game-data map ──────────────────────────────────────────
    const mapPathMatch = pathname.match(/^\/api\/game-data\/map\/([a-z0-9-]+)$/i);
    if (mapPathMatch) {
      ensureDbEnabled();
      const municipalitySlug = mapPathMatch[1].toLowerCase();
      const municipality = await getMunicipalityBySlug(municipalitySlug);
      if (!municipality) {
        return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      }

      if (req.method === 'GET') {
        const row = await getGameMapForMunicipality(municipality.id);
        if (!row) {
          return sendJson(res, 200, {
            ok: true,
            exists: false,
            municipality: {
              id: municipality.id,
              slug: municipality.slug,
              name: municipality.name,
              canton_code: municipality.canton_code,
            },
          });
        }
        return sendJson(res, 200, {
          ok: true,
          exists: true,
          municipality: {
            id: municipality.id,
            slug: municipality.slug,
            name: municipality.name,
            canton_code: municipality.canton_code,
          },
          map: {
            grid_size: row.grid_size,
            map_data: toJsonValue(row.map_data),
            water_bodies: toJsonValue(row.water_bodies),
            seed: row.seed,
            generator_version: row.generator_version,
            generated_at: row.generated_at,
            updated_at: row.updated_at,
          },
        });
      }

      if (req.method === 'POST') {
        const authUser = await getAuthenticatedUser(req);
        if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
        if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
          logInfo('SECURITY', `User ${authUser.id} versuchte Map-Daten für Gemeinde ${municipality.slug} zu speichern (eigene municipality_id: ${authUser.municipality_id})`);
          return sendJson(res, 403, { ok: false, error: 'Keine Berechtigung für diese Gemeinde' });
        }
        const mapUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
        if (!canBuildInMunicipality(mapUserRole) && !isGlobalAdmin(authUser)) {
          return sendJson(res, 403, { ok: false, error: 'Beobachter dürfen die Map nicht verändern' });
        }
        const body = await readJsonBody(req);
        if (typeof body.map_data === 'undefined') {
          return sendJson(res, 422, { ok: false, error: 'map_data ist erforderlich' });
        }
        const gridSize = Number(body.grid_size || 50);
        if (!Number.isInteger(gridSize) || gridSize < 10 || gridSize > 500) {
          return sendJson(res, 422, { ok: false, error: 'grid_size ist ungültig (10-500)' });
        }
        // Strukturvalidierung: map_data muss ein Object oder Array sein
        if (typeof body.map_data !== 'object' || body.map_data === null) {
          return sendJson(res, 422, { ok: false, error: 'map_data muss ein Object oder Array sein' });
        }
        if (Array.isArray(body.map_data) && body.map_data.length > gridSize * gridSize) {
          return sendJson(res, 422, { ok: false, error: `map_data enthält zu viele Einträge (max ${gridSize * gridSize})` });
        }

        await upsertGameMapForMunicipality(municipality.id, {
          gridSize,
          mapData: body.map_data,
          waterBodies: body.water_bodies ?? null,
          seed: body.seed ? String(body.seed) : null,
          generatorVersion: body.generator_version ? String(body.generator_version) : null,
          generatedAt: body.generated_at ? new Date(body.generated_at) : new Date(),
        });

        return sendJson(res, 200, {
          ok: true,
          municipality: {
            id: municipality.id,
            slug: municipality.slug,
            name: municipality.name,
            canton_code: municipality.canton_code,
          },
          saved: true,
        });
      }
    }

  };
};
