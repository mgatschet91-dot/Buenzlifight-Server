'use strict';
// ─── Room Layout API ──────────────────────────────────────────────────────────
// GET  /api/game/user/room/layout            → eigenes Layout laden (auth)
// GET  /api/game/user/room/layout?user_id=   → fremdes Layout laden (public)
// PUT  /api/game/user/room/layout            → eigenes Layout speichern (auth, owner only)
// PUT  /api/game/user/room/thumbnail         → Thumbnail speichern (auth, owner only)
// GET  /api/game/pub-room/layout?slug&room_code → PUB-Room Layout laden
// PUT  /api/game/pub-room/layout?slug&room_code → PUB-Room Layout speichern (admin/mod)

const fs   = require('fs');
const path = require('path');
const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser, getUserGlobalRole } = require('../../../auth/middleware');
const { GLOBAL_ROLE_MODERATOR, GLOBAL_ROLE_ADMINISTRATOR } = require('../../../config/constants');
const { getMunicipalityBySlug } = require('../../../game/municipality');
const crypto = require('crypto');

const THUMBS_DIR = path.join(__dirname, '../../../uploads/room-thumbs');

function hashRoomPassword(plaintext) {
  return crypto.createHash('sha256').update('meinort_room:' + plaintext).digest('hex');
}

