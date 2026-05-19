'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser, getUserGlobalRole } = require('../../../auth/middleware');

const {
  createOrGetRoom,
  getRoom,
  importRoomItems,
} = require('../../../game/rooms');

const {
  buildPublicRoomItems,
} = require('../../../game/map');

const {
  listPublicNavigatorMaps,
  getMunicipalityById,
} = require('../../../game/municipality');

const {
  normalizeRoomCode,
  normalizePublicRoomSizeKey,
  normalizePublicRoomIndex,
  normalizePublicRoomGenerator,
} = require('../../../shared/helpers');

const {
  PUBLIC_ROOM_SIZE_PRESETS,
  GLOBAL_ROLE_MODERATOR,
  GLOBAL_ROLE_ADMINISTRATOR,
} = require('../../../config/constants');

module.exports = function registerPublicMapsRoutes(/* deps */) {
  return async function handlePublicMaps(req, res, pathname, requestUrl) {

    // ── Public maps ────────────────────────────────────────────
    if (pathname === '/api/game/public-maps' && (req.method === 'GET' || req.method === 'POST')) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const resolvedGlobalRole = await getUserGlobalRole(authUser.id);
      const normalizedRole = String(resolvedGlobalRole || '').toLowerCase();
      const canCreateMaps =
        normalizedRole === GLOBAL_ROLE_MODERATOR ||
        normalizedRole === GLOBAL_ROLE_ADMINISTRATOR;

      if (req.method === 'GET') {
        const q = String(requestUrl.searchParams.get('q') || '');
        const limit = Math.min(100, Math.max(1, Number(requestUrl.searchParams.get('limit')) || 60));
        const maps = await listPublicNavigatorMaps(q, limit);
        return sendJson(res, 200, {
          success: true,
          data: {
            maps,
            count: maps.length,
            can_create_maps: canCreateMaps,
          },
        });
      }

      if (!canCreateMaps) {
        return sendJson(res, 403, { success: false, error: 'Nur Moderatoren und Admins dürfen Offizielle Räume erstellen' });
      }

      try {
        const municipality = await getMunicipalityById(Number(authUser.municipality_id || 0));
        if (!municipality) {
          return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
        }

        const body = await readJsonBody(req);
        const sizeKey = normalizePublicRoomSizeKey(body?.size_key || body?.size || 'small');
        const sizePreset = PUBLIC_ROOM_SIZE_PRESETS[sizeKey] || PUBLIC_ROOM_SIZE_PRESETS.small;
        const roomIndex = normalizePublicRoomIndex(body?.room_index || body?.roomNumber || 1);
        const generator = normalizePublicRoomGenerator(body?.generator || (sizeKey === 'small' ? 'small_walls' : 'open'));
        const regionName = String(body?.region_name || body?.region || 'Public Region').trim().slice(0, 48) || 'Public Region';
        const fallbackRoomCode = `PUB${String(roomIndex).padStart(2, '0')}`;
        const requestedRoomCode = normalizeRoomCode(body?.room_code || fallbackRoomCode) || fallbackRoomCode;
        let roomCode = requestedRoomCode;
        const hasExplicitRoomCode = String(body?.room_code || '').trim().length > 0;
        if (!hasExplicitRoomCode) {
          // Wenn kein expliziter room_code gesetzt ist, bei Kollisionen automatisch den
          // nächsten freien PUB-Code wählen, damit wirklich neue Rooms entstehen.
          let probeIndex = roomIndex;
          for (let i = 0; i < 999; i += 1) {
            const candidate = normalizeRoomCode(`PUB${String(probeIndex).padStart(2, '0')}`) || `PUB${String(probeIndex).padStart(2, '0')}`;
            // eslint-disable-next-line no-await-in-loop
            const existing = await getRoom(municipality.id, candidate);
            if (!existing) {
              roomCode = candidate;
              break;
            }
            probeIndex += 1;
          }
        }
        const roomName = String(body?.room_name || `${regionName} #${roomIndex}`).trim().slice(0, 80) || `${regionName} #${roomIndex}`;

        const effectiveRoomSize = Math.max(6, Math.min(12, Number(sizePreset.size || 8)));
        const effectiveTiles = effectiveRoomSize * effectiveRoomSize;
        const gameState = {
          navigator_public: true,
          region_name: regionName,
          room_index: roomIndex,
          size_key: sizeKey,
          size_label: sizePreset.label,
          room_size: effectiveRoomSize,
          total_tiles: effectiveTiles,
          generator,
          generated_by: Number(authUser.id),
          generated_at: new Date().toISOString(),
        };

        await createOrGetRoom(municipality.id, roomCode, roomName, gameState);
        const items = buildPublicRoomItems(effectiveRoomSize, generator);
        const imported = await importRoomItems(municipality.id, roomCode, 'region_generator', Number(authUser.id), items);

        return sendJson(res, 200, {
          success: true,
          data: {
            municipality_slug: municipality.slug,
            room_code: roomCode,
            room_name: roomName,
            region_name: regionName,
            size_key: sizeKey,
            size_label: sizePreset.label,
            room_size: effectiveRoomSize,
            total_tiles: effectiveTiles,
            generator,
            item_count: imported.totalImported || 0,
            message: `Public Room ${roomCode} erstellt (${sizePreset.label} ${effectiveRoomSize}x${effectiveRoomSize})`,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[public-maps:create] Fehler', {
          userId: Number(authUser.id || 0),
          municipalityId: Number(authUser.municipality_id || 0),
          message,
          stack: err instanceof Error ? err.stack : null,
        });
        const isDev = (process.env.NODE_ENV || '').toLowerCase() !== 'production';
        return sendJson(res, 500, {
          success: false,
          error: 'Interner Serverfehler',
          ...(isDev ? { detail: `Public-Map create fehlgeschlagen: ${message}` } : {}),
        });
      }
    }

  };
};
