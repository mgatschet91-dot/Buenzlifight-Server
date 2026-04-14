'use strict';

const { sendJson } = require('../../../infra/http');
const { getAuthenticatedUser } = require('../../../auth/middleware');

const {
  fetchItemDetails,
} = require('../../../game/building');

const {
  fetchMunicipalities,
  fetchCantonMunicipalities,
} = require('../../../game/municipality');

module.exports = function registerBuildingTypesRoutes(/* deps */) {
  return async function handleBuildingTypes(req, res, pathname /*, requestUrl */) {

    // ── Building types ─────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/game/building-types') {
      const details = await fetchItemDetails(null);
      const categories = {
        residential: [],
        commercial: [],
        industrial: [],
        infrastructure: [],
        public_service: [],
        parks: [],
        tourism: [],
        special: [],
      };
      for (const d of details) {
        const category = String(d.category || 'special');
        const target = categories[category] || categories.special;
        target.push({
          key: d.tool,
          name: d.display_name || d.tool,
          icon: d.tool,
          base_cost: Number(d.build_cost || 0),
          price: Number((d.price ?? d.build_cost) || 0),
        });
      }
      return sendJson(res, 200, { success: true, data: categories });
    }

    // ── Canton ──────────────────────────────────────────────────
    const cantonMatch = pathname.match(/^\/api\/game\/canton\/([a-z]{2})$/i);
    if (req.method === 'GET' && cantonMatch) {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const cantonCode = cantonMatch[1].toUpperCase();
      const municipalities = await fetchCantonMunicipalities(cantonCode);
      if (municipalities.length === 0) {
        return sendJson(res, 404, { success: false, error: 'Kanton nicht gefunden oder keine Gemeinden aktiv' });
      }
      const cantonName = municipalities[0].canton_name || cantonCode;
      const mappedMunicipalities = municipalities.map((m) => ({
        id: Number(m.id),
        name: m.name,
        slug: m.slug,
        bfs_number: '',
        is_capital: false,
        population: 0,
        coordinates: { lat: 47.0, lng: 8.0 },
        level: 1,
        owner: null,
      }));
      return sendJson(res, 200, {
        success: true,
        data: {
          canton: {
            code: cantonCode,
            name: cantonName,
            municipality_count: mappedMunicipalities.length,
          },
          stats: {
            total_xp: 0,
            total_value: 0,
            average_level: 1,
            total_buildings: 0,
            total_population: 0,
          },
          municipalities: mappedMunicipalities,
        },
      });
    }

    // ── Switzerland ─────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/game/switzerland') {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipalities = await fetchMunicipalities();
      const byCanton = new Map();
      for (const m of municipalities) {
        const code = String(m.canton_code || '').toUpperCase();
        if (!byCanton.has(code)) {
          byCanton.set(code, { code, name: m.canton_name || code, count: 0 });
        }
        byCanton.get(code).count += 1;
      }
      const cantons = Array.from(byCanton.values()).sort((a, b) => a.code.localeCompare(b.code));
      return sendJson(res, 200, {
        success: true,
        data: {
          overview: {
            total_municipalities: municipalities.length,
            total_xp: 0,
            total_value: 0,
            total_buildings: 0,
            active_players: 0,
          },
          cantons: cantons.map((c) => ({
            code: c.code,
            name: c.name,
            stats: {
              total_xp: 0,
              total_value: 0,
              average_level: 1,
              total_buildings: 0,
              total_population: 0,
            },
          })),
        },
      });
    }

  };
};