// ── Hilfsfunktion: Layout aus DB für einen User laden ─────────────────────────
async function loadLayoutForUser(userId) {
  // Etagen
  const [floorRows] = await dbPool.query(
    `SELECT id, floor_index, name, y_height, x0, x1, z0, z1,
            color_a, color_b,
            wall_n, wall_s, wall_e, wall_w,
            door_n, door_s, door_e, door_w
     FROM user_room_floors
     WHERE user_id = ?
     ORDER BY floor_index ASC`,
    [userId]
  );

  if (floorRows.length === 0) return null; // Kein eigenes Layout gespeichert

  // Boden-Löcher
  const floorIds = floorRows.map(f => f.id);
  let holeRows = [];
  if (floorIds.length > 0) {
    [holeRows] = await dbPool.query(
      `SELECT floor_id, tile_x, tile_z FROM user_room_floor_holes WHERE floor_id IN (?)`,
      [floorIds]
    );
  }

  // Treppen
  const [stairRows] = await dbPool.query(
    `SELECT id, from_floor, to_floor, anchor_x, anchor_z, dir,
            width_tiles, steps, height, style, gate_width, gate_open
     FROM user_room_staircases WHERE user_id = ? ORDER BY id ASC`,
    [userId]
  );

  // Roller
  const [rollerRows] = await dbPool.query(
    `SELECT id, floor_idx, x, z, dir FROM user_room_rollers WHERE user_id = ? ORDER BY id ASC`,
    [userId]
  );

  // Spawn
  const [spawnRows] = await dbPool.query(
    `SELECT spawn_x, spawn_z, floor_idx, facing_idx FROM user_room_spawn WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  const spawnRow = spawnRows[0] || { spawn_x: 0, spawn_z: 0, floor_idx: 0, facing_idx: 0 };

  // Raum-Einstellungen (Wandfarbe, Beleuchtung, Name, Kapazität, Schloss)
  const [[settingsRow]] = await dbPool.query(
    `SELECT wall_color_hex, lighting_json, room_display_name, room_description, max_visitors,
            is_locked, room_password_hash
     FROM user_room_settings WHERE user_id = ? LIMIT 1`,
    [userId]
  );

  // Löcher den Etagen zuordnen
  const holesById = {};
  for (const h of holeRows) {
    if (!holesById[h.floor_id]) holesById[h.floor_id] = [];
    holesById[h.floor_id].push([h.tile_x, h.tile_z]);
  }

  // Etagen in Editor-Format bauen (lokale IDs f0, f1, ...)
  const floors = floorRows.map(f => ({
    id:       'f' + f.floor_index,
    floor_index: f.floor_index,
    name:     f.name,
    y:        f.y_height,
    x0: f.x0, x1: f.x1, z0: f.z0, z1: f.z1,
    colorA:   f.color_a,
    colorB:   f.color_b,
    wallN: !!f.wall_n, wallS: !!f.wall_s, wallE: !!f.wall_e, wallW: !!f.wall_w,
    doorN: !!f.door_n, doorS: !!f.door_s, doorE: !!f.door_e, doorW: !!f.door_w,
    holes: holesById[f.id] || [],
  }));

  // Treppen in Editor-Format
  let stairs = stairRows.map((s, i) => ({
    id:          's' + i,
    fromFloorId: 'f' + s.from_floor,
    toFloorId:   s.to_floor != null ? 'f' + s.to_floor : null,
    from_floor:  s.from_floor,
    to_floor:    s.to_floor,
    x:           s.anchor_x,
    z:           s.anchor_z,
    dir:         s.dir,
    width:       s.width_tiles,
    steps:       s.steps,
    height:      s.height,
    style:       s.style,
    gate:        s.gate_width != null ? { width: s.gate_width, open: !!s.gate_open } : null,
  }));

  // Wenn mehrere Etagen vorhanden aber keine Treppe gespeichert: Treppe aus model_standard als Fallback
  // (passiert wenn Layout vor dem Treppen-System gespeichert wurde)
  if (floors.length > 1 && stairs.length === 0) {
    const [tmplRows] = await dbPool.query(
      `SELECT x0, x1, z0, z1, from_floor, to_floor
       FROM room_staircases WHERE model_name = 'model_standard' ORDER BY id ASC`
    );
    stairs = tmplRows.map((s, i) => {
      const dz  = Math.abs(s.z1 - s.z0), dx = Math.abs(s.x1 - s.x0);
      const dir = dz >= dx ? 'N' : 'E';
      const w   = dir === 'N' ? dx : dz;
      const ax  = (s.x0 + s.x1) / 2;
      const az  = dir === 'N' ? s.z1 : (s.z0 + s.z1) / 2;
      const toFloorIdx = s.to_floor != null ? s.to_floor : 1;
      const toFloorRow = floorRows.find(f => f.floor_index === toFloorIdx);
      const rise       = toFloorRow ? toFloorRow.y_height : 7;
      return {
        id:          's' + i,
        fromFloorId: 'f' + (s.from_floor || 0),
        toFloorId:   'f' + toFloorIdx,
        from_floor:  s.from_floor || 0,
        to_floor:    toFloorIdx,
        x: ax, z: az, dir,
        width: Math.round(w),
        steps: 14, height: rise, style: 'classic', gate: null,
      };
    });
  }

  // Roller in Editor-Format
  const rollers = rollerRows.map((r, i) => ({
    id:      'r' + i,
    floorId: 'f' + r.floor_idx,
    floor_idx: r.floor_idx,
    x: r.x, z: r.z, dir: r.dir,
  }));

  return {
    v: 1,
    wallColor:        settingsRow?.wall_color_hex ?? '#d8c9a8',
    lighting:         settingsRow?.lighting_json ? (() => { try { return JSON.parse(settingsRow.lighting_json); } catch { return null; } })() : null,
    roomDisplayName:  settingsRow?.room_display_name ?? null,
    roomDescription:  settingsRow?.room_description  ?? null,
    maxVisitors:      settingsRow?.max_visitors       ?? 25,
    isLocked:         settingsRow?.is_locked          ? true : false,
    hasPassword:      settingsRow?.room_password_hash ? true : false,
    floors,
    stairs,
    rollers,
    spawn: {
      x:          spawnRow.spawn_x,
      z:          spawnRow.spawn_z,
      floorId:    'f' + spawnRow.floor_idx,
      floor_idx:  spawnRow.floor_idx,
      facing_idx: spawnRow.facing_idx ?? 0,
    },
  };
}

// ── Standard-Grid beim ersten Raumbesuch initialisieren ──────────────────────
// Schreibt das Template einmalig in user_room_floors, sodass der User
// beim ersten Öffnen bereits ein fertiges Grid vorfindet.
async function initDefaultLayoutForUser(userId) {
  const layout = await loadTemplateForUser(userId);
  if (!layout || !layout.floors?.length) return layout;

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM user_room_floors WHERE user_id = ?', [userId]);
    await conn.query('DELETE FROM user_room_staircases WHERE user_id = ?', [userId]);

    // Nur Erdgeschoss (floor_index=0) — Treppe/OG kann User selbst im Editor hinzufügen
    const eg = layout.floors.find(f => f.floor_index === 0) || layout.floors[0];
    await conn.query(
      `INSERT INTO user_room_floors
       (user_id, floor_index, name, y_height, x0, x1, z0, z1,
        color_a, color_b, wall_n, wall_s, wall_e, wall_w, door_n, door_s, door_e, door_w)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        userId, 0, 'Erdgeschoss', 0,
        eg.x0 ?? -10, eg.x1 ?? 10,
        eg.z0 ?? -10, eg.z1 ?? 10,
        eg.colorA ?? 0x4a7a5a, eg.colorB ?? 0x527d63,
        eg.wallN ? 1 : 0, eg.wallS ? 1 : 0, eg.wallE ? 1 : 0, eg.wallW ? 1 : 0,
        eg.doorN ? 1 : 0, eg.doorS ? 1 : 0, eg.doorE ? 1 : 0, eg.doorW ? 1 : 0,
      ]
    );

    // Spawn-Punkt: Eingang nahe der Süd-Tür (z=8 = kurz vor Süd-Wand bei z=10)
    await conn.query(
      `INSERT INTO user_room_spawn (user_id, spawn_x, spawn_z, floor_idx)
       VALUES (?, 0, 8, 0)
       ON DUPLICATE KEY UPDATE spawn_x = 0, spawn_z = 8, floor_idx = 0`,
      [userId]
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback();
  } finally {
    conn.release();
  }

  return layout;
}

