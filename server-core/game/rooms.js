'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { logError } = require('../infra/logger');
const { ROOM_CACHE_UNLOAD_IDLE_MS, ROOM_CACHE_FLUSH_INTERVAL_MS } = require('../config/constants');
const {
  normalizeRoomCode,
  toJsonValue,
  cloneJsonValue,
  toFiniteNumber,
  jsonEquals,
  metaValue,
} = require('../shared/helpers');

const roomRuntimeCache = new Map();

// ─── Room DB ─────────────────────────────────────────────────────────────

async function getRoom(municipalityId, roomCode) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT id, room_code, city_name, game_state, player_count, is_active, created_at, updated_at
     FROM game_rooms
     WHERE municipality_id = ? AND room_code = ?
     LIMIT 1`,
    [municipalityId, roomCode]
  );
  return rows[0] || null;
}

async function createOrGetRoom(municipalityId, roomCode, cityName, gameState) {
  ensureDbEnabled();
  const serializedGameState =
    gameState === null || typeof gameState === 'undefined'
      ? null
      : typeof gameState === 'string'
        ? gameState
        : JSON.stringify(gameState);
  await dbPool.query(
    `INSERT INTO game_rooms (municipality_id, room_code, city_name, game_state, player_count, is_active)
     VALUES (?, ?, ?, ?, 0, 1)
     ON DUPLICATE KEY UPDATE
       city_name = CASE
         WHEN game_rooms.room_code LIKE 'PUB%' THEN game_rooms.city_name
         ELSE VALUES(city_name)
       END,
       game_state = COALESCE(VALUES(game_state), game_rooms.game_state),
       is_active = 1,
       updated_at = CURRENT_TIMESTAMP`,
    [municipalityId, roomCode, cityName, serializedGameState]
  );
  return getRoom(municipalityId, roomCode);
}

async function updateRoomState(municipalityId, roomCode, gameState) {
  ensureDbEnabled();
  const serializedGameState =
    gameState === null || typeof gameState === 'undefined'
      ? null
      : typeof gameState === 'string'
        ? gameState
        : JSON.stringify(gameState);
  await dbPool.query(
    `UPDATE game_rooms
     SET game_state = ?, updated_at = CURRENT_TIMESTAMP
     WHERE municipality_id = ? AND room_code = ?`,
    [serializedGameState, municipalityId, roomCode]
  );
  return getRoom(municipalityId, roomCode);
}

async function updateRoomPlayerCount(municipalityId, roomCode, playerCount) {
  ensureDbEnabled();
  await dbPool.query(
    `UPDATE game_rooms
     SET player_count = ?, updated_at = CURRENT_TIMESTAMP
     WHERE municipality_id = ? AND room_code = ?`,
    [playerCount, municipalityId, roomCode]
  );
}

// ─── Runtime cache ────────────────────────────────────────────────────────

function roomRuntimeCacheKey(municipalityId, roomCode) {
  return `${Number(municipalityId)}:${normalizeRoomCode(roomCode) || 'MAIN'}`;
}

function getRoomRuntimeEntry(municipalityId, roomCode, create = false) {
  const key = roomRuntimeCacheKey(municipalityId, roomCode);
  let entry = roomRuntimeCache.get(key);
  if (!entry && create) {
    entry = {
      key,
      municipalityId: Number(municipalityId),
      municipalitySlug: null,
      municipalityName: null,
      roomCode: normalizeRoomCode(roomCode) || 'MAIN',
      statsLoaded: false,
      statsData: null,
      statsDirty: false,
      activePlayers: 0,
      idleSince: Date.now(),
      lastAccessAt: Date.now(),
      lastFlushedAt: 0,
      lastFlushAttemptAt: 0,
      loadedAt: Date.now(),
    };
    roomRuntimeCache.set(key, entry);
  }
  return entry || null;
}

async function saveRoomStatsToDb(municipalityId, roomCode, statsData) {
  ensureDbEnabled();
  const safeRoomCode = normalizeRoomCode(roomCode) || 'MAIN';
  await dbPool.query(
    `INSERT INTO game_stats (municipality_id, room_code, stats_data)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       stats_data = VALUES(stats_data),
       updated_at = CURRENT_TIMESTAMP`,
    [municipalityId, safeRoomCode, JSON.stringify(statsData || {})]
  );
}

async function loadRoomStatsFromDb(municipalityId, roomCode) {
  ensureDbEnabled();
  const safeRoomCode = normalizeRoomCode(roomCode) || 'MAIN';
  const [rows] = await dbPool.query(
    `SELECT stats_data, updated_at
     FROM game_stats
     WHERE municipality_id = ? AND room_code = ?
     LIMIT 1`,
    [municipalityId, safeRoomCode]
  );
  if (!rows[0]) return null;
  const stats = toJsonValue(rows[0].stats_data);
  if (stats && rows[0].updated_at) {
    stats._db_updated_at = new Date(rows[0].updated_at).getTime();
  }
  return stats;
}

async function flushRoomRuntimeEntry(entry, reason = 'manual') {
  if (!entry || !entry.statsDirty) return false;
  entry.lastFlushAttemptAt = Date.now();
  await saveRoomStatsToDb(entry.municipalityId, entry.roomCode, entry.statsData || {});
  entry.statsDirty = false;
  entry.lastFlushedAt = Date.now();
  return true;
}

async function saveRoomStats(municipalityId, roomCode, statsData) {
  const entry = getRoomRuntimeEntry(municipalityId, roomCode, true);
  entry.lastAccessAt = Date.now();
  entry.statsLoaded = true;
  entry.statsData = cloneJsonValue(statsData || {});
  entry.statsDirty = true;
}

async function loadRoomStats(municipalityId, roomCode) {
  ensureDbEnabled();
  const entry = getRoomRuntimeEntry(municipalityId, roomCode, true);
  entry.lastAccessAt = Date.now();
  if (entry.statsLoaded) {
    return cloneJsonValue(entry.statsData);
  }
  const loaded = await loadRoomStatsFromDb(municipalityId, normalizeRoomCode(roomCode) || 'MAIN');
  entry.statsLoaded = true;
  entry.statsData = cloneJsonValue(loaded);
  return cloneJsonValue(loaded);
}

async function warmRoomRuntimeCache(municipality, roomCode, reason = 'join') {
  if (!municipality || !Number.isInteger(Number(municipality.id))) return null;
  const safeRoomCode = normalizeRoomCode(roomCode) || 'MAIN';
  const entry = getRoomRuntimeEntry(municipality.id, safeRoomCode, true);
  entry.lastAccessAt = Date.now();
  entry.municipalitySlug = String(municipality.slug || '').toLowerCase() || null;
  entry.municipalityName = municipality.name || null;
  if (!entry.statsLoaded) {
    entry.statsData = cloneJsonValue(await loadRoomStatsFromDb(municipality.id, safeRoomCode));
    entry.statsLoaded = true;
  }
  return entry;
}

function setRoomRuntimePlayers(municipalityId, roomCode, activePlayers) {
  const safePlayers = Math.max(0, Number(activePlayers || 0));
  const entry = getRoomRuntimeEntry(municipalityId, roomCode, safePlayers > 0);
  if (!entry) return;
  entry.activePlayers = safePlayers;
  entry.lastAccessAt = Date.now();
  entry.idleSince = safePlayers > 0 ? null : (entry.idleSince || Date.now());
  updateRoomPlayerCount(municipalityId, roomCode, safePlayers).catch(() => {});
}

function broadcastNavigatorRoomCount(
  ioInstance,
  roomCode,
  municipalitySlug,
  municipalityName,
  playerCount,
  roomName
) {
  if (!ioInstance) return;
  const normalizedRoomCode = normalizeRoomCode(roomCode) || 'MAIN';
  if (normalizedRoomCode !== 'MAIN' && !normalizedRoomCode.startsWith('PUB')) return;
  ioInstance.emit('navigator-room-count', {
    room_code: normalizedRoomCode,
    municipality_slug: String(municipalitySlug || '').toLowerCase(),
    municipality_name: String(municipalityName || ''),
    player_count: Math.max(0, Number(playerCount || 0)),
    room_name: String(roomName || municipalityName || ''),
    ts: Date.now(),
  });
}

async function unloadRoomRuntimeEntry(entry, reason = 'idle_timeout', ioInstance = null) {
  if (!entry) return false;
  updateRoomPlayerCount(entry.municipalityId, entry.roomCode, 0).catch(() => {});
  if (ioInstance) {
    broadcastNavigatorRoomCount(
      ioInstance,
      entry.roomCode,
      entry.municipalitySlug,
      entry.municipalityName,
      0
    );
  }
  await flushRoomRuntimeEntry(entry, reason);
  roomRuntimeCache.delete(entry.key);
  return true;
}

async function flushAllRoomRuntimeEntries(reason = 'shutdown') {
  const entries = Array.from(roomRuntimeCache.values());
  if (entries.length <= 0) return;
  for (const entry of entries) {
    try {
      await flushRoomRuntimeEntry(entry, reason);
    } catch (err) {
      logError('ROOMCACHE', 'Flush-Fehler für Raum', {
        reason,
        municipalityId: entry.municipalityId,
        municipalitySlug: entry.municipalitySlug,
        roomCode: entry.roomCode,
        error: err?.message || String(err),
      });
    }
  }
}

// ─── Stats API shape & time ───────────────────────────────────────────────

function defaultStatsApiShape() {
  return {
    finances: {
      money: 0,
      income: 0,
      expenses: 0,
      tax_rate: 10,
      total_tax_collected: 0,
      total_spent: 0,
    },
    population: {
      current: 0,
      max: 0,
      growth: 0,
      homeless: 0,
    },
    employment: {
      jobs: 0,
      employed: 0,
      unemployed: 0,
      rate: 0,
    },
    happiness: {
      overall: 50,
      residential: 50,
      commercial: 50,
      industrial: 50,
    },
    infrastructure: {
      power: { production: 0, consumption: 0, balance: 0 },
      water: { production: 0, consumption: 0, balance: 0 },
    },
    buildings: {
      total: 0,
      residential: 0,
      commercial: 0,
      industrial: 0,
      infrastructure: 0,
      decoration: 0,
    },
    zones: {
      residential: 0,
      commercial: 0,
      industrial: 0,
    },
    time: {
      tick: 0,
      speed: 1,
      play_time: 0,
    },
    game_map_data: null,
  };
}

const { getWeatherSync } = require('./weather');

function buildServerTimePayload() {
  const config = {
    seconds_per_day: 86400,
    ticks_per_day: 24,
    days_per_month: 30,
    months_per_year: 12,
  };
  const nowMs = Date.now();
  const baseEpoch = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - baseEpoch) / 1000));
  const totalTicks = Math.floor((elapsedSeconds / config.seconds_per_day) * config.ticks_per_day);
  const ticksPerDay = config.ticks_per_day;
  const totalDays = Math.floor(totalTicks / ticksPerDay);
  const hour = ((totalTicks % ticksPerDay) + ticksPerDay) % ticksPerDay;
  const dayInYear = totalDays % (config.days_per_month * config.months_per_year);
  const day = (dayInYear % config.days_per_month) + 1;
  const month = Math.floor(dayInYear / config.days_per_month) + 1;
  const year =
    2026 + Math.floor(totalDays / (config.days_per_month * config.months_per_year));
  const msPerTick = (config.seconds_per_day * 1000) / config.ticks_per_day;
  const nextTickInMs = Math.max(1, msPerTick - ((nowMs - baseEpoch) % msPerTick));
  return {
    tick: totalTicks,
    hour,
    day,
    month,
    year,
    total_days: totalDays,
    total_ticks: totalTicks,
    next_tick_in_ms: Math.round(nextTickInMs),
    server_timestamp: nowMs,
    weather: getWeatherSync(),
    config,
  };
}

function toStatsApiShape(raw) {
  const base = defaultStatsApiShape();
  const map = raw || {};
  base.finances.money = Number(map.money ?? base.finances.money);
  base.finances.income = Number(map.income ?? base.finances.income);
  base.finances.expenses = Number(map.expenses ?? base.finances.expenses);
  base.finances.tax_income = Number(map.tax_income ?? 0);
  base.finances.building_income = Number(map.building_income ?? 0);
  base.finances.tax_rate = Number(map.tax_rate ?? base.finances.tax_rate);
  base.finances.total_tax_collected = Number(
    map.total_tax_collected ?? base.finances.total_tax_collected
  );
  base.finances.total_spent = Number(map.total_spent ?? base.finances.total_spent);
  base.population.current = Number(map.population ?? base.population.current);
  base.population.max = Number(map.max_population ?? base.population.max);
  base.population.growth = Number(map.population_growth ?? base.population.growth);
  base.population.homeless = Number(map.homeless ?? base.population.homeless);
  base.employment.jobs = Number(map.jobs ?? base.employment.jobs);
  base.employment.employed = Number(map.employed ?? base.employment.employed);
  base.employment.unemployed = Number(map.unemployed ?? base.employment.unemployed);
  base.employment.rate = Number(map.unemployment_rate ?? base.employment.rate);
  base.happiness.overall = Number(map.happiness ?? base.happiness.overall);
  base.happiness.residential = Number(map.happiness_residential ?? base.happiness.residential);
  base.happiness.commercial = Number(map.happiness_commercial ?? base.happiness.commercial);
  base.happiness.industrial = Number(map.happiness_industrial ?? base.happiness.industrial);
  base.infrastructure.power.production = Number(
    map.power_production ?? base.infrastructure.power.production
  );
  base.infrastructure.power.consumption = Number(
    map.power_consumption ?? base.infrastructure.power.consumption
  );
  base.infrastructure.power.balance =
    base.infrastructure.power.production - base.infrastructure.power.consumption;
  base.infrastructure.water.production = Number(
    map.water_production ?? base.infrastructure.water.production
  );
  base.infrastructure.water.consumption = Number(
    map.water_consumption ?? base.infrastructure.water.consumption
  );
  base.infrastructure.water.balance =
    base.infrastructure.water.production - base.infrastructure.water.consumption;
  base.infrastructure.water.net_deficit = Number(map.water_net_deficit ?? 0);
  base.infrastructure.water.storage_level = Number(map.water_storage_level ?? 0);
  base.infrastructure.water.storage_capacity = Number(map.water_storage_capacity ?? 0);
  base.buildings.total = Number(map.buildings_total ?? base.buildings.total);
  base.buildings.residential = Number(map.buildings_residential ?? base.buildings.residential);
  base.buildings.commercial = Number(map.buildings_commercial ?? base.buildings.commercial);
  base.buildings.industrial = Number(map.buildings_industrial ?? base.buildings.industrial);
  base.buildings.infrastructure = Number(
    map.buildings_infrastructure ?? base.buildings.infrastructure
  );
  base.buildings.decoration = Number(map.buildings_decoration ?? base.buildings.decoration);
  base.zones.residential = Number(map.zones_residential ?? base.zones.residential);
  base.zones.commercial = Number(map.zones_commercial ?? base.zones.commercial);
  base.zones.industrial = Number(map.zones_industrial ?? base.zones.industrial);
  base.time.tick = Number(map.tick ?? base.time.tick);
  base.time.speed = Number(map.game_speed ?? base.time.speed);
  base.time.play_time = Number(map.play_time_seconds ?? base.time.play_time);
  base.game_map_data = map.game_map_data ?? null;
  return base;
}

function toItemsStatsShape(rawStats, fallbackWaterBodies = []) {
  const raw = rawStats && typeof rawStats === 'object' ? rawStats : {};
  const gameMapData =
    raw.game_map_data && typeof raw.game_map_data === 'object' ? raw.game_map_data : null;
  const mapStats =
    gameMapData && typeof gameMapData.stats === 'object' ? gameMapData.stats : null;
  const mapDemand =
    mapStats && typeof mapStats.demand === 'object' ? mapStats.demand : null;
  const mapSettings =
    gameMapData && typeof gameMapData.settings === 'object' ? gameMapData.settings : null;
  const mapBudget =
    gameMapData && typeof gameMapData.budget === 'object' ? gameMapData.budget : null;
  const mapWaterBodies = Array.isArray(gameMapData?.waterBodies)
    ? gameMapData.waterBodies
    : Array.isArray(fallbackWaterBodies)
      ? fallbackWaterBodies
      : [];

  return {
    money: Math.round(toFiniteNumber(raw.money, 0)),
    population: Math.max(0, Math.round(toFiniteNumber(raw.population, 0))),
    income: Math.round(toFiniteNumber(raw.income, 0)),
    expenses: Math.round(toFiniteNumber(raw.expenses, 0)),
    jobs: Math.max(0, Math.round(toFiniteNumber(raw.jobs, 0))),
    happiness: Math.max(
      0,
      Math.min(100, Math.round(toFiniteNumber(raw.happiness, 50)))
    ),
    health: Math.max(
      0,
      Math.min(100, Math.round(toFiniteNumber(mapStats?.health, 50)))
    ),
    education: Math.max(
      0,
      Math.min(100, Math.round(toFiniteNumber(mapStats?.education, 50)))
    ),
    safety: Math.max(
      0,
      Math.min(100, Math.round(toFiniteNumber(mapStats?.safety, 50)))
    ),
    environment: Math.max(
      0,
      Math.min(100, Math.round(toFiniteNumber(mapStats?.environment, 75)))
    ),
    demand: {
      residential: Math.round(toFiniteNumber(mapDemand?.residential, 50)),
      commercial: Math.round(toFiniteNumber(mapDemand?.commercial, 30)),
      industrial: Math.round(toFiniteNumber(mapDemand?.industrial, 40)),
    },
    tax_rate: Math.round(toFiniteNumber(raw.tax_rate ?? mapSettings?.taxRate, 10)),
    effective_tax_rate: Math.round(
      toFiniteNumber(mapSettings?.effectiveTaxRate ?? raw.tax_rate, 10)
    ),
    game_speed: Math.max(
      0,
      Math.min(3, Math.round(toFiniteNumber(raw.game_speed ?? mapSettings?.speed, 1)))
    ),
    budget: mapBudget || null,
    settings: mapSettings
      ? {
          taxRate: toFiniteNumber(mapSettings.taxRate, 10),
          effectiveTaxRate: toFiniteNumber(
            mapSettings.effectiveTaxRate,
            toFiniteNumber(mapSettings.taxRate, 10)
          ),
          speed: Math.max(
            0,
            Math.min(3, Math.round(toFiniteNumber(mapSettings.speed, 1)))
          ),
          disastersEnabled:
            typeof mapSettings.disastersEnabled === 'boolean'
              ? mapSettings.disastersEnabled
              : true,
          selectedTool: String(mapSettings.selectedTool || 'select'),
        }
      : undefined,
    water_bodies: mapWaterBodies,
  };
}

function applyStatsPatch(rawStats, patch) {
  const next = { ...(rawStats || {}) };
  const setNum = (key, value) => {
    if (typeof value === 'undefined' || value === null) return;
    next[key] = toFiniteNumber(value, Number(next[key] || 0));
  };
  // money wird nicht mehr aus dem Patch übernommen – treasury in municipality_stats ist die einzige Quelle
  setNum('income', patch.income);
  setNum('expenses', patch.expenses);
  setNum('population', patch.population);
  setNum('jobs', patch.jobs);
  setNum('happiness', patch.happiness);

  if (typeof patch.taxRate !== 'undefined' && patch.taxRate !== null) {
    const taxRate = Math.max(0, Math.min(100, toFiniteNumber(patch.taxRate, Number(next.tax_rate || 10))));
    next.tax_rate = taxRate;
    next.taxRate = taxRate;
  }
  if (typeof patch.gameSpeed !== 'undefined' && patch.gameSpeed !== null) {
    const gameSpeed = Math.max(0.5, Math.min(3, toFiniteNumber(patch.gameSpeed, Number(next.game_speed || 1))));
    next.game_speed = gameSpeed;
    next.gameSpeed = gameSpeed;
  }

  if (patch.budget && typeof patch.budget === 'object') {
    const VALID_BUDGET_KEYS = [
      'police',
      'fire',
      'health',
      'education',
      'transportation',
      'parks',
      'power',
      'water',
    ];
    const mapData =
      next.game_map_data && typeof next.game_map_data === 'object'
        ? { ...next.game_map_data }
        : {};
    const existingBudget =
      mapData.budget && typeof mapData.budget === 'object'
        ? { ...mapData.budget }
        : {};
    for (const key of VALID_BUDGET_KEYS) {
      const entry = patch.budget[key];
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.funding === 'number'
      ) {
        const existing =
          existingBudget[key] && typeof existingBudget[key] === 'object'
            ? { ...existingBudget[key] }
            : {
                name: key.charAt(0).toUpperCase() + key.slice(1),
                funding: 100,
                cost: 0,
              };
        existing.funding = Math.max(
          0,
          Math.min(100, Math.round(entry.funding))
        );
        existingBudget[key] = existing;
      }
    }
    mapData.budget = existingBudget;
    next.game_map_data = mapData;
  }

  // Sozialkasse-Einstellungen
  if (typeof patch.socialContributionRate !== 'undefined' && patch.socialContributionRate !== null) {
    next.social_contribution_rate = Math.max(0, Math.min(15, Math.round(toFiniteNumber(patch.socialContributionRate, 5))));
  }
  if (typeof patch.welfarePerUnemployed !== 'undefined' && patch.welfarePerUnemployed !== null) {
    next.welfare_per_unemployed = Math.max(0, Math.min(50, Math.round(toFiniteNumber(patch.welfarePerUnemployed, 8))));
  }

  return next;
}

function mapRowToDelta(row) {
  const delta = {
    type: row.action_type,
    x: row.x,
    y: row.y,
    tool: row.tool || undefined,
    zone: row.zone_type || undefined,
    timestamp: Number(row.client_timestamp || Date.now()),
    playerId: row.player_id || 'system',
    version: Number(row.version || 0),
    metadata: toJsonValue(row.metadata),
  };
  if (delta.type === 'zone') delete delta.tool;
  if (delta.type !== 'zone') delete delta.zone;
  return delta;
}

// ─── Municipality money (primary room) ────────────────────────────────────

async function getPrimaryRoomCode(municipalityId) {
  if (!dbPool) return 'MAIN';
  try {
    const [rows] = await dbPool.query(
      `SELECT room_code FROM game_rooms WHERE municipality_id = ? AND is_active = 1
       ORDER BY (room_code NOT LIKE 'PUB%') DESC, created_at ASC LIMIT 1`,
      [municipalityId]
    );
    return rows[0]?.room_code || 'MAIN';
  } catch (_) {
    return 'MAIN';
  }
}

async function getMunicipalityMoney(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT treasury FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
    [municipalityId]
  );
  if (!rows[0]) {
    await dbPool.query(`INSERT IGNORE INTO municipality_stats (municipality_id) VALUES (?)`, [municipalityId]);
    return 10000;
  }
  return Number(rows[0].treasury);
}

async function getMunicipalityFinance(municipalityId) {
  ensureDbEnabled();
  let [rows] = await dbPool.query(
    `SELECT treasury, debt, credit_limit, interest_rate, last_interest_at
     FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
    [municipalityId]
  );
  if (!rows[0]) {
    await dbPool.query(`INSERT IGNORE INTO municipality_stats (municipality_id) VALUES (?)`, [municipalityId]);
    [rows] = await dbPool.query(
      `SELECT treasury, debt, credit_limit, interest_rate, last_interest_at
       FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
      [municipalityId]
    );
  }
  const r = rows[0] || {};
  return {
    treasury: Number(r.treasury ?? 10000),
    debt: Number(r.debt ?? 0),
    credit_limit: Number(r.credit_limit ?? 50000),
    interest_rate: Number(r.interest_rate ?? 0.0005),
    last_interest_at: r.last_interest_at || null,
  };
}

async function setMunicipalityTreasury(municipalityId, newTreasury) {
  ensureDbEnabled();
  const safe = Math.round(Number(newTreasury) || 0);
  await dbPool.query(
    `UPDATE municipality_stats SET treasury = ? WHERE municipality_id = ?`,
    [safe, municipalityId]
  );
  return safe;
}

async function deductMunicipalityMoney(municipalityId, amount, reason = '') {
  ensureDbEnabled();
  const safeAmount = Math.max(0, Math.round(amount));
  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT treasury FROM municipality_stats WHERE municipality_id = ? FOR UPDATE`,
      [municipalityId]
    );
    const current = Number(rows[0]?.treasury ?? 10000);
    if (current < safeAmount) {
      await conn.rollback();
      throw new Error(
        `Nicht genug Geld in der Gemeindekasse (${current}/${safeAmount})${reason ? ' - ' + reason : ''}`
      );
    }
    const next = current - safeAmount;
    await conn.query(
      `UPDATE municipality_stats SET treasury = ? WHERE municipality_id = ?`,
      [next, municipalityId]
    );
    await conn.commit();
    return next;
  } catch (err) {
    try { await conn.rollback(); } catch {}
    throw err;
  } finally {
    conn.release();
  }
}

