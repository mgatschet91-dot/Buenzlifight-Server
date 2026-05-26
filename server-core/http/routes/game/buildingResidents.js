'use strict';

const { sendJson } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { logError } = require('../../../infra/logger');

// GET /api/game/:slug/residents-at?x=:x&y=:y
// Gibt alle Bürger zurück die in dem Wohngebäude an Position (x,y) leben.
// Öffentlich lesbar — Daten sind deterministisch aus Seeds generiert.

module.exports = function registerBuildingResidentsRoutes(_deps) {
  return async function handleBuildingResidents(req, res, pathname, requestUrl) {
    if (req.method !== 'GET') return;

    const slugMatch = pathname.match(/^\/api\/game\/([^/]+)\/residents-at$/);
    if (!slugMatch) return;

    const slug = slugMatch[1];
    const x = parseInt(requestUrl.searchParams.get('x') ?? '', 10);
    const y = parseInt(requestUrl.searchParams.get('y') ?? '', 10);

    if (isNaN(x) || isNaN(y)) {
      return sendJson(res, 400, { ok: false, error: 'x und y erforderlich' });
    }

    ensureDbEnabled();
    try {
      // Gemeinde-ID über slug ermitteln
      const [[muni]] = await dbPool.query(
        `SELECT id FROM municipalities WHERE slug = ? LIMIT 1`,
        [slug]
      );
      if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      // Gebäude an dieser Position suchen — place-Item ODER zone-evolved
      const [[building]] = await dbPool.query(
        `SELECT gi.id,
                CASE
                  WHEN gi.action_type = 'zone'
                  THEN JSON_UNQUOTE(JSON_EXTRACT(gi.metadata, '$.buildingType'))
                  ELSE gi.tool
                END AS tool,
                gi.action_type,
                COALESCE(gid.category, 'residential') AS category
         FROM game_items gi
         LEFT JOIN game_item_details gid
               ON gid.tool = CASE
                               WHEN gi.action_type = 'zone'
                               THEN JSON_UNQUOTE(JSON_EXTRACT(gi.metadata, '$.buildingType'))
                               ELSE gi.tool
                             END
         WHERE gi.municipality_id = ?
           AND gi.x = ? AND gi.y = ?
           AND gi.action_type IN ('place', 'zone')
         LIMIT 1`,
        [muni.id, x, y]
      );

      if (!building || !building.tool) {
        return sendJson(res, 200, { ok: true, families: [], total: 0 });
      }

      // Nur residential anzeigen
      const RESIDENTIAL_TYPES = new Set([
        'house_small', 'house_medium', 'mansion',
        'apartment_low', 'apartment_high', 'cabin_house',
      ]);
      if (building.category !== 'residential' && !RESIDENTIAL_TYPES.has(building.tool)) {
        return sendJson(res, 200, { ok: true, families: [], total: 0 });
      }

      // Alle Bürger dieses Gebäudes inklusive Familienzugehörigkeit
      const [rows] = await dbPool.query(
        `SELECT
           c.id,
           c.name_seed,
           c.age,
           c.gender,
           c.nationality_id,
           c.education,
           c.has_car,
           c.happiness,
           c.workplace_id,
           f.id AS family_id,
           f.surname_seed
         FROM citizens c
         LEFT JOIN families f ON c.family_id = f.id
         WHERE c.home_building_id = ?
         ORDER BY f.id, c.age DESC`,
        [building.id]
      );

      // Bürger nach Familien gruppieren
      const familyMap = new Map();
      for (const row of rows) {
        const fid = row.family_id ?? row.id;
        if (!familyMap.has(fid)) {
          familyMap.set(fid, {
            familyId: fid,
            surnameSeed: row.surname_seed ?? row.name_seed,
            members: [],
          });
        }
        familyMap.get(fid).members.push({
          id:            row.id,
          nameSeed:      row.name_seed,
          age:           row.age,
          gender:        row.gender,
          nationalityId: row.nationality_id,
          education:     row.education,
          hasCar:        row.has_car,
          happiness:     row.happiness,
          hasJob:        row.workplace_id !== null,
        });
      }

      const families = Array.from(familyMap.values());

      return sendJson(res, 200, {
        ok: true,
        buildingId: building.id,
        tool: building.tool,
        families,
        total: rows.length,
      });
    } catch (err) {
      logError('buildingResidents.GET', err);
      return sendJson(res, 500, { ok: false, error: 'Interner Fehler' });
    }
  };
};
