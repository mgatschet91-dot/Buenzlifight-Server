'use strict';

const fs = require('fs');
const path = require('path');
const { sendJson, readJsonBody } = require('../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../infra/db');
const { getAuthenticatedUser } = require('../../auth/middleware');
const {
  municipalityRoleRank,
  normalizeMunicipalityRole,
  canManageMunicipality,
  canInviteToMunicipality,
} = require('../../auth/permissions');
const {
  MUNICIPALITY_MEMBER_LIMIT,
  MUNICIPALITY_ROLE_OWNER,
  MUNICIPALITY_ROLE_COUNCIL,
  MUNICIPALITY_ROLE_CITIZEN,
  MUNICIPALITY_ROLE_OBSERVER,
  COAT_OF_ARMS_UPLOAD_DIR,
  MINIMAP_UPLOAD_DIR,
  GLOBAL_ROLE_ADMINISTRATOR,
} = require('../../config/constants');

function isGlobalAdmin(authUser) {
  return String(authUser?.global_role || '').toLowerCase() === GLOBAL_ROLE_ADMINISTRATOR;
}
const { normalizeRoomCode, parsePngDataUrl } = require('../../shared/helpers');
const {
  fetchMunicipalities,
  searchMunicipalitiesForPartnerships,
  getMunicipalityBySlug,
  getMunicipalityAdministration,
  getUserMunicipalityRole,
  ensureMinimapUploadDir,
  saveMinimapPng,
  buildCoatOfArmsImageUrl,
  getMunicipalityCoatOfArmsRecord,
  deleteMunicipalityCoatOfArms,
  saveMunicipalityCoatOfArmsPng,
  resolveMunicipalityCoatOfArmsDto,
  syncMunicipalityMemberships,
} = require('../../game/municipality');
const { createOrGetRoom, updateRoomState } = require('../../game/rooms');