async function addMunicipalityMoney(municipalityId, amount, reason = '') {
  ensureDbEnabled();
  const safeAmount = Math.max(0, Math.round(amount));
  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT treasury FROM municipality_stats WHERE municipality_id = ? FOR UPDATE`,
      [municipalityId]
    );
    const current = Number(rows[0]?.treasury ?? 10000);
    const next = current + safeAmount;
    await conn.query(
      `UPDATE municipality_stats SET treasury = ? WHERE municipality_id = ?`,
      [next, municipalityId]
    );
    await conn.commit();
    return next;
  } catch (err) {
    try { await conn.rollback(); } catch {}
    throw err;
  } finally {
    conn.release();
  }
}

// ─── Municipality Stats (sicherheitsrelevante Werte in DB-Spalten) ────────

async function loadMunicipalityStats(municipalityId) {
  ensureDbEnabled();
  let [rows] = await dbPool.query(
    `SELECT treasury, debt, credit_limit, interest_rate, last_interest_at,
            daily_income, daily_expenses, last_finance_day, tax_rate,
            population, max_population, jobs,
            total_tax_collected, total_spent,
            security, attractiveness, cleanliness, infrastructure, transparency,
            citizen_satisfaction, shield_active_until
     FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
    [municipalityId]
  );
  if (!rows[0]) {
    await dbPool.query(`INSERT IGNORE INTO municipality_stats (municipality_id) VALUES (?)`, [municipalityId]);
    [rows] = await dbPool.query(
      `SELECT treasury, debt, credit_limit, interest_rate, last_interest_at,
              daily_income, daily_expenses, last_finance_day, tax_rate,
              population, max_population, jobs,
              total_tax_collected, total_spent,
              security, attractiveness, cleanliness, infrastructure, transparency,
              citizen_satisfaction, shield_active_until
       FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
      [municipalityId]
    );
  }
  const r = rows[0] || {};
  return {
    treasury:             Number(r.treasury ?? 10000),
    debt:                 Number(r.debt ?? 0),
    credit_limit:         Number(r.credit_limit ?? 50000),
    interest_rate:        Number(r.interest_rate ?? 0.0005),
    last_interest_at:     r.last_interest_at || null,
    daily_income:         Number(r.daily_income ?? 0),
    daily_expenses:       Number(r.daily_expenses ?? 0),
    last_finance_day:     r.last_finance_day || null,
    tax_rate:             Number(r.tax_rate ?? 10),
    population:           Number(r.population ?? 0),
    max_population:       Number(r.max_population ?? 100),
    jobs:                 Number(r.jobs ?? 0),
    total_tax_collected:  Number(r.total_tax_collected ?? 0),
    total_spent:          Number(r.total_spent ?? 0),
    security:             Number(r.security ?? 50),
    attractiveness:       Number(r.attractiveness ?? 50),
    cleanliness:          Number(r.cleanliness ?? 50),
    infrastructure:       Number(r.infrastructure ?? 50),
    transparency:         Number(r.transparency ?? 50),
    citizen_satisfaction: Number(r.citizen_satisfaction ?? 50),
    shield_active_until:  r.shield_active_until || null,
  };
}

async function saveMunicipalityStats(municipalityId, stats) {
  ensureDbEnabled();
  const WRITABLE = [
    'treasury', 'debt', 'credit_limit', 'interest_rate',
    'daily_income', 'daily_expenses', 'last_finance_day', 'tax_rate',
    'population', 'max_population', 'jobs',
    'total_tax_collected', 'total_spent',
    'social_fund', 'social_contribution_rate', 'welfare_per_unemployed',
  ];
  const sets = [];
  const values = [];
  for (const col of WRITABLE) {
    if (typeof stats[col] === 'undefined') continue;
    sets.push(`${col} = ?`);
    if (col === 'interest_rate' || col === 'social_fund') {
      values.push(Number(stats[col]));
    } else if (col === 'last_finance_day') {
      values.push(stats[col] || null);
    } else {
      values.push(Math.round(Number(stats[col] || 0)));
    }
  }
  if (sets.length === 0) return;
  values.push(municipalityId);
  await dbPool.query(
    `UPDATE municipality_stats SET ${sets.join(', ')} WHERE municipality_id = ?`,
    values
  );
}

// ─── Game items ───────────────────────────────────────────────────────────

async function getRoomItemRows(municipalityId, roomCode) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT id, action_type, tool, zone_type, x, y, player_id, user_id, version, client_timestamp, applied_at, created_at, metadata
     FROM game_items
     WHERE municipality_id = ? AND room_code = ?
     ORDER BY version ASC, id ASC`,
    [municipalityId, roomCode]
  );
  return Array.isArray(rows) ? rows : [];
}