// ── Template-Fallback: room_models + room_floors + room_staircases → roomData ──
// Wird verwendet wenn der User noch kein eigenes Layout gespeichert hat.
// Konvertiert das globale Template in das Editor-Format damit die Treppe
// und das Stockwerk sofort im Editor sichtbar und bearbeitbar sind.
async function loadTemplateForUser(userId) {
  // Model-Name des Users ermitteln (residence_rooms)
  const [rrRows] = await dbPool.query(
    'SELECT model_name FROM residence_rooms WHERE user_id = ? LIMIT 1',
    [userId]
  );
  const modelName = rrRows[0]?.model_name || 'model_standard';

  // Template-Geometrie laden
  const [tplRows] = await dbPool.query(
    `SELECT grid_size, wall_n, wall_s, wall_e, wall_w,
            door_wall, door_offset, door_width, door_height
     FROM room_models WHERE model_name = ? LIMIT 1`,
    [modelName]
  );
  const tpl = tplRows[0] || {};
  const gridSize = tpl.grid_size || 20;
  const half = gridSize / 2;

  // Etagen aus room_floors (Oberstockwerke)
  const [floorRows] = await dbPool.query(
    `SELECT floor_index, y_height, x0, x1, z0, z1
     FROM room_floors WHERE model_name = ? ORDER BY floor_index ASC`,
    [modelName]
  );

  // Treppen aus room_staircases (altes Zonen-Format)
  // room_staircases hat nur das alte Zonen-Format (x0/x1/z0/z1)
  // anchor_x/dir/steps etc. existieren NICHT in dieser Tabelle
  const [stairRows] = await dbPool.query(
    `SELECT x0, x1, z0, z1, from_floor, to_floor
     FROM room_staircases WHERE model_name = ? ORDER BY id ASC`,
    [modelName]
  );

  // Erdgeschoss immer als Boden-Etage (floor_index=0, y=0)
  const floors = [{
    id:          'f0',
    floor_index: 0,
    name:        'Erdgeschoss',
    y:           0,
    x0:          -half, x1: half, z0: -half, z1: half,
    colorA:      0x4a7a5a,
    colorB:      0x527d63,
    wallN:       !!(tpl.wall_n),
    wallS:       !!(tpl.wall_s),
    wallE:       !!(tpl.wall_e),
    wallW:       !!(tpl.wall_w),
    doorN: false,
    doorS: (tpl.door_wall || 'S') === 'S',
    doorE: (tpl.door_wall || 'S') === 'E',
    doorW: (tpl.door_wall || 'S') === 'W',
    holes: [],
  }];

  // Oberstockwerke aus room_floors
  for (const f of floorRows) {
    floors.push({
      id:          'f' + f.floor_index,
      floor_index: f.floor_index,
      name:        'Stockwerk ' + f.floor_index,
      y:           f.y_height,
      x0: f.x0, x1: f.x1, z0: f.z0, z1: f.z1,
      colorA:      0xa07850,
      colorB:      0x8c6840,
      wallN: false, wallS: false, wallE: false, wallW: false,
      doorN: false, doorS: false, doorE: false, doorW: false,
      holes: [],
    });
  }

  // Treppen konvertieren: altes Zonen-Format (x0/x1/z0/z1) → Editor-Format
  const stairs = [];
  for (let i = 0; i < stairRows.length; i++) {
    const s = stairRows[i];
    // Geometrie aus der Zone ableiten
    const dz  = Math.abs(s.z1 - s.z0);
    const dx  = Math.abs(s.x1 - s.x0);
    // Treppe verläuft in der längeren Achse
    const dir = dz >= dx ? 'N' : 'E';
    const w   = dir === 'N' ? dx : dz;
    // Anker = unteres Ende der Treppe (Richtung N → Anker bei z1 = südliches Ende)
    const ax  = (s.x0 + s.x1) / 2;
    const az  = dir === 'N' ? s.z1 : (s.z0 + s.z1) / 2;
    const toFloorIdx = s.to_floor != null ? s.to_floor : 1;
    const toFloor    = floorRows.find(f => f.floor_index === toFloorIdx);
    const rise       = toFloor ? toFloor.y_height : 7;
    stairs.push({
      id:          's' + i,
      fromFloorId: 'f' + (s.from_floor || 0),
      toFloorId:   'f' + toFloorIdx,
      from_floor:  s.from_floor || 0,
      to_floor:    toFloorIdx,
      x:           ax,
      z:           az,
      dir:         dir,
      width:       Math.round(w),
      steps:       14,
      height:      rise,
      style:       'classic',
      gate:        null,
    });
  }

  return {
    v:       1,
    floors,
    stairs,
    rollers: [],
    spawn:   { x: 0, z: 0, floorId: 'f0', floor_idx: 0 },
  };
}