module.exports = function registerMunicipalityRoutes(deps) {
  return async function handleMunicipalities(req, res, pathname, requestUrl) {

    // GET /api/municipalities
    if (req.method === 'GET' && pathname === '/api/municipalities') {
      const municipalities = await fetchMunicipalities();
      return sendJson(res, 200, { ok: true, municipalities, member_limit: MUNICIPALITY_MEMBER_LIMIT });
    }

    // GET /api/game/municipalities/search
    if (req.method === 'GET' && pathname === '/api/game/municipalities/search') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const q = String(requestUrl.searchParams.get('q') || '');
      const limit = Math.min(500, Math.max(1, Number(requestUrl.searchParams.get('limit')) || 500));
      const municipalities = await searchMunicipalitiesForPartnerships(q, limit);
      return sendJson(res, 200, {
        success: true,
        data: {
          municipalities,
          count: municipalities.length,
        },
      });
    }

    // GET /api/game/municipality/:slug/coat-of-arms/image
    const municipalityCoatOfArmsImageMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/coat-of-arms\/image$/i);
    if (municipalityCoatOfArmsImageMatch && req.method === 'GET') {
      ensureDbEnabled();
      const slug = municipalityCoatOfArmsImageMatch[1].toLowerCase();
      const municipality = await getMunicipalityBySlug(slug);
      if (!municipality) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: 'Gemeinde nicht gefunden' }));
      }
      const coatRecord = await getMunicipalityCoatOfArmsRecord(municipality.id);
      if (!coatRecord?.image_filename) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: 'Wappen nicht gefunden' }));
      }
      const imagePath = path.join(COAT_OF_ARMS_UPLOAD_DIR, String(coatRecord.image_filename));
      if (!imagePath.startsWith(COAT_OF_ARMS_UPLOAD_DIR)) {
        return sendJson(res, 400, { ok: false, error: 'Ungültiger Dateiname' });
      }
      if (!fs.existsSync(imagePath)) {
        await deleteMunicipalityCoatOfArms(municipality.id);
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: 'Wappen-Datei fehlt' }));
      }
      const imageBuffer = fs.readFileSync(imagePath);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': imageBuffer.length,
        'Cache-Control': 'public, max-age=300',
      });
      return res.end(imageBuffer);
    }

    // PUT/DELETE /api/game/municipality/:slug/coat-of-arms
    const municipalityCoatOfArmsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/coat-of-arms$/i);
    if (municipalityCoatOfArmsMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const slug = municipalityCoatOfArmsMatch[1].toLowerCase();
      const municipality = await getMunicipalityBySlug(slug);
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const userRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (userRole !== MUNICIPALITY_ROLE_OWNER && userRole !== MUNICIPALITY_ROLE_COUNCIL) {
        return sendJson(res, 403, { success: false, error: 'Nur Besitzer oder Verwaltung dürfen das Wappen ändern' });
      }

      if (req.method === 'DELETE') {
        await deleteMunicipalityCoatOfArms(municipality.id);
        return sendJson(res, 200, {
          success: true,
          data: {
            municipality_slug: municipality.slug,
            coat_of_arms: { svg: null, image_url: null },
            message: 'Wappen entfernt',
          },
        });
      }

      const body = await readJsonBody(req);
      const pngBuffer = parsePngDataUrl(body?.png_data_url || body?.image_data_url || body?.pngDataUrl);
      if (!pngBuffer) {
        return sendJson(res, 422, { success: false, error: 'png_data_url muss ein gültiges data:image/png;base64 sein' });
      }
      const saved = await saveMunicipalityCoatOfArmsPng(municipality, pngBuffer);
      return sendJson(res, 200, {
        success: true,
        data: {
          municipality_slug: municipality.slug,
          coat_of_arms: {
            svg: null,
            image_url: buildCoatOfArmsImageUrl(municipality.slug, saved?.updated_at, requestUrl),
          },
          byte_size: Number(saved?.byte_size || pngBuffer.length),
          updated_at: saved?.updated_at || null,
          message: 'Wappen gespeichert',
        },
      });
    }

    // === MINIMAP ENDPOINT: POST speichert PNG, GET liefert es zurück ===
    const municipalityMinimapMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/minimap$/i);
    if (municipalityMinimapMatch) {
      const slug = municipalityMinimapMatch[1].toLowerCase();
      const municipality = await getMunicipalityBySlug(slug);
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });

      if (req.method === 'POST') {
        ensureDbEnabled();
        const authUser = await getAuthenticatedUser(req);
        if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
        if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
          return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
        }
        const userRole = await getUserMunicipalityRole(authUser.id, municipality.id);
        if (userRole !== MUNICIPALITY_ROLE_OWNER && userRole !== MUNICIPALITY_ROLE_COUNCIL) {
          return sendJson(res, 403, { success: false, error: 'Nur Besitzer oder Verwaltung dürfen die Minimap ändern' });
        }
        try {
          const body = await readJsonBody(req);
          const imageData = body?.image;
          if (!imageData || typeof imageData !== 'string') {
            return sendJson(res, 400, { success: false, error: 'image (data URL) fehlt' });
          }
          const pngBuffer = parsePngDataUrl(imageData);
          const saved = await saveMinimapPng(municipality, pngBuffer);
          return sendJson(res, 200, {
            success: true,
            data: {
              url: `/api/game/municipality/${slug}/minimap/image`,
              byte_size: saved.byteSize,
            },
          });
        } catch (err) {
          return sendJson(res, 400, { success: false, error: 'Minimap konnte nicht gespeichert werden' });
        }
      }

      if (req.method === 'GET') {
        ensureMinimapUploadDir();
        const filePath = path.join(MINIMAP_UPLOAD_DIR, `${slug}-minimap.png`);
        if (!fs.existsSync(filePath)) {
          return sendJson(res, 404, { success: false, error: 'Minimap nicht vorhanden' });
        }
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': data.length,
          'Cache-Control': 'public, max-age=60',
        });
        return res.end(data);
      }

      return sendJson(res, 405, { success: false, error: 'Method not allowed' });
    }

    // Minimap-Bild-Alias (GET /minimap/image)
    const municipalityMinimapImageMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/minimap\/image$/i);
    if (municipalityMinimapImageMatch && req.method === 'GET') {
      const slug = municipalityMinimapImageMatch[1].toLowerCase();
      ensureMinimapUploadDir();
      const filePath = path.join(MINIMAP_UPLOAD_DIR, `${slug}-minimap.png`);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: 'Minimap nicht vorhanden' }));
      }
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=60',
      });
      return res.end(data);
    }

    // GET /api/game/municipality/:slug/map
    const municipalityMapMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/map$/i);
    if (req.method === 'GET' && municipalityMapMatch) {
      const slug = municipalityMapMatch[1].toLowerCase();
      const municipality = await getMunicipalityBySlug(slug);
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const administration = await getMunicipalityAdministration(municipality.id);
      const owner = administration.owner || null;
      const memberCount = Number(administration.member_count || 0);
      const coatOfArms = await resolveMunicipalityCoatOfArmsDto(municipality, requestUrl);
      return sendJson(res, 200, {
        success: true,
        data: {
          municipality: {
            id: municipality.id,
            name: municipality.name,
            slug: municipality.slug,
            bfs_number: municipality.bfs_number || '',
            canton: municipality.canton_code,
            canton_full: municipality.canton_name,
            postal_code: municipality.postal_code || '',
            district: municipality.district || '',
            population: Number(municipality.population) || 0,
            area_km2: Number(municipality.area_km2) || 0,
            elevation_m: Number(municipality.elevation_m) || 0,
            is_city: true,
            is_canton_capital: false,
            language: 'de',
            coordinates: { lat: 47.0, lng: 8.0 },
            owner,
            coat_of_arms: coatOfArms,
          },
          map: {
            geojson: null,
            bounds: null,
            center: { lat: 47.0, lng: 8.0 },
          },
          buildings: [],
          stats: {
            level: 1,
            total_xp: 0,
            xp_for_next_level: 100,
            xp_progress: 0,
            value: 0,
            member_count: memberCount,
            conquered_at: null,
            buildings: { total: 0, by_type: {} },
            population: 0,
            area_km2: 0,
          },
          resources: [],
          administration,
        },
      });
    }

    // GET /api/game/municipality/:slug/administration
    const municipalityAdministrationMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/administration$/i);
    if (municipalityAdministrationMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityAdministrationMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const administration = await getMunicipalityAdministration(municipality.id);
      return sendJson(res, 200, { success: true, data: administration });
    }

    // PATCH /api/game/municipality/:slug/administration/members/:userId/role
    const municipalityAdministrationRoleMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/administration\/members\/([0-9]+)\/role$/i);
    if (municipalityAdministrationRoleMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityAdministrationRoleMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }

      const requesterRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canManageMunicipality(requesterRole)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung Rollen zu ändern' });
      }

      const targetUserId = Number(municipalityAdministrationRoleMatch[2]);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return sendJson(res, 422, { success: false, error: 'user_id ungültig' });
      }
      const body = await readJsonBody(req);
      const requestedRole = normalizeMunicipalityRole(body?.role);
      const allowedRoles = [MUNICIPALITY_ROLE_COUNCIL, MUNICIPALITY_ROLE_CITIZEN, MUNICIPALITY_ROLE_OBSERVER];
      if (!allowedRoles.includes(requestedRole)) {
        return sendJson(res, 422, { success: false, error: 'Ungültige Rolle' });
      }
      // Council darf nur citizen/observer vergeben, nicht council
      if (requesterRole === MUNICIPALITY_ROLE_COUNCIL && requestedRole === MUNICIPALITY_ROLE_COUNCIL) {
        return sendJson(res, 403, { success: false, error: 'Gemeinderat kann keine weiteren Gemeinderäte ernennen' });
      }

      const targetRole = await getUserMunicipalityRole(targetUserId, municipality.id);
      if (!targetRole) {
        return sendJson(res, 404, { success: false, error: 'Mitglied nicht gefunden' });
      }
      if (targetRole === MUNICIPALITY_ROLE_OWNER) {
        return sendJson(res, 422, { success: false, error: 'Gemeindepräsident-Rolle kann nicht geändert werden' });
      }
      // Council darf keine gleichrangigen oder höheren Ränge ändern
      if (requesterRole === MUNICIPALITY_ROLE_COUNCIL && municipalityRoleRank(targetRole) <= municipalityRoleRank(MUNICIPALITY_ROLE_COUNCIL)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung dieses Mitglied zu ändern' });
      }

      await dbPool.query(
        `UPDATE municipality_memberships
         SET role = ?, updated_at = CURRENT_TIMESTAMP
         WHERE municipality_id = ? AND user_id = ?`,
        [requestedRole, municipality.id, targetUserId]
      );

      const administration = await getMunicipalityAdministration(municipality.id);
      return sendJson(res, 200, {
        success: true,
        data: administration,
      });
    }

    // POST /api/game/municipality/:slug/rooms
    const municipalityRoomsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/rooms$/i);
    if (municipalityRoomsMatch && req.method === 'POST') {
      const municipality = await getMunicipalityBySlug(municipalityRoomsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const body = await readJsonBody(req);
      const roomCode = normalizeRoomCode(body.room_code);
      if (!roomCode) return sendJson(res, 422, { success: false, error: 'room_code ungültig' });
      const room = await createOrGetRoom(municipality.id, roomCode, String(body.city_name || municipality.name), body.game_state || null);
      return sendJson(res, 200, { success: true, data: room });
    }

    // PUT /api/game/municipality/:slug/rooms/:code
    const municipalityRoomMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/rooms\/([a-z0-9-]+)$/i);
    if (municipalityRoomMatch && req.method === 'PUT') {
      const municipality = await getMunicipalityBySlug(municipalityRoomMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const roomCode = normalizeRoomCode(municipalityRoomMatch[2]);
      const body = await readJsonBody(req);
      const room = await updateRoomState(municipality.id, roomCode, body.game_state || null);
      return sendJson(res, 200, { success: true, data: room });
    }

    // GET /api/game/municipality/:slug/members
    const municipalityMembersMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/members$/i);
    if (municipalityMembersMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityMembersMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const [members] = await dbPool.query(
        `SELECT mm.user_id, mm.role, mm.created_at AS joined_at, mm.updated_at,
                u.nickname,
                (SELECT level FROM user_xp WHERE user_id = mm.user_id) AS user_level,
                (SELECT total_xp FROM user_xp WHERE user_id = mm.user_id) AS user_xp
         FROM municipality_memberships mm
         JOIN users u ON u.id = mm.user_id
         WHERE mm.municipality_id = ?
         ORDER BY FIELD(mm.role, 'owner', 'admin', 'citizen'), u.nickname ASC`,
        [municipality.id]
      );

      return sendJson(res, 200, {
        ok: true,
        data: {
          municipality_id: municipality.id,
          municipality_name: municipality.name,
          member_limit: MUNICIPALITY_MEMBER_LIMIT,
          member_count: members.length,
          members,
        },
      });
    }

    // DELETE /api/game/municipality/:slug/members/:userId
    const municipalityMemberKickMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/members\/([0-9]+)$/i);
    if (municipalityMemberKickMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityMemberKickMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      // Nur Owner kann kicken
      const requesterRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (requesterRole !== MUNICIPALITY_ROLE_OWNER) {
        return sendJson(res, 403, { ok: false, error: 'Nur der Besitzer kann Mitglieder entfernen' });
      }

      const targetUserId = Number(municipalityMemberKickMatch[2]);
      if (targetUserId === Number(authUser.id)) {
        return sendJson(res, 400, { ok: false, error: 'Du kannst dich nicht selbst entfernen' });
      }

      // Prüfen ob Ziel Mitglied ist
      const targetRole = await getUserMunicipalityRole(targetUserId, municipality.id);
      if (!targetRole) return sendJson(res, 404, { ok: false, error: 'Mitglied nicht gefunden' });
      if (targetRole === MUNICIPALITY_ROLE_OWNER) {
        return sendJson(res, 400, { ok: false, error: 'Der Besitzer kann nicht entfernt werden' });
      }

      // Mitgliedschaft entfernen
      await dbPool.query(
        `DELETE FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [municipality.id, targetUserId]
      );
      // User aus Gemeinde austragen
      await dbPool.query(
        `UPDATE users SET municipality_id = NULL WHERE id = ? AND municipality_id = ?`,
        [targetUserId, municipality.id]
      );

      return sendJson(res, 200, { ok: true, data: { removed: true, user_id: targetUserId } });
    }

    // POST /api/game/municipality/:slug/members/invite
    const municipalityMemberInviteMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/members\/invite$/i);
    if (municipalityMemberInviteMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityMemberInviteMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const requesterRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canInviteToMunicipality(requesterRole)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Gemeindepräsident oder Gemeinderat können einladen' });
      }

      const body = await readJsonBody(req);
      const targetUserId = Number(body.user_id || 0);
      if (!targetUserId) return sendJson(res, 422, { ok: false, error: 'user_id erforderlich' });

      // Prüfen ob User existiert
      const [targetUser] = await dbPool.query(`SELECT id, nickname, municipality_id FROM users WHERE id = ?`, [targetUserId]);
      if (targetUser.length === 0) return sendJson(res, 404, { ok: false, error: 'User nicht gefunden' });
      if (Number(targetUser[0].municipality_id) === Number(municipality.id)) {
        return sendJson(res, 400, { ok: false, error: 'User ist bereits Mitglied dieser Gemeinde' });
      }

      // Member-Limit prüfen
      const [memberCount] = await dbPool.query(
        `SELECT COUNT(*) AS cnt FROM municipality_memberships WHERE municipality_id = ?`, [municipality.id]
      );
      if (memberCount[0].cnt >= MUNICIPALITY_MEMBER_LIMIT) {
        return sendJson(res, 400, { ok: false, error: `Gemeinde ist voll (${MUNICIPALITY_MEMBER_LIMIT} Mitglieder max.)` });
      }

      // User in Gemeinde aufnehmen
      await dbPool.query(`UPDATE users SET municipality_id = ? WHERE id = ?`, [municipality.id, targetUserId]);
      await syncMunicipalityMemberships(municipality.id);

      return sendJson(res, 200, { ok: true, data: { invited: true, user_id: targetUserId, nickname: targetUser[0].nickname } });
    }

    // GET /api/game/municipality/:slug/zone-settings
    const zoneSettingsGetMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/zone-settings$/i);
    if (zoneSettingsGetMatch && req.method === 'GET') {
      ensureDbEnabled();
      const municipality = await getMunicipalityBySlug(zoneSettingsGetMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const [rows] = await dbPool.query(
        `SELECT bauzone_mode FROM municipality_zone_settings WHERE municipality_id = ? AND room_code = 'main' LIMIT 1`,
        [municipality.id]
      );
      const mode = (Array.isArray(rows) && rows.length > 0) ? rows[0].bauzone_mode : 'disabled';
      return sendJson(res, 200, { ok: true, data: { bauzone_mode: mode } });
    }

    // PUT /api/game/municipality/:slug/zone-settings
    const zoneSettingsPutMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/zone-settings$/i);
    if (zoneSettingsPutMatch && req.method === 'PUT') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(zoneSettingsPutMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const requesterRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canManageMunicipality(requesterRole)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Gemeindepräsident oder Gemeinderat dürfen Zone-Einstellungen ändern' });
      }

      const body = await readJsonBody(req);
      const VALID_MODES = ['disabled', 'members', 'all'];
      const newMode = String(body.bauzone_mode || '').trim().toLowerCase();
      if (!VALID_MODES.includes(newMode)) {
        return sendJson(res, 422, { ok: false, error: `Ungültiger Modus. Erlaubt: ${VALID_MODES.join(', ')}` });
      }

      await dbPool.query(
        `INSERT INTO municipality_zone_settings (municipality_id, room_code, bauzone_mode)
         VALUES (?, 'main', ?)
         ON DUPLICATE KEY UPDATE bauzone_mode = VALUES(bauzone_mode)`,
        [municipality.id, newMode]
      );

      return sendJson(res, 200, { ok: true, data: { bauzone_mode: newMode } });
    }

  };
};