async function getRoomItemRowsForChunk(municipalityId, roomCode, cx, cy, chunkSize) {
  ensureDbEnabled();
  const xMin = cx * chunkSize;
  const xMax = (cx + 1) * chunkSize - 1;
  const yMin = cy * chunkSize;
  const yMax = (cy + 1) * chunkSize - 1;
  const [rows] = await dbPool.query(
    `SELECT id, action_type, tool, zone_type, x, y, player_id, user_id, version, client_timestamp, applied_at, created_at, metadata
     FROM game_items
     WHERE municipality_id = ? AND room_code = ?
       AND x BETWEEN ? AND ?
       AND y BETWEEN ? AND ?
     ORDER BY version ASC, id ASC`,
    [municipalityId, roomCode, xMin, xMax, yMin, yMax]
  );
  return Array.isArray(rows) ? rows : [];
}

async function getRoomItemVersion(municipalityId, roomCode) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT COALESCE(MAX(version), 0) AS max_version
     FROM game_items
     WHERE municipality_id = ? AND room_code = ?`,
    [municipalityId, roomCode]
  );
  return Number(rows[0]?.max_version || 0);
}

async function deleteRoomItems(municipalityId, roomCode) {
  ensureDbEnabled();
  const [result] = await dbPool.query(
    `DELETE FROM game_items
     WHERE municipality_id = ? AND room_code = ?`,
    [municipalityId, roomCode]
  );
  return result.affectedRows || 0;
}

async function importRoomItems(municipalityId, roomCode, clientId, userId, items) {
  ensureDbEnabled();
  const deletedOld = await deleteRoomItems(municipalityId, roomCode);
  let version = 0;
  const now = new Date();
  const timestamp = Date.now();
  for (const item of items) {
    version += 1;
    await dbPool.query(
      `INSERT INTO game_items
       (municipality_id, room_code, player_id, user_id, action_type, tool, zone_type, x, y, version, client_timestamp, applied_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        municipalityId,
        roomCode,
        clientId || 'system',
        userId || null,
        item.action_type,
        item.tool || null,
        item.zone_type || null,
        Number(item.x),
        Number(item.y),
        version,
        timestamp,
        now,
        item.metadata ? JSON.stringify(item.metadata) : null,
      ]
    );
  }
  return { deletedOld, totalImported: version, newVersion: version };
}

