'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser, getUserRankValue, getUserGlobalRole } = require('../../../auth/middleware');

const {
  getRoomItemVersion,
} = require('../../../game/rooms');

const {
  refreshGameDataMapFromItems,
} = require('../../../game/map');

const {
  getMunicipalityBySlug,
  getMunicipalityById,
} = require('../../../game/municipality');

const {
  recomputeAuthoritativePopulationAndJobs,
} = require('../../../game/stats');

const {
  triggerManualDisaster,
} = require('../../../game/disasters');

const {
  normalizeRoomCode,
  toJsonValue,
  metaValue,
} = require('../../../shared/helpers');

const { pushDiscordEvent } = require('../../../shared/discord');

const {
  GLOBAL_ROLE_ADMINISTRATOR,
} = require('../../../config/constants');

const { wsRoomKey } = require('../../../ws/socketio/helpers');

const {
  DEBUG_DISASTER_TYPES,
  parseManualDisasterIntensity,
  wsPublishAuthoritativeStats,
} = require('../../shared');

const { isGlobalAdmin } = require('./_shared');

module.exports = function registerDisastersRoutes(deps) {
  const io = deps?.io;

  return async function handleDisasters(req, res, pathname /*, requestUrl */) {

    // ── Disasters ──────────────────────────────────────────────
    const municipalityDisasterTriggerMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/disasters\/([a-z0-9-]+)\/trigger$/i);
    if (municipalityDisasterTriggerMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityDisasterTriggerMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const roomCode = normalizeRoomCode(municipalityDisasterTriggerMatch[2]);
      if (!roomCode) return sendJson(res, 422, { success: false, error: 'room_code ungültig' });

      const globalRole = await getUserGlobalRole(authUser.id);
      const userRank = await getUserRankValue(authUser.id);
      const isAllowed = String(globalRole) === GLOBAL_ROLE_ADMINISTRATOR || Number(userRank) >= 7;
      if (!isAllowed) {
        return sendJson(res, 403, { success: false, error: 'Nur Rank 7 / Global Admin darf Debug-Katastrophen ausloesen' });
      }

      const body = await readJsonBody(req);
      const disasterType = String(body?.type || '').trim().toLowerCase();
      const intensity = Number(body?.intensity);
      const targetX = Number(body?.target_x);
      const targetY = Number(body?.target_y);
      if (!DEBUG_DISASTER_TYPES.has(disasterType)) {
        return sendJson(res, 422, { success: false, error: 'Ungültiger disaster type' });
      }

      const meteorTarget = (disasterType === 'meteor' && Number.isFinite(targetX) && Number.isFinite(targetY))
        ? { x: Math.round(targetX), y: Math.round(targetY) }
        : null;
      const result = await triggerManualDisaster(municipality.id, roomCode, disasterType, intensity, meteorTarget);
      const roomKey = wsRoomKey(municipality.slug, roomCode);
      if (Array.isArray(result?.changes) && result.changes.length > 0) {
        const impactX = Number(result?.impact_x);
        const impactY = Number(result?.impact_y);
        const impactRadius = Number(result?.impact_radius);
        io.to(roomKey).emit('disasters-authoritative', {
          changes: result.changes,
          serverTimestamp: Date.now(),
          source: 'debug-manual-disaster',
          disasterType,
          intensity: parseManualDisasterIntensity(intensity),
          ...(Number.isFinite(impactX) ? { impactX: Math.round(impactX) } : {}),
          ...(Number.isFinite(impactY) ? { impactY: Math.round(impactY) } : {}),
          ...(Number.isFinite(impactRadius) ? { impactRadius: Math.max(1, Math.round(impactRadius)) } : {}),
        });
        // Discord: Manuelle Katastrophe melden
        pushDiscordEvent(disasterType, {
          municipalityName: municipality.name, roomCode,
          affectedCount: result.changes.length,
          intensity: parseManualDisasterIntensity(intensity),
          message: `${disasterType.toUpperCase()} in ${municipality.name}! ${result.changes.length} Gebäude betroffen.`,
        });
      }
      if (disasterType === 'meteor' && Array.isArray(result?.meteor_restore_entries) && result.meteor_restore_entries.length > 0) {
        const restoreEntries = result.meteor_restore_entries
          .filter((entry) => Number.isFinite(Number(entry?.id)))
          .map((entry) => ({
            id: Math.round(Number(entry.id)),
            x: Math.round(Number(entry.x || 0)),
            y: Math.round(Number(entry.y || 0)),
            restoreElevation: Math.max(0, Math.round(Number(entry.restore_elevation || 0))),
          }));
        const restoreDelayMs = 9000;
        setTimeout(async () => {
          try {
            if (!restoreEntries.length) return;
            let version = await getRoomItemVersion(municipality.id, roomCode);
            const now = new Date();
            const ts = Date.now();
            const restoreChanges = [];
            for (const entry of restoreEntries) {
              const [rows] = await dbPool.query(
                `SELECT id, x, y, metadata
                 FROM game_items
                 WHERE id = ? AND municipality_id = ? AND room_code = ?
                 LIMIT 1`,
                [entry.id, municipality.id, roomCode]
              );
              const row = Array.isArray(rows) ? rows[0] : null;
              if (!row) continue;
              const meta = toJsonValue(row.metadata) || {};
              const currentElevation = Math.max(0, Math.round(Number(metaValue(meta, 'elevation') || 0)));
              if (currentElevation === entry.restoreElevation) continue;
              const nextMeta = { ...meta, elevation: entry.restoreElevation };
              version += 1;
              await dbPool.query(
                `UPDATE game_items
                 SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [JSON.stringify(nextMeta), version, ts, now, row.id]
              );
              restoreChanges.push({
                x: Number(row.x),
                y: Number(row.y),
                elevation: entry.restoreElevation,
              });
            }
            if (restoreChanges.length > 0) {
              io.to(roomKey).emit('disasters-authoritative', {
                changes: restoreChanges,
                serverTimestamp: Date.now(),
                source: 'meteor-crater-restore',
                disasterType: 'meteor',
              });
              const municipalityFresh = await getMunicipalityById(municipality.id);
              if (municipalityFresh) {
                await refreshGameDataMapFromItems(municipalityFresh, roomCode, 'server-core-disaster-debug');
              }
            }
          } catch {
            // Meteor-Restore ist best effort.
          }
        }, restoreDelayMs);
      }

      try {
        await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);
        await wsPublishAuthoritativeStats(io, roomKey, String(authUser.id));
      } catch {
        // Endpoint response should still succeed even if WS push fails.
      }

      const impactX = Number(result?.impact_x);
      const impactY = Number(result?.impact_y);
      const impactRadius = Number(result?.impact_radius);
      return sendJson(res, 200, {
        success: true,
        data: {
          room_code: roomCode,
          municipality_slug: municipality.slug,
          disaster_type: disasterType,
          intensity: parseManualDisasterIntensity(intensity),
          updated: Number(result?.updated || 0),
          deleted: Number(result?.deleted || 0),
          changed_tiles: Array.isArray(result?.changes) ? result.changes.length : 0,
          ...(Number.isFinite(impactX) ? { impact_x: Math.round(impactX) } : {}),
          ...(Number.isFinite(impactY) ? { impact_y: Math.round(impactY) } : {}),
          ...(Number.isFinite(impactRadius) ? { impact_radius: Math.max(1, Math.round(impactRadius)) } : {}),
          ...(disasterType === 'meteor' ? { crater_restore_ms: 9000 } : {}),
        },
      });
    }

  };
};
