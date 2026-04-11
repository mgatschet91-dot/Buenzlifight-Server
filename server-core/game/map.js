'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { toJsonValue, toFiniteNumber, seededHash, mulberry32, pickRandomRows } = require('../shared/helpers');

// Lazy requires to avoid circular dependencies
function getRooms() {
  return require('./rooms');
}
function getBuilding() {
  return require('./building');
}

function buildPublicRoomItems(size, generator = 'open') {
  const items = [];
  const gridSize = 50;
  const roomSize = Math.max(6, Math.min(20, Math.round(Number(size || 8))));
  const startX = Math.floor((gridSize - roomSize) / 2);
  const startY = Math.floor((gridSize - roomSize) / 2);
  const endX = startX + roomSize - 1;
  const endY = startY + roomSize - 1;

  const setTerrainTile = (x, y, elevation, paintColor = null) => {
    items.push({
      action_type: 'bulldoze',
      x,
      y,
      metadata: {
        mapPersistent: true,
        publicRoom: true,
        generator,
        elevation,
        ...(paintColor ? { paintColor } : {}),
      },
    });
  };

  // Habbo-artige Public-Room-Variante:
  // Boden + Block-Wände über Elevation, mit kompaktem Eingang.
  if (generator === 'small_walls') {
    // 1) Bodenfläche im Raum markieren
    for (let y = startY; y <= endY; y += 1) {
      for (let x = startX; x <= endX; x += 1) {
        setTerrainTile(x, y, 0, 'dirt');
      }
    }

    // 2) Eingang (2 Tiles) unten mittig freihalten
    const gateX = Math.floor((startX + endX) / 2);
    const gateTiles = new Set([`${gateX},${endY}`, `${Math.max(startX, gateX - 1)},${endY}`]);

    // 3) Wandring als Block-Wand (elevation=2)
    for (let y = startY; y <= endY; y += 1) {
      for (let x = startX; x <= endX; x += 1) {
        const isEdge = x === startX || x === endX || y === startY || y === endY;
        if (!isEdge) continue;
        if (gateTiles.has(`${x},${y}`)) continue;
        setTerrainTile(x, y, 2, 'rock');
      }
    }

    // 4) Einfache "Plus-Block" Akzente innen für Habbo-ähnliche Form
    const centerX = Math.floor((startX + endX) / 2);
    const centerY = Math.floor((startY + endY) / 2);
    const plusOffsets = [
      [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    ];
    for (const [dx, dy] of plusOffsets) {
      const x = centerX + dx;
      const y = centerY + dy;
      if (x <= startX || x >= endX || y <= startY || y >= endY) continue;
      setTerrainTile(x, y, 1, 'rock');
    }

    // 5) Eckeingang akzentuieren
    setTerrainTile(gateX, endY - 1, 1, 'rock');

    // 6) Zusätzlicher kompakter Außenrahmen für Public-Room-Look
    const frameMinX = Math.max(1, startX - 2);
    const frameMinY = Math.max(1, startY - 2);
    const frameMaxX = Math.min(gridSize - 2, endX + 2);
    const frameMaxY = Math.min(gridSize - 2, endY + 2);
    for (let y = frameMinY; y <= frameMaxY; y += 1) {
      for (let x = frameMinX; x <= frameMaxX; x += 1) {
        const onFrame = x === frameMinX || x === frameMaxX || y === frameMinY || y === frameMaxY;
        if (!onFrame) continue;
        // Eingang vorne offen lassen
        if ((x === gateX || x === Math.max(frameMinX, gateX - 1)) && y === frameMaxY) continue;
        setTerrainTile(x, y, 1, 'rock');
      }
    }
  } else if (generator === 'open') {
    // Size-only: Keine Terrain-/Objekt-Items erzeugen.
    // Dadurch verschwindet die Mitte-Plattform komplett.
    // Die gewählte Room-Größe bleibt in game_state (room_size/size_key) gespeichert.
    return [];
  }

  return items;
}

async function getGameMapForMunicipality(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT municipality_id, grid_size, map_data, water_bodies, seed, generator_version, generated_at, updated_at
     FROM game_data_map
     WHERE municipality_id = ?
     LIMIT 1`,
    [municipalityId]
  );
  return rows[0] || null;
}

async function upsertGameMapForMunicipality(municipalityId, payload) {
  ensureDbEnabled();
  await dbPool.query(
    `INSERT INTO game_data_map (
      municipality_id, grid_size, map_data, water_bodies, seed, generator_version, generated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      grid_size = VALUES(grid_size),
      map_data = VALUES(map_data),
      water_bodies = VALUES(water_bodies),
      seed = VALUES(seed),
      generator_version = VALUES(generator_version),
      generated_at = VALUES(generated_at),
      updated_at = CURRENT_TIMESTAMP`,
    [
      municipalityId,
      payload.gridSize,
      JSON.stringify(payload.mapData),
      payload.waterBodies ? JSON.stringify(payload.waterBodies) : null,
      payload.seed,
      payload.generatorVersion,
      payload.generatedAt,
    ]
  );
}

function buildWaterBodiesFromItems(waterItems, gridSize, savedBodies = []) {
  const waterSet = new Set(waterItems.map((i) => `${i.x},${i.y}`));
  const visited = new Set();
  const names = [
    'Lago Alpin', 'Silbersee', 'Bergsee', 'Talwasser', 'Nordufersee',
    'Suedufersee', 'Steinsee', 'Auenwasser', 'Quellsee', 'Gletschersee',
  ];
  const bodies = [];
  for (const item of waterItems) {
    const startKey = `${item.x},${item.y}`;
    if (visited.has(startKey)) continue;
    const queue = [{ x: item.x, y: item.y }];
    const tiles = [];
    visited.add(startKey);
    while (queue.length > 0) {
      const cur = queue.shift();
      tiles.push(cur);
      const neighbors = [
        { x: cur.x - 1, y: cur.y },
        { x: cur.x + 1, y: cur.y },
        { x: cur.x, y: cur.y - 1 },
        { x: cur.x, y: cur.y + 1 },
      ];
      for (const n of neighbors) {
        if (n.x < 0 || n.y < 0 || n.x >= gridSize || n.y >= gridSize) continue;
        const nk = `${n.x},${n.y}`;
        if (!waterSet.has(nk) || visited.has(nk)) continue;
        visited.add(nk);
        queue.push(n);
      }
    }
    const centerX = Math.round(tiles.reduce((s, t) => s + t.x, 0) / Math.max(1, tiles.length));
    const centerY = Math.round(tiles.reduce((s, t) => s + t.y, 0) / Math.max(1, tiles.length));
    bodies.push({
      id: `wb_${bodies.length + 1}`,
      name: names[bodies.length % names.length],
      type: tiles.length > 120 ? 'ocean' : 'lake',
      centerX,
      centerY,
    });
  }
  // Falls gespeicherte Namen vorhanden sind, bestmoeglich wiederverwenden.
  const normalizedSaved = Array.isArray(savedBodies)
    ? savedBodies.filter(
        (b) =>
          b &&
          typeof b.name === 'string' &&
          Number.isFinite(Number(b.centerX)) &&
          Number.isFinite(Number(b.centerY))
      )
    : [];
  if (normalizedSaved.length > 0 && bodies.length > 0) {
    const usedSaved = new Set();
    for (const body of bodies) {
      let bestIdx = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < normalizedSaved.length; i++) {
        if (usedSaved.has(i)) continue;
        const s = normalizedSaved[i];
        const dx = Number(s.centerX) - Number(body.centerX);
        const dy = Number(s.centerY) - Number(body.centerY);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        usedSaved.add(bestIdx);
        body.name = String(normalizedSaved[bestIdx].name);
      }
    }
  }

  return bodies;
}

function generateServerMapItems(gridSize, seedText) {
  const seed = seededHash(seedText);
  const rnd = mulberry32(seed);
  const treeTypes = [
    'tree_oak', 'tree_maple', 'tree_birch', 'tree_pine', 'tree_spruce',
    'tree_fir', 'tree_cedar', 'tree_cherry',
  ];
  const items = [];
  const maxLakes = 2;
  const lakeCount = Math.max(1, Math.min(maxLakes, 1 + Math.floor(rnd() * 2)));
  const lakes = [];
  for (let i = 0; i < lakeCount; i += 1) {
    const radius = 2 + Math.floor(rnd() * 3); // kleine Seen: Radius 2..4
    const margin = 6 + radius;
    const cx = margin + Math.floor(rnd() * Math.max(1, gridSize - margin * 2));
    const cy = margin + Math.floor(rnd() * Math.max(1, gridSize - margin * 2));
    lakes.push({ cx, cy, radius });
  }

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      let isWater = false;
      for (const lake of lakes) {
        const dx = x - lake.cx;
        const dy = y - lake.cy;
        if ((dx * dx + dy * dy) <= (lake.radius * lake.radius)) {
          isWater = true;
          break;
        }
      }

      if (isWater) {
        items.push({
          action_type: 'place',
          tool: 'water',
          x,
          y,
          metadata: { mapPersistent: true },
        });
        continue;
      }

      const makeTree = rnd() < 0.075;
      if (makeTree) {
        items.push({
          action_type: 'place',
          tool: treeTypes[Math.floor(rnd() * treeTypes.length)],
          x,
          y,
          metadata: { mapPersistent: true },
        });
      }
    }
  }

  const waterItems = items.filter((i) => i.tool === 'water');
  const waterBodies = buildWaterBodiesFromItems(waterItems, gridSize);
  return { items, waterBodies };
}

async function ensureServerGeneratedRoomMap(municipality, roomCode) {
  ensureDbEnabled();
  const rooms = getRooms();
  await rooms.createOrGetRoom(municipality.id, roomCode, municipality.name, null);
  const room = await rooms.getRoom(municipality.id, roomCode);
  const roomState = toJsonValue(room?.game_state);
  const isNavigatorPublic = Boolean(roomCode.startsWith('PUB') || roomState?.navigator_public === true);
  const roomSize = Math.max(6, Math.min(12, Math.round(Number(roomState?.room_size || 8))));
  const existingRows = await rooms.getRoomItemRows(municipality.id, roomCode);
  if (existingRows.length > 0) {
    // Backfill: wenn Items existieren, aber noch kein game_data_map Snapshot vorhanden ist,
    // erzeugen wir ihn sofort aus den vorhandenen Items (inkl. water_bodies Namen).
    const existingMap = await getGameMapForMunicipality(municipality.id);
    if (!existingMap) {
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-backfill-v1');
    }
    return {
      generated: false,
      itemCount: existingRows.length,
      version: await rooms.getRoomItemVersion(municipality.id, roomCode),
    };
  }

  if (isNavigatorPublic) {
    // Public Rooms: Keine Wald-/See-Generierung.
    // Ein neutrales Marker-Item verhindert item_count=0 (sonst Join bricht ab).
    const marker = [{
      action_type: 'bulldoze',
      x: 0,
      y: 0,
      metadata: {
        mapPersistent: true,
        publicRoom: true,
        generator: 'open',
        room_size: roomSize,
      },
    }];
    const imported = await rooms.importRoomItems(municipality.id, roomCode, 'public-room-marker', null, marker);
    await upsertGameMapForMunicipality(municipality.id, {
      gridSize: roomSize,
      mapData: {
        source: 'server-core-public-room',
        room_code: roomCode,
        item_count: marker.length,
        items: marker,
      },
      waterBodies: [],
      seed: `${municipality.slug}:${roomCode}:public-room`,
      generatorVersion: 'server-core-public-room-v1',
      generatedAt: new Date(),
    });
    return {
      generated: true,
      itemCount: marker.length,
      version: imported.newVersion,
    };
  }

  const gridSize = 50;
  const seedText = `${municipality.slug}:${roomCode}:server-core-v1`;
  const { items, waterBodies } = generateServerMapItems(gridSize, seedText);
  const imported = await rooms.importRoomItems(municipality.id, roomCode, 'terrain', null, items);

  await upsertGameMapForMunicipality(municipality.id, {
    gridSize,
    mapData: {
      source: 'server-core',
      room_code: roomCode,
      item_count: items.length,
      items,
    },
    waterBodies,
    seed: seedText,
    generatorVersion: 'server-core-50x50-v1',
    generatedAt: new Date(),
  });

  return {
    generated: true,
    itemCount: items.length,
    version: imported.newVersion,
  };
}

async function refreshGameDataMapFromItems(municipality, roomCode, source = 'server-core-live-v1') {
  ensureDbEnabled();
  const rooms = getRooms();
  const building = getBuilding();
  const rows = await rooms.getRoomItemRows(municipality.id, roomCode);
  const version = await rooms.getRoomItemVersion(municipality.id, roomCode);
  const formattedItems = rows.map(building.formatGameItemRow);
  const existingMap = await getGameMapForMunicipality(municipality.id);
  const savedBodies = toJsonValue(existingMap?.water_bodies);
  // Preserve the current grid_size from DB (may have been expanded via expand-city)
  const currentGridSize = Number(existingMap?.grid_size || 50);
  const waterItems = formattedItems.filter(
    (i) => i.action_type === 'place' && i.tool === 'water'
  );
  const waterBodies = buildWaterBodiesFromItems(waterItems, currentGridSize, savedBodies);

  await upsertGameMapForMunicipality(municipality.id, {
    gridSize: currentGridSize,
    mapData: {
      source,
      room_code: roomCode,
      version,
      item_count: formattedItems.length,
      items: formattedItems,
    },
    waterBodies,
    seed: `${municipality.slug}:${roomCode}:server-core-v1`,
    generatorVersion: source,
    generatedAt: new Date(),
  });
}

module.exports = {
  buildPublicRoomItems,
  getGameMapForMunicipality,
  upsertGameMapForMunicipality,
  buildWaterBodiesFromItems,
  generateServerMapItems,
  ensureServerGeneratedRoomMap,
  refreshGameDataMapFromItems,
};