async function syncRoomItems(municipalityId, roomCode, clientId, userId, items) {
  ensureDbEnabled();
  const existingRows = await getRoomItemRows(municipalityId, roomCode);
  const existingMap = new Map();
  for (const row of existingRows) {
    const key = `${row.x},${row.y},${row.action_type}`;
    existingMap.set(key, row);
  }

  const incomingKeys = new Set();
  let version = await getRoomItemVersion(municipalityId, roomCode);
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  let unchanged = 0;
  const now = new Date();
  const timestamp = Date.now();

  for (const item of items) {
    const key = `${Number(item.x)},${Number(item.y)},${item.action_type}`;
    incomingKeys.add(key);
    const existing = existingMap.get(key);
    const newMeta = item.metadata ?? null;
    if (existing) {
      const existingMeta = toJsonValue(existing.metadata);
      const changed =
        existing.tool !== (item.tool || null) ||
        existing.zone_type !== (item.zone_type || null) ||
        !jsonEquals(existingMeta, newMeta);
      if (changed) {
        version += 1;
        await dbPool.query(
          `UPDATE game_items
           SET player_id = ?, user_id = ?, tool = ?, zone_type = ?, version = ?, client_timestamp = ?, applied_at = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            clientId || existing.player_id || 'system',
            userId || existing.user_id || null,
            item.tool || null,
            item.zone_type || null,
            version,
            timestamp,
            now,
            newMeta ? JSON.stringify(newMeta) : null,
            existing.id,
          ]
        );
        updated += 1;
      } else {
        unchanged += 1;
      }
    } else {
      version += 1;
      await dbPool.query(
        `INSERT INTO game_items
         (municipality_id, room_code, player_id, user_id, action_type, tool, zone_type, x, y, version, client_timestamp, applied_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          municipalityId,
          roomCode,
          clientId || 'system',
          userId || null,
          item.action_type,
          item.tool || null,
          item.zone_type || null,
          Number(item.x),
          Number(item.y),
          version,
          timestamp,
          now,
          newMeta ? JSON.stringify(newMeta) : null,
        ]
      );
      inserted += 1;
    }
  }

  for (const row of existingRows) {
    const key = `${row.x},${row.y},${row.action_type}`;
    if (!incomingKeys.has(key)) {
      await dbPool.query('DELETE FROM game_items WHERE id = ?', [row.id]);
      deleted += 1;
    }
  }

  const newVersion =
    inserted > 0 || updated > 0 || deleted > 0
      ? version
      : await getRoomItemVersion(municipalityId, roomCode);

  return { inserted, updated, deleted, unchanged, newVersion };
}

// ─── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  roomRuntimeCache,
  getRoom,
  createOrGetRoom,
  updateRoomState,
  updateRoomPlayerCount,
  roomRuntimeCacheKey,
  getRoomRuntimeEntry,
  saveRoomStatsToDb,
  loadRoomStatsFromDb,
  flushRoomRuntimeEntry,
  saveRoomStats,
  loadRoomStats,
  warmRoomRuntimeCache,
  setRoomRuntimePlayers,
  broadcastNavigatorRoomCount,
  unloadRoomRuntimeEntry,
  defaultStatsApiShape,
  buildServerTimePayload,
  toStatsApiShape,
  toItemsStatsShape,
  applyStatsPatch,
  mapRowToDelta,
  getPrimaryRoomCode,
  getMunicipalityMoney,
  getMunicipalityFinance,
  setMunicipalityTreasury,
  deductMunicipalityMoney,
  addMunicipalityMoney,
  loadMunicipalityStats,
  saveMunicipalityStats,
  getRoomItemRows,
  getRoomItemRowsForChunk,
  getRoomItemVersion,
  deleteRoomItems,
  importRoomItems,
  syncRoomItems,
  flushAllRoomRuntimeEntries,
};