// ── Validierung ───────────────────────────────────────────────────────────────
function validateLayout(layout) {
  if (!layout || typeof layout !== 'object') return 'Ungültiges Layout';
  if (!Array.isArray(layout.floors) || layout.floors.length < 1) return 'Mindestens 1 Etage erforderlich';
  if (layout.floors.length > 10) return 'Maximal 10 Etagen erlaubt';
  if (Array.isArray(layout.stairs) && layout.stairs.length > 20) return 'Maximal 20 Treppen erlaubt';
  if (Array.isArray(layout.rollers) && layout.rollers.length > 50) return 'Maximal 50 Roller erlaubt';
  const dirs = new Set(['N', 'S', 'E', 'W']);
  for (const s of (layout.stairs || [])) {
    if (!dirs.has(s.dir)) return 'Ungültige Trep-Richtung: ' + s.dir;
  }
  return null;
}

module.exports = function registerRoomLayoutRoutes(_deps) {
  return async function handleRoomLayout(req, res, pathname) {

    // ── GET /api/game/user/room/layout ─────────────────────────────────────
    if (pathname === '/api/game/user/room/layout' && req.method === 'GET') {
      ensureDbEnabled();
      const url     = new URL('http://x' + req.url);
      const uidParam = url.searchParams.get('user_id');

      let userId;
      if (uidParam) {
        userId = Number(uidParam);
        if (!Number.isInteger(userId) || userId <= 0)
          return sendJson(res, 400, { ok: false, error: 'Ungültige user_id' });
      } else {
        const user = await getAuthenticatedUser(req);
        if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
        userId = user.id;
      }

      let layout = await loadLayoutForUser(userId);

      // Kein eigenes Layout → Standard-Grid aus Template initialisieren und speichern
      if (!layout) {
        layout = await initDefaultLayoutForUser(userId);
      }

      return sendJson(res, 200, { ok: true, data: layout });
    }

    // ── PUT /api/game/user/room/layout ─────────────────────────────────────
    if (pathname === '/api/game/user/room/layout' && req.method === 'PUT') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const body = await readJsonBody(req);
      const err  = validateLayout(body);
      if (err) return sendJson(res, 422, { ok: false, error: err });

      const userId = user.id;
      const { floors, stairs = [], rollers = [], spawn, wallColor, lighting,
              roomDisplayName, roomDescription, maxVisitors,
              isLocked, roomPassword } = body;

      // Atomar: alles löschen → neu einfügen
      const conn = await dbPool.getConnection();
      try {
        await conn.beginTransaction();

        // 1. Löcher löschen (cascadiert von user_room_floors)
        await conn.query('DELETE FROM user_room_floors WHERE user_id = ?', [userId]);
        // Treppen + Roller manuell löschen (kein CASCADE)
        await conn.query('DELETE FROM user_room_staircases WHERE user_id = ?', [userId]);
        await conn.query('DELETE FROM user_room_rollers WHERE user_id = ?', [userId]);
        await conn.query('DELETE FROM user_room_spawn WHERE user_id = ?', [userId]);

        // 2. Etagen einfügen, neue IDs merken (floor_index → DB id)
        const floorIdMap = {}; // 'f0' → DB-id
        for (const fl of floors) {
          const floorIdx = fl.floor_index != null ? fl.floor_index : (parseInt((fl.id || '0').replace(/\D/g, ''), 10) || 0);
          const [res2] = await conn.query(
            `INSERT INTO user_room_floors
             (user_id, floor_index, name, y_height, x0, x1, z0, z1,
              color_a, color_b, wall_n, wall_s, wall_e, wall_w, door_n, door_s, door_e, door_w)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              userId, floorIdx,
              (fl.name || 'Etage').substring(0, 80),
              fl.y != null ? fl.y : (fl.y_height != null ? fl.y_height : 0),
              fl.x0 != null ? fl.x0 : -10, fl.x1 != null ? fl.x1 : 10,
              fl.z0 != null ? fl.z0 : -10, fl.z1 != null ? fl.z1 : 10,
              fl.colorA != null ? fl.colorA : (fl.color_a != null ? fl.color_a : 4882010),
              fl.colorB != null ? fl.colorB : (fl.color_b != null ? fl.color_b : 5406051),
              fl.wallN ? 1 : 0, fl.wallS ? 1 : 0, fl.wallE ? 1 : 0, fl.wallW ? 1 : 0,
              fl.doorN ? 1 : 0, fl.doorS ? 1 : 0, fl.doorE ? 1 : 0, fl.doorW ? 1 : 0,
            ]
          );
          floorIdMap[fl.id] = res2.insertId;
          floorIdMap['f' + floorIdx] = res2.insertId;

          // 3. Löcher einfügen
          for (const [tx, tz] of (fl.holes || [])) {
            await conn.query(
              'INSERT INTO user_room_floor_holes (floor_id, tile_x, tile_z) VALUES (?,?,?)',
              [res2.insertId, tx, tz]
            );
          }
        }

        // 4. Treppen einfügen
        for (const s of stairs) {
          const fromIdx = s.from_floor != null ? s.from_floor : (parseInt((s.fromFloorId || '0').replace(/\D/g, ''), 10) || 0);
          const toIdx   = s.to_floor != null ? s.to_floor
                        : (s.toFloorId ? parseInt(s.toFloorId.replace(/\D/g, ''), 10) : null);
          await conn.query(
            `INSERT INTO user_room_staircases
             (user_id, from_floor, to_floor, anchor_x, anchor_z, dir,
              width_tiles, steps, height, style, gate_width, gate_open)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              userId,
              fromIdx,
              toIdx != null ? Number(toIdx) : null,
              s.x ?? 0, s.z ?? 0,
              (s.dir || 'N').substring(0, 1).toUpperCase(),
              s.width ?? s.width_tiles ?? 3,
              s.steps ?? 14,
              s.height ?? 7,
              (s.style || 'classic').substring(0, 16),
              s.gate?.width ?? null,
              s.gate?.open ? 1 : 0,
            ]
          );
        }

        // 5. Roller einfügen
        for (const r of rollers) {
          const floorIdx = r.floor_idx != null ? r.floor_idx : (parseInt((r.floorId || '0').replace(/\D/g, ''), 10) || 0);
          await conn.query(
            'INSERT INTO user_room_rollers (user_id, floor_idx, x, z, dir) VALUES (?,?,?,?,?)',
            [userId, floorIdx, r.x ?? 0, r.z ?? 0, (r.dir || 'S').substring(0, 1).toUpperCase()]
          );
        }

        // 6. Spawn speichern
        if (spawn) {
          const floorIdx  = spawn.floor_idx != null ? spawn.floor_idx : (parseInt((spawn.floorId || '0').replace(/\D/g, ''), 10) || 0);
          const facingIdx = Math.max(0, Math.min(3, parseInt(spawn.facing_idx ?? 0, 10)));
          await conn.query(
            `INSERT INTO user_room_spawn (user_id, spawn_x, spawn_z, floor_idx, facing_idx)
             VALUES (?,?,?,?,?)`,
            [userId, spawn.x ?? 0, spawn.z ?? 0, floorIdx, facingIdx]
          );
        }

        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }

      // Raum-Einstellungen speichern (Wandfarbe, Beleuchtung, Name, Beschreibung, Kapazität, Schloss)
      const safeWallColor  = /^#[0-9a-fA-F]{6}$/.test(wallColor) ? wallColor : '#d8c9a8';
      const lightingJson   = lighting && typeof lighting === 'object' ? JSON.stringify(lighting) : null;
      const safeRoomName   = roomDisplayName ? String(roomDisplayName).trim().slice(0, 60)   || null : null;
      const safeRoomDesc   = roomDescription ? String(roomDescription).trim().slice(0, 200)  || null : null;
      const safeMaxVisit   = Math.min(50, Math.max(5, Number(maxVisitors) || 25));
      const safeLocked     = isLocked ? 1 : 0;
      // roomPassword: leer → Passwort entfernen; gesetzt → hashen und speichern
      // null → unveränderter Passwort-Hash (nicht mitgeschickt)
      let passwordHash;
      if (roomPassword === '') {
        passwordHash = null; // Passwort entfernen
      } else if (roomPassword && typeof roomPassword === 'string') {
        passwordHash = hashRoomPassword(roomPassword.slice(0, 100));
      } else {
        // Feld nicht mitgeschickt → bestehenden Hash behalten
        const [[curSettings]] = await dbPool.query(
          'SELECT room_password_hash FROM user_room_settings WHERE user_id = ? LIMIT 1',
          [userId]
        );
        passwordHash = curSettings?.room_password_hash ?? null;
      }
      await dbPool.query(
        `INSERT INTO user_room_settings
           (user_id, wall_color_hex, lighting_json, room_display_name, room_description, max_visitors, is_locked, room_password_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           wall_color_hex     = VALUES(wall_color_hex),
           lighting_json      = VALUES(lighting_json),
           room_display_name  = VALUES(room_display_name),
           room_description   = VALUES(room_description),
           max_visitors       = VALUES(max_visitors),
           is_locked          = VALUES(is_locked),
           room_password_hash = VALUES(room_password_hash)`,
        [userId, safeWallColor, lightingJson, safeRoomName, safeRoomDesc, safeMaxVisit, safeLocked, passwordHash]
      );

      return sendJson(res, 200, { ok: true });
    }

    // ── GET /api/game/pub-room/layout?slug=...&room_code=... ───────────────
    if (pathname === '/api/game/pub-room/layout' && req.method === 'GET') {
      ensureDbEnabled();
      const url      = new URL('http://x' + req.url);
      const slug     = (url.searchParams.get('slug') || '').trim();
      const roomCode = (url.searchParams.get('room_code') || '').trim().toUpperCase();
      if (!slug || !roomCode) return sendJson(res, 400, { ok: false, error: 'slug und room_code erforderlich' });

      const muni = await getMunicipalityBySlug(slug);
      if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const [[row]] = await dbPool.query(
        'SELECT layout_json FROM game_rooms WHERE municipality_id = ? AND room_code = ? LIMIT 1',
        [muni.id, roomCode]
      );
      if (!row) return sendJson(res, 404, { ok: false, error: 'Raum nicht gefunden' });

      // Kein gespeichertes Layout → einfaches Erdgeschoss als Fallback
      if (!row.layout_json) {
        const defaultLayout = {
          v: 1,
          floors: [{ id: 'f0', floor_index: 0, name: 'Erdgeschoss', y: 0, x0: -12, x1: 12, z0: -12, z1: 12, colorA: 0x5a8a7a, colorB: 0x4a7a6a, wallN: false, wallS: false, wallE: false, wallW: false, doorN: false, doorS: false, doorE: false, doorW: false, holes: [] }],
          stairs: [],
          rollers: [],
          spawn: { x: 0, z: 0, floorId: 'f0', floor_idx: 0, facing_idx: 0 },
        };
        return sendJson(res, 200, { ok: true, data: defaultLayout });
      }

      let layout;
      try { layout = JSON.parse(row.layout_json); } catch { return sendJson(res, 500, { ok: false, error: 'Gespeichertes Layout ist ungültig' }); }
      return sendJson(res, 200, { ok: true, data: layout });
    }

    // ── PUT /api/game/pub-room/layout?slug=...&room_code=... ──────────────
    if (pathname === '/api/game/pub-room/layout' && req.method === 'PUT') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });

      const globalRole = await getUserGlobalRole(user.id);
      const role = String(globalRole || '').toLowerCase();
      if (role !== GLOBAL_ROLE_MODERATOR && role !== GLOBAL_ROLE_ADMINISTRATOR) {
        return sendJson(res, 403, { ok: false, error: 'Nur Moderatoren und Admins dürfen öffentliche Räume bearbeiten' });
      }

      const url      = new URL('http://x' + req.url);
      const slug     = (url.searchParams.get('slug') || '').trim();
      const roomCode = (url.searchParams.get('room_code') || '').trim().toUpperCase();
      if (!slug || !roomCode) return sendJson(res, 400, { ok: false, error: 'slug und room_code erforderlich' });

      const muni = await getMunicipalityBySlug(slug);
      if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const body = await readJsonBody(req);
      const err  = validateLayout(body);
      if (err) return sendJson(res, 422, { ok: false, error: err });

      const [result] = await dbPool.query(
        'UPDATE game_rooms SET layout_json = ? WHERE municipality_id = ? AND room_code = ?',
        [JSON.stringify(body), muni.id, roomCode]
      );
      if (result.affectedRows === 0) return sendJson(res, 404, { ok: false, error: 'Raum nicht gefunden' });

      return sendJson(res, 200, { ok: true });
    }

    // ── PUT /api/game/user/room/thumbnail ───────────────────────────────────
    if (pathname === '/api/game/user/room/thumbnail' && req.method === 'PUT') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const body = await readJsonBody(req);
      const dataUrl = String(body?.dataUrl || '');
      const match = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
      if (!match) return sendJson(res, 400, { ok: false, error: 'Ungültige dataUrl' });

      const imageBuffer = Buffer.from(match[2], 'base64');
      if (imageBuffer.length > 500 * 1024) {
        return sendJson(res, 413, { ok: false, error: 'Thumbnail zu groß (max. 500 KB)' });
      }

      if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });
      fs.writeFileSync(path.join(THUMBS_DIR, `${authUser.id}.jpg`), imageBuffer);

      await dbPool.query(
        `INSERT INTO user_room_settings (user_id, thumbnail_updated_at)
         VALUES (?, NOW())
         ON DUPLICATE KEY UPDATE thumbnail_updated_at = NOW()`,
        [authUser.id]
      );

      return sendJson(res, 200, { ok: true, url: `/room-thumbs/${authUser.id}.jpg` });
    }
  };
};

module.exports.loadLayoutForUser    = loadLayoutForUser;
module.exports.loadTemplateForUser  = loadTemplateForUser;
