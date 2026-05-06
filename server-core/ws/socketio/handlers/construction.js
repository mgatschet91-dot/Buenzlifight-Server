'use strict';

const { logWarn, logError } = require('../../../infra/logger');
const { canBuildInMunicipality, canManageBauzones, shouldEnforceBauzone } = require('../../../auth/permissions');

// Lazy requires to avoid circular dependencies
const lazyRequire = (path) => () => require(path);
const getHandler = lazyRequire('../../../http/handler');

/**
 * Registers construction-related socket handlers:
 *   items-constructed-sync, upgrade-building, delta, deltas
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {object} context - shared state and connection-level variables
 */
module.exports = function registerConstructionHandlers(socket, io, context) {
  const {
    state,
    rateLimiter,
    wsRoomMetadata,
  } = context;

  // ══════════════════════════════════════════════════════════════
  // ITEMS-CONSTRUCTED-SYNC
  // ══════════════════════════════════════════════════════════════
  // SERVER-AUTHORITATIVE: Construction Progress wird vom Server berechnet
  // (runServerBuildingUpgradeTick). Client-Sync wird ignoriert.
  socket.on('items-constructed-sync', async (data = {}, ack = null) => {
    if (typeof ack === 'function') {
      ack({ success: true, data: { updated: 0, deleted: 0, authoritativeStats: null, message: 'server-authoritative' } });
    }
    return;
    // === DEAKTIVIERT: Alter Client-trusted Code ===
    /* istanbul ignore next */
    if (false) {
      logError('WS', 'items-constructed-sync unreachable', {
      });
      if (typeof ack === 'function') ack({ success: false, error: err?.message || 'construction_sync_failed' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // UPGRADE-BUILDING
  // ══════════════════════════════════════════════════════════════
  const UPGRADE_MAX_LEVELS = { woodcutter_house: 4 };
  const SERVICE_MAX_LEVEL = 5;

  socket.on('upgrade-building', async (data = {}, ack = null) => {
    if (rateLimiter('upgrade-building')) {
      if (typeof ack === 'function') ack({ success: false, error: 'rate_limited' });
      return;
    }
    if (!state.currentRoomKey || !state.currentUserId) {
      if (typeof ack === 'function') ack({ success: false, error: 'not_authenticated' });
      return;
    }
    // DB-Live-Check (nicht gecachte Rolle) für schreibende Operationen
    try {
      const { getUserMunicipalityRole } = require('../../../game/municipality');
      const liveRole = await getUserMunicipalityRole(state.currentUserId, state.socketMunicipalityId);
      state.socketMunicipalityRole = liveRole; // Cache aktualisieren
      if (!canBuildInMunicipality(liveRole)) {
        logWarn('SECURITY', `User ${state.currentUserId} versuchte Upgrade ohne Berechtigung (Rolle: ${liveRole})`, { room: state.currentRoomKey });
        if (typeof ack === 'function') ack({ success: false, error: 'no_permission' });
        return;
      }
    } catch {
      if (!canBuildInMunicipality(state.socketMunicipalityRole)) {
        if (typeof ack === 'function') ack({ success: false, error: 'no_permission' });
        return;
      }
    }
    const tileX = Number(data.x);
    const tileY = Number(data.y);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) {
      if (typeof ack === 'function') ack({ success: false, error: 'invalid_position' });
      return;
    }

    const roomMeta = wsRoomMetadata.get(state.currentRoomKey);
    if (!roomMeta) {
      if (typeof ack === 'function') ack({ success: false, error: 'room_not_found' });
      return;
    }

    try {
      const { dbPool } = require('../../../infra/db');
      const [items] = await dbPool.query(
        `SELECT gi.id, gi.tool, gi.metadata, gi.x, gi.y,
                gid.upgrade_build_time_seconds, gid.build_cost
         FROM game_items gi
         LEFT JOIN game_item_details gid ON gid.tool COLLATE utf8mb4_unicode_ci = gi.tool COLLATE utf8mb4_unicode_ci
         WHERE gi.municipality_id = ? AND gi.room_code = ? AND gi.x = ? AND gi.y = ?
         LIMIT 1`,
        [roomMeta.municipalityId, roomMeta.roomCode, tileX, tileY]
      );

      if (!items || items.length === 0) {
        if (typeof ack === 'function') ack({ success: false, error: 'building_not_found' });
        return;
      }

      const item = items[0];
      const buildingType = item.tool;
      const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata || '{}') : (item.metadata || {});
      const currentLevel = Number(meta.level || 1);
      const maxLevel = UPGRADE_MAX_LEVELS[buildingType] || SERVICE_MAX_LEVEL;

      if (currentLevel >= maxLevel) {
        if (typeof ack === 'function') ack({ success: false, error: 'max_level_reached' });
        return;
      }
      if ((meta.upgrade_started_at || meta.upgradeStartedAt) && (meta.upgrade_target_level || meta.upgradeTargetLevel)) {
        if (typeof ack === 'function') ack({ success: false, error: 'upgrade_already_in_progress' });
        return;
      }
      const cp = meta.constructionProgress ?? meta.construction_progress;
      if (cp !== undefined && cp !== null && Number(cp) < 100) {
        if (typeof ack === 'function') ack({ success: false, error: 'still_under_construction' });
        return;
      }

      const baseSeconds = Number(item.upgrade_build_time_seconds || 0);
      const targetLevel = currentLevel + 1;
      const upgradeSeconds = baseSeconds > 0
        ? Math.max(1, Math.round(baseSeconds * Math.pow(2, Math.max(0, targetLevel - 2))))
        : 0;

      // ── Treasury check: upgrade must be paid for ──
      // Kosten: build_cost × 2^currentLevel
      // L1→L2: ×2, L2→L3: ×4, L3→L4: ×8, L4→L5: ×16
      const baseCost = Math.max(0, Math.round(Number(item.build_cost || 0)));
      const upgradeCost = Math.max(0, Math.round(baseCost * Math.pow(2, currentLevel)));
      let newTreasuryAfterUpgrade = null;
      if (upgradeCost > 0) {
        const { applyMunicipalityTransaction } = require('../../../game/bank');
        const { getBankStatus } = require('../../../game/bank');
        const bankStatus = await getBankStatus(roomMeta.municipalityId);
        if (bankStatus.treasury < upgradeCost) {
          if (typeof ack === 'function') ack({ success: false, error: 'insufficient_funds', required: upgradeCost, available: bankStatus.treasury });
          return;
        }
        // applyMunicipalityTransaction bucht treasury UND schreibt Ledger-Eintrag in einem Schritt
        const bankResult = await applyMunicipalityTransaction(roomMeta.municipalityId, {
          amount: -upgradeCost,
          type: 'upgrade_cost',
          meta: { buildingType, fromLevel: currentLevel, toLevel: targetLevel, x: tileX, y: tileY },
          actorUserId: state.currentUserId,
          source: 'user',
        });
        newTreasuryAfterUpgrade = bankResult?.treasury ?? null;
      }

      const now = Date.now();
      const newMeta = {
        ...meta,
        upgrade_started_at: now,
        upgrade_target_level: targetLevel,
        upgrade_seconds: upgradeSeconds,
      };

      if (upgradeSeconds === 0) {
        newMeta.level = targetLevel;
        delete newMeta.upgrade_started_at;
        delete newMeta.upgrade_target_level;
        delete newMeta.upgrade_seconds;
      }

      await dbPool.query(
        `UPDATE game_items SET metadata = ? WHERE id = ?`,
        [JSON.stringify(newMeta), item.id]
      );

      // Broadcast sofort an alle Spieler im Raum — kein Warten auf nächsten 3s-Tick
      io.to(state.currentRoomKey).emit('buildings-authoritative', {
        changes: [{
          x: tileX,
          y: tileY,
          level: upgradeSeconds === 0 ? targetLevel : currentLevel,
          buildingType,
          upgradeStartedAt: upgradeSeconds > 0 ? now : null,
          upgradeTargetLevel: upgradeSeconds > 0 ? targetLevel : null,
          upgradeSeconds: upgradeSeconds > 0 ? upgradeSeconds : null,
          constructed: true,
        }],
        serverTimestamp: now,
      });

      if (typeof ack === 'function') {
        ack({
          success: true,
          data: {
            upgradeStartedAt: upgradeSeconds > 0 ? now : null,
            upgradeTargetLevel: targetLevel,
            upgradeSeconds,
            newLevel: upgradeSeconds === 0 ? targetLevel : currentLevel,
            newTreasury: newTreasuryAfterUpgrade,
          },
        });
      }
    } catch (err) {
      logError('UPGRADE', 'Fehler beim Upgrade', { error: err?.message, tileX, tileY });
      if (typeof ack === 'function') ack({ success: false, error: 'server_error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // REPAIR-BUILDING
  // ══════════════════════════════════════════════════════════════
  socket.on('repair-building', async (data = {}, ack = null) => {
    if (rateLimiter('repair-building')) {
      if (typeof ack === 'function') ack({ success: false, error: 'rate_limited' });
      return;
    }
    if (!state.currentRoomKey || !state.currentUserId) {
      if (typeof ack === 'function') ack({ success: false, error: 'not_authenticated' });
      return;
    }
    if (!canBuildInMunicipality(state.socketMunicipalityRole)) {
      if (typeof ack === 'function') ack({ success: false, error: 'no_permission' });
      return;
    }
    const tileX = Number(data.x);
    const tileY = Number(data.y);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) {
      if (typeof ack === 'function') ack({ success: false, error: 'invalid_position' });
      return;
    }

    const roomMeta = wsRoomMetadata.get(state.currentRoomKey);
    if (!roomMeta) {
      if (typeof ack === 'function') ack({ success: false, error: 'room_not_found' });
      return;
    }

    try {
      const { dbPool } = require('../../../infra/db');
      const [items] = await dbPool.query(
        `SELECT gi.id, gi.tool, gi.metadata, gi.x, gi.y,
                gid.build_cost, gid.footprint_width, gid.footprint_height
         FROM game_items gi
         LEFT JOIN game_item_details gid ON gid.tool COLLATE utf8mb4_unicode_ci = gi.tool COLLATE utf8mb4_unicode_ci
         WHERE gi.municipality_id = ? AND gi.room_code = ? AND gi.x = ? AND gi.y = ?
         LIMIT 1`,
        [roomMeta.municipalityId, roomMeta.roomCode, tileX, tileY]
      );

      if (!items || items.length === 0) {
        if (typeof ack === 'function') ack({ success: false, error: 'building_not_found' });
        return;
      }

      const item = items[0];
      const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata || '{}') : (item.metadata || {});

      if (!meta.abandoned && !meta.onFire) {
        if (typeof ack === 'function') ack({ success: false, error: 'not_damaged' });
        return;
      }

      // Repair cost = 50% of build cost
      const baseCost = Math.max(0, Math.round(Number(item.build_cost || 100)));
      const repairCost = Math.max(1, Math.round(baseCost * 0.5));

      const getRooms = require('../../../game/rooms');
      const currentMoney = await getRooms.getMunicipalityMoney(roomMeta.municipalityId);
      if (currentMoney < repairCost) {
        if (typeof ack === 'function') ack({ success: false, error: 'insufficient_funds', required: repairCost, available: currentMoney });
        return;
      }

      await getRooms.deductMunicipalityMoney(roomMeta.municipalityId, repairCost);
      const { applyMunicipalityTransaction } = require('../../../game/bank');
      const repairBankResult = await applyMunicipalityTransaction(roomMeta.municipalityId, {
        amount: -repairCost,
        type: 'repair_cost',
        meta: { buildingType: item.tool, x: tileX, y: tileY },
        actorUserId: state.currentUserId,
        source: 'user',
      });

      const now = Date.now();
      const newMeta = {
        ...meta,
        abandoned: false,
        onFire: false,
        fireProgress: 0,
        constructed: false,
        constructionProgress: 60,
        constructionStartedAt: now,
        age: 0,
      };

      // Update main tile
      await dbPool.query(
        `UPDATE game_items SET metadata = ? WHERE id = ?`,
        [JSON.stringify(newMeta), item.id]
      );

      // Update multi-tile parts (same building at adjacent positions)
      const fw = Math.max(1, Number(item.footprint_width || 1));
      const fh = Math.max(1, Number(item.footprint_height || 1));
      if (fw > 1 || fh > 1) {
        for (let dy = 0; dy < fh; dy++) {
          for (let dx = 0; dx < fw; dx++) {
            if (dx === 0 && dy === 0) continue;
            await dbPool.query(
              `UPDATE game_items SET metadata = JSON_SET(
                COALESCE(metadata, '{}'),
                '$.abandoned', false,
                '$.onFire', false,
                '$.fireProgress', 0,
                '$.constructionProgress', 60,
                '$.constructionStartedAt', ?,
                '$.age', 0
              ) WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ?`,
              [now, roomMeta.municipalityId, roomMeta.roomCode, tileX + dx, tileY + dy]
            );
          }
        }
      }

      if (typeof ack === 'function') {
        ack({
          success: true,
          data: { repairCost, constructionProgress: 60, constructionStartedAt: now, newTreasury: repairBankResult?.treasury ?? null },
        });
      }
    } catch (err) {
      logError('REPAIR', 'Fehler beim Reparieren', { error: err?.message, tileX, tileY });
      if (typeof ack === 'function') ack({ success: false, error: 'server_error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // MOVE-BUILDING
  // ══════════════════════════════════════════════════════════════
  socket.on('move-building', async (data = {}, ack = null) => {
    if (rateLimiter('move-building')) {
      if (typeof ack === 'function') ack({ success: false, error: 'rate_limited' });
      return;
    }
    if (!state.currentRoomKey || !state.currentUserId) {
      if (typeof ack === 'function') ack({ success: false, error: 'not_authenticated' });
      return;
    }
    try {
      const { getUserMunicipalityRole } = require('../../../game/municipality');
      const liveRole = await getUserMunicipalityRole(state.currentUserId, state.socketMunicipalityId);
      state.socketMunicipalityRole = liveRole;
      if (!canBuildInMunicipality(liveRole)) {
        if (typeof ack === 'function') ack({ success: false, error: 'no_permission' });
        return;
      }
    } catch {
      if (!canBuildInMunicipality(state.socketMunicipalityRole)) {
        if (typeof ack === 'function') ack({ success: false, error: 'no_permission' });
        return;
      }
    }

    const fromX = Number(data.fromX);
    const fromY = Number(data.fromY);
    const toX = Number(data.toX);
    const toY = Number(data.toY);
    const flipped = !!data.flipped;

    if (!Number.isFinite(fromX) || !Number.isFinite(fromY) || !Number.isFinite(toX) || !Number.isFinite(toY)) {
      if (typeof ack === 'function') ack({ success: false, error: 'invalid_position' });
      return;
    }
    const samePosition = fromX === toX && fromY === toY;

    const roomMeta = wsRoomMetadata.get(state.currentRoomKey);
    if (!roomMeta) {
      if (typeof ack === 'function') ack({ success: false, error: 'room_not_found' });
      return;
    }

    const liveRole = state.socketMunicipalityRole;
    const isCitizen = liveRole === 'citizen';

    try {
      const { dbPool } = require('../../../infra/db');
      const { getGameMapForMunicipality } = require('../../../game/map');

      // Get the building and its footprint + owner info
      const [items] = await dbPool.query(
        `SELECT gi.id, gi.tool, gi.metadata, gi.user_id,
                COALESCE(gid.footprint_width, 1) AS fw,
                COALESCE(gid.footprint_height, 1) AS fh
         FROM game_items gi
         LEFT JOIN game_item_details gid ON gid.tool COLLATE utf8mb4_unicode_ci = gi.tool COLLATE utf8mb4_unicode_ci
         WHERE gi.municipality_id = ? AND gi.room_code = ? AND gi.x = ? AND gi.y = ? AND gi.action_type = 'place'
         LIMIT 1`,
        [roomMeta.municipalityId, roomMeta.roomCode, fromX, fromY]
      );

      if (!items || items.length === 0) {
        if (typeof ack === 'function') ack({ success: false, error: 'building_not_found' });
        return;
      }

      const item = items[0];

      // Citizens dürfen nur ihre eigene Mansion verschieben (andere Gebäude sind Community-Gebäude)
      if (isCitizen && item.tool === 'mansion' && item.user_id && Number(item.user_id) !== Number(state.currentUserId)) {
        if (typeof ack === 'function') ack({ success: false, error: 'not_your_building' });
        return;
      }

      const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata || '{}') : (item.metadata || {});
      const fw = Math.max(1, Number(item.fw || meta.footprintWidth || 1));
      const fh = Math.max(1, Number(item.fh || meta.footprintHeight || 1));

      if (!samePosition) {
        // Grid-Grenzen prüfen
        const mapData = await getGameMapForMunicipality(roomMeta.municipalityId);
        const gridSize = Number(mapData?.grid_size || 50);
        if (toX < 0 || toY < 0 || toX + fw > gridSize || toY + fh > gridSize) {
          if (typeof ack === 'function') ack({ success: false, error: 'out_of_bounds' });
          return;
        }

        // Bauzone-Check für Zielfeld (gleiche Logik wie bei 'place' Delta)
        const [mzsRows] = await dbPool.query(
          `SELECT bauzone_mode FROM municipality_zone_settings WHERE municipality_id = ? AND room_code = ? LIMIT 1`,
          [roomMeta.municipalityId, roomMeta.roomCode]
        );
        const bauzoneMode = Array.isArray(mzsRows) && mzsRows.length > 0 ? mzsRows[0].bauzone_mode : 'disabled';
        const userMustFollowBauzone = canBuildInMunicipality(liveRole) && require('../../../auth/permissions').shouldEnforceBauzone(liveRole, bauzoneMode);

        if (userMustFollowBauzone) {
          const [bzRows] = await dbPool.query(
            `SELECT 1 FROM game_items WHERE municipality_id = ? AND room_code = ? AND action_type = 'bauzone' LIMIT 1`,
            [roomMeta.municipalityId, roomMeta.roomCode]
          );
          const hasBauzones = Array.isArray(bzRows) && bzRows.length > 0;
          if (hasBauzones) {
            for (let dy = 0; dy < fh; dy++) {
              for (let dx = 0; dx < fw; dx++) {
                const [tileBZ] = await dbPool.query(
                  `SELECT 1 FROM game_items WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'bauzone' LIMIT 1`,
                  [roomMeta.municipalityId, roomMeta.roomCode, toX + dx, toY + dy]
                );
                if (!Array.isArray(tileBZ) || tileBZ.length === 0) {
                  if (typeof ack === 'function') ack({ success: false, error: 'outside_bauzone' });
                  return;
                }
              }
            }
          }
        }

        // Zielfeld auf andere Gebäude prüfen (eigenes Gebäude ausschliessen)
        const targetCoords = [];
        for (let dy = 0; dy < fh; dy++) {
          for (let dx = 0; dx < fw; dx++) {
            targetCoords.push([toX + dx, toY + dy]);
          }
        }
        if (targetCoords.length > 0) {
          const placeholders = targetCoords.map(() => '(?, ?)').join(', ');
          const [occupied] = await dbPool.query(
            `SELECT 1 FROM game_items
             WHERE municipality_id = ? AND room_code = ? AND action_type = 'place'
               AND NOT (x = ? AND y = ?)
               AND (x, y) IN (${placeholders})
             LIMIT 1`,
            [roomMeta.municipalityId, roomMeta.roomCode, fromX, fromY, ...targetCoords.flat()]
          );
          if (occupied && occupied.length > 0) {
            if (typeof ack === 'function') ack({ success: false, error: 'target_occupied' });
            return;
          }
        }
      }

      // Metadata updaten (flipped) + Position
      const newMeta = { ...meta, flipped };
      await dbPool.query(
        `UPDATE game_items SET x = ?, y = ?, metadata = ?, version = version + 1
         WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'place'`,
        [toX, toY, JSON.stringify(newMeta), roomMeta.municipalityId, roomMeta.roomCode, fromX, fromY]
      );

      // Zonen unter altem Footprint mitverschie­ben (nur bei echtem Positions-Wechsel)
      if (!samePosition) {
        const moveDx = toX - fromX;
        const moveDy = toY - fromY;
        for (let oy = 0; oy < fh; oy++) {
          for (let ox = 0; ox < fw; ox++) {
            await dbPool.query(
              `UPDATE game_items SET x = x + ?, y = y + ?, version = version + 1
               WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'zone'`,
              [moveDx, moveDy, roomMeta.municipalityId, roomMeta.roomCode, fromX + ox, fromY + oy]
            );
          }
        }
      }

      if (typeof ack === 'function') ack({ success: true });
    } catch (err) {
      logError('WS', 'move-building error', { error: err?.message });
      if (typeof ack === 'function') ack({ success: false, error: 'server_error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // EXPAND-CITY
  // ══════════════════════════════════════════════════════════════
  const EXPAND_COST = 50000;
  const EXPAND_TILES = 15;

  socket.on('expand-city', async (data = {}, ack = null) => {
    if (rateLimiter('expand-city')) {
      if (typeof ack === 'function') ack({ success: false, error: 'rate_limited' });
      return;
    }
    if (!state.currentRoomKey || !state.currentUserId) {
      if (typeof ack === 'function') ack({ success: false, error: 'not_authenticated' });
      return;
    }
    // DB-Live-Check für schreibende Operation
    try {
      const { getUserMunicipalityRole } = require('../../../game/municipality');
      const liveRole = await getUserMunicipalityRole(state.currentUserId, state.socketMunicipalityId);
      state.socketMunicipalityRole = liveRole;
    } catch {}
    // Only owner can expand
    if (state.socketMunicipalityRole !== 'owner') {
      if (typeof ack === 'function') ack({ success: false, error: 'only_owner_can_expand' });
      return;
    }

    const roomMeta = wsRoomMetadata.get(state.currentRoomKey);
    if (!roomMeta) {
      if (typeof ack === 'function') ack({ success: false, error: 'room_not_found' });
      return;
    }

    try {
      const { dbPool } = require('../../../infra/db');
      const getRooms = require('../../../game/rooms');
      const { getGameMapForMunicipality, upsertGameMapForMunicipality } = require('../../../game/map');

      // Check money
      const currentMoney = await getRooms.getMunicipalityMoney(roomMeta.municipalityId);
      if (currentMoney < EXPAND_COST) {
        if (typeof ack === 'function') ack({ success: false, error: 'insufficient_funds', required: EXPAND_COST, available: currentMoney });
        return;
      }

      // Get current grid_size
      const mapData = await getGameMapForMunicipality(roomMeta.municipalityId);
      const currentGridSize = Number(mapData?.grid_size || 50);
      const newGridSize = currentGridSize + EXPAND_TILES;

      if (newGridSize > 500) {
        if (typeof ack === 'function') ack({ success: false, error: 'max_grid_size_reached' });
        return;
      }

      // Deduct money
      await getRooms.deductMunicipalityMoney(roomMeta.municipalityId, EXPAND_COST);
      const { applyMunicipalityTransaction } = require('../../../game/bank');
      const expandBankResult = await applyMunicipalityTransaction(roomMeta.municipalityId, {
        amount: -EXPAND_COST,
        type: 'expand_city',
        meta: { oldSize: currentGridSize, newSize: newGridSize },
        actorUserId: state.currentUserId,
        source: 'user',
      });

      // NO coordinate shifting needed — expansion adds tiles to right/bottom edge only.
      // Existing game_items stay at their original coordinates.

      // Update grid_size in game_data_map
      await dbPool.query(
        `UPDATE game_data_map SET grid_size = ?, updated_at = CURRENT_TIMESTAMP WHERE municipality_id = ?`,
        [newGridSize, roomMeta.municipalityId]
      );

      if (typeof ack === 'function') {
        ack({
          success: true,
          data: { newGridSize, offset: EXPAND_TILES, cost: EXPAND_COST, newTreasury: expandBankResult?.treasury ?? null },
        });
      }
    } catch (err) {
      logError('EXPAND', 'Fehler beim Stadt erweitern', { error: err?.message });
      if (typeof ack === 'function') ack({ success: false, error: 'server_error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // DELTA / DELTAS (Tile-Placement Forwarding with validation)
  // ══════════════════════════════════════════════════════════════

  // Lazy grid-size cache pro Socket-Connection (wird bei erstem Aufruf geladen)
  let _socketGridSize = undefined;
  const getSocketGridSize = async () => {
    if (_socketGridSize !== undefined) return _socketGridSize;
    const roomMeta = wsRoomMetadata.get(state.currentRoomKey);
    const munId = roomMeta?.municipalityId || state.socketMunicipalityId;
    if (!munId) { _socketGridSize = 0; return 0; }
    try {
      const { dbPool } = require('../../../infra/db');
      const [rows] = await dbPool.query(
        `SELECT grid_size FROM game_data_map WHERE municipality_id = ? LIMIT 1`,
        [munId]
      );
      _socketGridSize = Number(rows?.[0]?.grid_size || 0);
    } catch { _socketGridSize = 0; }
    return _socketGridSize;
  };

  function validateDelta(delta) {
    if (!state.currentRoomKey) return 'no_room';
    if (state.isViewOnly) return 'view_only';
    if (!state.socketMunicipalityRole) return 'not_authenticated';
    if (!canBuildInMunicipality(state.socketMunicipalityRole)) return 'observer_cannot_build';

    const type = String(delta?.type || '');

    if (type === 'bauzone') {
      if (!canManageBauzones(state.socketMunicipalityRole)) return 'bauzone_requires_admin';
    }

    return null;
  }

  function isOutOfBounds(x, y, gridSize) {
    if (!gridSize || gridSize <= 0) return false;
    return !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= gridSize || y >= gridSize;
  }

  socket.on('delta', async (data = {}) => {
    if (rateLimiter('delta')) return;
    if (!state.currentRoomKey || state.isViewOnly) return;
    if (!canBuildInMunicipality(state.socketMunicipalityRole)) {
      socket.emit('delta-rejected', { reason: 'insufficient_permission', delta: data });
      return;
    }
    const rejection = validateDelta(data);
    if (rejection) {
      socket.emit('delta-rejected', { reason: rejection, delta: data });
      return;
    }

    const type = String(data.type || '');
    if (['place', 'zone', 'bulldoze', 'bauzone'].includes(type)) {
      const gridSize = await getSocketGridSize();
      if (isOutOfBounds(Number(data.x), Number(data.y), gridSize)) {
        socket.emit('delta-rejected', { reason: 'out_of_bounds', delta: data });
        return;
      }
    }

    // Bauzone enforcement: uses mode-based check instead of role-only
    if ((type === 'place' || type === 'zone' || type === 'bulldoze') && shouldEnforceBauzone(state.socketMunicipalityRole, state.socketBauzoneMode)) {
      const roomMeta = wsRoomMetadata.get(state.currentRoomKey);
      const munId = roomMeta?.municipalityId || state.socketMunicipalityId;
      const rc = roomMeta?.roomCode;
      if (munId && rc) {
        try {
          const { dbPool } = require('../../../infra/db');
          const [bzRows] = await dbPool.query(
            `SELECT 1 FROM game_items WHERE municipality_id = ? AND room_code = ? AND action_type = 'bauzone' LIMIT 1`,
            [munId, rc]
          );
          if (Array.isArray(bzRows) && bzRows.length > 0) {
            const x = Number(data.x);
            const y = Number(data.y);
            if (Number.isInteger(x) && Number.isInteger(y)) {
              const [tileBZ] = await dbPool.query(
                `SELECT 1 FROM game_items WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'bauzone' LIMIT 1`,
                [munId, rc, x, y]
              );
              if (!Array.isArray(tileBZ) || tileBZ.length === 0) {
                socket.emit('delta-rejected', { reason: 'outside_bauzone', delta: data });
                return;
              }
            }
          }
        } catch (err) {
          logError('WS', 'Bauzone-Check Fehler', { error: err?.message });
        }
      }
    }

    socket.to(state.currentRoomKey).emit('delta', { ...data, playerId: state.currentPlayerId, timestamp: Date.now() });
  });

  socket.on('deltas', async (deltas = []) => {
    if (rateLimiter('deltas')) return;
    if (!state.currentRoomKey || state.isViewOnly || !Array.isArray(deltas)) return;
    if (deltas.length > 200) return;
    if (!state.socketMunicipalityRole || !canBuildInMunicipality(state.socketMunicipalityRole)) {
      socket.emit('delta-rejected', { reason: 'insufficient_permission', delta: deltas });
      return;
    }

    const accepted = [];
    const mustEnforce = shouldEnforceBauzone(state.socketMunicipalityRole, state.socketBauzoneMode);
    const roomMeta = wsRoomMetadata.get(state.currentRoomKey);
    const munId = roomMeta?.municipalityId || state.socketMunicipalityId;
    const rc = roomMeta?.roomCode;
    let _bzCache;
    const hasBauzones = async () => {
      if (_bzCache !== undefined) return _bzCache;
      if (!munId || !rc) { _bzCache = false; return false; }
      try {
        const { dbPool } = require('../../../infra/db');
        const [rows] = await dbPool.query(
          `SELECT 1 FROM game_items WHERE municipality_id = ? AND room_code = ? AND action_type = 'bauzone' LIMIT 1`,
          [munId, rc]
        );
        _bzCache = Array.isArray(rows) && rows.length > 0;
      } catch { _bzCache = false; }
      return _bzCache;
    };

    const batchGridSize = await getSocketGridSize();
    for (const d of deltas) {
      const rejection = validateDelta(d);
      if (rejection) {
        socket.emit('delta-rejected', { reason: rejection, delta: d });
        continue;
      }

      const dtype = String(d.type || '');
      if (['place', 'zone', 'bulldoze', 'bauzone'].includes(dtype)) {
        if (isOutOfBounds(Number(d.x), Number(d.y), batchGridSize)) {
          socket.emit('delta-rejected', { reason: 'out_of_bounds', delta: d });
          continue;
        }
      }
      if (mustEnforce && munId && rc) {
        try {
          const { dbPool } = require('../../../infra/db');
          const dx = Number(d.x);
          const dy = Number(d.y);

          if ((dtype === 'place' || dtype === 'zone' || dtype === 'bulldoze') && Number.isInteger(dx) && Number.isInteger(dy)) {
            if (await hasBauzones()) {
              const [tileBZ] = await dbPool.query(
                `SELECT 1 FROM game_items WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'bauzone' LIMIT 1`,
                [munId, rc, dx, dy]
              );
              if (!Array.isArray(tileBZ) || tileBZ.length === 0) {
                socket.emit('delta-rejected', { reason: 'outside_bauzone', delta: d });
                continue;
              }
            }
          }
        } catch (err) {
          logError('WS', 'Bauzone-Batch-Check Fehler', { error: err?.message });
        }
      }

      accepted.push({ ...d, playerId: state.currentPlayerId, timestamp: Date.now() });
    }
    if (accepted.length > 0) {
      socket.to(state.currentRoomKey).emit('deltas', accepted);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // WERKHOF-REPAIR-COMPLETE
  // Werkhof-LKW hat Gebäude repariert → Zustand auf 100% setzen
  // ══════════════════════════════════════════════════════════════
  socket.on('werkhof-repair-complete', async (data = {}) => {
    if (!state.currentRoomKey) return;

    const tileX = Number(data.x);
    const tileY = Number(data.y);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return;

    const roomMeta = wsRoomMetadata.get(state.currentRoomKey);
    if (!roomMeta) return;

    try {
      const { dbPool } = require('../../../infra/db');

      // Gebäudezustand auf 100% zurücksetzen
      await dbPool.query(
        `UPDATE game_items
         SET metadata = JSON_SET(COALESCE(metadata, '{}'), '$.condition', 100)
         WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ?`,
        [roomMeta.municipalityId, roomMeta.roomCode, tileX, tileY]
      );

      // XP an Patrol-NPC des Werkhofs vergeben (5 XP pro Reparatur)
      const XP_PER_REPAIR = 5;
      await dbPool.query(
        `UPDATE npc_bots nb
         JOIN companies c ON c.id = nb.company_id
         JOIN company_types ct ON ct.id = c.company_type_id
         SET nb.xp_earned = nb.xp_earned + ?,
             nb.patrol_repairs = nb.patrol_repairs + 1
         WHERE c.municipality_id = ? AND ct.code = 'werkhof'
           AND nb.patrol_mode = 1 AND nb.status != 'fired'
         LIMIT 1`,
        [XP_PER_REPAIR, roomMeta.municipalityId]
      );
    } catch (err) {
      logError('WERKHOF', 'Fehler bei Werkhof-Reparatur', { error: err?.message, tileX, tileY });
    }
  });
};
