'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { logInfo } = require('../../../infra/logger');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { canBuildInMunicipality, canManageBauzones, shouldEnforceBauzone } = require('../../../auth/permissions');

const {
  loadRoomStats,
  saveRoomStats,
  mapRowToDelta,
  getMunicipalityMoney,
  getRoomItemVersion,
  getRoom,
} = require('../../../game/rooms');

const {
  ensureItemDetailExists,
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
  getZoneBuildingPool,
  getZoneStarterBuilding,
  pickRandomZoneBuildingType,
  runServerDisasterTick,
  runServerBuildingUpgradeTick,
} = require('../../../game/disasters');

const { applyMunicipalityTransaction } = require('../../../game/bank');

const {
  toFiniteNumber,
  normalizeRoomCode,
  toJsonValue,
  metaValue,
} = require('../../../shared/helpers');

const {
  BULLDOZE_COST_PER_CLICK,
} = require('../../../config/constants');

const { wsRoomKey } = require('../../../ws/socketio/helpers');

const {
  hasAdjacentWaterForFootprint,
  wsPublishAuthoritativeStats,
} = require('../../shared');

const { isGlobalAdmin } = require('./_shared');

module.exports = function registerDeltasRoutes(deps) {

  return async function handleDeltas(req, res, pathname, requestUrl) {
    // io wird zur Request-Zeit gelesen, nicht beim Start (deps.io ist beim Start noch null)
    const io = deps?.io;

    // ── Deltas POST ────────────────────────────────────────────
    const municipalityDeltasPostMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/deltas$/i);
    if (municipalityDeltasPostMatch && req.method === 'POST') {
      const municipality = await getMunicipalityBySlug(municipalityDeltasPostMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        logInfo('SECURITY', `User ${authUser.id} versuchte Deltas für Gemeinde ${municipality.slug} zu senden (eigene municipality_id: ${authUser.municipality_id})`);
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const deltasUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(deltasUserRole) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Beobachter dürfen die Map nicht verändern' });
      }
      const body = await readJsonBody(req);
      const roomCode = normalizeRoomCode(body.room_code);
      const deltas = Array.isArray(body.deltas) ? body.deltas : [];
      const clientVersion = Number(body.client_version || 0);
      const clientId = String(body.client_id || 'system');
      const itemDetailCache = new Map();
      const rejectedDeltas = [];
      let statsSnapshot = (await loadRoomStats(municipality.id, roomCode)) || {};
      let currentMoney = await getMunicipalityMoney(municipality.id);
      const originalMoney = currentMoney;
      let statsChanged = false;
      let mapChanged = false;
      let version = await getRoomItemVersion(municipality.id, roomCode);
      let applied = 0;
      const placedBuildingsMeta = []; // { tool, cost } pro platziertem Gebäude für Ledger-Meta
      const assignedZoneBuildings = []; // für sofortiges buildings-authoritative nach Zone-Platzierung
      const now = new Date();
      const mapMeta = await getGameMapForMunicipality(municipality.id);
      const mapGridSize = Number(mapMeta?.grid_size || 0);
      let _bauzoneExistsCache = undefined;
      const bauzoneExistsForRoom = async () => {
        if (_bauzoneExistsCache !== undefined) return _bauzoneExistsCache;
        const [rows] = await dbPool.query(
          `SELECT 1 FROM game_items WHERE municipality_id = ? AND room_code = ? AND action_type = 'bauzone' LIMIT 1`,
          [municipality.id, roomCode]
        );
        _bauzoneExistsCache = Array.isArray(rows) && rows.length > 0;
        return _bauzoneExistsCache;
      };
      const userRoleForBauzone = await getUserMunicipalityRole(authUser.id, municipality.id);
      let _bauzoneMode = 'disabled';
      try {
        const [mzsRows] = await dbPool.query(
          `SELECT bauzone_mode FROM municipality_zone_settings WHERE municipality_id = ? AND room_code = ? LIMIT 1`,
          [municipality.id, roomCode]
        );
        if (Array.isArray(mzsRows) && mzsRows.length > 0) _bauzoneMode = mzsRows[0].bauzone_mode;
      } catch {}
      const userMustFollowBauzone = isGlobalAdmin(authUser) ? false : shouldEnforceBauzone(userRoleForBauzone, _bauzoneMode);
      const userCanBypassBauzone = !userMustFollowBauzone;
      for (const delta of deltas) {
        const x = Number(delta.x);
        const y = Number(delta.y);
        const type = String(delta.type || '');
        let persistedActionType = type;
        let persistedTool = delta.tool || null;
        let persistedZone = delta.zone || null;
        let persistedMetadata = delta.metadata && typeof delta.metadata === 'object'
          ? { ...delta.metadata }
          : null;
        if (type === 'stats_update') {
          rejectedDeltas.push({
            type: 'stats_update',
            reason: 'server_authoritative_stats',
          });
          continue;
        }
        if (!['place', 'zone', 'bulldoze', 'bauzone', 'metadata_update'].includes(type)) continue;
        if ((type === 'place' || type === 'zone' || type === 'bulldoze' || type === 'bauzone' || type === 'metadata_update') && (!Number.isInteger(x) || !Number.isInteger(y))) {
          continue;
        }
        if (mapGridSize > 0 && (x < 0 || y < 0 || x >= mapGridSize || y >= mapGridSize)) {
          rejectedDeltas.push({ type, x, y, reason: 'out_of_bounds' });
          continue;
        }

        // metadata_update: Aktualisiert Metadata eines bestehenden game_items (z.B. Autobahn-Richtung)
        if (type === 'metadata_update') {
          const updateMeta = delta.metadata && typeof delta.metadata === 'object' ? delta.metadata : {};
          const allowedKeys = ['autobahnDirection'];
          const safeUpdate = {};
          for (const key of allowedKeys) {
            if (key in updateMeta) safeUpdate[key] = updateMeta[key] === null ? null : String(updateMeta[key]);
          }
          if (Object.keys(safeUpdate).length === 0) continue;

          const [existingRows] = await dbPool.query(
            `SELECT id, metadata FROM game_items
             WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'place'
             ORDER BY version DESC LIMIT 1`,
            [municipality.id, roomCode, x, y]
          );
          if (!Array.isArray(existingRows) || existingRows.length === 0) continue;
          const row = existingRows[0];
          let meta = {};
          try { meta = JSON.parse(row.metadata || '{}'); } catch { meta = {}; }
          for (const [k, v] of Object.entries(safeUpdate)) {
            if (v === null || v === 'null') { delete meta[k]; } else { meta[k] = v; }
          }
          version += 1;
          await dbPool.query(
            `UPDATE game_items SET metadata = ?, version = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [JSON.stringify(meta), version, now, row.id]
          );
          mapChanged = true;
          applied += 1;
          continue;
        }
        if (type === 'bulldoze') {
          if (!userCanBypassBauzone) {
            const hasBauzones = await bauzoneExistsForRoom();
            if (hasBauzones) {
              const [tileBZ] = await dbPool.query(
                `SELECT 1 FROM game_items WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'bauzone' LIMIT 1`,
                [municipality.id, roomCode, x, y]
              );
              if (!Array.isArray(tileBZ) || tileBZ.length === 0) {
                rejectedDeltas.push({ type: 'bulldoze', x, y, reason: 'outside_bauzone' });
                continue;
              }
            }
          }
          const [existingRows] = await dbPool.query(
            `SELECT id
             FROM game_items
             WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('place', 'zone')
             LIMIT 1`,
            [municipality.id, roomCode, x, y]
          );
          const hasPlacedItem = Array.isArray(existingRows) && existingRows.length > 0;
          if (!hasPlacedItem) {
            continue;
          }
          if (BULLDOZE_COST_PER_CLICK > currentMoney) {
            rejectedDeltas.push({
              type: 'bulldoze',
              x,
              y,
              reason: 'insufficient_funds',
              required: BULLDOZE_COST_PER_CLICK,
              available: currentMoney,
            });
            continue;
          }
          if (BULLDOZE_COST_PER_CLICK > 0) {
            currentMoney = Math.max(0, currentMoney - BULLDOZE_COST_PER_CLICK);
            const spentNow = Math.max(0, Math.round(toFiniteNumber(statsSnapshot.total_spent, 0))) + BULLDOZE_COST_PER_CLICK;
            statsSnapshot = {
              ...(statsSnapshot || {}),
              money: currentMoney,
              total_spent: spentNow,
            };
            statsChanged = true;
          }
          await dbPool.query(
            `DELETE FROM game_items
             WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('place', 'zone')`,
            [municipality.id, roomCode, x, y]
          );
          mapChanged = true;
          applied += 1;
          continue;
        }
        if (type === 'bauzone') {
          if (!canManageBauzones(userRoleForBauzone)) {
            rejectedDeltas.push({ type: 'bauzone', x, y, reason: 'insufficient_permission' });
            continue;
          }
          const enabled = delta.enabled !== false;
          if (!enabled) {
            await dbPool.query(
              `DELETE FROM game_items
               WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'bauzone'`,
              [municipality.id, roomCode, x, y]
            );
          } else {
            await dbPool.query(
              `DELETE FROM game_items
               WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'bauzone'`,
              [municipality.id, roomCode, x, y]
            );
            version += 1;
            await dbPool.query(
              `INSERT INTO game_items
               (municipality_id, room_code, player_id, user_id, action_type, tool, zone_type, x, y, version, client_timestamp, applied_at, metadata)
               VALUES (?, ?, ?, ?, 'bauzone', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
              [
                municipality.id,
                roomCode,
                clientId,
                authUser.id,
                x, y,
                version,
                delta.timestamp || null,
                now,
                JSON.stringify({ enabled: true }),
              ]
            );
          }
          _bauzoneExistsCache = undefined;
          mapChanged = true;
          applied += 1;
          continue;
        }
        if (type === 'place') {
          const tool = String(persistedTool || '').trim();
          if (!tool) continue;
          const normalizedTool = tool.toLowerCase();
          const isTerrainTool = normalizedTool.startsWith('terrain_');
          const isPaintTool = normalizedTool.startsWith('paint_');
          const isWaterTool = normalizedTool === 'zone_water';
          const isLandTool = normalizedTool === 'zone_land';

          // ── zone_water: Gras-Tile in Wasser umwandeln ──
          if (isWaterTool) {
            await dbPool.query(
              `DELETE FROM game_items WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('place','zone')`,
              [municipality.id, roomCode, x, y]
            );
            version += 1;
            await dbPool.query(
              `INSERT INTO game_items (municipality_id, room_code, player_id, user_id, action_type, tool, zone_type, x, y, version, client_timestamp, applied_at, metadata)
               VALUES (?, ?, ?, ?, 'place', 'water', NULL, ?, ?, ?, ?, ?, NULL)`,
              [municipality.id, roomCode, clientId, authUser?.id || null, x, y, version, Number(delta.timestamp || Date.now()), now]
            );
            mapChanged = true;
            applied += 1;
            continue;
          }

          // ── zone_land: Wasser-Tile zurück in Gras umwandeln ──
          if (isLandTool) {
            // Nur auf Wasser-Tiles erlaubt
            const [waterCheck] = await dbPool.query(
              `SELECT id FROM game_items WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND tool = 'water' AND action_type = 'place' LIMIT 1`,
              [municipality.id, roomCode, x, y]
            );
            if (!Array.isArray(waterCheck) || waterCheck.length === 0) {
              rejectedDeltas.push({ type: 'place', tool, x, y, reason: 'not_water_tile' });
              continue;
            }
            await dbPool.query(
              `DELETE FROM game_items WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('place','zone')`,
              [municipality.id, roomCode, x, y]
            );
            mapChanged = true;
            applied += 1;
            continue;
          }

          // ── Bauzone enforcement: non-admins may only place within bauzone tiles ──
          if (!userCanBypassBauzone) {
            const hasBauzones = await bauzoneExistsForRoom();
            if (hasBauzones) {
              const [tileBZ] = await dbPool.query(
                `SELECT 1 FROM game_items
                 WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'bauzone'
                 LIMIT 1`,
                [municipality.id, roomCode, x, y]
              );
              const tileIsBauzone = Array.isArray(tileBZ) && tileBZ.length > 0;
              if (!tileIsBauzone) {
                rejectedDeltas.push({ type: 'place', tool, x, y, reason: 'outside_bauzone' });
                continue;
              }
            }
          }

          // ── Furni: ensure furniClassname is always in metadata ──
          if (normalizedTool === 'furni' || normalizedTool.startsWith('furni_')) {
            if (!persistedMetadata || typeof persistedMetadata !== 'object') {
              persistedMetadata = {};
            }
            if (!persistedMetadata.furniClassname) {
              // Derive classname from tool: 'furni_ads_calip_cola' -> 'ads_calip_cola'
              const cls = normalizedTool === 'furni'
                ? (delta.metadata?.furniClassname || '')
                : normalizedTool.replace(/^furni_/, '');
              if (cls) {
                persistedMetadata.furniClassname = cls;
              }
            }
            if (typeof persistedMetadata.furniDirection !== 'number') {
              persistedMetadata.furniDirection = 2;
            }
            if (typeof persistedMetadata.furniState !== 'number') {
              persistedMetadata.furniState = 0;
            }
          }

          let tileMutationHandled = false;
          let detail = itemDetailCache.get(tool);
          if (typeof detail === 'undefined') {
            detail = await ensureItemDetailExists(tool, delta.metadata);
            itemDetailCache.set(tool, detail || null);
          }
          const buildCost = detail ? Math.max(0, Math.round(toFiniteNumber(detail.build_cost, 0))) : 0;
          if (!detail) continue;
          if (isTerrainTool || isPaintTool) {
            const [existingRows] = await dbPool.query(
              `SELECT id, action_type, tool, zone_type, metadata
               FROM game_items
               WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('place','zone')
               ORDER BY version DESC, id DESC
               LIMIT 1`,
              [municipality.id, roomCode, x, y]
            );
            const existing = Array.isArray(existingRows) && existingRows.length > 0 ? existingRows[0] : null;
            const existingMeta = toJsonValue(existing?.metadata) || {};
            persistedMetadata = {
              ...existingMeta,
              ...(persistedMetadata && typeof persistedMetadata === 'object' ? persistedMetadata : {}),
            };
            const baseActionType = String(existing?.action_type || 'place').toLowerCase() === 'zone' ? 'zone' : 'place';
            persistedActionType = baseActionType;
            persistedTool = existing?.tool || 'grass';
            persistedZone = existing?.zone_type || null;

            const effectiveTool = String(
              baseActionType === 'zone'
                ? (metaValue(persistedMetadata, 'buildingType', 'building_type') || '')
                : (persistedTool || '')
            )
              .trim()
              .toLowerCase();
            if (effectiveTool === 'water') {
              continue;
            }

            let changed = false;
            if (isTerrainTool) {
              const isRaising = normalizedTool === 'terrain_raise' || normalizedTool === 'terrain_hill' || normalizedTool === 'terrain_mountain';
              const canRaiseOn =
                effectiveTool === 'grass' ||
                effectiveTool === 'empty' ||
                effectiveTool === 'tree' ||
                effectiveTool.startsWith('tree_');
              if (isRaising && !canRaiseOn) {
                continue;
              }
              const currentElevation = Math.max(-6, Math.min(6, Math.round(Number(metaValue(persistedMetadata, 'elevation') || 0))));
              let targetElevation = currentElevation;
              if (normalizedTool === 'terrain_raise') {
                targetElevation = Math.min(6, currentElevation + 1);
              } else if (normalizedTool === 'terrain_lower') {
                targetElevation = Math.max(-6, currentElevation - 1);
              } else if (normalizedTool === 'terrain_lower2') {
                targetElevation = Math.max(-6, currentElevation - 2);
              } else if (normalizedTool === 'terrain_hill') {
                targetElevation = 2;
              } else if (normalizedTool === 'terrain_mountain') {
                targetElevation = 4;
              } else if (normalizedTool === 'terrain_flatten') {
                targetElevation = 0;
              }
              if (targetElevation === currentElevation) {
                continue;
              }
              persistedMetadata.elevation = targetElevation;
              changed = true;
            }

            if (isPaintTool) {
              const paintMap = {
                paint_green: 'green',
                paint_sand: 'sand',
                paint_dirt: 'dirt',
                paint_snow: 'snow',
                paint_dark_grass: 'dark_grass',
                paint_rock: 'rock',
                paint_reset: 'reset',
              };
              const paintValue = paintMap[normalizedTool] || null;
              if (paintValue) {
                const currentPaint = String(metaValue(persistedMetadata, 'paintColor', 'paint_color') || '');
                if (paintValue === 'reset') {
                  if (currentPaint) {
                    delete persistedMetadata.paintColor;
                    delete persistedMetadata.paint_color;
                    changed = true;
                  }
                } else if (currentPaint !== paintValue) {
                  persistedMetadata.paintColor = paintValue;
                  delete persistedMetadata.paint_color;
                  changed = true;
                }
              }
            }

            if (!changed) {
              continue;
            }

            if (buildCost > currentMoney) {
              rejectedDeltas.push({
                type: 'place',
                x,
                y,
                tool,
                reason: 'insufficient_funds',
                required: buildCost,
                available: currentMoney,
              });
              continue;
            }
            if (buildCost > 0) {
              currentMoney = Math.max(0, currentMoney - buildCost);
              const spentNow = Math.max(0, Math.round(toFiniteNumber(statsSnapshot.total_spent, 0))) + buildCost;
              statsSnapshot = {
                ...(statsSnapshot || {}),
                money: currentMoney,
                total_spent: spentNow,
              };
              statsChanged = true;
              placedBuildingsMeta.push({ tool: normalizedTool, cost: buildCost });
            }
            await dbPool.query(
              `DELETE FROM game_items
               WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('place','zone')`,
              [municipality.id, roomCode, x, y]
            );
            mapChanged = true;
            tileMutationHandled = true;
          } else if (tool === 'pier_large') {
            const footprintWidth = Math.max(1, Math.round(toFiniteNumber(detail.footprint_width, 1)));
            const footprintHeight = Math.max(1, Math.round(toFiniteNumber(detail.footprint_height, 1)));
            const hasAdjacentWater = await hasAdjacentWaterForFootprint(
              municipality.id,
              roomCode,
              x,
              y,
              footprintWidth,
              footprintHeight
            );
            if (!hasAdjacentWater) {
              rejectedDeltas.push({
                type: 'place',
                x,
                y,
                tool,
                reason: 'requires_adjacent_water',
              });
              continue;
            }
          }
          if (!tileMutationHandled) {
            // Footprint-Belegung: Kein Überbauen von bestehenden Gebäuden
            const OVERWRITE_ALLOWED = new Set(['road', 'bridge', 'rail', 'subway', 'water', 'zone_water', 'zone_land']);
            if (!OVERWRITE_ALLOWED.has(normalizedTool)) {
              const fw = Math.max(1, Math.round(toFiniteNumber(detail?.footprint_width, 1)));
              const fh = Math.max(1, Math.round(toFiniteNumber(detail?.footprint_height, 1)));
              const fpPositions = [];
              for (let fx = 0; fx < fw; fx++) {
                for (let fy = 0; fy < fh; fy++) {
                  fpPositions.push([x + fx, y + fy]);
                }
              }
              const posConds = fpPositions.map(() => '(x = ? AND y = ?)').join(' OR ');
              const posArgs = fpPositions.flatMap(([px, py]) => [px, py]);
              try {
                const [blockedItems] = await dbPool.query(
                  `SELECT gi.id FROM game_items gi
                   WHERE gi.municipality_id = ? AND gi.room_code = ?
                   AND (${posConds})
                   AND (
                     (gi.action_type = 'place'
                      AND gi.tool NOT IN ('road', 'bridge', 'rail', 'water', 'subway', 'grass')
                      AND gi.tool NOT LIKE 'terrain_%'
                      AND gi.tool NOT LIKE 'paint_%'
                      AND gi.tool NOT LIKE 'zone_%'
                      AND gi.tool NOT LIKE 'tree%')
                     OR
                     (gi.action_type = 'zone'
                      AND gi.metadata IS NOT NULL
                      AND gi.metadata != '{}'
                      AND gi.metadata LIKE '%"buildingType"%'
                      AND gi.metadata NOT LIKE '%"buildingType":""'
                      AND gi.metadata NOT LIKE '%"buildingType":"grass"'
                      AND gi.metadata NOT LIKE '%"buildingType":"empty"')
                   )
                   LIMIT 1`,
                  [municipality.id, roomCode, ...posArgs]
                );
                if (Array.isArray(blockedItems) && blockedItems.length > 0) {
                  rejectedDeltas.push({ type: 'place', tool, x, y, reason: 'tile_occupied' });
                  continue;
                }
              } catch (_occupancyErr) {
                // Check fehlgeschlagen → zur Sicherheit ablehnen
                rejectedDeltas.push({ type: 'place', tool, x, y, reason: 'tile_occupied' });
                continue;
              }
            }

            if (buildCost > currentMoney) {
              rejectedDeltas.push({
                type: 'place',
                x,
                y,
                tool,
                reason: 'insufficient_funds',
                required: buildCost,
                available: currentMoney,
              });
              continue;
            }
            if (buildCost > 0) {
              currentMoney = Math.max(0, currentMoney - buildCost);
              const spentNow = Math.max(0, Math.round(toFiniteNumber(statsSnapshot.total_spent, 0))) + buildCost;
              statsSnapshot = {
                ...(statsSnapshot || {}),
                money: currentMoney,
                total_spent: spentNow,
              };
              statsChanged = true;
              placedBuildingsMeta.push({ tool: normalizedTool, cost: buildCost });
            }
            await dbPool.query(
              `DELETE FROM game_items
               WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('place','zone')`,
              [municipality.id, roomCode, x, y]
            );
            mapChanged = true;
          }
          if (!persistedMetadata || typeof persistedMetadata !== 'object') {
            persistedMetadata = {};
          }
          if (typeof persistedMetadata.constructionProgress !== 'number') {
            persistedMetadata.constructionProgress = 0;
          }
          if (typeof persistedMetadata.constructed !== 'boolean') {
            persistedMetadata.constructed = false;
          }
        }
        if (type === 'zone') {
          const normalizedZone = String(persistedZone || '').trim().toLowerCase();
          // ── Zone-Kosten (müssen mit Client game.ts übereinstimmen) ──
          const ZONE_COST_MAP = { residential: 50, commercial: 50, industrial: 50, none: 0 };
          const zoneCost = ZONE_COST_MAP[normalizedZone] ?? 0;
          if (zoneCost > currentMoney) {
            rejectedDeltas.push({ type: 'zone', zone: normalizedZone, x, y, reason: 'insufficient_funds', required: zoneCost, available: currentMoney });
            continue;
          }
          // Strassen/Schienen/Brücken nicht mit Zone überschreiben
          if (normalizedZone !== 'none') {
            const [roadCheck] = await dbPool.query(
              `SELECT 1 FROM game_items
               WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ?
               AND action_type = 'place' AND tool IN ('road', 'bridge', 'rail', 'subway')
               LIMIT 1`,
              [municipality.id, roomCode, x, y]
            );
            if (Array.isArray(roadCheck) && roadCheck.length > 0) continue;
          }

          if (zoneCost > 0) {
            currentMoney = Math.max(0, currentMoney - zoneCost);
            const spentNow = Math.max(0, Math.round(toFiniteNumber(statsSnapshot.total_spent, 0))) + zoneCost;
            statsSnapshot = { ...(statsSnapshot || {}), money: currentMoney, total_spent: spentNow };
            statsChanged = true;
            placedBuildingsMeta.push({ tool: `zone_${normalizedZone}`, cost: zoneCost });
          }
          // ── Bauzone enforcement for zone deltas ──
          if (!userCanBypassBauzone) {
            const hasBauzonesZ = await bauzoneExistsForRoom();
            if (hasBauzonesZ) {
              const [tileBZZ] = await dbPool.query(
                `SELECT 1 FROM game_items
                 WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'bauzone'
                 LIMIT 1`,
                [municipality.id, roomCode, x, y]
              );
              const tileIsBauzoneZ = Array.isArray(tileBZZ) && tileBZZ.length > 0;
              if (!tileIsBauzoneZ) {
                rejectedDeltas.push({ type: 'zone', zone: normalizedZone, x, y, reason: 'outside_bauzone' });
                continue;
              }
            }
          }
          await dbPool.query(
            `DELETE FROM game_items
             WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('place','zone')`,
            [municipality.id, roomCode, x, y]
          );
          mapChanged = true;
          if (normalizedZone === 'none') {
            applied += 1;
            continue;
          }
          if (!persistedMetadata || typeof persistedMetadata !== 'object') {
            persistedMetadata = {};
          }
          const incomingBuildingType = String(
            metaValue(persistedMetadata, 'buildingType', 'building_type') || ''
          )
            .trim()
            .toLowerCase();
          const zonePool = getZoneBuildingPool(normalizedZone);
          const starterTool = getZoneStarterBuilding(normalizedZone);
          const hasBuildingType = incomingBuildingType.length > 0;
          const incomingInPool = hasBuildingType && zonePool.includes(incomingBuildingType);
          const shouldReplaceStarter =
            hasBuildingType &&
            starterTool.length > 0 &&
            incomingBuildingType === starterTool;
          const shouldReplaceInvalid = hasBuildingType && !incomingInPool;
          // Gap-Hash: ~30% der Tiles bleiben als Gras (Luecken fuer spaetere Evolution)
          const gapHash = (Math.imul(x, 73856093) ^ Math.imul(y, 19349669)) >>> 0;
          const isGapTile = (gapHash % 100) < 30;

          if (isGapTile) {
            // Gap-Tile: bleibt Gras, kein Gebaeude
            persistedMetadata.buildingType = 'grass';
          } else if (!hasBuildingType || shouldReplaceStarter || shouldReplaceInvalid) {
            const randomizedTool = pickRandomZoneBuildingType(normalizedZone);
            if (randomizedTool) {
              persistedMetadata.buildingType = randomizedTool;
            }
          }
          if (!isGapTile) {
            if (typeof persistedMetadata.constructionProgress !== 'number') {
              persistedMetadata.constructionProgress = 0;
            }
            if (typeof persistedMetadata.constructed !== 'boolean') {
              persistedMetadata.constructed = false;
            }
            // Sofort an Client broadcasten sobald Gebäudetyp zugewiesen wurde
            if (persistedMetadata.buildingType && persistedMetadata.buildingType !== 'grass') {
              assignedZoneBuildings.push({
                x,
                y,
                buildingType: persistedMetadata.buildingType,
                constructionProgress: 0,
                level: 1,
              });
            }
          }
        }
        version += 1;
        await dbPool.query(
          `INSERT INTO game_items
           (municipality_id, room_code, player_id, user_id, action_type, tool, zone_type, x, y, version, client_timestamp, applied_at, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            municipality.id,
            roomCode,
            clientId,
            authUser?.id || null,
            persistedActionType,
            persistedTool,
            persistedZone,
            Number.isInteger(x) ? x : 0,
            Number.isInteger(y) ? y : 0,
            version,
            Number(delta.timestamp || Date.now()),
            now,
            persistedMetadata ? JSON.stringify(persistedMetadata) : null,
          ]
        );
        applied += 1;
      }

      let newTreasury = null;
      if (statsChanged) {
        await saveRoomStats(municipality.id, roomCode, statsSnapshot);
        const totalCost = originalMoney - currentMoney;
        if (totalCost > 0) {
          const bankResult = await applyMunicipalityTransaction(municipality.id, {
            amount: -totalCost,
            type: 'building_cost',
            meta: { roomCode, deltasApplied: applied, buildings: placedBuildingsMeta },
            actorUserId: authUser?.id || null,
            source: 'user',
          });
          newTreasury = bankResult?.treasury ?? null;
        }
      }

      await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);

      if (mapChanged) {
        await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
      }

      const [newRows] = await dbPool.query(
        `SELECT *
         FROM game_items
         WHERE municipality_id = ? AND room_code = ? AND version > ? AND user_id <> ?
         ORDER BY version ASC`,
        [municipality.id, roomCode, clientVersion, authUser.id]
      );
      const newDeltas = (Array.isArray(newRows) ? newRows : []).map(mapRowToDelta);
      const roomKey = wsRoomKey(municipality.slug, roomCode);
      // Echtzeit: Stats sofort nach Delta-Verarbeitung pushen (nicht erst im 3s-Intervall),
      // damit kein kurzfristiges Zurueckspringen im UI sichtbar ist.
      try {
        await wsPublishAuthoritativeStats(io, roomKey, clientId);
      } catch {
        // API-Antwort darf nicht fehlschlagen, wenn WS-Push gerade nicht verfügbar ist.
      }

      // Sofort buildings-authoritative emittieren, damit der platzierende Client
      // den zugewiesenen Gebäudetyp ohne Warten auf den 3s-Tick sieht.
      if (assignedZoneBuildings.length > 0) {
        try {
          io.to(roomKey).emit('buildings-authoritative', {
            changes: assignedZoneBuildings,
            serverTimestamp: Date.now(),
          });
        } catch {
          // non-critical
        }
      }

      return sendJson(res, 200, {
        success: true,
        data: {
          serverVersion: await getRoomItemVersion(municipality.id, roomCode),
          appliedDeltas: applied,
          rejectedDeltas,
          conflicts: [],
          newDeltas,
          newTreasury,
        },
      });
    }

    // ── Deltas GET ─────────────────────────────────────────────
    const municipalityDeltasGetMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/deltas\/([a-z0-9-]+)$/i);
    if (municipalityDeltasGetMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityDeltasGetMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const roomCode = normalizeRoomCode(municipalityDeltasGetMatch[2]);
      await runServerDisasterTick(municipality.id, roomCode);
      await runServerBuildingUpgradeTick(municipality.id, roomCode);
      const since = Number(requestUrl.searchParams.get('since') || 0);
      const clientId = String(requestUrl.searchParams.get('client_id') || '');
      const [rows] = await dbPool.query(
        `SELECT action_type, x, y, tool, zone_type, client_timestamp, player_id, version, metadata
         FROM game_items
         WHERE municipality_id = ? AND room_code = ? AND version > ? ${clientId ? 'AND player_id <> ?' : ''}
         ORDER BY version ASC`,
        clientId
          ? [municipality.id, roomCode, since, clientId]
          : [municipality.id, roomCode, since]
      );
      const deltas = (Array.isArray(rows) ? rows : []).map(mapRowToDelta);
      const room = await getRoom(municipality.id, roomCode);
      return sendJson(res, 200, {
        success: true,
        data: {
          deltas,
          server_version: await getRoomItemVersion(municipality.id, roomCode),
          players: [],
          player_count: Number(room?.player_count || 0),
        },
      });
    }

  };
};
