const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const getBank = () => require('./game/bank');

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const cfg = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    cfg[key] = value;
  }
  return cfg;
}

const CONFIG_PATH = path.join(__dirname, 'config.cfg');
const config = loadConfig(CONFIG_PATH);

const HOST = config.HOST || '127.0.0.1';
const PORT = Number(config.PORT || 4100);
const JWT_SECRET = config.JWT_SECRET || 'change-me';
const TOKEN_TTL_HOURS = Number(config.TOKEN_TTL_HOURS || 24);
const TOKEN_TTL_HOURS_REMEMBER = Number(config.TOKEN_TTL_HOURS_REMEMBER || 24 * 30); // 30 Tage
const DB_HOST = config.DB_HOST || '127.0.0.1';
const DB_PORT = Number(config.DB_PORT || 3306);
const DB_NAME = config.DB_NAME || '';
const DB_USER = config.DB_USER || '';
const DB_PASSWORD = config.DB_PASSWORD || '';
const DB_CONNECTION_LIMIT = Number(config.DB_CONNECTION_LIMIT || 10);
const BULLDOZE_COST_PER_CLICK = 10;
const MUNICIPALITY_MEMBER_LIMIT = 25;
const MUNICIPALITY_ROLE_OWNER = 'owner';
const MUNICIPALITY_ROLE_COUNCIL = 'council';
const MUNICIPALITY_ROLE_CITIZEN = 'citizen';
const MUNICIPALITY_ROLE_OBSERVER = 'observer';
const MUNICIPALITY_ROLE_HIERARCHY = [MUNICIPALITY_ROLE_OWNER, MUNICIPALITY_ROLE_COUNCIL, MUNICIPALITY_ROLE_CITIZEN, MUNICIPALITY_ROLE_OBSERVER];
function municipalityRoleRank(role) { const idx = MUNICIPALITY_ROLE_HIERARCHY.indexOf(role); return idx >= 0 ? idx : 999; }
function canBuildInMunicipality(role) { return role === MUNICIPALITY_ROLE_OWNER || role === MUNICIPALITY_ROLE_COUNCIL || role === MUNICIPALITY_ROLE_CITIZEN; }
function canManageMunicipality(role) { return role === MUNICIPALITY_ROLE_OWNER || role === MUNICIPALITY_ROLE_COUNCIL; }
function canInviteToMunicipality(role) { return role === MUNICIPALITY_ROLE_OWNER || role === MUNICIPALITY_ROLE_COUNCIL; }
function canManageBauzones(role) { return role === MUNICIPALITY_ROLE_OWNER || role === MUNICIPALITY_ROLE_COUNCIL; }
function shouldEnforceBauzone(role, mode) {
  if (!mode || mode === 'disabled') return false;
  if (mode === 'members') return role === MUNICIPALITY_ROLE_CITIZEN;
  if (mode === 'all') return role !== MUNICIPALITY_ROLE_OWNER;
  return false;
}
const GLOBAL_ROLE_USER = 'user';
const GLOBAL_ROLE_MODERATOR = 'moderator';
const GLOBAL_ROLE_ADMINISTRATOR = 'administrator';
const DISCORD_BOT_WEBHOOK_URL = config.DISCORD_BOT_WEBHOOK_URL || '';
const CORS_ALLOWED_ORIGINS = String(config.CORS_ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((v) => String(v || '').trim())
  .filter(Boolean);
const CORS_ALLOWED_ORIGIN_SET = new Set(CORS_ALLOWED_ORIGINS);
const CORS_ALLOW_ALL = CORS_ALLOWED_ORIGIN_SET.has('*');

const dbPool = DB_NAME && DB_USER
  ? mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user: DB_USER,
      password: DB_PASSWORD,
      connectionLimit: DB_CONNECTION_LIMIT,
      waitForConnections: true,
      queueLimit: 0,
    })
  : null;

const CLIENT_TOOL_INFO_PATH = path.resolve(__dirname, '..', 'mapGame', 'src', 'games', 'isocity', 'types', 'game.ts');
const CLIENT_ITEM_DETAILS_PATH = path.resolve(__dirname, '..', 'mapGame', 'src', 'lib', 'itemDetails.ts');
const CLIENT_BUILDING_STATS_PATH = path.resolve(__dirname, '..', 'mapGame', 'src', 'games', 'isocity', 'types', 'buildings.ts');
const HARD_CODED_BUILDING_STATS = new Map(); // Map<tool, { maxPop, maxJobs, pollution, landValue }>
let hardcodedCatalogCache = null;
const SERVICE_UPGRADE_TOOLS = new Set([
  'police_station',
  'fire_station',
  'hospital',
  'school',
  'university',
  'power_plant',
  'water_tower',
  'woodcutter_house',
]);
const COAT_OF_ARMS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'coat-of-arms');
const MINIMAP_UPLOAD_DIR = path.join(__dirname, 'uploads', 'minimaps');
const MAX_COAT_OF_ARMS_PNG_BYTES = 512 * 1024; // 512KB
const MAX_MINIMAP_PNG_BYTES = 256 * 1024; // 256KB
const ROOM_CACHE_UNLOAD_IDLE_MS = Number(config.ROOM_CACHE_UNLOAD_IDLE_MS || 180000); // 3 Minuten
const ROOM_CACHE_FLUSH_INTERVAL_MS = Number(config.ROOM_CACHE_FLUSH_INTERVAL_MS || 10000); // 10 Sekunden
const roomRuntimeCache = new Map(); // Map<`${municipalityId}:${roomCode}`, { ...runtime }>
const DEFAULT_ACHIEVEMENTS = [
  {
    code: 'first_steps',
    title: 'Erste Schritte',
    description: 'Baue mindestens 10 Gebaeude in deiner Gemeinde.',
    goal_type: 'building_count',
    goal_value: 10,
    reward_xp: 50,
    reward_money: 1000,
    sort_order: 10,
  },
  {
    code: 'city_hall_built',
    title: 'Rathaus steht',
    description: 'Errichte ein City Hall Gebaeude.',
    goal_type: 'city_hall_count',
    goal_value: 1,
    reward_xp: 80,
    reward_money: 2500,
    sort_order: 20,
  },
  {
    code: 'population_100',
    title: 'Dorfleben',
    description: 'Erreiche 100 Einwohner.',
    goal_type: 'population',
    goal_value: 100,
    reward_xp: 100,
    reward_money: 3000,
    sort_order: 30,
  },
  {
    code: 'population_500',
    title: 'Kleinstadt',
    description: 'Erreiche 500 Einwohner.',
    goal_type: 'population',
    goal_value: 500,
    reward_xp: 220,
    reward_money: 7000,
    sort_order: 40,
  },
  {
    code: 'jobs_200',
    title: 'Wirtschaft laeuft',
    description: 'Erreiche 200 Arbeitsplaetze.',
    goal_type: 'jobs',
    goal_value: 200,
    reward_xp: 120,
    reward_money: 3500,
    sort_order: 50,
  },
  {
    code: 'money_100k',
    title: 'Gefuellte Kasse',
    description: 'Halte mindestens 100000 Geld in der Stadtkasse.',
    goal_type: 'money',
    goal_value: 100000,
    reward_xp: 180,
    reward_money: 5000,
    sort_order: 60,
  },
  {
    code: 'money_250k',
    title: 'Finanzmeister',
    description: 'Halte mindestens 250000 Geld in der Stadtkasse.',
    goal_type: 'money',
    goal_value: 250000,
    reward_xp: 300,
    reward_money: 12000,
    sort_order: 70,
  },
  {
    code: 'trade_connected',
    title: 'Vernetzte Region',
    description: 'Verbinde mindestens eine Handelsroute.',
    goal_type: 'connected_partnerships',
    goal_value: 1,
    reward_xp: 160,
    reward_money: 4500,
    sort_order: 80,
  },
];

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input) {
  let str = input.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4 !== 0) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function signToken(payloadObj, ttlHours = TOKEN_TTL_HOURS) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ...payloadObj,
    iat: now,
    exp: now + ttlHours * 3600,
  };
  const headerPart = base64UrlEncode(JSON.stringify(header));
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const data = `${headerPart}.${payloadPart}`;
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${data}.${signature}`;
}

function verifyToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  const data = `${headerPart}.${payloadPart}`;
  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  if (expected !== signaturePart) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(payloadPart));
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createPasswordData(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  return { salt, passwordHash };
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Body zu gross'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Ungueltiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function toJsonValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function tokenExpiresAtDate(ttlHours = TOKEN_TTL_HOURS) {
  return new Date(Date.now() + ttlHours * 3600 * 1000);
}

function ensureDbEnabled() {
  if (!dbPool) {
    throw new Error('DB-Konfiguration fehlt (DB_NAME/DB_USER).');
  }
}

function nowStamp() {
  return new Date().toISOString();
}

function logInfo(scope, message, details = null) {
  if (details && typeof details === 'object') {
    console.log(`[${nowStamp()}] [${scope}] ${message}`, details);
    return;
  }
  console.log(`[${nowStamp()}] [${scope}] ${message}`);
}

function logWarn(scope, message, details = null) {
  if (details && typeof details === 'object') {
    console.warn(`[${nowStamp()}] [${scope}] ${message}`, details);
    return;
  }
  console.warn(`[${nowStamp()}] [${scope}] ${message}`);
}

function logError(scope, message, details = null) {
  if (details && typeof details === 'object') {
    console.error(`[${nowStamp()}] [${scope}] ${message}`, details);
    return;
  }
  console.error(`[${nowStamp()}] [${scope}] ${message}`);
}

async function runStartupTask(name, task) {
  const started = Date.now();
  logInfo('BOOT', `Start: ${name}`);
  try {
    await task();
    const elapsed = Date.now() - started;
    logInfo('BOOT', `OK: ${name} (${elapsed}ms)`);
    return { name, ok: true, elapsed };
  } catch (err) {
    const elapsed = Date.now() - started;
    logError('BOOT', `FEHLER: ${name} (${elapsed}ms)`, { error: err?.message || String(err) });
    return { name, ok: false, elapsed, error: err };
  }
}

function resolveCorsOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return null;
  if (CORS_ALLOW_ALL) return origin;
  return CORS_ALLOWED_ORIGIN_SET.has(origin) ? origin : null;
}

function applyCorsHeaders(req, res) {
  res.setHeader('Vary', 'Origin');
  const allowedOrigin = resolveCorsOrigin(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    return true;
  }
  return false;
}

function parseToolInfoFromClientSource(source) {
  const items = new Map();
  const lines = String(source || '').split(/\r?\n/);
  const entryRegex = /^\s*([a-z0-9_]+)\s*:\s*\{(.+)\}\s*,?\s*$/i;
  for (const line of lines) {
    const match = line.match(entryRegex);
    if (!match) continue;
    const tool = String(match[1] || '').trim().toLowerCase();
    const body = match[2] || '';
    if (!tool) continue;

    const costMatch = body.match(/\bcost:\s*([0-9]+)/i);
    if (!costMatch) continue;
    const sizeMatch = body.match(/\bsize:\s*([0-9]+)/i);
    const nameMatch = body.match(/name:\s*msg\('((?:\\'|[^'])*)'\)/i);
    const displayName = nameMatch ? nameMatch[1].replace(/\\'/g, '\'') : toDisplayNameFromTool(tool);
    const cost = Math.max(0, Math.round(Number(costMatch[1] || 0)));
    const size = sizeMatch ? Math.max(1, Math.round(Number(sizeMatch[1] || 1))) : 1;

    items.set(tool, {
      tool,
      display_name: displayName,
      build_cost: cost,
      size,
    });
  }
  return items;
}

function parseItemFootprintsFromClientSource(source) {
  const items = new Map();
  const lines = String(source || '').split(/\r?\n/);
  const footprintRegex = /^\s*([a-z0-9_]+)\s*:\s*\{\s*footprintWidth:\s*([0-9]+)\s*,\s*footprintHeight:\s*([0-9]+)\s*\}\s*,?\s*$/i;
  for (const line of lines) {
    const match = line.match(footprintRegex);
    if (!match) continue;
    const tool = String(match[1] || '').trim().toLowerCase();
    if (!tool) continue;
    items.set(tool, {
      width: Math.max(1, Math.round(Number(match[2] || 1))),
      height: Math.max(1, Math.round(Number(match[3] || 1))),
    });
  }
  return items;
}

function parseBuildingStatsFromClientSource(source) {
  const items = new Map();
  const lines = String(source || '').split(/\r?\n/);
  const statsRegex = /^\s*([a-z0-9_]+)\s*:\s*\{\s*maxPop:\s*(-?[0-9]+)\s*,\s*maxJobs:\s*(-?[0-9]+)\s*,\s*pollution:\s*(-?[0-9]+)\s*,\s*landValue:\s*(-?[0-9]+)\s*\}\s*,?\s*$/i;
  for (const line of lines) {
    const match = line.match(statsRegex);
    if (!match) continue;
    const tool = String(match[1] || '').trim().toLowerCase();
    if (!tool) continue;
    items.set(tool, {
      maxPop: Math.max(0, Math.round(Number(match[2] || 0))),
      maxJobs: Math.max(0, Math.round(Number(match[3] || 0))),
      pollution: Math.round(Number(match[4] || 0)),
      landValue: Math.round(Number(match[5] || 0)),
    });
  }
  return items;
}

function deriveBuildTimeSecondsByFootprint(width, height, tool) {
  const area = Math.max(1, Math.round(Number(width || 1)) * Math.max(1, Math.round(Number(height || 1))));
  if (String(tool || '').toLowerCase() === 'water_tower') return 60;
  if (area >= 16) return 60;
  if (area >= 9) return 45;
  if (area >= 4) return 30;
  return 20;
}

async function loadHardcodedCatalogFromClientFiles(force = false) {
  if (hardcodedCatalogCache && !force) return hardcodedCatalogCache;
  const missing = [];
  if (!fs.existsSync(CLIENT_TOOL_INFO_PATH)) missing.push(CLIENT_TOOL_INFO_PATH);
  if (!fs.existsSync(CLIENT_ITEM_DETAILS_PATH)) missing.push(CLIENT_ITEM_DETAILS_PATH);
  if (!fs.existsSync(CLIENT_BUILDING_STATS_PATH)) missing.push(CLIENT_BUILDING_STATS_PATH);
  if (missing.length > 0) {
    const msg = `Client-Quelldateien nicht gefunden: ${missing.join(', ')}`;
    if (!hardcodedCatalogCache) {
      hardcodedCatalogCache = { tools: [], statsByTool: new Map(), missing };
    }
    return hardcodedCatalogCache;
  }

  const toolInfoRaw = fs.readFileSync(CLIENT_TOOL_INFO_PATH, 'utf8');
  const itemDetailsRaw = fs.readFileSync(CLIENT_ITEM_DETAILS_PATH, 'utf8');
  const buildingStatsRaw = fs.readFileSync(CLIENT_BUILDING_STATS_PATH, 'utf8');

  const tools = parseToolInfoFromClientSource(toolInfoRaw);
  const footprints = parseItemFootprintsFromClientSource(itemDetailsRaw);
  const statsByTool = parseBuildingStatsFromClientSource(buildingStatsRaw);

  const catalogTools = [];
  for (const [tool, raw] of tools.entries()) {
    const fp = footprints.get(tool) || { width: raw.size || 1, height: raw.size || 1 };
    const category = inferCategoryFromTool(tool, 'general');
    const buildCost = Math.max(0, Math.round(Number(raw.build_cost || 0)));
    const bStats = statsByTool.get(tool);
    const pollutionVal = bStats ? Math.round(Number(bStats.pollution || 0)) : 0;
    catalogTools.push({
      tool,
      display_name: raw.display_name || toDisplayNameFromTool(tool),
      category,
      footprint_width: Math.max(1, Math.round(Number(fp.width || 1))),
      footprint_height: Math.max(1, Math.round(Number(fp.height || 1))),
      build_cost: buildCost,
      pollution: pollutionVal,
      build_time_seconds: deriveBuildTimeSecondsByFootprint(fp.width, fp.height, tool),
      requires_power: 0,
      requires_water: 0,
      is_active: 1,
    });
  }

  hardcodedCatalogCache = { tools: catalogTools, statsByTool, missing: [] };
  return hardcodedCatalogCache;
}

async function seedGameItemDetailsFromClientHardcodedData() {
  ensureDbEnabled();
  const catalog = await loadHardcodedCatalogFromClientFiles();
  const rows = Array.isArray(catalog.tools) ? catalog.tools : [];
  if (!rows.length) return { seeded: 0, missing: catalog.missing || [] };

  let seeded = 0;
  // Pruefen ob pollution-Spalte existiert (Migration 017)
  let hasPollutionColumn = true;
  try {
    await dbPool.query(`SELECT pollution FROM game_item_details LIMIT 1`);
  } catch (_e) {
    hasPollutionColumn = false;
  }

  for (const row of rows) {
    if (hasPollutionColumn) {
      await dbPool.query(
        `INSERT INTO game_item_details
         (tool, display_name, category, footprint_width, footprint_height, build_cost, pollution, build_time_seconds, requires_power, requires_water, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          display_name = VALUES(display_name),
          category = VALUES(category),
          footprint_width = VALUES(footprint_width),
          footprint_height = VALUES(footprint_height),
          build_cost = VALUES(build_cost),
          pollution = VALUES(pollution),
          build_time_seconds = VALUES(build_time_seconds),
          requires_power = VALUES(requires_power),
          requires_water = VALUES(requires_water),
          is_active = VALUES(is_active),
          updated_at = CURRENT_TIMESTAMP`,
        [
          row.tool,
          row.display_name,
          row.category,
          row.footprint_width,
          row.footprint_height,
          row.build_cost,
          row.pollution || 0,
          row.build_time_seconds,
          row.requires_power,
          row.requires_water,
          row.is_active,
        ]
      );
    } else {
      await dbPool.query(
        `INSERT INTO game_item_details
         (tool, display_name, category, footprint_width, footprint_height, build_cost, build_time_seconds, requires_power, requires_water, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          display_name = VALUES(display_name),
          category = VALUES(category),
          footprint_width = VALUES(footprint_width),
          footprint_height = VALUES(footprint_height),
          build_cost = VALUES(build_cost),
          build_time_seconds = VALUES(build_time_seconds),
          requires_power = VALUES(requires_power),
          requires_water = VALUES(requires_water),
          is_active = VALUES(is_active),
          updated_at = CURRENT_TIMESTAMP`,
        [
          row.tool,
          row.display_name,
          row.category,
          row.footprint_width,
          row.footprint_height,
          row.build_cost,
          row.build_time_seconds,
          row.requires_power,
          row.requires_water,
          row.is_active,
        ]
      );
    }
    seeded += 1;
  }

  HARD_CODED_BUILDING_STATS.clear();
  if (catalog.statsByTool instanceof Map) {
    for (const [tool, stats] of catalog.statsByTool.entries()) {
      HARD_CODED_BUILDING_STATS.set(String(tool || '').toLowerCase(), stats);
    }
  }
  return { seeded, missing: [] };
}

async function fetchMunicipalities() {
  if (!dbPool) return [];
  const [rows] = await dbPool.query(
    `SELECT m.id, m.name, m.slug, m.canton_code, m.canton_name,
            COALESCE(mc.cnt, 0) AS members_count
     FROM municipalities m
     LEFT JOIN (
       SELECT municipality_id, COUNT(*) AS cnt
       FROM users
       WHERE is_active = 1
       GROUP BY municipality_id
     ) mc ON mc.municipality_id = m.id
     WHERE m.is_active = 1
       AND (m.is_user_created = 0 OR m.is_user_created IS NULL)
     ORDER BY m.canton_code ASC, m.name ASC`
  );
  return Array.isArray(rows) ? rows : [];
}

async function fetchCantonMunicipalities(cantonCode) {
  ensureDbEnabled();
  const code = String(cantonCode || '').toUpperCase().trim();
  const [rows] = await dbPool.query(
    `SELECT id, name, slug, canton_code, canton_name
     FROM municipalities
     WHERE is_active = 1 AND canton_code = ?
     ORDER BY name ASC`,
    [code]
  );
  return Array.isArray(rows) ? rows : [];
}

async function searchMunicipalitiesForPartnerships(query = '', limit = 500) {
  ensureDbEnabled();
  const q = String(query || '').trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(2000, Math.round(Number(limit || 500))));
  const where = ['m.is_active = 1'];
  const args = [];
  if (q) {
    where.push('(LOWER(m.name) LIKE ? OR LOWER(m.slug) LIKE ?)');
    args.push(`%${q}%`, `%${q}%`);
  }
  args.push(safeLimit);
  const [rows] = await dbPool.query(
    `SELECT
      m.id,
      m.name,
      m.slug,
      m.canton_code,
      m.canton_name,
      (
        SELECT COUNT(*)
        FROM users u_count
        WHERE u_count.municipality_id = m.id AND u_count.is_active = 1
      ) AS member_count,
      owner.id AS owner_id,
      owner.nickname AS owner_nickname
     FROM municipalities m
     LEFT JOIN users owner ON owner.id = (
       SELECT MIN(u2.id)
       FROM users u2
       WHERE u2.municipality_id = m.id AND u2.is_active = 1
     )
     WHERE ${where.join(' AND ')}
     ORDER BY m.canton_code ASC, m.name ASC
     LIMIT ?`,
    args
  );
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    bfs_number: '',
    is_capital: false,
    population: Number(row.member_count || 0),
    coordinates: { lat: 47.0, lng: 8.0 },
    level: 1,
    canton: row.canton_code || null,
    owner: row.owner_id
      ? { id: Number(row.owner_id), nickname: row.owner_nickname || `User #${Number(row.owner_id)}` }
      : null,
  }));
}

async function listPublicNavigatorMaps(query = '', limit = 60) {
  ensureDbEnabled();
  const q = String(query || '').trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(200, Math.round(Number(limit || 60))));
  const where = ['m.is_active = 1'];
  const args = [];
  if (q) {
    where.push('(LOWER(m.name) LIKE ? OR LOWER(m.slug) LIKE ? OR LOWER(COALESCE(r.city_name, "")) LIKE ? OR LOWER(COALESCE(r.room_code, "")) LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  args.push(safeLimit);

  const [rows] = await dbPool.query(
    `SELECT
      m.id,
      m.name,
      m.slug,
      m.canton_code,
      m.canton_name,
      COALESCE(r.room_code, 'MAIN') AS room_code,
      COALESCE(r.city_name, m.name) AS room_name,
      COALESCE(r.player_count, 0) AS player_count,
      r.game_state AS room_game_state,
      r.updated_at AS room_updated_at,
      owner.id AS owner_id,
      owner.nickname AS owner_nickname
     FROM municipalities m
     INNER JOIN game_rooms r
       ON r.municipality_id = m.id
      AND r.is_active = 1
      AND (r.room_code = 'MAIN' OR r.room_code LIKE 'PUB%')
     LEFT JOIN users owner ON owner.id = (
       SELECT MIN(u2.id)
       FROM users u2
       WHERE u2.municipality_id = m.id AND u2.is_active = 1
     )
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(r.player_count, 0) DESC, m.name ASC
     LIMIT ?`,
    args
  );

  const list = Array.isArray(rows) ? rows : [];
  const enriched = list.map((row) => {
    const gameState = toJsonValue(row.room_game_state);
    // Live-Spielerzahl aus dem Runtime-Cache holen (WebSocket-basiert)
    const runtimeEntry = getRoomRuntimeEntry(Number(row.id), String(row.room_code || 'MAIN'), false);
    const livePlayerCount = runtimeEntry ? Math.max(0, Number(runtimeEntry.activePlayers || 0)) : 0;
    // Nehme das Maximum aus DB und Live-Cache
    const effectivePlayerCount = Math.max(livePlayerCount, Number(row.player_count || 0));
    return {
    municipality_id: Number(row.id),
    municipality_name: String(row.name || ''),
    municipality_slug: String(row.slug || ''),
    canton_code: row.canton_code || null,
    canton_name: row.canton_name || null,
    room_code: String(row.room_code || 'MAIN'),
    room_name: String(row.room_name || row.name || 'Public Room'),
    player_count: Math.max(0, effectivePlayerCount),
    owner: row.owner_id
      ? { id: Number(row.owner_id), nickname: row.owner_nickname || `User #${Number(row.owner_id)}` }
      : null,
    region_name: typeof gameState?.region_name === 'string' ? gameState.region_name : null,
    size_label: typeof gameState?.size_label === 'string' ? gameState.size_label : null,
    generator: typeof gameState?.generator === 'string' ? gameState.generator : null,
    updated_at: row.room_updated_at || null,
    };
  });
  // Re-Sort nach Live-Spielerzahl (Räume mit Leuten oben)
  enriched.sort((a, b) => Number(b.player_count || 0) - Number(a.player_count || 0));
  return enriched;
}

const PUBLIC_ROOM_SIZE_PRESETS = {
  very_small: { size: 6, label: 'Sehr klein', tiles: 36 },
  small: { size: 8, label: 'Klein', tiles: 64 },
  medium: { size: 10, label: 'Mittel', tiles: 100 },
  large: { size: 12, label: 'Gross', tiles: 144 },
};

function normalizePublicRoomSizeKey(value) {
  const v = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PUBLIC_ROOM_SIZE_PRESETS, v) ? v : 'small';
}

function normalizePublicRoomIndex(value) {
  const n = Math.round(Number(value || 1));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(99, n));
}

function normalizePublicRoomGenerator(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'open') return 'open';
  if (v === 'small_walls') return 'small_walls';
  return 'small_walls';
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
  // Boden + Block-Waende ueber Elevation, mit kompaktem Eingang.
  if (generator === 'small_walls') {
    // 1) Bodenflaeche im Raum markieren
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

    // 4) Einfache "Plus-Block" Akzente innen fuer Habbo-aehnliche Form
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

async function getMunicipalityById(id) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT id, name, slug, canton_code, canton_name
     FROM municipalities
     WHERE id = ? AND is_active = 1
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function getMunicipalityBySlug(slug) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT id, name, slug, canton_code, canton_name
     FROM municipalities
     WHERE slug = ? AND is_active = 1
     LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

function oppositeDirection(direction) {
  const map = {
    north: 'south',
    south: 'north',
    east: 'west',
    west: 'east',
  };
  return map[String(direction || '').toLowerCase()] || null;
}

function normalizeDirection(direction) {
  const value = String(direction || '').toLowerCase();
  return ['north', 'south', 'east', 'west'].includes(value) ? value : null;
}

function normalizePartnershipStatus(status) {
  const value = String(status || '').toLowerCase();
  return ['discovered', 'connected'].includes(value) ? value : 'discovered';
}

async function getMunicipalityOwner(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT id, nickname
     FROM users
     WHERE municipality_id = ? AND is_active = 1
     ORDER BY id ASC
     LIMIT 1`,
    [municipalityId]
  );
  return rows[0] || null;
}

function normalizeMunicipalityRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === MUNICIPALITY_ROLE_OWNER) return MUNICIPALITY_ROLE_OWNER;
  if (value === MUNICIPALITY_ROLE_COUNCIL || value === 'admin') return MUNICIPALITY_ROLE_COUNCIL;
  if (value === MUNICIPALITY_ROLE_OBSERVER) return MUNICIPALITY_ROLE_OBSERVER;
  return MUNICIPALITY_ROLE_CITIZEN;
}

function normalizeGlobalRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === GLOBAL_ROLE_ADMINISTRATOR) return GLOBAL_ROLE_ADMINISTRATOR;
  if (value === GLOBAL_ROLE_MODERATOR) return GLOBAL_ROLE_MODERATOR;
  return GLOBAL_ROLE_USER;
}

function globalRoleFromUserRank(rankValue) {
  const rank = Math.max(0, Math.round(Number(rankValue || 0)));
  if (rank >= 7) return GLOBAL_ROLE_ADMINISTRATOR;
  if (rank >= 6) return GLOBAL_ROLE_MODERATOR;
  return GLOBAL_ROLE_USER;
}

async function getUserRankValue(userId) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return 0;
  try {
    const [rows] = await dbPool.query(
      `SELECT \`rank\` AS user_rank
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [safeUserId]
    );
    const rank = Number(rows?.[0]?.user_rank || 0);
    if (Number.isFinite(rank) && rank > 0) {
      return Math.max(0, Math.round(rank));
    }
  } catch (err) {
    // rank-Spalte evtl. noch nicht vorhanden; Fallback unten.
  }

  // EMU-Fallback: admin_users.rank via E-Mail-Match.
  try {
    const [rows] = await dbPool.query(
      `SELECT COALESCE(au.rank, 0) AS user_rank
       FROM users u
       LEFT JOIN admin_users au ON LOWER(au.email) = LOWER(u.email)
       WHERE u.id = ?
       LIMIT 1`,
      [safeUserId]
    );
    const rank = Number(rows?.[0]?.user_rank || 0);
    return Number.isFinite(rank) ? Math.max(0, Math.round(rank)) : 0;
  } catch {
    return 0;
  }
}

async function syncUserGlobalRoleFromRank(userId, fallbackRole = GLOBAL_ROLE_USER) {
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) {
    return { rank: 0, role: normalizeGlobalRole(fallbackRole) };
  }
  const rank = await getUserRankValue(safeUserId);
  const normalizedFallback = normalizeGlobalRole(fallbackRole);
  const role = rank > 0 ? globalRoleFromUserRank(rank) : normalizedFallback;
  await setUserGlobalRole(safeUserId, role);
  return { rank, role };
}

async function ensureAtLeastOneGlobalAdministrator() {
  ensureDbEnabled();
  const [activeRows] = await dbPool.query(
    `SELECT id
     FROM users
     WHERE is_active = 1
     ORDER BY id ASC`
  );
  for (const row of Array.isArray(activeRows) ? activeRows : []) {
    const activeUserId = Number(row.id);
    if (!Number.isInteger(activeUserId) || activeUserId <= 0) continue;
    await syncUserGlobalRoleFromRank(activeUserId, GLOBAL_ROLE_USER);
  }
}

async function getUserGlobalRole(userId) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return GLOBAL_ROLE_USER;
  const synced = await syncUserGlobalRoleFromRank(safeUserId, GLOBAL_ROLE_USER);
  return normalizeGlobalRole(synced.role);
}

async function setUserGlobalRole(userId, role) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return false;
  const normalizedRole = normalizeGlobalRole(role);
  await dbPool.query(
    `INSERT INTO user_global_roles (user_id, role)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE
       role = VALUES(role),
       updated_at = CURRENT_TIMESTAMP`,
    [safeUserId, normalizedRole]
  );
  return true;
}

async function ensureMunicipalityIsUserCreatedColumn() {
  ensureDbEnabled();
  // Spalte is_user_created hinzufuegen (fuer vom Spieler erstellte Gemeinden)
  try {
    const [cols] = await dbPool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'municipalities'
         AND COLUMN_NAME = 'is_user_created'`
    );
    if (!Array.isArray(cols) || cols.length === 0) {
      await dbPool.query(
        `ALTER TABLE municipalities
         ADD COLUMN is_user_created TINYINT(1) NOT NULL DEFAULT 0`
      );
    }
  } catch (err) {
    // Spalte existiert evtl. schon – ignorieren
    if (!String(err?.message || '').includes('Duplicate column')) throw err;
  }
}

async function ensureMunicipalityRoleTables() {
  ensureDbEnabled();
  await dbPool.query(
    `CREATE TABLE IF NOT EXISTS municipality_memberships (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      municipality_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      role ENUM('owner', 'council', 'citizen', 'observer') NOT NULL DEFAULT 'citizen',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_municipality_user (municipality_id, user_id),
      KEY idx_user_id (user_id),
      KEY idx_municipality_role (municipality_id, role),
      CONSTRAINT fk_membership_municipality FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
      CONSTRAINT fk_membership_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  // Migration: ENUM erweitern falls Tabelle schon existiert (admin -> council, observer hinzufuegen)
  try {
    await dbPool.query(
      `ALTER TABLE municipality_memberships MODIFY COLUMN role ENUM('owner', 'admin', 'council', 'citizen', 'observer') NOT NULL DEFAULT 'citizen'`
    );
    const [migrated] = await dbPool.query(
      `UPDATE municipality_memberships SET role = 'council' WHERE role = 'admin'`
    );
    if (migrated.affectedRows > 0) {
      logInfo('BOOT', `${migrated.affectedRows} Mitglieder von 'admin' auf 'council' migriert`);
    }
    // Nach Migration: alte 'admin'-Rolle entfernen
    await dbPool.query(
      `ALTER TABLE municipality_memberships MODIFY COLUMN role ENUM('owner', 'council', 'citizen', 'observer') NOT NULL DEFAULT 'citizen'`
    );
  } catch (e) {
    // Ignorieren wenn ENUM bereits korrekt ist
    if (!String(e?.message || '').includes('Duplicate')) {
      logInfo('BOOT', `Municipality-Roles Migration: ${e?.message || 'ok'}`);
    }
  }
}

async function syncMunicipalityMemberships(municipalityId) {
  ensureDbEnabled();
  await ensureMunicipalityRoleTables();
  const [activeUsers] = await dbPool.query(
    `SELECT id
     FROM users
     WHERE municipality_id = ? AND is_active = 1
     ORDER BY id ASC`,
    [municipalityId]
  );
  const activeRows = Array.isArray(activeUsers) ? activeUsers : [];
  if (activeRows.length <= 0) {
    await dbPool.query(
      `DELETE FROM municipality_memberships
       WHERE municipality_id = ?`,
      [municipalityId]
    );
    return;
  }

  const ownerUserId = Number(activeRows[0].id);
  const values = [];
  const params = [];
  for (const row of activeRows) {
    const userId = Number(row.id);
    if (!Number.isInteger(userId) || userId <= 0) continue;
    values.push('(?, ?, ?)');
    params.push(
      Number(municipalityId),
      userId,
      userId === ownerUserId ? MUNICIPALITY_ROLE_OWNER : MUNICIPALITY_ROLE_CITIZEN
    );
  }
  if (values.length > 0) {
    await dbPool.query(
      `INSERT INTO municipality_memberships (municipality_id, user_id, role)
       VALUES ${values.join(', ')}
       ON DUPLICATE KEY UPDATE
         updated_at = CURRENT_TIMESTAMP`,
      params
    );
  }

  await dbPool.query(
    `UPDATE municipality_memberships
     SET role = ?, updated_at = CURRENT_TIMESTAMP
     WHERE municipality_id = ? AND user_id = ?`,
    [MUNICIPALITY_ROLE_OWNER, municipalityId, ownerUserId]
  );
  await dbPool.query(
    `UPDATE municipality_memberships
     SET role = ?, updated_at = CURRENT_TIMESTAMP
     WHERE municipality_id = ? AND user_id <> ? AND role = ?`,
    [MUNICIPALITY_ROLE_CITIZEN, municipalityId, ownerUserId, MUNICIPALITY_ROLE_OWNER]
  );

  await dbPool.query(
    `DELETE mm
     FROM municipality_memberships mm
     LEFT JOIN users u ON u.id = mm.user_id
     WHERE mm.municipality_id = ?
       AND (u.id IS NULL OR u.is_active <> 1 OR u.municipality_id <> ?)`,
    [municipalityId, municipalityId]
  );
}

async function getMunicipalityAdministration(municipalityId) {
  ensureDbEnabled();
  await syncMunicipalityMemberships(municipalityId);
  const [rows] = await dbPool.query(
    `SELECT mm.user_id, mm.role, u.nickname
     FROM municipality_memberships mm
     INNER JOIN users u ON u.id = mm.user_id
     WHERE mm.municipality_id = ?
       AND u.is_active = 1
       AND u.municipality_id = ?
     ORDER BY
       CASE mm.role
         WHEN 'owner' THEN 0
         WHEN 'council' THEN 1
         WHEN 'citizen' THEN 2
         WHEN 'observer' THEN 3
         ELSE 4
       END,
       u.id ASC`,
    [municipalityId, municipalityId]
  );
  const list = Array.isArray(rows) ? rows : [];
  const owner = list.find((r) => normalizeMunicipalityRole(r.role) === MUNICIPALITY_ROLE_OWNER) || null;
  const administrators = list
    .filter((r) => normalizeMunicipalityRole(r.role) === MUNICIPALITY_ROLE_COUNCIL)
    .map((r) => ({ id: Number(r.user_id), nickname: r.nickname, role: MUNICIPALITY_ROLE_COUNCIL }));
  const citizens = list
    .filter((r) => normalizeMunicipalityRole(r.role) === MUNICIPALITY_ROLE_CITIZEN)
    .map((r) => ({ id: Number(r.user_id), nickname: r.nickname, role: MUNICIPALITY_ROLE_CITIZEN }));
  const observers = list
    .filter((r) => normalizeMunicipalityRole(r.role) === MUNICIPALITY_ROLE_OBSERVER)
    .map((r) => ({ id: Number(r.user_id), nickname: r.nickname, role: MUNICIPALITY_ROLE_OBSERVER }));

  return {
    owner: owner ? { id: Number(owner.user_id), nickname: owner.nickname, role: MUNICIPALITY_ROLE_OWNER } : null,
    administrators,
    citizens,
    observers,
    member_count: list.length,
    administrator_count: administrators.length,
    member_limit: MUNICIPALITY_MEMBER_LIMIT,
    slots_remaining: Math.max(0, MUNICIPALITY_MEMBER_LIMIT - list.length),
  };
}

async function getUserMunicipalityRole(userId, municipalityId) {
  ensureDbEnabled();
  if (!Number.isInteger(Number(userId)) || !Number.isInteger(Number(municipalityId))) return MUNICIPALITY_ROLE_OBSERVER;
  try {
    await syncMunicipalityMemberships(Number(municipalityId));
    const [rows] = await dbPool.query(
      `SELECT role
       FROM municipality_memberships
       WHERE municipality_id = ? AND user_id = ?
       LIMIT 1`,
      [Number(municipalityId), Number(userId)]
    );
    if (!Array.isArray(rows) || rows.length <= 0) return MUNICIPALITY_ROLE_OBSERVER;
    return normalizeMunicipalityRole(rows[0].role);
  } catch (err) {
    return MUNICIPALITY_ROLE_OBSERVER;
  }
}

async function getMunicipalityRoleMap(municipalityId) {
  ensureDbEnabled();
  try {
    await syncMunicipalityMemberships(municipalityId);
    const [rows] = await dbPool.query(
      `SELECT user_id, role
       FROM municipality_memberships
       WHERE municipality_id = ?`,
      [municipalityId]
    );
    const roleByUserId = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const userId = Number(row.user_id);
      if (!Number.isInteger(userId) || userId <= 0) continue;
      roleByUserId.set(userId, normalizeMunicipalityRole(row.role));
    }
    return roleByUserId;
  } catch (err) {
    // Fallback: Chat darf auch ohne Rollen-Map funktionieren.
    return new Map();
  }
}

function ensureCoatOfArmsUploadDir() {
  if (!fs.existsSync(COAT_OF_ARMS_UPLOAD_DIR)) {
    fs.mkdirSync(COAT_OF_ARMS_UPLOAD_DIR, { recursive: true });
  }
}

function ensureMinimapUploadDir() {
  if (!fs.existsSync(MINIMAP_UPLOAD_DIR)) {
    fs.mkdirSync(MINIMAP_UPLOAD_DIR, { recursive: true });
  }
}

async function saveMinimapPng(municipality, pngBuffer) {
  ensureMinimapUploadDir();
  if (!pngBuffer || pngBuffer.length < 8) {
    throw new Error('PNG-Daten fehlen');
  }
  if (pngBuffer.length > MAX_MINIMAP_PNG_BYTES) {
    throw new Error('Minimap-PNG ist zu gross (max 256KB)');
  }
  const slug = String(municipality.slug || municipality.id).toLowerCase();
  const fileName = `${slug}-minimap.png`;
  const filePath = path.join(MINIMAP_UPLOAD_DIR, fileName);
  fs.writeFileSync(filePath, pngBuffer);
  return { fileName, byteSize: pngBuffer.length };
}

function parsePngDataUrl(input) {
  const raw = String(input || '').trim();
  const match = raw.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[1], 'base64');
    if (!buffer || buffer.length <= 0) return null;
    return buffer;
  } catch {
    return null;
  }
}

async function ensureMunicipalityCoatOfArmsTable() {
  ensureDbEnabled();
  await dbPool.query(
    `CREATE TABLE IF NOT EXISTS municipality_coat_of_arms (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      municipality_id BIGINT UNSIGNED NOT NULL,
      image_filename VARCHAR(255) NOT NULL,
      byte_size INT UNSIGNED NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_municipality_id (municipality_id),
      CONSTRAINT fk_coa_municipality FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

function buildCoatOfArmsImageUrl(municipalitySlug, updatedAt, requestUrl) {
  const safeSlug = String(municipalitySlug || '').toLowerCase();
  if (!safeSlug) return null;
  const stamp = updatedAt ? new Date(updatedAt).getTime() : Date.now();
  const relative = `/api/game/municipality/${safeSlug}/coat-of-arms/image?v=${Number.isFinite(stamp) ? stamp : Date.now()}`;
  if (requestUrl && requestUrl.origin) return `${requestUrl.origin}${relative}`;
  return relative;
}

async function getMunicipalityCoatOfArmsRecord(municipalityId) {
  ensureDbEnabled();
  await ensureMunicipalityCoatOfArmsTable();
  const [rows] = await dbPool.query(
    `SELECT municipality_id, image_filename, byte_size, created_at, updated_at
     FROM municipality_coat_of_arms
     WHERE municipality_id = ?
     LIMIT 1`,
    [municipalityId]
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function deleteMunicipalityCoatOfArms(municipalityId) {
  ensureDbEnabled();
  await ensureMunicipalityCoatOfArmsTable();
  ensureCoatOfArmsUploadDir();
  const existing = await getMunicipalityCoatOfArmsRecord(municipalityId);
  if (existing?.image_filename) {
    const oldPath = path.join(COAT_OF_ARMS_UPLOAD_DIR, String(existing.image_filename));
    if (fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch {
        // Ignorieren: Datei evtl. schon entfernt.
      }
    }
  }
  await dbPool.query(
    `DELETE FROM municipality_coat_of_arms
     WHERE municipality_id = ?`,
    [municipalityId]
  );
}

async function saveMunicipalityCoatOfArmsPng(municipality, pngBuffer) {
  ensureDbEnabled();
  await ensureMunicipalityCoatOfArmsTable();
  ensureCoatOfArmsUploadDir();
  const municipalityId = Number(municipality?.id || 0);
  if (!Number.isInteger(municipalityId) || municipalityId <= 0) {
    throw new Error('Ungueltige municipality_id fuer Wappen');
  }
  if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length <= 0) {
    throw new Error('PNG-Daten fehlen');
  }
  if (pngBuffer.length > MAX_COAT_OF_ARMS_PNG_BYTES) {
    throw new Error('PNG-Datei ist zu gross (max 512KB)');
  }
  if (pngBuffer.length < 8 || pngBuffer.readUInt32BE(0) !== 0x89504e47 || pngBuffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('Nur gueltige PNG-Dateien sind erlaubt');
  }

  const existing = await getMunicipalityCoatOfArmsRecord(municipalityId);
  const fileName = `${String(municipality.slug || municipalityId).toLowerCase()}-${Date.now()}.png`;
  const filePath = path.join(COAT_OF_ARMS_UPLOAD_DIR, fileName);
  fs.writeFileSync(filePath, pngBuffer);

  await dbPool.query(
    `INSERT INTO municipality_coat_of_arms (municipality_id, image_filename, byte_size)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       image_filename = VALUES(image_filename),
       byte_size = VALUES(byte_size),
       updated_at = CURRENT_TIMESTAMP`,
    [municipalityId, fileName, pngBuffer.length]
  );

  if (existing?.image_filename && String(existing.image_filename) !== fileName) {
    const oldPath = path.join(COAT_OF_ARMS_UPLOAD_DIR, String(existing.image_filename));
    if (fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch {
        // Ignorieren.
      }
    }
  }

  return getMunicipalityCoatOfArmsRecord(municipalityId);
}

async function resolveMunicipalityCoatOfArmsDto(municipality, requestUrl) {
  const record = await getMunicipalityCoatOfArmsRecord(municipality.id);
  if (!record?.image_filename) {
    return { svg: null, image_url: null };
  }
  return {
    svg: null,
    image_url: buildCoatOfArmsImageUrl(municipality.slug, record.updated_at, requestUrl),
  };
}

function mapChatMessageRowToDto(row, ownerUserId, roleByUserId = null) {
  const userId = Number(row.user_id);
  const mappedRole = roleByUserId instanceof Map ? normalizeMunicipalityRole(roleByUserId.get(userId)) : null;
  const userRole = userId === Number(ownerUserId)
    ? 'owner'
    : mappedRole === MUNICIPALITY_ROLE_COUNCIL
      ? 'admin'
      : 'member';
  return {
    id: Number(row.id),
    user: {
      id: userId,
      name: row.user_name || `User #${userId}`,
      avatar_config: null,
      role: userRole,
      is_municipality_owner: userId === Number(ownerUserId),
    },
    message: String(row.message || ''),
    type: ['text', 'system', 'announcement'].includes(String(row.type || 'text')) ? String(row.type || 'text') : 'text',
    reply_to: row.reply_to_id
      ? {
          id: Number(row.reply_to_id),
          message: String(row.reply_to_message || ''),
        }
      : null,
    is_edited: Boolean(row.is_edited),
    created_at: row.created_at,
    edited_at: row.edited_at || null,
  };
}

async function ensureMunicipalityChatTables() {
  ensureDbEnabled();
  await dbPool.query(
    `CREATE TABLE IF NOT EXISTS municipality_chat_messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      municipality_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      message TEXT NOT NULL,
      type ENUM('text', 'system', 'announcement') NOT NULL DEFAULT 'text',
      metadata JSON NULL,
      reply_to_id BIGINT UNSIGNED NULL,
      is_edited TINYINT(1) NOT NULL DEFAULT 0,
      edited_at TIMESTAMP NULL DEFAULT NULL,
      deleted_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_municipality_created (municipality_id, created_at),
      KEY idx_user_created (user_id, created_at),
      KEY idx_reply_to_id (reply_to_id),
      CONSTRAINT fk_chat_msg_municipality FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
      CONSTRAINT fk_chat_msg_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_chat_msg_reply FOREIGN KEY (reply_to_id) REFERENCES municipality_chat_messages(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await dbPool.query(
    `CREATE TABLE IF NOT EXISTS municipality_chat_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      message_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      action ENUM('created', 'edited', 'deleted', 'restored', 'reported') NOT NULL,
      old_content TEXT NULL,
      new_content TEXT NULL,
      ip_address VARCHAR(45) NULL,
      user_agent TEXT NULL,
      metadata JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_message_created (message_id, created_at),
      KEY idx_user_action (user_id, action),
      CONSTRAINT fk_chat_log_message FOREIGN KEY (message_id) REFERENCES municipality_chat_messages(id) ON DELETE CASCADE,
      CONSTRAINT fk_chat_log_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

async function ensureUsersDataTable() {
  ensureDbEnabled();
  await dbPool.query(
    `CREATE TABLE IF NOT EXISTS users_data (
      user_id BIGINT UNSIGNED NOT NULL,
      avatar_config JSON NULL,
      project_data JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      CONSTRAINT fk_users_data_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

async function getUserAvatarConfig(userId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT avatar_config
     FROM users_data
     WHERE user_id = ?
     LIMIT 1`,
    [Number(userId)]
  );
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  return wsSanitizeAvatarConfig(toJsonValue(row?.avatar_config || null) || {});
}

async function upsertUserAvatarConfig(userId, avatarConfig) {
  ensureDbEnabled();
  const existing = await getUserAvatarConfig(userId);
  const incoming = avatarConfig && typeof avatarConfig === 'object' ? avatarConfig : {};
  const merged = {
    ...existing,
    ...incoming,
  };
  if (incoming.figure == null || String(incoming.figure || '').trim() === '') {
    merged.figure = existing.figure;
  }
  const sanitized = wsSanitizeAvatarConfig(merged);
  await dbPool.query(
    `INSERT INTO users_data (user_id, avatar_config, project_data)
     VALUES (?, ?, NULL)
     ON DUPLICATE KEY UPDATE
      avatar_config = VALUES(avatar_config),
      updated_at = CURRENT_TIMESTAMP`,
    [Number(userId), JSON.stringify(sanitized)]
  );
  return sanitized;
}

function normalizeInventoryItemCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]/g, '')
    .slice(0, 64);
}

function normalizeInventoryQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

async function ensureUserInventoryTable() {
  ensureDbEnabled();
  await dbPool.query(
    `CREATE TABLE IF NOT EXISTS user_inventory (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      item_code VARCHAR(64) NOT NULL,
      quantity INT UNSIGNED NOT NULL DEFAULT 0,
      metadata JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_user_item (user_id, item_code),
      KEY idx_user_updated (user_id, updated_at),
      CONSTRAINT fk_user_inventory_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

async function upsertUserInventoryItem(userId, itemCode, quantity, metadata = null) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  const normalizedCode = normalizeInventoryItemCode(itemCode);
  const normalizedQty = normalizeInventoryQuantity(quantity);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0 || !normalizedCode) return null;

  if (normalizedQty <= 0) {
    await dbPool.query(
      `DELETE FROM user_inventory
       WHERE user_id = ? AND item_code = ?`,
      [safeUserId, normalizedCode]
    );
    return {
      item_code: normalizedCode,
      quantity: 0,
      metadata: null,
      removed: true,
    };
  }

  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : null;
  await dbPool.query(
    `INSERT INTO user_inventory (user_id, item_code, quantity, metadata)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      quantity = VALUES(quantity),
      metadata = VALUES(metadata),
      updated_at = CURRENT_TIMESTAMP`,
    [safeUserId, normalizedCode, normalizedQty, safeMetadata ? JSON.stringify(safeMetadata) : null]
  );
  return {
    item_code: normalizedCode,
    quantity: normalizedQty,
    metadata: safeMetadata,
    removed: false,
  };
}

async function adjustUserInventoryItem(userId, itemCode, delta, metadata = null) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  const normalizedCode = normalizeInventoryItemCode(itemCode);
  const normalizedDelta = Math.round(Number(delta || 0));
  if (!Number.isInteger(safeUserId) || safeUserId <= 0 || !normalizedCode || !Number.isFinite(normalizedDelta)) return null;

  const [rows] = await dbPool.query(
    `SELECT quantity, metadata
     FROM user_inventory
     WHERE user_id = ? AND item_code = ?
     LIMIT 1`,
    [safeUserId, normalizedCode]
  );
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  const currentQty = normalizeInventoryQuantity(row?.quantity || 0);
  const nextQty = Math.max(0, currentQty + normalizedDelta);

  let nextMetadata = toJsonValue(row?.metadata);
  if (metadata && typeof metadata === 'object') {
    nextMetadata = {
      ...(nextMetadata && typeof nextMetadata === 'object' ? nextMetadata : {}),
      ...metadata,
    };
  }

  return upsertUserInventoryItem(safeUserId, normalizedCode, nextQty, nextMetadata);
}

async function getMunicipalityChatMessageRowById(municipalityId, messageId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT
      m.id, m.municipality_id, m.user_id, m.message, m.type, m.reply_to_id, m.is_edited, m.created_at, m.edited_at,
      u.nickname AS user_name,
      r.message AS reply_to_message
     FROM municipality_chat_messages m
     INNER JOIN users u ON u.id = m.user_id
     LEFT JOIN municipality_chat_messages r ON r.id = m.reply_to_id
     WHERE m.municipality_id = ? AND m.id = ?
     LIMIT 1`,
    [municipalityId, messageId]
  );
  return rows[0] || null;
}

async function listMunicipalityChatMessages(municipalityId, { limit = 10, before = null, after = null } = {}) {
  ensureDbEnabled();
  const safeLimit = Math.max(1, Math.min(10, Math.round(Number(limit || 10))));
  const where = [
    'm.municipality_id = ?',
    'm.created_at >= DATE_SUB(NOW(), INTERVAL 2 DAY)',
    'm.deleted_at IS NULL',
  ];
  const args = [municipalityId];
  let orderBy = 'm.id DESC';
  if (Number.isFinite(Number(before)) && Number(before) > 0) {
    where.push('m.id < ?');
    args.push(Number(before));
  }
  if (Number.isFinite(Number(after)) && Number(after) > 0) {
    where.push('m.id > ?');
    args.push(Number(after));
    orderBy = 'm.id ASC';
  }
  args.push(safeLimit + 1);
  const [rows] = await dbPool.query(
    `SELECT
      m.id, m.user_id, m.message, m.type, m.reply_to_id, m.is_edited, m.created_at, m.edited_at,
      u.nickname AS user_name,
      r.message AS reply_to_message
     FROM municipality_chat_messages m
     INNER JOIN users u ON u.id = m.user_id
     LEFT JOIN municipality_chat_messages r ON r.id = m.reply_to_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT ?`,
    args
  );
  const list = Array.isArray(rows) ? rows : [];
  const hasMore = list.length > safeLimit;
  const trimmed = hasMore ? list.slice(0, safeLimit) : list;
  return { rows: trimmed, hasMore };
}

async function createMunicipalityChatMessage({ municipalityId, userId, message, replyToId = null, ipAddress = null, userAgent = null }) {
  ensureDbEnabled();
  let resolvedReplyTo = null;
  if (Number.isFinite(Number(replyToId)) && Number(replyToId) > 0) {
    const [replyRows] = await dbPool.query(
      `SELECT id
       FROM municipality_chat_messages
       WHERE municipality_id = ? AND id = ?
       LIMIT 1`,
      [municipalityId, Number(replyToId)]
    );
    if (Array.isArray(replyRows) && replyRows.length > 0) {
      resolvedReplyTo = Number(replyToId);
    }
  }
  const [result] = await dbPool.query(
    `INSERT INTO municipality_chat_messages
     (municipality_id, user_id, message, type, reply_to_id, is_edited, edited_at)
     VALUES (?, ?, ?, 'text', ?, 0, NULL)`,
    [municipalityId, userId, String(message || '').slice(0, 4000), resolvedReplyTo]
  );
  const messageId = Number(result.insertId || 0);
  if (messageId > 0) {
    await dbPool.query(
      `INSERT INTO municipality_chat_logs
       (message_id, user_id, action, old_content, new_content, ip_address, user_agent, metadata)
       VALUES (?, ?, 'created', NULL, ?, ?, ?, NULL)`,
      [messageId, userId, String(message || '').slice(0, 4000), ipAddress, userAgent ? String(userAgent).slice(0, 1000) : null]
    );
  }
  return messageId;
}

async function updateMunicipalityChatMessage({ municipalityId, messageId, userId, newMessage, ipAddress = null, userAgent = null }) {
  ensureDbEnabled();
  const prev = await getMunicipalityChatMessageRowById(municipalityId, messageId);
  if (!prev) return { updated: 0, previous: null };
  await dbPool.query(
    `UPDATE municipality_chat_messages
     SET message = ?, is_edited = 1, edited_at = NOW(), updated_at = CURRENT_TIMESTAMP
     WHERE municipality_id = ? AND id = ? AND deleted_at IS NULL`,
    [String(newMessage || '').slice(0, 4000), municipalityId, messageId]
  );
  await dbPool.query(
    `INSERT INTO municipality_chat_logs
     (message_id, user_id, action, old_content, new_content, ip_address, user_agent, metadata)
     VALUES (?, ?, 'edited', ?, ?, ?, ?, NULL)`,
    [messageId, userId, String(prev.message || ''), String(newMessage || '').slice(0, 4000), ipAddress, userAgent ? String(userAgent).slice(0, 1000) : null]
  );
  return { updated: 1, previous: prev };
}

async function softDeleteMunicipalityChatMessage({ municipalityId, messageId, userId, ipAddress = null, userAgent = null }) {
  ensureDbEnabled();
  const prev = await getMunicipalityChatMessageRowById(municipalityId, messageId);
  if (!prev) return { deleted: 0, previous: null };
  await dbPool.query(
    `INSERT INTO municipality_chat_logs
     (message_id, user_id, action, old_content, new_content, ip_address, user_agent, metadata)
     VALUES (?, ?, 'deleted', ?, NULL, ?, ?, NULL)`,
    [messageId, userId, String(prev.message || ''), ipAddress, userAgent ? String(userAgent).slice(0, 1000) : null]
  );
  await dbPool.query(
    `DELETE FROM municipality_chat_messages
     WHERE municipality_id = ? AND id = ?`,
    [municipalityId, messageId]
  );
  return { deleted: 1, previous: prev };
}

async function listMunicipalityChatLogs(municipalityId, limit = 100) {
  ensureDbEnabled();
  const safeLimit = Math.max(1, Math.min(500, Math.round(Number(limit || 100))));
  const [rows] = await dbPool.query(
    `SELECT
      l.id, l.message_id, l.user_id, l.action, l.old_content, l.new_content, l.ip_address, l.created_at,
      u.nickname AS user_name
     FROM municipality_chat_logs l
     INNER JOIN municipality_chat_messages m ON m.id = l.message_id
     INNER JOIN users u ON u.id = l.user_id
     WHERE m.municipality_id = ?
     ORDER BY l.id DESC
     LIMIT ?`,
    [municipalityId, safeLimit]
  );
  return Array.isArray(rows) ? rows : [];
}

// ── Discord Bot: Event an den externen Discord-Bot pushen ────
function pushDiscordEvent(eventType, data) {
  if (!DISCORD_BOT_WEBHOOK_URL) return;
  try {
    const payload = JSON.stringify({ type: eventType, ...data, serverTimestamp: Date.now() });
    const url = new URL(DISCORD_BOT_WEBHOOK_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 3000,
    };
    const req = http.request(options, () => {});
    req.on('error', () => {}); // Fire-and-forget, Fehler ignorieren
    req.write(payload);
    req.end();
  } catch (_) { /* Absichtlich ignoriert */ }
}

async function createUserNotification(userId, notificationType, title, message, payload = null) {
  ensureDbEnabled();
  if (!userId) return;
  await dbPool.query(
    `INSERT INTO user_notifications (user_id, notification_type, title, message, payload, is_read)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [userId, notificationType, title, message, payload ? JSON.stringify(payload) : null]
  );
  // Push an Discord Bot (fire-and-forget)
  pushDiscordEvent(notificationType, { title, message, payload, userId });
}

// ============================================================
// XP & LEVEL SYSTEM
// ============================================================
const XP_LEVEL_CAP = 25;
const XP_DAILY_LOGIN = 50;

function calculateLevel(totalXp) {
  const level = Math.floor(Math.sqrt(totalXp / 100)) + 1;
  return Math.min(level, XP_LEVEL_CAP);
}

function xpForLevel(level) {
  return Math.pow(level - 1, 2) * 100;
}

async function getUserXp(userId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT user_id, total_xp, level, login_streak, best_streak, last_login_date, last_xp_at
     FROM user_xp WHERE user_id = ?`, [userId]
  );
  if (rows.length > 0) return rows[0];
  await dbPool.query(
    `INSERT IGNORE INTO user_xp (user_id, total_xp, level) VALUES (?, 0, 1)`, [userId]
  );
  return { user_id: userId, total_xp: 0, level: 1, login_streak: 0, best_streak: 0, last_login_date: null, last_xp_at: null };
}

async function awardXp(userId, amount, reason, description = null, refType = null, refId = null) {
  ensureDbEnabled();
  if (!userId || amount === 0) return null;

  const conn = await dbPool.getConnection();
  let newTotal, newLevel, oldLevel;
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT total_xp, level FROM user_xp WHERE user_id = ? FOR UPDATE`,
      [userId]
    );
    if (rows.length === 0) {
      await conn.query(
        `INSERT IGNORE INTO user_xp (user_id, total_xp, level) VALUES (?, 0, 1)`,
        [userId]
      );
      rows[0] = { total_xp: 0, level: 1 };
    }

    oldLevel = rows[0].level;
    newTotal = Math.max(0, rows[0].total_xp + amount);
    newLevel = calculateLevel(newTotal);

    await conn.query(
      `UPDATE user_xp SET total_xp = ?, level = ?, last_xp_at = NOW(), updated_at = NOW() WHERE user_id = ?`,
      [newTotal, newLevel, userId]
    );
    await conn.query(
      `INSERT INTO user_xp_log (user_id, xp_amount, reason, description, ref_type, ref_id, total_after, level_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, amount, reason, description, refType, refId, newTotal, newLevel]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  if (newLevel > oldLevel) {
    const levelBadges = { 5: 'LVL_5', 10: 'LVL_10', 15: 'LVL_15', 20: 'LVL_20', 25: 'LVL_25' };
    if (levelBadges[newLevel]) {
      try {
        await dbPool.query(
          `INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, ?)`,
          [userId, levelBadges[newLevel]]
        );
      } catch (_) {}
    }
    await createUserNotification(
      userId, 'level_up',
      `Level ${newLevel} erreicht!`,
      `Glueckwunsch! Du bist jetzt Level ${newLevel}.`,
      { old_level: oldLevel, new_level: newLevel, total_xp: newTotal }
    );
  }

  return { total_xp: newTotal, level: newLevel, old_level: oldLevel, xp_change: amount };
}

async function processDailyLogin(userId) {
  ensureDbEnabled();
  await getUserXp(userId);

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const [updateResult] = await dbPool.query(
    `UPDATE user_xp
     SET best_streak   = GREATEST(best_streak, IF(last_login_date = ?, login_streak + 1, 1)),
         login_streak  = IF(last_login_date = ?, login_streak + 1, 1),
         last_login_date = ?,
         updated_at = NOW()
     WHERE user_id = ? AND (last_login_date IS NULL OR last_login_date < ?)`,
    [yesterday, yesterday, today, userId, today]
  );

  if (updateResult.affectedRows === 0) return null;

  const xpData = await getUserXp(userId);
  const newStreak = xpData.login_streak;
  const bestStreak = xpData.best_streak;

  let totalBonus = 0;
  const [bonuses] = await dbPool.query(
    `SELECT streak_days, bonus_xp, badge_code FROM xp_streak_bonuses WHERE streak_days <= ? ORDER BY streak_days DESC`,
    [newStreak]
  );
  if (bonuses.length > 0) {
    totalBonus = bonuses[0].bonus_xp;
    for (const bonus of bonuses) {
      if (bonus.badge_code && bonus.streak_days === newStreak) {
        try {
          await dbPool.query(
            `INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, ?)`,
            [userId, bonus.badge_code]
          );
        } catch (_) {}
      }
    }
  }

  const totalXpGain = XP_DAILY_LOGIN + totalBonus;
  const result = await awardXp(userId, totalXpGain, 'daily_login',
    `Taegl. Login (+${XP_DAILY_LOGIN}) + Streak ${newStreak} Tage (+${totalBonus})`);

  return { ...result, login_streak: newStreak, best_streak: bestStreak, bonus_xp: totalBonus };
}

// ============================================================
// BUENZLI EVENT SYSTEM
// ============================================================
const BUENZLI_EVENTS_ENABLED = (config.BUENZLI_EVENTS_ENABLED || 'true').toLowerCase() === 'true';
const BUENZLI_EVENTS_PER_DAY_MIN = 4;
const BUENZLI_EVENTS_PER_DAY_MAX = 10;
const BUENZLI_EVENT_CHECK_INTERVAL_MS = 60000; // 1 Minute
const INSPECTION_DURATION_MS = 10 * 60 * 1000; // 10 Minuten
const INSPECTION_RADIUS = 5;
let buenzliLastCheckDate = null;

async function findBuildingForEvent(municipalityId, eventTypeId) {
  const [mappings] = await dbPool.query(
    `SELECT building_tool, priority FROM event_type_building_map
     WHERE event_type_id = ? ORDER BY priority DESC`,
    [eventTypeId]
  );
  if (mappings.length === 0) return null;

  const tools = mappings.map(m => m.building_tool);
  const placeholders = tools.map(() => '?').join(',');
  const [buildings] = await dbPool.query(
    `SELECT gi.id, gi.room_code, gi.tool, gi.x, gi.y, gi.metadata
     FROM game_items gi
     WHERE gi.municipality_id = ? AND gi.action_type = 'place'
       AND gi.tool IN (${placeholders})
       AND gi.applied_at <= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       AND gi.id NOT IN (
         SELECT affected_item_id FROM municipality_events
         WHERE municipality_id = ? AND affected_item_id IS NOT NULL
           AND status IN ('detected','reported','investigating','assigned')
       )
     ORDER BY RAND() LIMIT 1`,
    [municipalityId, ...tools, municipalityId]
  );
  if (buildings.length === 0) return null;

  const b = buildings[0];
  let meta = null;
  try { meta = typeof b.metadata === 'string' ? JSON.parse(b.metadata) : b.metadata; } catch (_) {}
  return {
    item_id: b.id,
    room_code: b.room_code,
    x: b.x,
    y: b.y,
    snapshot: {
      tool: b.tool,
      x: b.x,
      y: b.y,
      level: meta?.level || 1,
      metadata: meta,
      captured_at: new Date().toISOString(),
    },
  };
}

async function verifyBuildingExists(eventId) {
  ensureDbEnabled();
  const [events] = await dbPool.query(
    `SELECT me.id, me.affected_item_id, me.municipality_id, me.room_code, me.location_x, me.location_y,
            me.building_snapshot, me.status
     FROM municipality_events me WHERE me.id = ?`, [eventId]
  );
  if (events.length === 0) return null;
  const ev = events[0];
  if (!ev.affected_item_id) return { exists: null, event: ev };

  const [items] = await dbPool.query(
    `SELECT id, tool, x, y, metadata FROM game_items
     WHERE id = ? AND municipality_id = ? AND action_type = 'place'`,
    [ev.affected_item_id, ev.municipality_id]
  );
  const exists = items.length > 0;

  await dbPool.query(
    `UPDATE municipality_events SET building_exists = ?, building_verified_at = NOW(), updated_at = NOW() WHERE id = ?`,
    [exists ? 1 : 0, eventId]
  );

  if (!exists && ['detected', 'reported'].includes(ev.status)) {
    await dbPool.query(
      `UPDATE municipality_events SET status = 'resolved', resolved_at = NOW(),
              updated_at = NOW() WHERE id = ? AND status IN ('detected','reported')`,
      [eventId]
    );
    logInfo('BUENZLI', `Event #${eventId} auto-resolved: Gebaeude wurde abgerissen`);
  }

  return { exists, event: ev, building: items[0] || null };
}

async function generateBuenzliEventsForMunicipality(municipalityId) {
  ensureDbEnabled();
  const today = new Date().toISOString().slice(0, 10);

  const [genLog] = await dbPool.query(
    `SELECT events_generated FROM event_generation_log WHERE municipality_id = ? AND generation_date = ?`,
    [municipalityId, today]
  );
  if (genLog.length > 0) return 0;

  const [activeEvents] = await dbPool.query(
    `SELECT COUNT(*) AS cnt FROM municipality_events
     WHERE municipality_id = ? AND status IN ('detected','reported','investigating','assigned')`,
    [municipalityId]
  );
  const currentActive = activeEvents[0]?.cnt || 0;
  if (currentActive >= BUENZLI_EVENTS_PER_DAY_MAX) return 0;

  // Kantonale Untersuchung aktiv? → Event-Rate x2, Severity +1
  let cantonalActive = false;
  try {
    const [cantonalCheck] = await dbPool.query(
      `SELECT cantonal_investigation_until FROM municipality_stats WHERE municipality_id = ?`, [municipalityId]
    );
    cantonalActive = cantonalCheck[0]?.cantonal_investigation_until &&
      new Date(cantonalCheck[0].cantonal_investigation_until) > new Date();
  } catch (_) {}

  const maxNew = Math.max(0, BUENZLI_EVENTS_PER_DAY_MAX - currentActive);
  let baseGenerate = BUENZLI_EVENTS_PER_DAY_MIN + Math.floor(Math.random() * (BUENZLI_EVENTS_PER_DAY_MAX - BUENZLI_EVENTS_PER_DAY_MIN + 1));
  if (cantonalActive) baseGenerate = Math.min(baseGenerate * 2, BUENZLI_EVENTS_PER_DAY_MAX * 2);
  const toGenerate = Math.min(maxNew, baseGenerate);
  if (toGenerate <= 0) return 0;

  const [eventTypes] = await dbPool.query(
    `SELECT * FROM event_types WHERE is_active = 1`
  );
  if (eventTypes.length === 0) return 0;

  const totalWeight = eventTypes.reduce((sum, et) => sum + (et.spawn_weight || 1), 0);
  let generatedCount = 0;

  for (let i = 0; i < toGenerate; i++) {
    let rng = Math.random() * totalWeight;
    let chosen = eventTypes[0];
    for (const et of eventTypes) {
      rng -= (et.spawn_weight || 1);
      if (rng <= 0) { chosen = et; break; }
    }

    const durationHours = chosen.duration_hours_min +
      Math.floor(Math.random() * (chosen.duration_hours_max - chosen.duration_hours_min + 1));
    const expiresAt = new Date(Date.now() + durationHours * 3600000);

    let confidence = Number(chosen.base_confidence);
    if (confidence < 1.0) {
      confidence = Math.max(0.2, confidence + (Math.random() * 0.3 - 0.15));
    }
    const actualReal = confidence >= 0.9 ? 1 : (Math.random() < confidence ? 1 : 0);

    const fixCost = chosen.fix_cost_min +
      Math.floor(Math.random() * (chosen.fix_cost_max - chosen.fix_cost_min + 1));

    const building = await findBuildingForEvent(municipalityId, chosen.id);

    await dbPool.query(
      `INSERT INTO municipality_events
       (municipality_id, room_code, event_type_id, status, severity, confidence, actual_real,
        min_level, fix_cost, location_x, location_y, affected_item_id,
        building_snapshot, building_exists, building_verified_at,
        expires_at, spawned_at)
       VALUES (?, ?, ?, 'detected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW())`,
      [
        municipalityId,
        building?.room_code || null,
        chosen.id,
        Math.min(5, chosen.severity + (cantonalActive ? 1 : 0)),
        confidence,
        actualReal,
        chosen.min_level,
        fixCost,
        building?.x ?? null,
        building?.y ?? null,
        building?.item_id ?? null,
        building ? JSON.stringify(building.snapshot) : null,
        building ? 1 : null,
        expiresAt,
      ]
    );
    generatedCount++;
  }

  await dbPool.query(
    `INSERT INTO event_generation_log (municipality_id, generation_date, events_generated) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE events_generated = events_generated + VALUES(events_generated)`,
    [municipalityId, today, generatedCount]
  );

  logInfo('BUENZLI', `Events generiert fuer Gemeinde ${municipalityId}`, { count: generatedCount });
  return generatedCount;
}

async function expireBuenzliEvents() {
  ensureDbEnabled();

  // Gebaeude-Existenz pruefen fuer aktive Events (alle 60s im Tick)
  const [buildingEvents] = await dbPool.query(
    `SELECT me.id, me.affected_item_id, me.municipality_id
     FROM municipality_events me
     WHERE me.affected_item_id IS NOT NULL
       AND me.status IN ('detected','reported','investigating','assigned')
       AND (me.building_verified_at IS NULL OR me.building_verified_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE))`
  );
  for (const ev of buildingEvents) {
    try {
      await verifyBuildingExists(ev.id);
    } catch (_) {}
  }

  const [result] = await dbPool.query(
    `UPDATE municipality_events SET status = 'expired', updated_at = NOW()
     WHERE status IN ('detected','reported') AND expires_at <= NOW()`
  );
  const expired = result.affectedRows || 0;
  if (expired > 0) {
    logInfo('BUENZLI', `${expired} Events abgelaufen`);
    const [expiredEvents] = await dbPool.query(
      `SELECT me.id, me.municipality_id, me.event_type_id, et.stat_impact, et.stat_damage
       FROM municipality_events me
       JOIN event_types et ON et.id = me.event_type_id
       WHERE me.status = 'expired' AND me.updated_at >= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
         AND et.stat_impact IS NOT NULL`
    );

    // Schutzschild und Daily-Cap pro Gemeinde pruefen
    const shieldCache = {};
    const dailyDamageCache = {};

    for (const ev of expiredEvents) {
      const mId = ev.municipality_id;

      // Schild-Check (cached pro Gemeinde)
      if (shieldCache[mId] === undefined) {
        const [sh] = await dbPool.query(
          `SELECT shield_active_until FROM municipality_stats WHERE municipality_id = ?`, [mId]
        );
        const shieldUntil = sh[0]?.shield_active_until;
        shieldCache[mId] = shieldUntil && new Date(shieldUntil) > new Date();
      }
      if (shieldCache[mId]) {
        logInfo('SHIELD', `Debuff blockiert durch Schutzschild`, { municipality_id: mId, event_id: ev.id, blocked_damage: ev.stat_damage });
        continue;
      }

      // Daily-Cap: Max -15 Gesamtschaden pro Stat pro Tag pro Gemeinde
      const capKey = `${mId}:${ev.stat_impact}`;
      if (dailyDamageCache[capKey] === undefined) {
        const [todayDmg] = await dbPool.query(
          `SELECT COALESCE(SUM(ABS(change_amount)), 0) AS total_dmg
           FROM municipality_stats_log
           WHERE municipality_id = ? AND stat_name = ? AND change_amount < 0
             AND reason = 'event_expired' AND created_at >= CURDATE()`, [mId, ev.stat_impact]
        );
        dailyDamageCache[capKey] = todayDmg[0]?.total_dmg || 0;
      }

      const DAILY_DEBUFF_CAP = 15;
      if (dailyDamageCache[capKey] >= DAILY_DEBUFF_CAP) {
        logInfo('BUENZLI', `Daily Debuff-Cap erreicht`, { municipality_id: mId, stat: ev.stat_impact, cap: DAILY_DEBUFF_CAP });
        continue;
      }

      // Schaden anwenden (begrenzt auf verbleibendes Cap)
      const remaining = DAILY_DEBUFF_CAP - dailyDamageCache[capKey];
      const actualDamage = Math.max(ev.stat_damage, -remaining);
      await applyStatChange(mId, ev.stat_impact, actualDamage, 'event_expired', 'event', ev.id);
      dailyDamageCache[capKey] += Math.abs(actualDamage);
    }
  }

  // ── Externe Reports: Frist abgelaufen → Eskalation ──
  const [ignoredExternals] = await dbPool.query(
    `SELECT me.id, me.municipality_id, me.severity, me.external_reporter_id, me.escalation_level,
            et.stat_impact, et.stat_damage, et.name AS event_name
     FROM municipality_events me
     JOIN event_types et ON et.id = me.event_type_id
     WHERE me.status = 'external_reported' AND me.external_deadline <= NOW()`
  );
  for (const ev of ignoredExternals) {
    const newSeverity = Math.min(5, ev.severity + 1);
    const newEscLevel = Math.min(2, ev.escalation_level + 1);
    await dbPool.query(
      `UPDATE municipality_events
       SET status = 'reported', severity = ?, escalation_level = ?, updated_at = NOW()
       WHERE id = ?`,
      [newSeverity, newEscLevel, ev.id]
    );
    await applyStatChange(ev.municipality_id, 'transparency', -(ev.severity * 2),
      'external_ignored', 'event', ev.id);
    if (ev.stat_impact && ev.stat_impact !== 'transparency') {
      await applyStatChange(ev.municipality_id, ev.stat_impact, Math.round(ev.stat_damage * 0.5),
        'external_ignored', 'event', ev.id);
    }
    if (ev.external_reporter_id) {
      const xpBonus = 15 + ev.severity * 5;
      await awardXp(ev.external_reporter_id, xpBonus, 'external_report_ignored',
        `Gemeinde ignorierte Report: ${ev.event_name} (Eskalation!)`, 'event', ev.id);
      await createUserNotification(ev.external_reporter_id, 'report_escalated',
        'Gemeinde hat deinen Report ignoriert!',
        `Dein Report "${ev.event_name}" wurde ignoriert. Severity: ${newSeverity}. Du erhaeltst ${xpBonus} Bonus-XP.`,
        { event_id: ev.id, xp_bonus: xpBonus });
    }
    logInfo('BUENZLI', `Externer Report ignoriert → eskaliert`, {
      event_id: ev.id, municipality_id: ev.municipality_id, new_severity: newSeverity, escalation_level: newEscLevel
    });
  }

  // ── Disputes auswerten (Timer abgelaufen) ──
  const [resolvedDisputes] = await dbPool.query(
    `SELECT me.id, me.municipality_id, me.evidence_score, me.external_reporter_id,
            me.severity, et.name AS event_name
     FROM municipality_events me
     JOIN event_types et ON et.id = me.event_type_id
     WHERE me.status = 'disputed' AND me.dispute_until <= NOW()`
  );
  for (const ev of resolvedDisputes) {
    const score = ev.evidence_score || 0;
    if (score >= 60) {
      await dbPool.query(
        `UPDATE municipality_events SET status = 'reported', updated_at = NOW() WHERE id = ?`, [ev.id]
      );
      await applyStatChange(ev.municipality_id, 'transparency', -(ev.severity),
        'dispute_lost', 'event', ev.id);
      if (ev.external_reporter_id) {
        const xpBonus = 25 + ev.severity * 5;
        await awardXp(ev.external_reporter_id, xpBonus, 'dispute_won',
          `Einspruch abgelehnt: ${ev.event_name}`, 'event', ev.id);
        await createUserNotification(ev.external_reporter_id, 'dispute_won',
          'Einspruch abgelehnt — du hattest recht!',
          `Der Einspruch gegen "${ev.event_name}" wurde abgelehnt (Evidence: ${score}/100). Bonus: ${xpBonus} XP!`,
          { event_id: ev.id });
      }
      logInfo('BUENZLI', `Dispute verloren (Score ${score}): Event #${ev.id} → reported`);
    } else {
      await dbPool.query(
        `UPDATE municipality_events SET status = 'false_alarm', updated_at = NOW() WHERE id = ?`, [ev.id]
      );
      if (ev.external_reporter_id) {
        const xpPenalty = -(10 + ev.severity * 3);
        await awardXp(ev.external_reporter_id, xpPenalty, 'dispute_lost',
          `Falschmeldung: ${ev.event_name}`, 'event', ev.id);
        await dbPool.query(
          `UPDATE event_reports SET foreign_cooldown_until = DATE_ADD(NOW(), INTERVAL 12 HOUR)
           WHERE event_id = ? AND user_id = ?`, [ev.id, ev.external_reporter_id]
        );
        await createUserNotification(ev.external_reporter_id, 'dispute_lost',
          'Einspruch akzeptiert — Falschmeldung!',
          `Dein Report "${ev.event_name}" war falsch (Evidence: ${score}/100). 12h Cooldown.`,
          { event_id: ev.id });
      }
      logInfo('BUENZLI', `Dispute gewonnen (Score ${score}): Event #${ev.id} → false_alarm`);
    }
  }

  // ── Kantonale Untersuchung pruefen ──
  await checkCantonalInvestigation();

  return expired;
}

// ── Kantonale Untersuchung: Trigger-Check und Effekte ──
async function checkCantonalInvestigation() {
  ensureDbEnabled();
  try {
    const [candidates] = await dbPool.query(
      `SELECT ms.municipality_id, ms.transparency, ms.cantonal_investigation_until,
              m.name AS municipality_name, m.canton_name
       FROM municipality_stats ms
       JOIN municipalities m ON m.id = ms.municipality_id
       WHERE ms.cantonal_investigation_until IS NULL OR ms.cantonal_investigation_until < NOW()`
    );
    for (const muni of candidates) {
      if (muni.cantonal_investigation_until && new Date(muni.cantonal_investigation_until) > new Date()) continue;
      let shouldInvestigate = false;
      let reason = '';

      const [ignoredCount] = await dbPool.query(
        `SELECT COUNT(*) AS cnt FROM municipality_events
         WHERE municipality_id = ? AND escalation_level >= 1
           AND updated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
        [muni.municipality_id]
      );
      if ((ignoredCount[0]?.cnt || 0) >= 3) {
        shouldInvestigate = true;
        reason = `${ignoredCount[0].cnt} ignorierte externe Reports in 7 Tagen`;
      }
      if (!shouldInvestigate && muni.transparency < 25) {
        shouldInvestigate = true;
        reason = `Transparenz kritisch niedrig: ${muni.transparency}/100`;
      }

      if (shouldInvestigate) {
        const durationHours = 48 + Math.floor(Math.random() * 25);
        const until = new Date(Date.now() + durationHours * 3600000);
        await dbPool.query(
          `UPDATE municipality_stats SET cantonal_investigation_until = ?, updated_at = NOW()
           WHERE municipality_id = ?`, [until, muni.municipality_id]
        );
        await createNotificationForAllMembers(muni.municipality_id, {
          type: 'cantonal_investigation',
          title: 'Kantonale Untersuchung eingeleitet!',
          message: `Der Kanton ${muni.canton_name || 'Bern'} hat eine Untersuchung gegen eure Gemeinde eingeleitet (${reason}). Dauer: ${Math.round(durationHours)}h. Event-Rate verdoppelt!`,
        });
        pushDiscordEvent('cantonal_investigation', {
          municipality_id: muni.municipality_id,
          municipality_name: muni.municipality_name,
          canton: muni.canton_name || 'Bern',
          reason,
          duration_hours: durationHours,
          message: `Kanton ${muni.canton_name || 'Bern'} hat Untersuchung gegen ${muni.municipality_name} eingeleitet! Grund: ${reason}.`,
        });
        logInfo('CANTONAL', `Kantonale Untersuchung eingeleitet`, {
          municipality_id: muni.municipality_id, reason, duration_hours: durationHours,
        });
      }
    }

    // Aktive Untersuchungen: stuendliche Effekte
    const [activeInvestigations] = await dbPool.query(
      `SELECT municipality_id FROM municipality_stats
       WHERE cantonal_investigation_until IS NOT NULL AND cantonal_investigation_until > NOW()`
    );
    for (const inv of activeInvestigations) {
      const [recentPenalty] = await dbPool.query(
        `SELECT COUNT(*) AS cnt FROM municipality_stats_log
         WHERE municipality_id = ? AND reason = 'cantonal_ongoing'
           AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
        [inv.municipality_id]
      );
      if ((recentPenalty[0]?.cnt || 0) === 0) {
        await applyStatChange(inv.municipality_id, 'transparency', -1, 'cantonal_ongoing', 'investigation', inv.municipality_id);
        await applyStatChange(inv.municipality_id, 'attractiveness', -1, 'cantonal_ongoing', 'investigation', inv.municipality_id);
      }
    }
  } catch (err) {
    logError('CANTONAL', 'Kantonale Untersuchung Check Fehler', { error: err?.message || String(err) });
  }
}

async function applyStatChange(municipalityId, statName, changeAmount, reason, refType = null, refId = null) {
  ensureDbEnabled();
  const validStats = ['security', 'attractiveness', 'cleanliness', 'infrastructure', 'transparency'];
  if (!validStats.includes(statName)) return;

  await dbPool.query(
    `INSERT IGNORE INTO municipality_stats (municipality_id) VALUES (?)`, [municipalityId]
  );

  const [current] = await dbPool.query(
    `SELECT ${statName} AS val FROM municipality_stats WHERE municipality_id = ?`, [municipalityId]
  );
  const oldValue = current[0]?.val ?? 50;
  const newValue = Math.max(0, Math.min(100, oldValue + changeAmount));

  if (newValue !== oldValue) {
    await dbPool.query(
      `UPDATE municipality_stats SET \`${statName}\` = ?, updated_at = NOW() WHERE municipality_id = ?`,
      [newValue, municipalityId]
    );
    await dbPool.query(
      `INSERT INTO municipality_stats_log
       (municipality_id, stat_name, old_value, new_value, change_amount, reason, ref_type, ref_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [municipalityId, statName, oldValue, newValue, changeAmount, reason, refType, refId]
    );
  }

  const [allStats] = await dbPool.query(
    `SELECT security, attractiveness, cleanliness, infrastructure, transparency FROM municipality_stats WHERE municipality_id = ?`,
    [municipalityId]
  );
  if (allStats.length > 0) {
    const s = allStats[0];
    const avg = Math.round((s.security + s.attractiveness + s.cleanliness + s.infrastructure + s.transparency) / 5);
    await dbPool.query(
      `UPDATE municipality_stats SET citizen_satisfaction = ?, updated_at = NOW() WHERE municipality_id = ?`,
      [avg, municipalityId]
    );
  }
}

// Multiplikator fuer fremde Gemeinde-Meldungen
const FOREIGN_REPORT_COIN_MULTIPLIER = 3;   // User bekommt 3x Coins
const FOREIGN_REPORT_XP_MULTIPLIER = 2;     // User bekommt 2x XP
const FOREIGN_REPORT_PENALTY_MULTIPLIER = 2; // fix_cost wird verdoppelt (Strafe vom Amt)

async function reportBuenzliEvent(eventId, userId, reportType = 'confirm', comment = null) {
  ensureDbEnabled();
  const [events] = await dbPool.query(
    `SELECT me.*, et.xp_reward_report, et.xp_penalty_wrong, et.stat_impact, et.stat_fix_bonus,
            et.code AS event_code, et.name AS event_name, et.base_confidence,
            et.coin_reward_report, et.coin_municipality_report, et.severity
     FROM municipality_events me
     JOIN event_types et ON et.id = me.event_type_id
     WHERE me.id = ?`, [eventId]
  );
  if (events.length === 0) throw new Error('Event nicht gefunden');
  const event = events[0];

  if (!['detected', 'reported'].includes(event.status)) {
    throw new Error('Event kann nicht mehr gemeldet werden');
  }

  const userXp = await getUserXp(userId);
  if (userXp.level < event.min_level) {
    throw new Error(`Level ${event.min_level} erforderlich (du bist Level ${userXp.level})`);
  }

  // Eigene oder fremde Gemeinde?
  const [userRow] = await dbPool.query(
    `SELECT municipality_id FROM users WHERE id = ?`, [userId]
  );
  const userMunicipalityId = userRow[0]?.municipality_id || null;
  const isForeignReport = userMunicipalityId && userMunicipalityId !== event.municipality_id;

  // ── Anti-Griefing fuer externe Reports ──
  if (isForeignReport) {
    // Max 3 externe Reports pro User pro Tag pro Gemeinde
    const [recentForeign] = await dbPool.query(
      `SELECT COUNT(*) AS cnt FROM event_reports er
       JOIN municipality_events me ON me.id = er.event_id
       WHERE er.user_id = ? AND er.is_foreign = 1
         AND me.municipality_id = ? AND er.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
      [userId, event.municipality_id]
    );
    if ((recentForeign[0]?.cnt || 0) >= 3) {
      throw new Error('Tageslimit erreicht: Max 3 externe Reports pro Tag pro Gemeinde');
    }
    // Cooldown nach Falschmeldung pruefen
    const [cooldownCheck] = await dbPool.query(
      `SELECT foreign_cooldown_until FROM event_reports
       WHERE user_id = ? AND foreign_cooldown_until > NOW() ORDER BY foreign_cooldown_until DESC LIMIT 1`,
      [userId]
    );
    if (cooldownCheck.length > 0 && cooldownCheck[0].foreign_cooldown_until) {
      const until = new Date(cooldownCheck[0].foreign_cooldown_until);
      const hoursLeft = Math.ceil((until.getTime() - Date.now()) / 3600000);
      throw new Error(`Cooldown aktiv: Du kannst erst in ${hoursLeft}h wieder extern melden (Falschmeldung)`);
    }
  }

  await dbPool.query(
    `INSERT INTO event_reports (event_id, user_id, report_type, comment, user_level, is_foreign)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE report_type = VALUES(report_type), comment = VALUES(comment), is_foreign = VALUES(is_foreign)`,
    [eventId, userId, reportType, comment, userXp.level, isForeignReport ? 1 : 0]
  );

  if (event.status === 'detected') {
    if (isForeignReport) {
      // Externe Meldung: Status → external_reported mit Frist
      const deadlineHours = event.severity >= 4 ? 12 : event.severity >= 3 ? 18 : 24;
      await dbPool.query(
        `UPDATE municipality_events
         SET status = 'external_reported', reported_by = ?, reported_at = NOW(),
             external_reporter_id = ?, external_deadline = DATE_ADD(NOW(), INTERVAL ? HOUR),
             updated_at = NOW()
         WHERE id = ?`,
        [userId, userId, deadlineHours, eventId]
      );
    } else {
      // Interne Meldung: normaler Flow
      await dbPool.query(
        `UPDATE municipality_events SET status = 'reported', reported_by = ?, reported_at = NOW(), updated_at = NOW() WHERE id = ?`,
        [userId, eventId]
      );
    }
  }

  let xpResult = null;
  let coinsAwarded = 0;
  let penaltyCost = 0;

  if (reportType === 'investigate' && event.base_confidence < 1.0) {
    // Investigation (Korruption etc.)
    const isCorrect = event.actual_real === 1;
    const baseXp = isCorrect ? event.xp_reward_report * 2 : -(event.xp_penalty_wrong || 0);
    const xpAmount = isCorrect && isForeignReport ? baseXp * FOREIGN_REPORT_XP_MULTIPLIER : baseXp;
    xpResult = await awardXp(userId, xpAmount,
      isCorrect ? 'corruption_correct' : 'corruption_wrong',
      `Investigation: ${event.event_name} - ${isCorrect ? 'korrekt' : 'Fehlalarm'}${isForeignReport ? ' (Fremdgemeinde)' : ''}`,
      'event', eventId
    );
    await dbPool.query(
      `UPDATE event_reports SET is_correct = ?, xp_awarded = ? WHERE event_id = ? AND user_id = ?`,
      [isCorrect ? 1 : 0, xpAmount, eventId, userId]
    );
    if (!isCorrect) {
      await dbPool.query(
        `UPDATE municipality_events SET status = 'false_alarm', updated_at = NOW() WHERE id = ?`, [eventId]
      );
      try {
        await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, 'ACH_FalseAlarm')`, [userId]);
      } catch (_) {}
    } else {
      coinsAwarded = (event.coin_reward_report || 0) * (isForeignReport ? FOREIGN_REPORT_COIN_MULTIPLIER * 2 : 3);
      try {
        await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, 'ACH_Corruption')`, [userId]);
      } catch (_) {}
    }
  } else {
    // Normale Meldung
    const baseXp = event.xp_reward_report;
    const xpAmount = isForeignReport ? baseXp * FOREIGN_REPORT_XP_MULTIPLIER : baseXp;
    xpResult = await awardXp(userId, xpAmount,
      isForeignReport ? 'event_report_foreign' : 'event_report',
      isForeignReport
        ? `Fremdgemeinde-Meldung ans Amt: ${event.event_name}`
        : `Event gemeldet: ${event.event_name}`,
      'event', eventId);
    coinsAwarded = (event.coin_reward_report || 0) * (isForeignReport ? FOREIGN_REPORT_COIN_MULTIPLIER : 1);
  }

  // User bekommt Coins (Finderlohn)
  let newUserCoins = null;
  if (coinsAwarded > 0) {
    newUserCoins = await addBobbaCoins(userId, coinsAwarded);
  }

  // Fremde Gemeinde: Strafgebuehr vom Amt → fix_cost wird erhoeht
  if (isForeignReport) {
    const penalty = Math.round(event.fix_cost * (FOREIGN_REPORT_PENALTY_MULTIPLIER - 1));
    penaltyCost = penalty;
    if (penalty > 0) {
      await dbPool.query(
        `UPDATE municipality_events SET fix_cost = fix_cost + ?, updated_at = NOW() WHERE id = ?`,
        [penalty, eventId]
      );
    }
    try {
      await applyMunicipalityTransaction(event.municipality_id, {
        amount: -penalty,
        type: 'event_penalty',
        meta: { eventId, eventName: event.event_name },
        source: 'system',
        allowOverdraft: true,
      });
    } catch (_) {
      logInfo('ECONOMY', `Strafgebuehr konnte nicht abgezogen werden: ${penalty}`, { municipalityId: event.municipality_id });
    }
    // Notification an Gemeinde: Externe Meldung mit Frist
    const deadlineHoursNotif = event.severity >= 4 ? 12 : event.severity >= 3 ? 18 : 24;
    const [muniAdminsExt] = await dbPool.query(
      `SELECT user_id FROM municipality_memberships WHERE municipality_id = ? AND role IN ('owner','admin','council')`,
      [event.municipality_id]
    );
    for (const admin of muniAdminsExt) {
      await createUserNotification(
        admin.user_id, 'external_report',
        'Externe Meldung eingegangen!',
        `Ein Buerger einer anderen Gemeinde hat "${event.event_name}" gemeldet. Strafgebuehr: ${penalty} CHF. Ihr habt ${deadlineHoursNotif}h Zeit zu reagieren (Akzeptieren oder Einspruch). Bei Ignorieren: Stat-Malus + Eskalation!`,
        { event_id: eventId, penalty, reporter_municipality_id: userMunicipalityId, severity: event.severity, deadline_hours: deadlineHoursNotif }
      );
    }
    logInfo('BUENZLI', `Fremdgemeinde-Meldung: User ${userId} meldet Event #${eventId} in Gemeinde ${event.municipality_id}`, {
      penalty, coins_user: coinsAwarded, fix_cost_new: event.fix_cost + penalty,
    });
  } else {
    // Eigene Gemeinde: Nur interne Benachrichtigung an Verwaltung
    const [muniAdmins] = await dbPool.query(
      `SELECT user_id FROM municipality_memberships WHERE municipality_id = ? AND role IN ('owner','admin') AND user_id != ?`,
      [event.municipality_id, userId]
    );
    for (const admin of muniAdmins) {
      await createUserNotification(
        admin.user_id, 'event_reported',
        'Neue Meldung in deiner Gemeinde',
        `"${event.event_name}" wurde von einem Buerger gemeldet. Bitte kuemmere dich darum.`,
        { event_id: eventId, severity: event.severity }
      );
    }
  }

  const [reportCount] = await dbPool.query(
    `SELECT COUNT(*) AS cnt FROM event_reports WHERE user_id = ?`, [userId]
  );
  const cnt = reportCount[0]?.cnt || 0;
  const reportBadges = { 1: 'ACH_Report1', 10: 'ACH_Report10', 50: 'ACH_Report50' };
  if (reportBadges[cnt]) {
    try {
      await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, ?)`, [userId, reportBadges[cnt]]);
    } catch (_) {}
  }

  return {
    event, xp: xpResult, report_type: reportType,
    is_foreign_report: isForeignReport,
    penalty: penaltyCost,
    coins: { user: coinsAwarded, user_balance: newUserCoins },
  };
}

async function resolveBuenzliEvent(eventId, userId) {
  ensureDbEnabled();
  const [events] = await dbPool.query(
    `SELECT me.*, et.xp_reward_fix, et.stat_impact, et.stat_fix_bonus,
            et.name AS event_name, et.coin_reward_fix
     FROM municipality_events me
     JOIN event_types et ON et.id = me.event_type_id
     WHERE me.id = ?`, [eventId]
  );
  if (events.length === 0) throw new Error('Event nicht gefunden');
  const event = events[0];

  if (!['reported', 'investigating', 'assigned', 'external_reported'].includes(event.status)) {
    throw new Error('Event kann nicht behoben werden (aktueller Status: ' + event.status + ')');
  }

  // Gebaeude-Existenz pruefen
  let buildingCheck = null;
  if (event.affected_item_id) {
    buildingCheck = await verifyBuildingExists(eventId);
    if (buildingCheck && !buildingCheck.exists) {
      return {
        event, xp: null, cost: 0,
        coins: { user: 0, user_balance: null },
        auto_resolved: true,
        message: 'Event wurde automatisch geloest: Gebaeude wurde abgerissen',
      };
    }
  }

  await applyMunicipalityTransaction(event.municipality_id, {
    amount: -event.fix_cost,
    type: 'event_fix',
    meta: { eventId, eventName: event.event_name },
    actorUserId: userId,
    source: 'user',
  });

  await dbPool.query(
    `UPDATE municipality_events SET status = 'resolved', resolved_by = ?, resolved_at = NOW(),
            building_verified_at = NOW(), building_exists = ?, updated_at = NOW() WHERE id = ?`,
    [userId, buildingCheck ? 1 : null, eventId]
  );

  // Reports als korrekt markieren (damit "Ausstehend" korrekt zaehlt)
  await dbPool.query(
    `UPDATE event_reports SET is_correct = 1 WHERE event_id = ? AND is_correct IS NULL`,
    [eventId]
  );

  // Stats verbessern sich wenn behoben
  if (event.stat_impact) {
    await applyStatChange(event.municipality_id, event.stat_impact, event.stat_fix_bonus,
      'event_fixed', 'event', eventId);
  }

  // XP an User
  const xpResult = await awardXp(userId, event.xp_reward_fix, 'event_fix',
    `Event behoben: ${event.event_name}`, 'event', eventId);

  // Coins an User (Belohnung fuers Beheben)
  const coinsUser = event.coin_reward_fix || 0;
  let newUserCoins = null;
  if (coinsUser > 0) {
    newUserCoins = await addBobbaCoins(userId, coinsUser);
  }

  // Badges
  const [fixCount] = await dbPool.query(
    `SELECT COUNT(*) AS cnt FROM municipality_events WHERE resolved_by = ? AND status = 'resolved'`, [userId]
  );
  const cnt = fixCount[0]?.cnt || 0;
  const fixBadges = { 1: 'ACH_Fix1', 25: 'ACH_Fix25' };
  if (fixBadges[cnt]) {
    try {
      await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, ?)`, [userId, fixBadges[cnt]]);
    } catch (_) {}
  }

  return {
    event, xp: xpResult, cost: event.fix_cost, building: buildingCheck?.building || null,
    coins: { user: coinsUser, user_balance: newUserCoins },
  };
}

async function runBuenzliEventTick() {
  if (!dbPool || !BUENZLI_EVENTS_ENABLED) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (buenzliLastCheckDate === today) {
      await expireBuenzliEvents();
      return;
    }

    const [municipalities] = await dbPool.query(
      `SELECT id FROM municipalities WHERE is_active = 1`
    );
    let totalGenerated = 0;
    for (const muni of municipalities) {
      try {
        totalGenerated += await generateBuenzliEventsForMunicipality(muni.id);
      } catch (err) {
        logError('BUENZLI', `Event-Generierung fehlgeschlagen fuer Gemeinde ${muni.id}`, { error: err?.message });
      }
    }
    if (totalGenerated > 0) {
      logInfo('BUENZLI', `Taegl. Event-Generierung abgeschlossen`, { total: totalGenerated, date: today });
    }
    buenzliLastCheckDate = today;
    await expireBuenzliEvents();
  } catch (err) {
    logError('BUENZLI', 'Event-Tick Fehler', { error: err?.message || String(err) });
  }
}

async function fetchRivers(cantonCode) {
  ensureDbEnabled();
  const normalized = cantonCode ? cantonCode.toUpperCase().trim() : null;
  if (normalized) {
    const [rows] = await dbPool.query(
      `SELECT id, name, slug, canton_code, canton_name, length_km, source_name, mouth_name, river_type
       FROM game_data_rivers
       WHERE is_active = 1 AND canton_code = ?
       ORDER BY name ASC`,
      [normalized]
    );
    return Array.isArray(rows) ? rows : [];
  }

  const [rows] = await dbPool.query(
    `SELECT id, name, slug, canton_code, canton_name, length_km, source_name, mouth_name, river_type
     FROM game_data_rivers
     WHERE is_active = 1
     ORDER BY canton_code ASC, name ASC`
  );
  return Array.isArray(rows) ? rows : [];
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

function roomRuntimeCacheKey(municipalityId, roomCode) {
  return `${Number(municipalityId)}:${normalizeRoomCode(roomCode) || 'MAIN'}`;
}

function cloneJsonValue(value) {
  if (value === null || typeof value === 'undefined') return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
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
  // Speichere den DB-Zeitstempel im Stats-Objekt, damit Idle-Einnahmen berechnet werden koennen
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
  if (reason !== 'periodic_flush') {
    logInfo('ROOMCACHE', 'Stats-Flush ausgefuehrt', {
      reason,
      municipalityId: entry.municipalityId,
      municipalitySlug: entry.municipalitySlug,
      roomCode: entry.roomCode,
    });
  }
  return true;
}

async function saveRoomStats(municipalityId, roomCode, statsData) {
  ensureDbEnabled();
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
    logInfo('ROOMCACHE', 'Raum in RAM geladen', {
      reason,
      municipalityId: entry.municipalityId,
      municipalitySlug: entry.municipalitySlug,
      municipalityName: entry.municipalityName,
      roomCode: safeRoomCode,
    });
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
  // Spielerzahl auch in DB persistieren (fire-and-forget)
  updateRoomPlayerCount(municipalityId, roomCode, safePlayers).catch((err) => {
    logInfo('ROOMCACHE', 'player_count DB-Update fehlgeschlagen', { municipalityId, roomCode, error: String(err?.message || err) });
  });
}

/**
 * Broadcast Navigator-Update an alle verbundenen Clients via WebSocket.
 * Wird aufgerufen wenn Spieler einem öffentlichen Raum beitreten oder ihn verlassen.
 */
function broadcastNavigatorRoomCount(ioInstance, roomCode, municipalitySlug, municipalityName, playerCount, roomName) {
  if (!ioInstance) return;
  const normalizedRoomCode = normalizeRoomCode(roomCode) || 'MAIN';
  // Nur für öffentliche Räume (MAIN oder PUB*)
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

async function unloadRoomRuntimeEntry(entry, reason = 'idle_timeout') {
  if (!entry) return false;
  // Spielerzahl in DB auf 0 setzen (fire-and-forget)
  updateRoomPlayerCount(entry.municipalityId, entry.roomCode, 0).catch(() => {});
  // Navigator-Broadcast: Raum ist leer
  if (typeof io !== 'undefined' && io) {
    broadcastNavigatorRoomCount(io, entry.roomCode, entry.municipalitySlug, entry.municipalityName, 0);
  }
  await flushRoomRuntimeEntry(entry, reason);
  roomRuntimeCache.delete(entry.key);
  logInfo('ROOMCACHE', 'Raum aus RAM entladen', {
    reason,
    municipalityId: entry.municipalityId,
    municipalitySlug: entry.municipalitySlug,
    municipalityName: entry.municipalityName,
    roomCode: entry.roomCode,
  });
  return true;
}

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

function buildServerTimePayload() {
  const config = {
    seconds_per_day: 86400, // Echtzeit: 1 realer Tag = 1 Spieltag
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
  const year = 2026 + Math.floor(totalDays / (config.days_per_month * config.months_per_year));
  const msPerTick = (config.seconds_per_day * 1000) / config.ticks_per_day;
  const nextTickInMs = Math.max(1, msPerTick - ((nowMs - baseEpoch) % msPerTick));

  let weather = null;
  try { weather = require('./game/weather').getWeatherSync(); } catch (_) {}

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
    weather,
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
  base.finances.total_tax_collected = Number(map.total_tax_collected ?? base.finances.total_tax_collected);
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
  base.infrastructure.power.production = Number(map.power_production ?? base.infrastructure.power.production);
  base.infrastructure.power.consumption = Number(map.power_consumption ?? base.infrastructure.power.consumption);
  base.infrastructure.power.balance = base.infrastructure.power.production - base.infrastructure.power.consumption;
  base.infrastructure.water.production = Number(map.water_production ?? base.infrastructure.water.production);
  base.infrastructure.water.consumption = Number(map.water_consumption ?? base.infrastructure.water.consumption);
  base.infrastructure.water.balance = base.infrastructure.water.production - base.infrastructure.water.consumption;
  base.buildings.total = Number(map.buildings_total ?? base.buildings.total);
  base.buildings.residential = Number(map.buildings_residential ?? base.buildings.residential);
  base.buildings.commercial = Number(map.buildings_commercial ?? base.buildings.commercial);
  base.buildings.industrial = Number(map.buildings_industrial ?? base.buildings.industrial);
  base.buildings.infrastructure = Number(map.buildings_infrastructure ?? base.buildings.infrastructure);
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
  const gameMapData = raw.game_map_data && typeof raw.game_map_data === 'object'
    ? raw.game_map_data
    : null;
  const mapStats = gameMapData && typeof gameMapData.stats === 'object'
    ? gameMapData.stats
    : null;
  const mapDemand = mapStats && typeof mapStats.demand === 'object'
    ? mapStats.demand
    : null;
  const mapSettings = gameMapData && typeof gameMapData.settings === 'object'
    ? gameMapData.settings
    : null;
  const mapBudget = gameMapData && typeof gameMapData.budget === 'object'
    ? gameMapData.budget
    : null;
  const mapWaterBodies = gameMapData && Array.isArray(gameMapData.waterBodies)
    ? gameMapData.waterBodies
    : (Array.isArray(fallbackWaterBodies) ? fallbackWaterBodies : []);

  return {
    money: Math.round(toFiniteNumber(raw.money, 0)),
    population: Math.max(0, Math.round(toFiniteNumber(raw.population, 0))),
    income: Math.round(toFiniteNumber(raw.income, 0)),
    expenses: Math.round(toFiniteNumber(raw.expenses, 0)),
    jobs: Math.max(0, Math.round(toFiniteNumber(raw.jobs, 0))),
    happiness: Math.max(0, Math.min(100, Math.round(toFiniteNumber(raw.happiness, 50)))),
    health: Math.max(0, Math.min(100, Math.round(toFiniteNumber(mapStats?.health, 50)))),
    education: Math.max(0, Math.min(100, Math.round(toFiniteNumber(mapStats?.education, 50)))),
    safety: Math.max(0, Math.min(100, Math.round(toFiniteNumber(mapStats?.safety, 50)))),
    environment: Math.max(0, Math.min(100, Math.round(toFiniteNumber(mapStats?.environment, 75)))),
    demand: {
      residential: Math.round(toFiniteNumber(mapDemand?.residential, 50)),
      commercial: Math.round(toFiniteNumber(mapDemand?.commercial, 30)),
      industrial: Math.round(toFiniteNumber(mapDemand?.industrial, 40)),
    },
    tax_rate: Math.round(toFiniteNumber(raw.tax_rate ?? mapSettings?.taxRate, 10)),
    effective_tax_rate: Math.round(toFiniteNumber(mapSettings?.effectiveTaxRate ?? raw.tax_rate, 10)),
    game_speed: Math.max(0, Math.min(3, Math.round(toFiniteNumber(raw.game_speed ?? mapSettings?.speed, 1)))),
    budget: mapBudget || null,
    settings: mapSettings
      ? {
          taxRate: toFiniteNumber(mapSettings.taxRate, 10),
          effectiveTaxRate: toFiniteNumber(mapSettings.effectiveTaxRate, toFiniteNumber(mapSettings.taxRate, 10)),
          speed: Math.max(0, Math.min(3, Math.round(toFiniteNumber(mapSettings.speed, 1)))),
          disastersEnabled: typeof mapSettings.disastersEnabled === 'boolean' ? mapSettings.disastersEnabled : true,
          selectedTool: String(mapSettings.selectedTool || 'select'),
        }
      : undefined,
    water_bodies: mapWaterBodies,
  };
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ── Gemeindekasse & Stats: Delegiert an game/rooms.js ───────────
// Alle Stats liegen in municipality_stats (DB-Spalten).
const _rooms = require('./game/rooms');
const _bank = require('./game/bank');
const getMunicipalityMoney = (...a) => _rooms.getMunicipalityMoney(...a);
const getMunicipalityFinance = (...a) => _rooms.getMunicipalityFinance(...a);
const setMunicipalityTreasury = (...a) => _rooms.setMunicipalityTreasury(...a);
const deductMunicipalityMoney = (...a) => _rooms.deductMunicipalityMoney(...a);
const addMunicipalityMoney = (...a) => _rooms.addMunicipalityMoney(...a);
const applyMunicipalityTransaction = (...a) => _bank.applyMunicipalityTransaction(...a);
const loadMunicipalityStats = (...a) => _rooms.loadMunicipalityStats(...a);
const saveMunicipalityStats = (...a) => _rooms.saveMunicipalityStats(...a);
const getPrimaryRoomCode = (...a) => _rooms.getPrimaryRoomCode(...a);

function applyStatsPatch(rawStats, patch) {
  const next = { ...(rawStats || {}) };
  const setNum = (key, value) => {
    if (typeof value === 'undefined' || value === null) return;
    next[key] = toFiniteNumber(value, Number(next[key] || 0));
  };
  // money wird nicht mehr aus dem Patch uebernommen – treasury in municipality_stats ist die einzige Quelle
  setNum('income', patch.income);
  setNum('expenses', patch.expenses);
  setNum('population', patch.population);
  setNum('jobs', patch.jobs);
  setNum('happiness', patch.happiness);
  setNum('tick', patch.tick);
  setNum('year', patch.year);
  setNum('month', patch.month);

  if (typeof patch.taxRate !== 'undefined' && patch.taxRate !== null) {
    const taxRate = toFiniteNumber(patch.taxRate, Number(next.tax_rate || 10));
    next.tax_rate = taxRate;
    next.taxRate = taxRate;
  }
  if (typeof patch.gameSpeed !== 'undefined' && patch.gameSpeed !== null) {
    const gameSpeed = toFiniteNumber(patch.gameSpeed, Number(next.game_speed || 1));
    next.game_speed = gameSpeed;
    next.gameSpeed = gameSpeed;
  }

  // Budget-Patch: funding-Werte in game_map_data.budget mergen
  if (patch.budget && typeof patch.budget === 'object') {
    const VALID_BUDGET_KEYS = ['police', 'fire', 'health', 'education', 'transportation', 'parks', 'power', 'water'];
    const mapData = next.game_map_data && typeof next.game_map_data === 'object'
      ? { ...next.game_map_data }
      : {};
    const existingBudget = mapData.budget && typeof mapData.budget === 'object'
      ? { ...mapData.budget }
      : {};
    for (const key of VALID_BUDGET_KEYS) {
      const entry = patch.budget[key];
      if (entry && typeof entry === 'object' && typeof entry.funding === 'number') {
        const existing = existingBudget[key] && typeof existingBudget[key] === 'object'
          ? { ...existingBudget[key] }
          : { name: key.charAt(0).toUpperCase() + key.slice(1), funding: 100, cost: 0 };
        existing.funding = Math.max(0, Math.min(100, Math.round(entry.funding)));
        existingBudget[key] = existing;
      }
    }
    mapData.budget = existingBudget;
    next.game_map_data = mapData;
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

async function hasAdjacentWaterForFootprint(municipalityId, roomCode, x, y, width = 1, height = 1) {
  ensureDbEnabled();
  const footprintWidth = Math.max(1, Math.round(Number(width) || 1));
  const footprintHeight = Math.max(1, Math.round(Number(height) || 1));
  const minX = Math.round(Number(x) || 0);
  const minY = Math.round(Number(y) || 0);
  const maxX = minX + footprintWidth - 1;
  const maxY = minY + footprintHeight - 1;

  const [rows] = await dbPool.query(
    `SELECT id
     FROM game_items
     WHERE municipality_id = ?
       AND room_code = ?
       AND action_type = 'place'
       AND tool = 'water'
       AND (
         (x BETWEEN ? AND ? AND y = ?)
         OR (x BETWEEN ? AND ? AND y = ?)
         OR (x = ? AND y BETWEEN ? AND ?)
         OR (x = ? AND y BETWEEN ? AND ?)
       )
     LIMIT 1`,
    [
      municipalityId,
      roomCode,
      minX,
      maxX,
      minY - 1,
      minX,
      maxX,
      maxY + 1,
      minX - 1,
      minY,
      maxY,
      maxX + 1,
      minY,
      maxY,
    ]
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function markItemsConstructed(municipalityId, roomCode, positions) {
  ensureDbEnabled();
  let updated = 0;
  let deleted = 0;
  let currentVersion = await getRoomItemVersion(municipalityId, roomCode);
  let statsSnapshot = (await loadRoomStats(municipalityId, roomCode)) || {};
  let currentMoney = await getMunicipalityMoney(municipalityId);
  const originalMoney = currentMoney;
  let statsChanged = false;
  const itemDetailCache = new Map();
  const timestamp = Date.now();
  const now = new Date();

  for (const pos of positions) {
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (pos.removed) {
      const [result] = await dbPool.query(
        `DELETE FROM game_items
         WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('place', 'zone')`,
        [municipalityId, roomCode, x, y]
      );
      deleted += result.affectedRows || 0;
      continue;
    }
    const [rows] = await dbPool.query(
      `SELECT id, metadata, tool
       FROM game_items
       WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('zone', 'place')
       ORDER BY CASE WHEN action_type='zone' THEN 0 ELSE 1 END, version DESC
       LIMIT 1`,
      [municipalityId, roomCode, x, y]
    );
    const row = rows[0];
    if (!row) continue;
    const meta = toJsonValue(row.metadata) || {};
    let changed = false;
    const setIfDiff = (key, value) => {
      if (typeof value === 'undefined') return;
      if (!jsonEquals(meta[key], value)) {
        meta[key] = value;
        changed = true;
      }
    };
    if (typeof pos.progress !== 'undefined' && pos.progress !== null) {
      // Keep fractional progress to persist long construction projects smoothly.
      const progress = Math.max(0, Math.min(100, Math.round(Number(pos.progress) * 100) / 100));
      setIfDiff('constructionProgress', progress);
      setIfDiff('constructed', progress >= 100);
    }
    let buildingTypeForSync = pos.tool;
    if (row.action_type === 'zone') {
      const zoneType = String(pos.zone || row.zone_type || '').trim().toLowerCase();
      const existingBuildingType = String(metaValue(meta, 'buildingType', 'building_type') || '').trim().toLowerCase();
      const incomingTool = String(pos.tool || '').trim().toLowerCase();
      const zonePool = getZoneBuildingPool(zoneType);
      const starterTool = getZoneStarterBuilding(zoneType);
      const randomizedTool = pickRandomZoneBuildingType(zoneType);
      const hasExistingBuildingType = existingBuildingType.length > 0;
      const existingInPool = hasExistingBuildingType && zonePool.includes(existingBuildingType);
      const incomingInPool = incomingTool.length > 0 && zonePool.includes(incomingTool);
      const shouldRandomizeStarter =
        !hasExistingBuildingType &&
        incomingTool.length > 0 &&
        starterTool.length > 0 &&
        incomingTool === starterTool &&
        randomizedTool;
      const shouldReplaceExistingStarter =
        hasExistingBuildingType &&
        existingInPool &&
        starterTool.length > 0 &&
        existingBuildingType === starterTool &&
        randomizedTool;
      const shouldReplaceIncomingStarter =
        incomingTool.length > 0 &&
        starterTool.length > 0 &&
        incomingTool === starterTool &&
        randomizedTool;
      const shouldReplaceInvalidExisting =
        hasExistingBuildingType &&
        !existingInPool &&
        randomizedTool;
      const shouldReplaceInvalidIncoming =
        incomingTool.length > 0 &&
        !incomingInPool &&
        randomizedTool;

      if (!incomingTool && !hasExistingBuildingType && randomizedTool) {
        buildingTypeForSync = randomizedTool;
      } else if (shouldReplaceExistingStarter) {
        buildingTypeForSync = randomizedTool;
      } else if (shouldReplaceIncomingStarter) {
        buildingTypeForSync = randomizedTool;
      } else if (shouldReplaceInvalidExisting) {
        buildingTypeForSync = randomizedTool;
      } else if (shouldReplaceInvalidIncoming) {
        buildingTypeForSync = randomizedTool;
      } else if (shouldRandomizeStarter) {
        buildingTypeForSync = randomizedTool;
      } else if (!incomingTool && hasExistingBuildingType) {
        buildingTypeForSync = existingBuildingType;
      }
    }
    setIfDiff('buildingType', buildingTypeForSync);
    if (typeof pos.abandoned !== 'undefined') setIfDiff('abandoned', Boolean(pos.abandoned));
    if (typeof pos.planted_at !== 'undefined' && pos.planted_at !== null) {
      setIfDiff('plantedAt', Math.max(0, Math.round(Number(pos.planted_at))));
    }
    if (typeof pos.on_fire !== 'undefined') setIfDiff('onFire', Boolean(pos.on_fire));
    if (typeof pos.fire_progress !== 'undefined' && pos.fire_progress !== null) {
      setIfDiff('fireProgress', Math.max(0, Math.min(100, Math.round(Number(pos.fire_progress)))));
    }
    // === Service-Upgrade Bauzeit-System ===
    // Der Client schickt upgradeStartedAt + upgradeTargetLevel wenn ein Upgrade gestartet wird.
    // Spaeter schickt er level=newLevel wenn die Bauzeit abgelaufen ist.
    // Der Server validiert beides.
    const toolName = String(
      pos.tool || row.tool || metaValue(meta, 'buildingType', 'building_type') || ''
    )
      .trim()
      .toLowerCase();
    const previousLevel = Math.max(
      1,
      Math.min(5, Math.round(Number(metaValue(meta, 'level') ?? 1)))
    );

    // 1) Upgrade-Start: Client sendet upgradeStartedAt + upgradeTargetLevel
    if (typeof pos.upgrade_started_at !== 'undefined' && pos.upgrade_started_at !== null &&
        typeof pos.upgrade_target_level !== 'undefined' && pos.upgrade_target_level !== null) {
      const targetLevel = Math.max(1, Math.min(5, Math.round(Number(pos.upgrade_target_level))));
      const upgradeStartedAt = Math.round(Number(pos.upgrade_started_at));

      if (targetLevel > previousLevel && SERVICE_UPGRADE_TOOLS.has(toolName) &&
          Number.isFinite(upgradeStartedAt) && upgradeStartedAt > 0) {
        // Geld abziehen fuer den Upgrade-Start
        let detail = itemDetailCache.get(toolName);
        if (typeof detail === 'undefined') {
          detail = await ensureItemDetailExists(toolName, null);
          itemDetailCache.set(toolName, detail || null);
        }
        const baseCost = detail
          ? Math.max(0, Math.round(toFiniteNumber(detail.build_cost, 0)))
          : 0;
        // Kosten fuer genau einen Level-Schritt: baseCost * 2^currentLevel
        const upgradeCost = Math.max(0, Math.round(baseCost * Math.pow(2, previousLevel)));

        if (upgradeCost > 0 && currentMoney < upgradeCost) {
          // Nicht genug Geld -> Upgrade-Start ablehnen (Felder nicht setzen)
        } else {
          if (upgradeCost > 0) {
            currentMoney = Math.max(0, currentMoney - upgradeCost);
            const spentNow =
              Math.max(0, Math.round(toFiniteNumber(statsSnapshot.total_spent, 0))) +
              upgradeCost;
            statsSnapshot = {
              ...(statsSnapshot || {}),
              money: currentMoney,
              total_spent: spentNow,
            };
            statsChanged = true;
          }
          setIfDiff('upgradeStartedAt', upgradeStartedAt);
          setIfDiff('upgradeTargetLevel', targetLevel);
        }
      }
    }

    // 2) Upgrade-Abschluss: Client sendet neues level > previousLevel
    if (typeof pos.level !== 'undefined' && pos.level !== null) {
      let safeLevel = Math.max(0, Math.min(5, Math.round(Number(pos.level))));

      if (safeLevel > previousLevel && SERVICE_UPGRADE_TOOLS.has(toolName)) {
        // Pruefen ob ein Upgrade laeuft und genug Zeit vergangen ist
        const storedUpgradeStartedAt = Number(metaValue(meta, 'upgradeStartedAt', 'upgrade_started_at') || 0);
        const storedUpgradeTargetLevel = Number(metaValue(meta, 'upgradeTargetLevel', 'upgrade_target_level') || 0);

        if (storedUpgradeStartedAt > 0 && storedUpgradeTargetLevel === safeLevel) {
          // Upgrade-Bauzeit validieren
          let detail = itemDetailCache.get(toolName);
          if (typeof detail === 'undefined') {
            detail = await ensureItemDetailExists(toolName, null);
            itemDetailCache.set(toolName, detail || null);
          }
          const baseUpgradeSeconds = detail
            ? Math.max(0, Math.round(toFiniteNumber(detail.upgrade_build_time_seconds, 0)))
            : 0;

          if (baseUpgradeSeconds > 0) {
            // Skalierte Bauzeit: base * 2^(targetLevel-2)
            const scaledSeconds = baseUpgradeSeconds * Math.pow(2, Math.max(0, safeLevel - 2));
            const elapsedMs = Date.now() - storedUpgradeStartedAt;
            const elapsedSeconds = elapsedMs / 1000;

            // 10% Toleranz fuer Client-Timing-Ungenauigkeiten
            if (elapsedSeconds < scaledSeconds * 0.9) {
              // Nicht genug Zeit vergangen -> Level-Erhoehung ablehnen
              safeLevel = previousLevel;
            } else {
              // Upgrade abgeschlossen -> aufraumen
              setIfDiff('upgradeStartedAt', null);
              setIfDiff('upgradeTargetLevel', null);
            }
          } else {
            // Kein upgrade_build_time_seconds konfiguriert -> sofort erlauben (Fallback)
            setIfDiff('upgradeStartedAt', null);
            setIfDiff('upgradeTargetLevel', null);
          }
        } else if (storedUpgradeStartedAt <= 0) {
          // Kein laufendes Upgrade gespeichert -> Geld abziehen (Fallback fuer alten Flow)
          let detail = itemDetailCache.get(toolName);
          if (typeof detail === 'undefined') {
            detail = await ensureItemDetailExists(toolName, null);
            itemDetailCache.set(toolName, detail || null);
          }
          const baseCost = detail
            ? Math.max(0, Math.round(toFiniteNumber(detail.build_cost, 0)))
            : 0;
          let totalUpgradeCost = 0;
          for (let lvl = previousLevel; lvl < safeLevel; lvl++) {
            totalUpgradeCost += Math.max(0, Math.round(baseCost * Math.pow(2, lvl)));
          }
          if (totalUpgradeCost > 0) {
            if (currentMoney < totalUpgradeCost) {
              safeLevel = previousLevel;
            } else {
              currentMoney = Math.max(0, currentMoney - totalUpgradeCost);
              const spentNow =
                Math.max(0, Math.round(toFiniteNumber(statsSnapshot.total_spent, 0))) +
                totalUpgradeCost;
              statsSnapshot = {
                ...(statsSnapshot || {}),
                money: currentMoney,
                total_spent: spentNow,
              };
              statsChanged = true;
            }
          }
        } else {
          // Upgrade laeuft aber targetLevel stimmt nicht -> ablehnen
          safeLevel = previousLevel;
        }
      }

      if (safeLevel > 0) {
        setIfDiff('level', safeLevel);
      }
    }
    if (typeof pos.population !== 'undefined' && pos.population !== null) {
      setIfDiff('population', Math.max(0, Math.round(Number(pos.population))));
    }
    if (typeof pos.jobs !== 'undefined' && pos.jobs !== null) {
      setIfDiff('jobs', Math.max(0, Math.round(Number(pos.jobs))));
    }
    if (typeof pos.footprint_width !== 'undefined' && pos.footprint_width !== null) {
      setIfDiff('footprintWidth', Math.max(1, Math.round(Number(pos.footprint_width))));
    }
    if (typeof pos.footprint_height !== 'undefined' && pos.footprint_height !== null) {
      setIfDiff('footprintHeight', Math.max(1, Math.round(Number(pos.footprint_height))));
    }
    if (!changed) continue;
    currentVersion += 1;
    await dbPool.query(
      `UPDATE game_items
       SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [JSON.stringify(meta), currentVersion, timestamp, now, row.id]
    );
    updated += 1;
  }

  if (statsChanged) {
    await saveRoomStats(municipalityId, roomCode, statsSnapshot);
    const totalCost = originalMoney - currentMoney;
    if (totalCost > 0) {
      await applyMunicipalityTransaction(municipalityId, {
        amount: -totalCost,
        type: 'upgrade_cost',
        meta: { roomCode, positionsProcessed: positions.length },
        source: 'system',
      });
    } else {
      await setMunicipalityTreasury(municipalityId, currentMoney);
    }
  }

  return { updated, deleted };
}

async function processConstructionSyncAndBroadcast({
  municipality,
  roomCode,
  positions,
  io,
  sourcePlayerId = null,
}) {
  const result = await markItemsConstructed(municipality.id, roomCode, positions);
  let authoritativeStats = null;
  if (result.updated > 0 || result.deleted > 0) {
    await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
    authoritativeStats = await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);
    const roomKey = wsRoomKey(municipality.slug, roomCode);
    try {
      await wsPublishAuthoritativeStats(io, roomKey, sourcePlayerId);
    } catch {
      // Antwort nicht fehlschlagen lassen, wenn WS kurzzeitig nicht verfuegbar ist.
    }
  }
  return {
    ...result,
    authoritativeStats: authoritativeStats ? toStatsApiShape(authoritativeStats) : null,
  };
}

async function getUserByEmailWithMunicipality(email) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT
      u.id,
      u.uuid,
      u.email,
      u.nickname,
      u.password_hash,
      u.password_salt,
      u.is_active,
      COALESCE(u.is_banned, 0) AS is_banned,
      u.municipality_id,
      m.slug AS municipality_slug,
      m.name AS municipality_name
     FROM users u
     LEFT JOIN municipalities m ON m.id = u.municipality_id
     WHERE u.email = ?
     LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function getUserByIdWithMunicipality(id) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT
      u.id,
      u.uuid,
      u.email,
      u.nickname,
      u.is_active,
      COALESCE(u.is_banned, 0) AS is_banned,
      u.municipality_id,
      m.slug AS municipality_slug,
      m.name AS municipality_name
     FROM users u
     LEFT JOIN municipalities m ON m.id = u.municipality_id
     WHERE u.id = ?
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function createAuthSession(userId, token, req, ttlHours = TOKEN_TTL_HOURS) {
  ensureDbEnabled();
  const tokenHash = sha256(token);
  const expiresAt = tokenExpiresAtDate(ttlHours);
  const ipAddress = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().slice(0, 45);
  const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 255);
  await dbPool.query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, tokenHash, expiresAt, ipAddress, userAgent]
  );
}

async function isSessionValid(token) {
  ensureDbEnabled();
  const tokenHash = sha256(token);
  const [rows] = await dbPool.query(
    `SELECT id
     FROM auth_sessions
     WHERE token_hash = ?
       AND revoked_at IS NULL
       AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function revokeSession(token) {
  ensureDbEnabled();
  const tokenHash = sha256(token);
  const [result] = await dbPool.query(
    `UPDATE auth_sessions
     SET revoked_at = NOW(), updated_at = CURRENT_TIMESTAMP
     WHERE token_hash = ?
       AND revoked_at IS NULL`,
    [tokenHash]
  );
  return result.affectedRows || 0;
}

function getGameToken(req) {
  const bearer = getBearerToken(req);
  if (bearer) return bearer;
  const raw = req.headers['x-game-token'];
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').trim() || null;
}

async function getAuthenticatedUser(req) {
  ensureDbEnabled();
  const token = getGameToken(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const validSession = await isSessionValid(token);
  if (!validSession) return null;
  const userId = Number(payload.sub);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const user = await getUserByIdWithMunicipality(userId);
  if (!user || !user.is_active || user.is_banned) return null;
  user.global_role = await getUserGlobalRole(userId);
  return user;
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || '').trim().toUpperCase().slice(0, 10);
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .reduce((acc, key) => {
        acc[key] = canonicalizeJson(value[key]);
        return acc;
      }, {});
  }
  return value ?? null;
}

function jsonEquals(a, b) {
  return JSON.stringify(canonicalizeJson(a)) === JSON.stringify(canonicalizeJson(b));
}

function metaValue(meta, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(meta, key) && typeof meta[key] !== 'undefined') {
      return meta[key];
    }
  }
  return undefined;
}

function extractItemState(metadata) {
  const meta = toJsonValue(metadata) || {};
  const constructionProgress = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 0);
  const level = Number(metaValue(meta, 'level') ?? 0);
  const footprintWidth = Number(metaValue(meta, 'footprintWidth', 'footprint_width') ?? 1);
  const footprintHeight = Number(metaValue(meta, 'footprintHeight', 'footprint_height') ?? 1);
  const onFire = Boolean(metaValue(meta, 'onFire', 'on_fire') ?? false);
  const fireProgress = Number(metaValue(meta, 'fireProgress', 'fire_progress') ?? 0);
  const mapPersistent = Boolean(metaValue(meta, 'mapPersistent', 'map_persistent') ?? false);
  const plantedAt = Number(metaValue(meta, 'plantedAt', 'planted_at') ?? 0);
  return {
    construction_progress: Number.isFinite(constructionProgress) ? constructionProgress : 0,
    constructed: Boolean(meta.constructed ?? false),
    level: Number.isFinite(level) ? level : 0,
    abandoned: Boolean(meta.abandoned ?? false),
    on_fire: onFire,
    fire_progress: Number.isFinite(fireProgress) ? fireProgress : 0,
    footprint_width: Number.isFinite(footprintWidth) ? Math.max(1, footprintWidth) : 1,
    footprint_height: Number.isFinite(footprintHeight) ? Math.max(1, footprintHeight) : 1,
    map_persistent: mapPersistent,
    planted_at: Number.isFinite(plantedAt) && plantedAt > 0 ? plantedAt : 0,
  };
}

function isNonEconomicTool(tool) {
  const t = String(tool || '').trim().toLowerCase();
  if (!t) return true;
  if (['grass', 'water', 'road', 'rail', 'bridge', 'tree', 'empty'].includes(t)) return true;
  if (t.startsWith('tree_') || t.startsWith('bush_') || t.startsWith('flower_') || t.startsWith('topiary_')) return true;
  if (t.startsWith('paint_') || t.startsWith('terrain_') || t.startsWith('zone_')) return true;
  return false;
}

function inferCategoryFromTool(tool, fallbackCategory = 'general') {
  const t = String(tool || '').toLowerCase();
  const fromDb = String(fallbackCategory || '').toLowerCase();
  if (fromDb && fromDb !== 'general') return fromDb;

  // woodcutter_house ist ein Service-Gebäude, kein Wohnhaus
  if (t === 'woodcutter_house') return 'infrastructure';
  if (t.includes('house') || t.includes('apartment') || t.includes('residential') || t.includes('cabin') || t.includes('lodge')) {
    return 'residential';
  }
  if (t.includes('shop') || t.includes('office') || t.includes('mall') || t.includes('commercial') || t.includes('market')) {
    return 'commercial';
  }
  if (t.includes('factory') || t.includes('warehouse') || t.includes('industrial') || t.includes('plant')) {
    return 'industrial';
  }
  if (
    t.includes('station') ||
    t.includes('school') ||
    t.includes('hospital') ||
    t.includes('police') ||
    t.includes('fire_') ||
    t.includes('city_hall') ||
    t.includes('airport') ||
    t.includes('museum') ||
    t.includes('university')
  ) {
    return 'infrastructure';
  }
  if (
    t.includes('park') ||
    t.includes('garden') ||
    t.includes('playground') ||
    t.includes('field') ||
    t.includes('stadium') ||
    t.includes('pool')
  ) {
    return 'decoration';
  }

  return 'infrastructure';
}

function estimateBuildingBaseStats({ category, footprintArea }) {
  const area = Math.max(1, Math.round(Number(footprintArea || 1)));
  const cat = String(category || 'infrastructure').toLowerCase();

  // Gewuenscht: Haeuser liefern standardmaessig +2 Bevoelkerung pro Haus (bei 1x1).
  if (cat === 'residential') return { pop: Math.max(2, area * 2), jobs: 0 };
  if (cat === 'commercial') return { pop: 0, jobs: Math.max(3, area * 4) };
  if (cat === 'industrial') return { pop: 0, jobs: Math.max(4, area * 5) };
  if (cat === 'decoration') return { pop: 0, jobs: Math.max(1, area * 1) };
  return { pop: 0, jobs: Math.max(3, area * 3) };
}

function estimateDefaultBuildCost(tool, metadata = null, footprintWidth = 1, footprintHeight = 1, categoryHint = 'general') {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const fromMeta = Number(meta.buildCost ?? meta.build_cost ?? meta.price ?? meta.cost);
  if (Number.isFinite(fromMeta) && fromMeta >= 0) return Math.round(fromMeta);
  const normalizedTool = String(tool || '').trim().toLowerCase();
  if (normalizedTool === 'terrain_lower2') return 90;

  if (isNonEconomicTool(tool)) return 0;

  const area = Math.max(1, Math.round(Number(footprintWidth || 1)) * Math.max(1, Math.round(Number(footprintHeight || 1))));
  const category = inferCategoryFromTool(tool, categoryHint);

  if (category === 'residential') return Math.max(400, area * 700);
  if (category === 'commercial') return Math.max(600, area * 950);
  if (category === 'industrial') return Math.max(800, area * 1200);
  if (category === 'decoration') return Math.max(100, area * 220);
  return Math.max(300, area * 500);
}

async function recomputeAuthoritativePopulationAndJobs(municipalityId, roomCode) {
  const rows = await getRoomItemRows(municipalityId, roomCode);
  const rawStats = (await loadRoomStats(municipalityId, roomCode)) || {};
  const detailsList = await fetchItemDetails();
  const detailsByTool = new Map((Array.isArray(detailsList) ? detailsList : []).map((d) => [String(d.tool || '').toLowerCase(), d]));
  const serverTime = buildServerTimePayload();
  const gameMapData = rawStats.game_map_data && typeof rawStats.game_map_data === 'object'
    ? rawStats.game_map_data
    : null;
  const mapSettings = gameMapData && typeof gameMapData.settings === 'object'
    ? gameMapData.settings
    : null;
  const budgetData = gameMapData && gameMapData.budget && typeof gameMapData.budget === 'object'
    ? gameMapData.budget
    : null;
  const taxRate = toFiniteNumber(rawStats.tax_rate ?? rawStats.taxRate, 10);
  const effectiveTaxRate = toFiniteNumber(
    rawStats.effective_tax_rate ?? rawStats.effectiveTaxRate ?? mapSettings?.effectiveTaxRate ?? taxRate,
    taxRate
  );

  let population = 0;
  let jobs = 0;
  let maxPopulation = 0;
  let buildingsTotal = 0;
  let buildingsResidential = 0;
  let buildingsCommercial = 0;
  let buildingsIndustrial = 0;
  let buildingsInfrastructure = 0;
  let buildingsDecoration = 0;
  let zonesResidential = 0;
  let zonesCommercial = 0;
  let zonesIndustrial = 0;
  let powerProduction = 0;
  let powerConsumption = 0;
  let waterProduction = 0;
  let waterConsumption = 0;
  let maxTileX = 0;
  let maxTileY = 0;
  const serviceBuildings = [];
  let treeCount = 0;
  let waterTileCount = 0;
  let parkCount = 0;
  let railTileCount = 0;
  let railStationCount = 0;
  let subwayTileCount = 0;
  let subwayStationCount = 0;
  let policeStationCount = 0;
  let fireStationCount = 0;
  let hospitalCount = 0;
  let schoolCount = 0;
  let universityCount = 0;
  let stadiumCount = 0;
  let museumCount = 0;
  let hasAirport = false;
  let hasCityHall = false;
  let hasSpaceProgram = false;
  let hasAmusementPark = false;
  let totalPollution = 0;
  let totalBuildingDailyIncome = 0;

  for (const row of rows) {
    if (Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y))) {
      maxTileX = Math.max(maxTileX, Math.round(Number(row.x)));
      maxTileY = Math.max(maxTileY, Math.round(Number(row.y)));
    }
    const meta = toJsonValue(row.metadata) || {};
    if (row.action_type === 'zone') {
      const z = String(row.zone_type || '').toLowerCase();
      if (z === 'residential') zonesResidential += 1;
      if (z === 'commercial') zonesCommercial += 1;
      if (z === 'industrial') zonesIndustrial += 1;
    }
    if (row.action_type !== 'place' && row.action_type !== 'zone') continue;

    // Bei gewachsenen Zonen (zone + metadata.buildingType) liegt kein action_type='place' vor.
    // Diese muessen trotzdem in die autoritative Population/Jobs einfliessen.
    const effectiveTool = row.action_type === 'place'
      ? row.tool
      : metaValue(meta, 'buildingType', 'building_type');
    const tool = String(effectiveTool || '').toLowerCase();
    if (!tool || isNonEconomicTool(tool)) continue;
    const isConstructed = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 100) >= 100 || meta.constructed === true;
    if (!isConstructed) continue;
    if (meta.abandoned === true) continue;
    if (metaValue(meta, 'mapPersistent', 'map_persistent') === true) continue;

    const detail = detailsByTool.get(tool) || null;
    const footprintWidth = Math.max(
      1,
      Math.round(Number(metaValue(meta, 'footprintWidth', 'footprint_width') ?? detail?.footprint_width ?? 1))
    );
    const footprintHeight = Math.max(
      1,
      Math.round(Number(metaValue(meta, 'footprintHeight', 'footprint_height') ?? detail?.footprint_height ?? 1))
    );
    const footprintArea = footprintWidth * footprintHeight;
    const category = inferCategoryFromTool(tool, detail?.category || 'general');

    const level = Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1))));
    const metaPopulation = Number(meta.population ?? meta.residents ?? meta.capacity_population);
    const metaJobs = Number(meta.jobs ?? meta.workers ?? meta.capacity_jobs);
    const hasMetaPopulation = Number.isFinite(metaPopulation) && metaPopulation > 0;
    const hasMetaJobs = Number.isFinite(metaJobs) && metaJobs > 0;
    const hardcodedStats = HARD_CODED_BUILDING_STATS.get(tool);

    const base = estimateBuildingBaseStats({ category, footprintArea });
    const pop = hasMetaPopulation
      ? Math.max(0, Math.round(metaPopulation))
      : (hardcodedStats
        ? Math.round(Math.max(0, Number(hardcodedStats.maxPop || 0)) * level * 0.8)
        : Math.round(base.pop * level));
    const job = hasMetaJobs
      ? Math.max(0, Math.round(metaJobs))
      : (hardcodedStats
        ? Math.round(Math.max(0, Number(hardcodedStats.maxJobs || 0)) * level * 0.8)
        : Math.round(base.jobs * level));
    const metaPowerProd = Number(meta.powerProduction ?? meta.power_production);
    const metaPowerCons = Number(meta.powerConsumption ?? meta.power_consumption);
    const metaWaterProd = Number(meta.waterProduction ?? meta.water_production);
    const metaWaterCons = Number(meta.waterConsumption ?? meta.water_consumption);
    const metaPollution = Number(meta.pollution ?? meta.pollutionLevel ?? detail?.pollution ?? 0);

    population += pop;
    jobs += job;
    maxPopulation += Math.round(base.pop * level);
    buildingsTotal += 1;

    if (category === 'residential') buildingsResidential += 1;
    else if (category === 'commercial') buildingsCommercial += 1;
    else if (category === 'industrial') buildingsIndustrial += 1;
    else if (category === 'decoration') buildingsDecoration += 1;
    else buildingsInfrastructure += 1;

    if (tool === 'tree' || tool.startsWith('tree_')) treeCount += 1;
    if (tool.startsWith('bush_') || tool.startsWith('topiary_') || tool.startsWith('flower_')) parkCount += 1;
    if (tool === 'water') waterTileCount += 1;
    if (tool === 'park' || tool === 'park_large' || tool === 'tennis') parkCount += 1;
    if (tool === 'rail') railTileCount += 1;
    if (tool === 'rail_station') railStationCount += 1;
    if (tool === 'subway') subwayTileCount += 1;
    if (tool === 'subway_station') subwayStationCount += 1;
    if (tool === 'police_station') policeStationCount += 1;
    if (tool === 'fire_station') fireStationCount += 1;
    if (tool === 'hospital') hospitalCount += 1;
    if (tool === 'school') schoolCount += 1;
    if (tool === 'university') universityCount += 1;
    if (tool === 'stadium') stadiumCount += 1;
    if (tool === 'museum') museumCount += 1;
    if (tool === 'airport') hasAirport = true;
    if (tool === 'city_hall') hasCityHall = true;
    if (tool === 'space_program') hasSpaceProgram = true;
    if (tool === 'amusement_park') hasAmusementPark = true;
    totalPollution += Number.isFinite(metaPollution) ? Math.max(0, Math.round(metaPollution)) : 0;
    // Gebaeude-Einkommen (daily_income) aus game_item_details
    const buildingDailyIncome = detail ? Math.max(0, Math.round(toFiniteNumber(detail.daily_income, 0))) * level : 0;
    totalBuildingDailyIncome += buildingDailyIncome;
    if (tool === 'police_station' || tool === 'fire_station' || tool === 'hospital' || tool === 'school' || tool === 'university') {
      serviceBuildings.push({
        x: Math.max(0, Math.round(Number(row.x || 0))),
        y: Math.max(0, Math.round(Number(row.y || 0))),
        tool,
        level: Math.max(1, Math.min(5, level)),
      });
    }

    if (Number.isFinite(metaPowerProd) && metaPowerProd > 0) {
      powerProduction += Math.round(metaPowerProd);
    } else if (tool.includes('power_plant')) {
      powerProduction += 100 * level;
    }
    if (Number.isFinite(metaWaterProd) && metaWaterProd > 0) {
      waterProduction += Math.round(metaWaterProd);
    } else if (tool.includes('water_tower')) {
      waterProduction += 80 * level;
    }
    if (Number.isFinite(metaPowerCons) && metaPowerCons > 0) {
      powerConsumption += Math.round(metaPowerCons);
    } else if (category === 'residential') {
      powerConsumption += Math.max(1, Math.round(pop * 0.4));
    } else if (category === 'commercial') {
      powerConsumption += Math.max(1, Math.round(job * 0.35));
    } else if (category === 'industrial') {
      powerConsumption += Math.max(2, Math.round(job * 0.5));
    }
    if (Number.isFinite(metaWaterCons) && metaWaterCons > 0) {
      waterConsumption += Math.round(metaWaterCons);
    } else if (category === 'residential') {
      waterConsumption += Math.max(1, Math.round(pop * 0.5));
    } else if (category === 'commercial') {
      waterConsumption += Math.max(1, Math.round(job * 0.2));
    } else if (category === 'industrial') {
      waterConsumption += Math.max(1, Math.round(job * 0.25));
    }
  }

  const employed = Math.min(population, jobs);
  const unemployed = Math.max(0, population - jobs);
  const unemploymentRate = population > 0 ? Math.round((unemployed / population) * 10000) / 100 : 0;
  const powerBalance = powerProduction - powerConsumption;
  const waterBalance = waterProduction - waterConsumption;
  const homeless = Math.max(0, population - maxPopulation);
  let populationGrowth = Math.max(0, Math.round((jobs - population) * 0.02));

  // Budget-Kosten serverseitig berechnen (wie im Client: simulation.ts updateBudgetCosts)
  const roadCount = rows.filter(r => String(r.tool || '').toLowerCase() === 'road' && r.action_type === 'place').length;
  const serverBudgetCosts = {
    police: policeStationCount * 50,
    fire: fireStationCount * 50,
    health: hospitalCount * 100,
    education: schoolCount * 30 + universityCount * 100,
    transportation: roadCount * 2 + subwayTileCount * 3 + subwayStationCount * 25,
    parks: parkCount * 10,
    power: rows.filter(r => String(r.tool || '').toLowerCase() === 'power_plant' && r.action_type === 'place').length * 150,
    water: rows.filter(r => String(r.tool || '').toLowerCase() === 'water_tower' && r.action_type === 'place').length * 75,
  };

  const budgetKeys = ['police', 'fire', 'health', 'education', 'transportation', 'parks', 'power', 'water'];
  let budgetExpenses = 0;
  // Budget-Daten mit server-berechneten Kosten aktualisieren
  const updatedBudget = {};
  for (const key of budgetKeys) {
    const node = budgetData && budgetData[key] && typeof budgetData[key] === 'object' ? budgetData[key] : null;
    const funding = node ? toFiniteNumber(node.funding, 100) : 100;
    const serverCost = serverBudgetCosts[key] || 0;
    updatedBudget[key] = {
      name: node?.name || (key.charAt(0).toUpperCase() + key.slice(1)),
      funding: Math.max(0, Math.min(100, Math.round(funding))),
      cost: serverCost,
    };
    budgetExpenses += Math.round(serverCost * (funding / 100));
  }
  // Budget-Kosten in game_map_data zurueckschreiben
  if (gameMapData) {
    gameMapData.budget = updatedBudget;
  }
  // Unterhaltskosten pro Tag
  const maintenanceExpenses =
    buildingsResidential * 2 +
    buildingsCommercial * 5 +
    buildingsIndustrial * 8 +
    buildingsInfrastructure * 4 +
    buildingsDecoration * 0;
  const expenses = Math.max(0, Math.round(budgetExpenses + maintenanceExpenses));

  // Taegliches Einkommen: Steuern + Gebaeude-Einkommen (Basis, wird nach muniStatBonus angepasst)
  // Steuer: (Population * 3 + Jobs * 2) * (Steuersatz / 10)
  const taxIncomeBase = Math.max(0, Math.round(((population * 3) + (jobs * 2)) * (taxRate / 10)));
  let income = Math.max(0, taxIncomeBase + totalBuildingDailyIncome);

  const clamp100 = (value) => Math.max(0, Math.min(100, Math.round(value)));
  const gridSize = Math.max(10, Math.max(maxTileX + 1, maxTileY + 1, 50));
  const createCoverageGrid = () => Array.from({ length: gridSize }, () => Array(gridSize).fill(0));
  const policeCoverage = createCoverageGrid();
  const fireCoverage = createCoverageGrid();
  const healthCoverage = createCoverageGrid();
  const educationCoverage = createCoverageGrid();
  const serviceBaseRange = {
    police_station: 13,
    fire_station: 18,
    hospital: 24,
    school: 11,
    university: 19,
  };
  for (const svc of serviceBuildings) {
    const baseRange = serviceBaseRange[svc.tool];
    if (!baseRange) continue;
    const range = Math.max(1, Math.floor(baseRange * (1 + (svc.level - 1) * 0.2)));
    const rangeSquared = range * range;
    const minY = Math.max(0, svc.y - range);
    const maxY = Math.min(gridSize - 1, svc.y + range);
    const minX = Math.max(0, svc.x - range);
    const maxX = Math.min(gridSize - 1, svc.x + range);
    let target = policeCoverage;
    if (svc.tool === 'fire_station') target = fireCoverage;
    else if (svc.tool === 'hospital') target = healthCoverage;
    else if (svc.tool === 'school' || svc.tool === 'university') target = educationCoverage;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - svc.x;
        const dy = y - svc.y;
        const distSquared = dx * dx + dy * dy;
        if (distSquared > rangeSquared) continue;
        const distance = Math.sqrt(distSquared);
        const coverage = Math.max(0, (1 - distance / range) * 100);
        target[y][x] = Math.min(100, Number(target[y][x] || 0) + coverage);
      }
    }
  }
  const avgCoverage = (matrix) => {
    let total = 0;
    let count = 0;
    for (const row of matrix) {
      for (const value of row) {
        total += Number(value || 0);
        count += 1;
      }
    }
    return count > 0 ? total / count : 0;
  };
  const avgPoliceCoverage = avgCoverage(policeCoverage);
  const avgFireCoverage = avgCoverage(fireCoverage);
  const avgHealthCoverage = avgCoverage(healthCoverage);
  const avgEducationCoverage = avgCoverage(educationCoverage);

  // ── Municipality Stats laden (Event-System) ──
  // Stats gehen von 0-100, Standard 50. Ueber 50 = Bonus, unter 50 = Malus.
  // Effekt: (stat - 50) ergibt einen Wert von -50 bis +50
  // Gewichtet mit 0.3 (max ±15 Punkte Einfluss pro Stat)
  let muniStatBonus = { security: 0, attractiveness: 0, cleanliness: 0, infrastructure: 0, transparency: 0 };
  try {
    const [muniRows] = await dbPool.query(
      `SELECT security, attractiveness, cleanliness, infrastructure, transparency
       FROM municipality_stats WHERE municipality_id = ?`, [municipalityId]
    );
    if (muniRows.length > 0) {
      const ms = muniRows[0];
      muniStatBonus.security = ((ms.security || 50) - 50) * 0.3;
      muniStatBonus.attractiveness = ((ms.attractiveness || 50) - 50) * 0.3;
      muniStatBonus.cleanliness = ((ms.cleanliness || 50) - 50) * 0.3;
      muniStatBonus.infrastructure = ((ms.infrastructure || 50) - 50) * 0.3;
      muniStatBonus.transparency = ((ms.transparency || 50) - 50) * 0.3;
    }
  } catch (_) {}

  // Simulation-Stats: Gebaeude-Basis + Municipality-Event-Bonus/Malus
  const safety = clamp100(avgPoliceCoverage * 0.7 + avgFireCoverage * 0.3 + muniStatBonus.security);
  const health = clamp100(avgHealthCoverage * 0.8 + (100 - totalPollution / Math.max(1, gridSize * gridSize)) * 0.2 + muniStatBonus.cleanliness);
  const education = clamp100(avgEducationCoverage + muniStatBonus.transparency);
  const greenRatio = (treeCount + waterTileCount + parkCount) / Math.max(1, gridSize * gridSize);
  const pollutionRatio = totalPollution / Math.max(1, gridSize * gridSize * 100);
  const environment = clamp100(greenRatio * 200 - pollutionRatio * 100 + 50 + muniStatBonus.cleanliness);
  const jobSatisfaction = jobs >= population ? 100 : (jobs / (population || 1)) * 100;

  // Happiness: Gebaeude-Stats + Municipality-Stats (Attraktivitaet + Transparenz)
  const muniHappinessBonus = (muniStatBonus.attractiveness + muniStatBonus.transparency) / 2;
  const happinessOverall = clamp100(
    safety * 0.15 +
    health * 0.2 +
    education * 0.15 +
    environment * 0.15 +
    jobSatisfaction * 0.2 +
    (100 - effectiveTaxRate * 3) * 0.15 +
    muniHappinessBonus
  );
  const happinessResidential = clamp100(happinessOverall + (waterBalance >= 0 ? 4 : -8));
  const happinessCommercial = clamp100(happinessOverall + (powerBalance >= 0 ? 3 : -6));
  const happinessIndustrial = clamp100(happinessOverall - 3);

  // ── Municipality-Stats Einfluss auf Einnahmen ──
  // Infrastruktur beeinflusst Steuereinnahmen: ±10% maximal
  // Attraktivitaet beeinflusst Gebaeude-Einkommen: ±10% maximal
  // Formel: stat-50 ergibt Wert von -50 bis +50, /500 = ±10%
  const infraMultiplier = 1 + (muniStatBonus.infrastructure / 50);    // 0.70 bis 1.30
  const attractMultiplier = 1 + (muniStatBonus.attractiveness / 50);  // 0.70 bis 1.30
  const adjustedTaxIncome = Math.max(0, Math.round(taxIncomeBase * infraMultiplier));
  const adjustedBuildingIncome = Math.max(0, Math.round(totalBuildingDailyIncome * attractMultiplier));
  income = Math.max(0, adjustedTaxIncome + adjustedBuildingIncome);

  // ── Municipality-Stats Einfluss auf Bevoelkerungswachstum ──
  // Hohe Attraktivitaet/Sicherheit = mehr Zuzug, niedrige = Abwanderung
  // Happiness unter 40 = Wachstum halbiert, ueber 60 = +50% Wachstum
  if (happinessOverall < 40 && populationGrowth > 0) {
    populationGrowth = Math.max(0, Math.round(populationGrowth * (happinessOverall / 60)));
  } else if (happinessOverall > 60 && populationGrowth > 0) {
    populationGrowth = Math.round(populationGrowth * (1 + (happinessOverall - 60) / 80));
  }

  const tick = Math.max(0, Math.round(Number(serverTime.tick || rawStats.tick || 0)));
  const gameSpeed = Math.max(0, Math.min(3, Math.round(toFiniteNumber(rawStats.game_speed ?? rawStats.gameSpeed, 1))));
  const secondsPerTick = Number(serverTime?.config?.seconds_per_day || 300) / Number(serverTime?.config?.ticks_per_day || 24);
  const playTimeSeconds = Math.max(
    0,
    Math.round(
      Number(rawStats.play_time_seconds ?? 0) > 0
        ? Number(rawStats.play_time_seconds)
        : tick * secondsPerTick
    )
  );
  const currentMoney = await getMunicipalityMoney(municipalityId);
  const totalTaxCollected = Math.max(
    0,
    Math.round(toFiniteNumber(rawStats.total_tax_collected, 0))
  );
  const totalSpent = Math.max(
    0,
    Math.round(toFiniteNumber(rawStats.total_spent, 0))
  );

  // IDLE EARNINGS: Berechne Einnahmen/Kosten fuer die Offline-Zeit (Echtzeit-taeglich)
  let idleEarnings = 0;
  let idleDays = 0;
  const dbUpdatedAt = Number(rawStats._db_updated_at || 0);
  if (dbUpdatedAt > 0 && income > 0) {
    const nowMs = Date.now();
    const offlineMs = nowMs - dbUpdatedAt;
    const offlineDays = offlineMs / (1000 * 60 * 60 * 24);
    // Nur wenn mehr als 5 Minuten offline (um kurze Reloads zu ignorieren)
    if (offlineDays > (5 / (60 * 24))) {
      const dailyNet = income - expenses;
      const cappedDays = Math.min(offlineDays, 7); // Max 7 Tage Catch-up
      const earnings = Math.floor(dailyNet * cappedDays);
      if (earnings !== 0) {
        idleEarnings = earnings;
        idleDays = Math.round(cappedDays * 100) / 100;
        // Persistente Benachrichtigung an alle Gemeinde-Mitglieder
        const timeText = idleDays >= 1
          ? `${idleDays} Tag${idleDays >= 1.5 ? 'e' : ''}`
          : `${Math.round(idleDays * 24)} Stunde${Math.round(idleDays * 24) !== 1 ? 'n' : ''}`;
        const earningsText = earnings >= 0
          ? `+$${earnings.toLocaleString()}`
          : `-$${Math.abs(earnings).toLocaleString()}`;
        createNotificationForAllMembers(municipalityId, {
          type: 'idle_earnings',
          title: 'Willkommen zurueck!',
          message: `Deine Stadt hat in ${timeText} ${earningsText} verdient`,
          icon: earnings >= 0 ? 'money' : 'city',
          amount: earnings,
        });
        logInfo('IDLE', 'Idle-Einnahmen berechnet (Echtzeit)', {
          municipalityId,
          roomCode,
          offlineDays: Math.round(offlineDays * 100) / 100,
          cappedDays,
          dailyNet,
          dailyIncome: income,
          dailyExpenses: expenses,
          buildingIncome: adjustedBuildingIncome,
          taxIncome: adjustedTaxIncome,
          idleEarnings,
        });
      }
    }
  }

  await saveMunicipalityStats(municipalityId, {
    treasury: currentMoney,
    daily_income: income,
    daily_expenses: expenses,
    last_finance_day: new Date().toISOString().slice(0, 10),
    tax_rate: taxRate,
    population,
    max_population: Math.max(population, maxPopulation),
    jobs,
    total_tax_collected: totalTaxCollected,
    total_spent: totalSpent,
  });

  if (idleEarnings !== 0) {
    try {
      await applyMunicipalityTransaction(municipalityId, {
        amount: idleEarnings,
        type: 'idle_earnings',
        meta: { idleDays, dailyIncome: income, dailyExpenses: expenses },
        source: 'system',
      });
    } catch (err) {
      logError('IDLE', 'Ledger-Eintrag fuer Idle-Einnahmen fehlgeschlagen', {
        municipalityId, idleEarnings, error: err?.message,
      });
    }
  }
  const newTreasury = currentMoney + idleEarnings;

  const next = {
    ...(rawStats || {}),
    money: newTreasury,
    income,
    expenses,
    tax_income: adjustedTaxIncome,
    building_income: adjustedBuildingIncome,
    maintenance_expenses: maintenanceExpenses,
    tax_rate: taxRate,
    taxRate,
    total_tax_collected: totalTaxCollected,
    total_spent: totalSpent,
    population,
    max_population: Math.max(population, maxPopulation),
    population_growth: populationGrowth,
    homeless,
    jobs,
    employed,
    unemployed,
    unemployment_rate: unemploymentRate,
    happiness: happinessOverall,
    happiness_residential: happinessResidential,
    happiness_commercial: happinessCommercial,
    happiness_industrial: happinessIndustrial,
    power_production: Math.max(0, Math.round(powerProduction)),
    power_consumption: Math.max(0, Math.round(powerConsumption)),
    water_production: Math.max(0, Math.round(waterProduction)),
    water_consumption: Math.max(0, Math.round(waterConsumption)),
    buildings_total: buildingsTotal,
    buildings_residential: buildingsResidential,
    buildings_commercial: buildingsCommercial,
    buildings_industrial: buildingsIndustrial,
    buildings_infrastructure: buildingsInfrastructure,
    buildings_decoration: buildingsDecoration,
    zones_residential: zonesResidential,
    zones_commercial: zonesCommercial,
    zones_industrial: zonesIndustrial,
    tick,
    year: Math.max(2026, Math.round(Number(rawStats.year ?? serverTime.year ?? 2026))),
    month: Math.max(1, Math.min(12, Math.round(Number(rawStats.month ?? serverTime.month ?? 1)))),
    game_speed: gameSpeed,
    gameSpeed,
    play_time_seconds: playTimeSeconds,
    game_map_data: gameMapData,
  };

  if (idleEarnings !== 0) {
    next._idle_earnings = idleEarnings;
    next._idle_days = idleDays;
  }

  delete next._db_updated_at;
  if (!jsonEquals(rawStats, next)) {
    const toSave = { ...next };
    delete toSave._idle_earnings;
    delete toSave._idle_days;
    delete toSave._db_updated_at;
    await saveRoomStats(municipalityId, roomCode, toSave);
  }

  const milestones = await checkAndAwardMilestones(municipalityId, roomCode, population);
  if (milestones.length > 0) {
    next._milestones_awarded = milestones;
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    await dbPool.query(
      `INSERT IGNORE INTO municipality_stats_history
         (municipality_id, room_code, snapshot_date, population, jobs, money, income, expenses, happiness)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [municipalityId, roomCode, today, population, jobs, newTreasury, income, expenses, happinessOverall]
    );
  } catch (snapshotErr) {
    console.error('[StatsHistory] Snapshot fehlgeschlagen:', snapshotErr.message);
  }

  return next;
}

// ── PERSISTENTE BENACHRICHTIGUNGEN ─────────────────────────────────
// Speichert Notifications in der DB, damit sie nach Reload noch da sind.

async function createNotificationForAllMembers(municipalityId, { type, title, message, icon, amount }) {
  if (!dbPool || !municipalityId) return;
  try {
    const [members] = await dbPool.query(
      `SELECT user_id FROM municipality_memberships WHERE municipality_id = ?`,
      [municipalityId]
    );
    if (!members || members.length === 0) return;
    const values = members.map(m => [m.user_id, municipalityId, type || 'info', title, message, icon || 'info', amount || null]);
    await dbPool.query(
      `INSERT INTO user_notifications (user_id, municipality_id, notification_type, title, message, icon, amount) VALUES ?`,
      [values]
    );
  } catch (err) {
    console.error('[Notifications] Fehler beim Erstellen:', err.message);
  }
}

async function createNotificationForUser(userId, municipalityId, { type, title, message, icon, amount }) {
  if (!dbPool || !userId) return;
  try {
    await dbPool.query(
      `INSERT INTO user_notifications (user_id, municipality_id, notification_type, title, message, icon, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, municipalityId || null, type || 'info', title, message, icon || 'info', amount || null]
    );
  } catch (err) {
    console.error('[Notifications] Fehler beim Erstellen:', err.message);
  }
}

// ── MEILENSTEIN-BONI ──────────────────────────────────────────────
const POPULATION_MILESTONES = [
  { code: 'POP_100',  threshold: 100,  bonus: 5000 },
  { code: 'POP_500',  threshold: 500,  bonus: 15000 },
  { code: 'POP_1000', threshold: 1000, bonus: 50000 },
  { code: 'POP_2000', threshold: 2000, bonus: 100000 },
  { code: 'POP_3000', threshold: 3000, bonus: 200000 },
];

async function checkAndAwardMilestones(municipalityId, roomCode, population) {
  if (!dbPool || !municipalityId || population <= 0) return [];
  const awarded = [];
  try {
    for (const milestone of POPULATION_MILESTONES) {
      if (population < milestone.threshold) break;
      // INSERT IGNORE: affectedRows=1 wenn neu, 0 wenn bereits vorhanden
      const [result] = await dbPool.query(
        `INSERT IGNORE INTO municipality_milestones (municipality_id, milestone_code, bonus_amount) VALUES (?, ?, ?)`,
        [municipalityId, milestone.code, milestone.bonus]
      );
      if (!result || result.affectedRows === 0) continue;
      await applyMunicipalityTransaction(municipalityId, {
        amount: milestone.bonus,
        type: 'milestone',
        meta: { milestoneCode: milestone.code, threshold: milestone.threshold },
        source: 'system',
      });
      awarded.push({ code: milestone.code, threshold: milestone.threshold, bonus: milestone.bonus });
      // Persistente Benachrichtigung an alle Gemeinde-Mitglieder
      await createNotificationForAllMembers(municipalityId, {
        type: 'milestone',
        title: `Meilenstein: ${milestone.threshold.toLocaleString()} Einwohner!`,
        message: `Bonus: +$${milestone.bonus.toLocaleString()} fuer die Gemeindekasse`,
        icon: 'money',
        amount: milestone.bonus,
      });
      logInfo('MILESTONE', `Gemeinde ${municipalityId} erreicht ${milestone.threshold} Einwohner! Bonus: ${milestone.bonus}`, {
        municipalityId, roomCode, milestone: milestone.code, population, bonus: milestone.bonus,
      });
    }
  } catch (err) {
    logInfo('MILESTONE', `Fehler bei Meilenstein-Pruefung: ${err.message}`, { municipalityId });
  }
  return awarded;
}

const DISASTER_NON_BURNABLE_TOOLS = new Set([
  'grass',
  'water',
  'road',
  'rail',
  'bridge',
  'tree',
  'furni',
]);
const FIRE_RESPONSE_RANGE_TILES = 18;

const disasterTickLocks = new Set();
const upgradeTickLocks = new Set();
const NON_UPGRADABLE_TOOLS = new Set([
  'grass',
  'water',
  'road',
  'rail',
  'bridge',
  'tree',
  'empty',
  'zone_residential',
  'zone_commercial',
  'zone_industrial',
  'zone_dezone',
  'zone_water',
  'zone_land',
  'terrain_raise',
  'terrain_lower',
  'terrain_lower2',
  'terrain_hill',
  'terrain_mountain',
  'terrain_flatten',
  'paint_green',
  'paint_sand',
  'paint_dirt',
  'paint_snow',
  'paint_dark_grass',
  'paint_rock',
  'paint_reset',
  'bank_house',
]);

function canBurnTool(tool) {
  const t = String(tool || '').trim().toLowerCase();
  if (!t) return false;
  if (DISASTER_NON_BURNABLE_TOOLS.has(t)) return false;
  if (t.startsWith('tree_') || t.startsWith('bush_') || t.startsWith('flower_') || t.startsWith('topiary_')) return false;
  if (t.startsWith('furni_') || t === 'furni') return false; // Habbo furniture can't burn
  return true;
}

function isFireStationTool(tool) {
  const t = String(tool || '').trim().toLowerCase();
  if (!t) return false;
  if (t === 'fire_station') return true;
  return t.includes('fire') && t.includes('station');
}

function isDisasterEnabledInStats(rawStats) {
  const stats = rawStats && typeof rawStats === 'object' ? rawStats : {};
  const mapData = stats.game_map_data && typeof stats.game_map_data === 'object' ? stats.game_map_data : null;
  const settings = mapData && typeof mapData.settings === 'object' ? mapData.settings : null;
  if (settings && typeof settings.disastersEnabled === 'boolean') {
    return settings.disastersEnabled;
  }
  return true;
}

// Nur 1x1-Gebaeude fuer Zone-Spawns — groessere (2x2, 3x3) entstehen durch Konsolidierung
// (z.B. 4 house_small -> 1 mansion, 4 shop_small -> 1 office_low)
const ZONE_SPAWN_BUILDINGS = Object.freeze({
  residential: Object.freeze(['house_small', 'house_medium']),
  commercial: Object.freeze(['shop_small', 'shop_medium']),
  industrial: Object.freeze(['factory_small']),
});

function getZoneBuildingPool(zoneType) {
  const z = String(zoneType || '').trim().toLowerCase();
  const pool = ZONE_SPAWN_BUILDINGS[z];
  return Array.isArray(pool) ? pool : [];
}

function getZoneStarterBuilding(zoneType) {
  const pool = getZoneBuildingPool(zoneType);
  return pool.length > 0 ? String(pool[0]) : '';
}

function deterministicUpgradeUnit(key) {
  const digest = crypto.createHash('sha256').update(String(key)).digest('hex');
  const n = parseInt(digest.slice(0, 8), 16);
  return n / 0xffffffff;
}

function pickRandomZoneBuildingType(zoneType) {
  const pool = getZoneBuildingPool(zoneType);
  if (pool.length <= 0) return null;
  const idx = Math.floor(Math.random() * pool.length);
  return String(pool[Math.max(0, Math.min(pool.length - 1, idx))] || '');
}

// === Gebaeude-Evolution: Level → Gebaeude-Typ (wie im Original-Client) ===
// Kette: Level 1 = kleinstes Gebaeude, Level 5 = groesstes
const ZONE_EVOLUTION_CHAIN = Object.freeze({
  residential: Object.freeze(['house_small', 'house_medium', 'mansion', 'apartment_low', 'apartment_high']),
  commercial: Object.freeze(['shop_small', 'shop_medium', 'office_low', 'office_high', 'mall']),
  industrial: Object.freeze(['factory_small', 'factory_medium', 'warehouse', 'factory_large', 'factory_large']),
});

// Gebaeude-Groessen (Multi-Tile) — gleich wie im Client
const SERVER_BUILDING_SIZES = Object.freeze({
  mansion: { width: 2, height: 2 },
  apartment_low: { width: 2, height: 2 },
  apartment_high: { width: 2, height: 2 },
  office_low: { width: 2, height: 2 },
  office_high: { width: 2, height: 2 },
  mall: { width: 3, height: 3 },
  factory_medium: { width: 2, height: 2 },
  factory_large: { width: 3, height: 3 },
  warehouse: { width: 2, height: 2 },
});

// Kleine Gebaeude, die bei hohem Demand konsolidiert (gemerged) werden koennen
const SERVER_CONSOLIDATABLE_BUILDINGS = Object.freeze({
  residential: new Set(['house_small', 'house_medium']),
  commercial: new Set(['shop_small', 'shop_medium']),
  industrial: new Set(['factory_small']),
});

const SERVER_MERGEABLE_TYPES = new Set(['grass', 'tree', '']);

function getServerBuildingSize(buildingType) {
  const t = String(buildingType || '').trim().toLowerCase();
  const size = SERVER_BUILDING_SIZES[t];
  return size ? { width: size.width, height: size.height } : { width: 1, height: 1 };
}

function getTargetBuildingTypeForLevel(zoneCategory, level) {
  const chain = ZONE_EVOLUTION_CHAIN[zoneCategory];
  if (!Array.isArray(chain) || chain.length === 0) return null;
  const safeLevel = Math.max(1, Math.min(chain.length, Math.round(Number(level) || 1)));
  return chain[safeLevel - 1] || chain[0];
}

// Grid aus DB-Rows bauen fuer raeumliche Pruefungen (Konsolidierung)
function buildRoomGrid(rows) {
  const grid = new Map();
  for (const row of rows) {
    if (row.action_type !== 'place' && row.action_type !== 'zone') continue;
    const x = Number(row.x);
    const y = Number(row.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    grid.set(`${x},${y}`, row);
  }
  return grid;
}

// Pruefen ob ein Tile fuer Konsolidierung nutzbar ist
function isServerMergeableTile(tileRow, tileMeta, targetZone, isOriginTile, allowBuildingConsolidation) {
  if (isOriginTile) {
    const zone = String(tileRow?.zone_type || '').trim().toLowerCase();
    return zone === targetZone && tileMeta.onFire !== true;
  }
  const zone = String(tileRow?.zone_type || '').trim().toLowerCase();
  if (zone !== targetZone) return false;
  if (tileMeta.onFire === true) return false;
  if (tileMeta.abandoned === true) return false;
  const bt = String(metaValue(tileMeta, 'buildingType', 'building_type') || tileRow?.tool || '').trim().toLowerCase();
  if (SERVER_MERGEABLE_TYPES.has(bt) || bt === 'grass') return true;
  if (allowBuildingConsolidation) {
    const consolidatable = SERVER_CONSOLIDATABLE_BUILDINGS[targetZone];
    if (consolidatable && consolidatable.has(bt)) {
      const cp = Number(metaValue(tileMeta, 'constructionProgress', 'construction_progress') ?? 100);
      return cp >= 100 || tileMeta.constructed === true;
    }
  }
  if (bt === 'empty') return false;
  return false;
}

// Beste Footprint-Position finden die das Tile (x,y) enthaelt
function findServerConsolidationFootprint(grid, x, y, width, height, zone, allowBuildingConsolidation) {
  let bestOrigin = null;
  let bestScore = -Infinity;
  for (let oy = y - (height - 1); oy <= y; oy++) {
    for (let ox = x - (width - 1); ox <= x; ox++) {
      let available = true;
      for (let dy = 0; dy < height && available; dy++) {
        for (let dx = 0; dx < width && available; dx++) {
          const key = `${ox + dx},${oy + dy}`;
          const tileRow = grid.get(key);
          if (!tileRow) { available = false; break; }
          const tileMeta = toJsonValue(tileRow.metadata) || {};
          const isOrigin = (ox + dx === x && oy + dy === y);
          if (!isServerMergeableTile(tileRow, tileMeta, zone, isOrigin, allowBuildingConsolidation)) {
            available = false;
          }
        }
      }
      if (!available) continue;
      if (x < ox || x >= ox + width || y < oy || y >= oy + height) continue;
      // Score: Strassenanschluss bevorzugen
      let score = 0;
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          const neighbors = [[ox+dx-1,oy+dy],[ox+dx+1,oy+dy],[ox+dx,oy+dy-1],[ox+dx,oy+dy+1]];
          for (const [nx, ny] of neighbors) {
            const nRow = grid.get(`${nx},${ny}`);
            if (!nRow) continue;
            const nTool = String(nRow.tool || '').toLowerCase();
            const nMeta = toJsonValue(nRow.metadata) || {};
            const nBt = String(metaValue(nMeta, 'buildingType', 'building_type') || nTool).toLowerCase();
            if (nBt === 'road' || nBt === 'bridge' || nTool === 'road' || nTool === 'bridge') score++;
          }
        }
      }
      score -= width * height * 0.25;
      if (score > bestScore) {
        bestScore = score;
        bestOrigin = { originX: ox, originY: oy };
      }
    }
  }
  return bestOrigin;
}

function getUpgradeHourRangeForLevel(fromLevel) {
  // Upgrade-Zeiten pro Stufe (in Stunden) — synchron mit Client:
  // L1->L2: 2-5 Min, L2->L3: 5-12 Min, L3->L4: 15-30 Min, L4->L5: 30-60 Min
  switch (Number(fromLevel)) {
    case 1:
      return [2 / 60, 5 / 60];    // 2-5 Minuten
    case 2:
      return [5 / 60, 12 / 60];   // 5-12 Minuten
    case 3:
      return [15 / 60, 30 / 60];  // 15-30 Minuten
    case 4:
      return [30 / 60, 60 / 60];  // 30-60 Minuten
    default:
      return [1, 2];              // 1-2 Stunden
  }
}

function getServerTargetLevelByElapsedHours(seedBase, elapsedHours) {
  let cumulative = 0;
  let level = 1;
  for (let fromLevel = 1; fromLevel <= 4; fromLevel += 1) {
    const [minH, maxH] = getUpgradeHourRangeForLevel(fromLevel);
    const r = deterministicUpgradeUnit(`${seedBase}:L${fromLevel}`);
    const needed = minH + (maxH - minH) * r;
    cumulative += needed;
    if (elapsedHours >= cumulative) {
      level = fromLevel + 1;
    } else {
      break;
    }
  }
  return Math.max(1, Math.min(5, level));
}

function canUpgradeTool(tool) {
  const t = String(tool || '').trim().toLowerCase();
  if (!t) return false;
  if (NON_UPGRADABLE_TOOLS.has(t)) return false;
  if (t.startsWith('tree_') || t.startsWith('bush_') || t.startsWith('flower_') || t.startsWith('topiary_')) return false;
  return true;
}

function getEconomicZoneFromRow(row, meta) {
  const explicitZone = String(row?.zone_type || '').trim().toLowerCase();
  if (explicitZone === 'residential' || explicitZone === 'commercial' || explicitZone === 'industrial') {
    return explicitZone;
  }
  const effectiveTool = String(
    row?.action_type === 'zone'
      ? (metaValue(meta, 'buildingType', 'building_type') || '')
      : (row?.tool || '')
  )
    .trim()
    .toLowerCase();
  const inferred = inferCategoryFromTool(effectiveTool, 'general');
  if (inferred === 'residential' || inferred === 'commercial' || inferred === 'industrial') {
    return inferred;
  }
  return null;
}

function getUpgradeToolFromRow(row, meta) {
  const effectiveTool = String(
    row?.action_type === 'zone'
      ? (metaValue(meta, 'buildingType', 'building_type') || '')
      : (row?.tool || '')
  )
    .trim()
    .toLowerCase();
  return effectiveTool;
}

async function runServerBuildingUpgradeTick(municipalityId, roomCode) {
  ensureDbEnabled();
  const lockKey = `${municipalityId}:${roomCode}`;
  if (upgradeTickLocks.has(lockKey)) return { updated: 0 };
  upgradeTickLocks.add(lockKey);

  try {
    const rawStats = (await loadRoomStats(municipalityId, roomCode)) || {};
    const statsShape = toItemsStatsShape(rawStats);
    const demand = statsShape && statsShape.demand && typeof statsShape.demand === 'object'
      ? statsShape.demand
      : { residential: 0, commercial: 0, industrial: 0 };
    const powerBalance = toFiniteNumber(rawStats.power_production, 0) - toFiniteNumber(rawStats.power_consumption, 0);
    const waterBalance = toFiniteNumber(rawStats.water_production, 0) - toFiniteNumber(rawStats.water_consumption, 0);

    const rows = await getRoomItemRows(municipalityId, roomCode);
    if (!rows.length) return { updated: 0 };

    const candidates = rows.filter((row) => {
      if (row.action_type !== 'place' && row.action_type !== 'zone') return false;
      const meta = toJsonValue(row.metadata) || {};
      const toolForUpgrade = getUpgradeToolFromRow(row, meta);
      return canUpgradeTool(toolForUpgrade);
    });
    if (!candidates.length) return { updated: 0 };

    let currentVersion = await getRoomItemVersion(municipalityId, roomCode);
    const nowMs = Date.now();
    const now = new Date();
    const timestamp = Date.now();
    let updated = 0;
    const changedTiles = [];
    let roomGrid = null; // Lazy: wird erst bei Konsolidierung gebaut
    const processedTiles = new Set(); // Tiles die durch Konsolidierung bereits geaendert wurden

    for (const row of candidates) {
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent) continue;
      if (meta.onFire === true) continue;
      // Furni (Habbo furniture) is immune to abandonment/upgrade ticks
      const rowTool = String(row.tool || '').trim().toLowerCase();
      if (rowTool === 'furni' || rowTool.startsWith('furni_')) continue;
      // Skip tiles die durch eine fruehere Konsolidierung in diesem Tick bereits geaendert wurden
      if (processedTiles.has(`${row.x},${row.y}`)) continue;

      const constructionProgress = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 100);
      let isConstructed = constructionProgress >= 100 || meta.constructed === true;

      let nextMeta = { ...meta };

      // --- Zonen-Baufortschritt: Server progressed Bau genau wie Client simulateTick ---
      // Wenn Zone noch nicht fertig gebaut ist, Baufortschritt basierend auf elapsed time berechnen
      if (!isConstructed && row.action_type === 'zone') {
        const buildingType = String(metaValue(meta, 'buildingType', 'building_type') || '').trim().toLowerCase();
        if (buildingType.length > 0) {
          // constructionStartedAt fuer konsolidierte Gebaeude, sonst created_at (unveraenderlich)
          const consolidatedAtMs = Number(metaValue(meta, 'constructionStartedAt') || 0);
          const createdAtMs = row.created_at ? new Date(row.created_at).getTime() : Number(row.client_timestamp || 0);
          const referenceMs = consolidatedAtMs > 0 ? consolidatedAtMs : createdAtMs;
          const safeCreatedAtMs = Number.isFinite(referenceMs) && referenceMs > 0 ? referenceMs : nowMs;
          const elapsedSec = Math.max(0, (nowMs - safeCreatedAtMs) / 1000);

          // Baugeschwindigkeit: ~33% pro Sekunde fuer 1x1 Gebaeude (wie Client ~46%/s)
          // 1x1 Gebaeude fertig in ca. 3 Sekunden
          // Groessere Gebaeude wuerden laenger brauchen, aber Zone-Spawns sind derzeit alle 1x1
          const constructionSpeedPerSec = 33;
          const targetProgress = Math.min(100, Math.round(constructionSpeedPerSec * elapsedSec * 100) / 100);

          if (targetProgress > constructionProgress) {
            nextMeta.constructionProgress = targetProgress;
            nextMeta.constructed = targetProgress >= 100;
            isConstructed = nextMeta.constructed === true;
          }
        }

        // Wenn noch nicht fertig: Aenderungen speichern und weiter zum naechsten Kandidat
        if (!isConstructed) {
          if (!jsonEquals(meta, nextMeta)) {
            currentVersion += 1;
            await dbPool.query(
              `UPDATE game_items
               SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [JSON.stringify(nextMeta), currentVersion, timestamp, now, row.id]
            );
            updated += 1;
            changedTiles.push({
              x: Number(row.x),
              y: Number(row.y),
              level: 1,
              abandoned: false,
              buildingType: String(nextMeta.buildingType || row.tool || ''),
              constructionProgress: nextMeta.constructionProgress,
              constructed: false,
            });
          }
          continue;
        }
      }
      if (!isConstructed) continue;
      const zoneCategory = getEconomicZoneFromRow(row, meta);
      const isEconomicZone = zoneCategory === 'residential' || zoneCategory === 'commercial' || zoneCategory === 'industrial';
      const currentAbandoned = Boolean(meta.abandoned === true);
      const startedAtMsBase = row.applied_at ? new Date(row.applied_at).getTime() : Number(row.client_timestamp || 0);
      const startedAtMs = Number.isFinite(startedAtMsBase) && startedAtMsBase > 0 ? startedAtMsBase : nowMs;
      const ageHours = Math.max(0, (nowMs - startedAtMs) / (1000 * 60 * 60));
      const lastAbandonTickMsRaw = Number(
        metaValue(meta, 'lastAbandonmentTickAt', 'last_abandonment_tick_at') || startedAtMs
      );
      const lastAbandonTickMs = Number.isFinite(lastAbandonTickMsRaw) && lastAbandonTickMsRaw > 0
        ? lastAbandonTickMsRaw
        : startedAtMs;
      const elapsedAbandonHours = Math.max(0, (nowMs - lastAbandonTickMs) / (1000 * 60 * 60));

      if (isEconomicZone && elapsedAbandonHours > 0.01) {
        const zoneDemand = Math.round(toFiniteNumber(demand[zoneCategory], 0));
        const currentLevel = Math.max(1, Math.min(5, Math.round(Number(metaValue(meta, 'level') ?? 1))));
        if (!currentAbandoned && ageHours >= 24 && zoneDemand < -80) {
          // Abandonment erst ab 24h Alter und extrem negativer Demand (< -80).
          // Chancen stark reduziert: max ~0.15% pro Stunde bei extremer Ueberversorgung.
          const basePerHour = Math.min(0.0008, Math.abs(zoneDemand + 80) / 120000);
          const utilityPenalty = (powerBalance < 0 ? 0.0002 : 0) + (waterBalance < 0 ? 0.0002 : 0);
          const levelPenalty = currentLevel <= 2 ? 0.0001 : 0;
          const perHourChance = Math.max(0, Math.min(0.0015, basePerHour + utilityPenalty + levelPenalty));
          const chance = 1 - Math.pow(1 - perHourChance, elapsedAbandonHours);
          if (Math.random() < chance) {
            nextMeta.abandoned = true;
          }
        } else if (currentAbandoned && zoneDemand > 5) {
          const baseRecoveryPerHour = Math.min(0.04, (zoneDemand - 5) / 2000);
          const utilityBoost = (powerBalance >= 0 ? 0.004 : 0) + (waterBalance >= 0 ? 0.004 : 0);
          const recoveryPerHour = Math.max(0, Math.min(0.08, baseRecoveryPerHour + utilityBoost));
          const recoveryChance = 1 - Math.pow(1 - recoveryPerHour, elapsedAbandonHours);
          if (Math.random() < recoveryChance) {
            nextMeta.abandoned = false;
          }
        }
        nextMeta.lastAbandonmentTickAt = nowMs;
      }

      const currentAbandonedAfterTick = Boolean(nextMeta.abandoned === true);
      const toolForUpgrade = getUpgradeToolFromRow(row, meta);
      // Auto-Level nur fuer wirtschaftliche Zonen (residential/commercial/industrial).
      // Service-Gebaeude (police, fire, hospital, school, university, power_plant, water_tower)
      // und alle anderen Nicht-Zone-Gebaeude benutzen das manuelle Upgrade-System.
      if (!currentAbandonedAfterTick && isEconomicZone && !SERVICE_UPGRADE_TOOLS.has(toolForUpgrade)) {
        const currentLevel = Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1))));
        if (currentLevel < 5) {
          const startedAtMsLevel = row.applied_at ? new Date(row.applied_at).getTime() : Number(row.client_timestamp || 0);
          if (Number.isFinite(startedAtMsLevel) && startedAtMsLevel > 0) {
            const elapsedHours = Math.max(0, (nowMs - startedAtMsLevel) / (1000 * 60 * 60));
            const seedBase = `${municipalityId}:${roomCode}:${row.x}:${row.y}:${toolForUpgrade}`;
            const targetLevel = getServerTargetLevelByElapsedHours(seedBase, elapsedHours);
            if (targetLevel > currentLevel) {
              nextMeta = {
                ...nextMeta,
                level: targetLevel,
                serverLevelAuthoritative: true,
              };
            }
          }
        }
      }

      // === Gebaeude-Typ-Evolution: Level bestimmt Gebaeude-Typ (wie Original-Client) ===
      // z.B. Residential Level 3 → mansion (2x2), Level 5 → apartment_high (2x2)
      // Commercial Level 3 → office_low (2x2), Level 5 → mall (3x3)
      if (isEconomicZone && row.action_type === 'zone' && !currentAbandonedAfterTick) {
        const currentBuildingType = String(metaValue(nextMeta, 'buildingType', 'building_type') || '').trim().toLowerCase();
        const evolLevel = Math.max(1, Math.min(5, Math.round(Number(nextMeta.level ?? meta.level ?? 1))));
        const targetEvolutionType = getTargetBuildingTypeForLevel(zoneCategory, evolLevel);

        if (targetEvolutionType && targetEvolutionType !== currentBuildingType && currentBuildingType !== 'empty') {
          const currentSize = getServerBuildingSize(currentBuildingType);
          const targetSize = getServerBuildingSize(targetEvolutionType);

          if (targetSize.width <= currentSize.width && targetSize.height <= currentSize.height) {
            // Gleiche oder kleinere Groesse — nur Typ aendern (z.B. house_small → house_medium)
            nextMeta.buildingType = targetEvolutionType;
          } else {
            // Groesseres Gebaeude — Konsolidierung: mehrere Tiles zu einem Multi-Tile-Gebaeude mergen
            if (!roomGrid) roomGrid = buildRoomGrid(rows);

            const zoneDemandVal = Math.round(toFiniteNumber(demand[zoneCategory], 0));
            // Bei moderatem Demand (> 40) bestehende kleine Gebaeude mergen erlauben
            // Server hat kein "Gras-Fenster" wie Client, daher niedrigerer Schwellenwert
            let allowBuildingConsolidation = zoneDemandVal > 40;

            // Konsolidierungs-Wahrscheinlichkeit: ~14% pro 3s-Server-Tick
            // Entspricht Client: 2.5% pro 500ms × 6 Ticks ≈ 1-(1-0.025)^6 ≈ 14%
            let consolidationChance = 0.14;
            if (zoneDemandVal > 30) {
              // Gradual boost (wie Original-Client: max 25% bei demand 100)
              consolidationChance += Math.min(0.25, (zoneDemandVal - 30) / 300);
              if (zoneDemandVal > 70) {
                consolidationChance += 0.05;
                allowBuildingConsolidation = true; // immer erlaubt bei hohem Demand
              }
            }

            if (Math.random() < consolidationChance) {
              const footprint = findServerConsolidationFootprint(
                roomGrid, Number(row.x), Number(row.y),
                targetSize.width, targetSize.height,
                zoneCategory, allowBuildingConsolidation
              );

              if (footprint) {
                const ox = footprint.originX;
                const oy = footprint.originY;

                for (let dy = 0; dy < targetSize.height; dy++) {
                  for (let dx = 0; dx < targetSize.width; dx++) {
                    const tx = ox + dx;
                    const ty = oy + dy;
                    const isOrigin = (dx === 0 && dy === 0);
                    const tk = `${tx},${ty}`;
                    processedTiles.add(tk);

                    const tileRow = roomGrid.get(tk);
                    if (!tileRow) continue;
                    const isCurrentRow = (tileRow.id === row.id);

                    if (isOrigin) {
                      // Origin-Tile bekommt den grossen Gebaeude-Typ
                      if (isCurrentRow) {
                        nextMeta.buildingType = targetEvolutionType;
                        nextMeta.level = evolLevel;
                        nextMeta.constructionStartedAt = nowMs;
                        nextMeta.constructionProgress = 0;
                        nextMeta.constructed = false;
                        nextMeta.abandoned = false;
                      } else {
                        const originMeta = { ...(toJsonValue(tileRow.metadata) || {}) };
                        originMeta.buildingType = targetEvolutionType;
                        originMeta.level = evolLevel;
                        originMeta.constructionStartedAt = nowMs;
                        originMeta.constructionProgress = 0;
                        originMeta.constructed = false;
                        originMeta.abandoned = false;

                        currentVersion += 1;
                        await dbPool.query(
                          `UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                          [JSON.stringify(originMeta), currentVersion, timestamp, now, tileRow.id]
                        );
                        updated += 1;
                        changedTiles.push({
                          x: tx, y: ty,
                          level: evolLevel,
                          abandoned: false,
                          buildingType: targetEvolutionType,
                          constructionProgress: 0,
                          constructed: false,
                        });
                      }
                    } else {
                      // Nicht-Origin-Tiles werden 'empty' Platzhalter
                      const emptyUpdate = {
                        buildingType: 'empty',
                        level: 0,
                        constructionProgress: 100,
                        constructed: true,
                        population: 0,
                        jobs: 0,
                        abandoned: false,
                      };

                      if (isCurrentRow) {
                        Object.assign(nextMeta, emptyUpdate);
                      } else {
                        const tileMeta = { ...(toJsonValue(tileRow.metadata) || {}), ...emptyUpdate };

                        currentVersion += 1;
                        await dbPool.query(
                          `UPDATE game_items SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                          [JSON.stringify(tileMeta), currentVersion, timestamp, now, tileRow.id]
                        );
                        updated += 1;
                      }
                      changedTiles.push({
                        x: tx, y: ty,
                        level: 0,
                        abandoned: false,
                        buildingType: 'empty',
                        constructionProgress: 100,
                        constructed: true,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (jsonEquals(meta, nextMeta)) continue;

      currentVersion += 1;
      await dbPool.query(
        `UPDATE game_items
         SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(nextMeta), currentVersion, timestamp, now, row.id]
      );
      updated += 1;

      // Sammle geänderte Tiles für den Client-Broadcast
      changedTiles.push({
        x: Number(row.x),
        y: Number(row.y),
        level: Number(nextMeta.level ?? meta.level ?? 1),
        abandoned: Boolean(nextMeta.abandoned),
        buildingType: String(nextMeta.buildingType || row.tool || ''),
        constructionProgress: Number(nextMeta.constructionProgress ?? meta.constructionProgress ?? 100),
        constructed: Boolean(nextMeta.constructed ?? meta.constructed ?? true),
      });
    }

    // Discord: Gebäude-Events direkt aus dem Tick pushen
    if (changedTiles.length > 0) {
      const completedCount = changedTiles.filter(c => c.constructed === true && c.constructionProgress >= 100).length;
      const upgradedCount = changedTiles.filter(c => c.level && c.level > 1 && !c.abandoned).length;
      const abandonedCount = changedTiles.filter(c => c.abandoned === true).length;
      if (completedCount > 0 || upgradedCount > 0 || abandonedCount > 0) {
        getMunicipalityById(municipalityId).then(m => {
          const name = m?.name || `Gemeinde #${municipalityId}`;
          if (completedCount > 0) pushDiscordEvent('building_complete', { municipalityName: name, roomCode, count: completedCount, message: `${completedCount} Gebäude fertiggestellt in ${name}` });
          if (upgradedCount > 0) pushDiscordEvent('building_upgrade', { municipalityName: name, roomCode, count: upgradedCount, message: `${upgradedCount} Gebäude aufgewertet in ${name}` });
          if (abandonedCount > 0) pushDiscordEvent('building_abandoned', { municipalityName: name, roomCode, count: abandonedCount, message: `${abandonedCount} Gebäude verlassen in ${name}` });
        }).catch(() => {});
      }
    }

    return { updated, changes: changedTiles };
  } finally {
    upgradeTickLocks.delete(lockKey);
  }
}

async function runServerDisasterTick(municipalityId, roomCode) {
  ensureDbEnabled();
  const lockKey = `${municipalityId}:${roomCode}`;
  if (disasterTickLocks.has(lockKey)) return { updated: 0, deleted: 0, changes: [] };
  disasterTickLocks.add(lockKey);

  try {
    const nowMs = Date.now();
    const stats = await loadRoomStats(municipalityId, roomCode);
    if (!isDisasterEnabledInStats(stats)) {
      return { updated: 0, deleted: 0, changes: [] };
    }

    const rows = await getRoomItemRows(municipalityId, roomCode);
    if (!rows.length) return { updated: 0, deleted: 0, changes: [] };

    // ── Furni auto-heal: extinguish any furniture that is (wrongly) on fire ──
    const furniHealMutations = [];
    for (const row of rows) {
      if (row.action_type !== 'place') continue;
      const t = String(row.tool || '').trim().toLowerCase();
      if (!(t === 'furni' || t.startsWith('furni_'))) continue;
      const meta = toJsonValue(row.metadata) || {};
      if (meta.onFire) {
        furniHealMutations.push({ type: 'update', row, meta: { ...meta, onFire: false, fireProgress: 0 } });
      }
    }
    if (furniHealMutations.length) {
      console.log(`[fire-tick] Auto-healed ${furniHealMutations.length} furni item(s) that were on fire`);
    }

    const placeRows = rows.filter((row) => row.action_type === 'place' && canBurnTool(row.tool));
    if (!placeRows.length && !furniHealMutations.length) return { updated: 0, deleted: 0, changes: [] };

    const allPlaceRows = rows.filter((row) => row.action_type === 'place');
    const activeFireStations = [];
    for (const row of allPlaceRows) {
      if (!isFireStationTool(row.tool)) continue;
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent) continue;
      if (meta.abandoned === true) continue;
      if (meta.onFire === true) continue;
      const constructionProgress = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 100);
      const isConstructed = constructionProgress >= 100 || meta.constructed === true;
      if (!isConstructed) continue;
      activeFireStations.push({
        x: Number(row.x),
        y: Number(row.y),
        level: Math.max(1, Math.min(5, Math.round(Number(meta.level ?? 1)))),
      });
    }

    const mapData = stats && typeof stats.game_map_data === 'object' ? stats.game_map_data : null;
    const budgetData = mapData && typeof mapData.budget === 'object' ? mapData.budget : null;
    const fireBudgetNode = budgetData && typeof budgetData.fire === 'object' ? budgetData.fire : null;
    const fireFunding = Math.max(0, Math.min(200, Number(fireBudgetNode?.funding ?? 100)));
    const fireFundingFactor = Math.max(0.35, fireFunding / 100);

    const byPos = new Map();
    for (const row of placeRows) {
      byPos.set(`${Number(row.x)},${Number(row.y)}`, row);
    }

    const currentlyBurning = new Set();
    for (const row of placeRows) {
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent) continue;
      if (Boolean(meta.onFire)) {
        currentlyBurning.add(`${Number(row.x)},${Number(row.y)}`);
      }
    }

    const mutations = [...furniHealMutations];
    const hasBurningNeighbor = (x, y) => {
      const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dx, dy] of offsets) {
        if (currentlyBurning.has(`${x + dx},${y + dy}`)) return true;
      }
      return false;
    };
    const getFireResponseAt = (x, y) => {
      let stationsInRange = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      let bestLevel = 1;
      for (const station of activeFireStations) {
        const distance = Math.abs(Number(station.x) - x) + Math.abs(Number(station.y) - y);
        if (distance > FIRE_RESPONSE_RANGE_TILES) continue;
        stationsInRange += 1;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          bestLevel = station.level;
        }
      }
      if (stationsInRange <= 0) {
        return {
          stationsInRange: 0,
          nearestDistance: Number.POSITIVE_INFINITY,
          distanceFactor: 0,
          stationStrength: 0,
          hasCoverage: false,
        };
      }
      const distanceFactor = Math.max(0.05, 1 - (nearestDistance / (FIRE_RESPONSE_RANGE_TILES + 1)));
      const stationStrength = Math.min(2.5, (0.8 + stationsInRange * 0.35) * (1 + (bestLevel - 1) * 0.12));
      return {
        stationsInRange,
        nearestDistance,
        distanceFactor,
        stationStrength,
        hasCoverage: true,
      };
    };

    for (const row of placeRows) {
      const x = Number(row.x);
      const y = Number(row.y);
      const meta = toJsonValue(row.metadata) || {};
      if (meta.mapPersistent) continue;
      const response = getFireResponseAt(x, y);

      const onFire = Boolean(meta.onFire);
      const fireProgress = Math.max(0, Math.min(100, Math.round(Number(meta.fireProgress || 0))));

      if (onFire) {
        const extinguishChance = response.hasCoverage
          ? Math.min(0.90, 0.12 + (0.30 * response.distanceFactor * response.stationStrength * fireFundingFactor))
          : 0;
        if (response.hasCoverage && Math.random() < extinguishChance) {
          mutations.push({ type: 'update', row, meta: { ...meta, onFire: false, fireProgress: 0 } });
          continue;
        }

        const suppressionFactor = response.hasCoverage
          ? Math.max(0.2, 1 - (response.distanceFactor * response.stationStrength * fireFundingFactor * 0.55))
          : 1;
        const progressStep = Math.max(1, Math.round(2 * suppressionFactor));
        const nextProgress = Math.min(100, fireProgress + progressStep);
        if (nextProgress >= 100) {
          // Gebäude brennt nicht weg – wird als verlassen/ausgebrannt markiert
          mutations.push({ type: 'update', row, meta: { ...meta, onFire: false, fireProgress: 0, abandoned: true } });
        } else {
          mutations.push({ type: 'update', row, meta: { ...meta, onFire: true, fireProgress: nextProgress } });
        }
        continue;
      }

      // Gebaeude muessen mindestens 24 Stunden alt sein, bevor sie Feuer fangen koennen.
      const startedAtMsFire = row.applied_at ? new Date(row.applied_at).getTime() : Number(row.client_timestamp || 0);
      const fireAgeHours = (Number.isFinite(startedAtMsFire) && startedAtMsFire > 0)
        ? Math.max(0, (nowMs - startedAtMsFire) / (1000 * 60 * 60))
        : 0;
      if (fireAgeHours < 24) continue;

      const baseIgnitionChance = hasBurningNeighbor(x, y) ? 0.012 : 0.0004;
      const preventionFactor = response.hasCoverage
        ? Math.max(0.08, 1 - (response.distanceFactor * response.stationStrength * fireFundingFactor * 0.5))
        : 1;
      const ignitionChance = baseIgnitionChance * preventionFactor;
      if (Math.random() < ignitionChance) {
        mutations.push({ type: 'update', row, meta: { ...meta, onFire: true, fireProgress: 0 } });
      }
    }

    if (!mutations.length) return { updated: 0, deleted: 0, changes: [] };

    let currentVersion = await getRoomItemVersion(municipalityId, roomCode);
    const now = new Date();
    const timestamp = Date.now();
    let updated = 0;
    let deleted = 0;
    const changes = [];

    for (const mutation of mutations) {
      if (mutation.type === 'delete') {
        const [result] = await dbPool.query(
          `DELETE FROM game_items
           WHERE id = ?`,
          [mutation.row.id]
        );
        if ((result?.affectedRows || 0) > 0) {
          deleted += 1;
          changes.push({
            x: Number(mutation.row.x),
            y: Number(mutation.row.y),
            removed: true,
          });
        }
        continue;
      }

      const prevMeta = toJsonValue(mutation.row.metadata) || {};
      const nextMeta = mutation.meta || {};
      if (jsonEquals(prevMeta, nextMeta)) continue;

      currentVersion += 1;
      await dbPool.query(
        `UPDATE game_items
         SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(nextMeta), currentVersion, timestamp, now, mutation.row.id]
      );
      updated += 1;
      changes.push({
        x: Number(mutation.row.x),
        y: Number(mutation.row.y),
        on_fire: Boolean(nextMeta.onFire),
        fire_progress: Math.max(0, Math.min(100, Math.round(Number(nextMeta.fireProgress || 0)))),
      });
    }

    if (updated > 0 || deleted > 0) {
      const municipality = await getMunicipalityById(municipalityId);
      if (municipality) {
        await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-disaster-v1');
      }
      // Discord: Katastrophen-Events direkt aus dem Tick pushen
      const mName = municipality?.name || `Gemeinde #${municipalityId}`;
      const fireCount = changes.filter(c => c.on_fire === true).length;
      if (fireCount > 0) {
        pushDiscordEvent('fire', { municipalityName: mName, roomCode, affectedCount: fireCount, message: `${fireCount} Gebäude brennen in ${mName}!` });
      }
      if (deleted > 0) {
        pushDiscordEvent('disaster', { municipalityName: mName, roomCode, destroyedCount: deleted, message: `${deleted} Gebäude zerstört in ${mName}!` });
      }
    }

    return { updated, deleted, changes };
  } finally {
    disasterTickLocks.delete(lockKey);
  }
}

const DEBUG_DISASTER_TYPES = new Set([
  'fire_single',
  'fire_cluster',
  'fire_storm',
  'earthquake',
  'meteor',
  'extinguish_all',
]);

function pickRandomRows(rows, count) {
  const pool = Array.isArray(rows) ? [...rows] : [];
  const out = [];
  const max = Math.max(0, Math.min(pool.length, Math.round(Number(count || 0))));
  while (out.length < max && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

function parseManualDisasterIntensity(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(5, Math.round(n)));
}

async function triggerManualDisaster(municipalityId, roomCode, disasterType, rawIntensity = 1, targetTile = null) {
  ensureDbEnabled();
  const type = String(disasterType || '').trim().toLowerCase();
  if (!DEBUG_DISASTER_TYPES.has(type)) {
    return { updated: 0, deleted: 0, changes: [], error: 'Unknown disaster type' };
  }
  const intensity = parseManualDisasterIntensity(rawIntensity);
  const rows = await getRoomItemRows(municipalityId, roomCode);
  const placeRows = rows.filter((row) => row.action_type === 'place');
  if (!placeRows.length) {
    return { updated: 0, deleted: 0, changes: [] };
  }

  const burnableRows = placeRows.filter((row) => {
    if (!canBurnTool(row.tool)) return false;
    const meta = toJsonValue(row.metadata) || {};
    if (meta.mapPersistent) return false;
    return true;
  });

  const burningRows = burnableRows.filter((row) => {
    const meta = toJsonValue(row.metadata) || {};
    return Boolean(meta.onFire);
  });

  const destructionCandidates = placeRows.filter((row) => {
    const tool = String(row.tool || '').trim().toLowerCase();
    if (!tool) return false;
    if (tool === 'grass' || tool === 'water' || tool === 'empty') return false;
    if (tool === 'furni' || tool.startsWith('furni_')) return false; // Furni can't be destroyed by disasters
    const meta = toJsonValue(row.metadata) || {};
    if (meta.mapPersistent) return false;
    return true;
  });

  const placeByPos = new Map();
  for (const row of placeRows) {
    placeByPos.set(`${Number(row.x)},${Number(row.y)}`, row);
  }

  const getDistance = (ax, ay, bx, by) => Math.hypot(Number(ax) - Number(bx), Number(ay) - Number(by));
  const isDestructibleTool = (tool) => {
    const t = String(tool || '').trim().toLowerCase();
    if (!t) return false;
    if (t === 'grass' || t === 'water' || t === 'road' || t === 'rail' || t === 'bridge' || t === 'empty') return false;
    if (t.startsWith('tree_') || t.startsWith('bush_') || t.startsWith('flower_') || t.startsWith('topiary_')) return false;
    if (t === 'furni' || t.startsWith('furni_')) return false; // Habbo furniture is indestructible
    return true;
  };

  const updatesById = new Map();
  const deletesById = new Map();
  const meteorRestoreById = new Map();
  const upsertUpdate = (row, nextMeta) => {
    if (!row || !row.id) return;
    if (deletesById.has(row.id)) return;
    updatesById.set(row.id, { row, meta: nextMeta });
  };
  const upsertDelete = (row) => {
    if (!row || !row.id) return;
    updatesById.delete(row.id);
    deletesById.set(row.id, { row });
  };
  let disasterMeta = {};

  if (type === 'fire_single') {
    const target = pickRandomRows(burnableRows, 1)[0] || null;
    if (target) {
      const prevMeta = toJsonValue(target.metadata) || {};
      const nextMeta = { ...prevMeta, onFire: true, fireProgress: 0 };
      upsertUpdate(target, nextMeta);
    }
  } else if (type === 'fire_cluster') {
    const center = pickRandomRows(burnableRows, 1)[0] || null;
    if (center) {
      const cx = Number(center.x);
      const cy = Number(center.y);
      const radius = intensity >= 4 ? 3 : 2;
      const cluster = burnableRows.filter((row) => {
        const d = Math.abs(Number(row.x) - cx) + Math.abs(Number(row.y) - cy);
        return d <= radius;
      });
      const pickCount = Math.max(3, Math.min(cluster.length, 4 + intensity * 3));
      for (const row of pickRandomRows(cluster, pickCount)) {
        const prevMeta = toJsonValue(row.metadata) || {};
        const nextMeta = {
          ...prevMeta,
          onFire: true,
          fireProgress: Math.max(0, Math.min(100, Math.round(Number(prevMeta.fireProgress || 0)))),
        };
        upsertUpdate(row, nextMeta);
      }
    }
  } else if (type === 'fire_storm') {
    const pickCount = Math.max(5, Math.min(burnableRows.length, 6 + intensity * 5));
    for (const row of pickRandomRows(burnableRows, pickCount)) {
      const prevMeta = toJsonValue(row.metadata) || {};
      const nextMeta = {
        ...prevMeta,
        onFire: true,
        fireProgress: Math.max(0, Math.min(100, Math.round(Number(prevMeta.fireProgress || 0)))),
      };
      upsertUpdate(row, nextMeta);
    }
  } else if (type === 'earthquake') {
    const pickCount = Math.max(1, Math.min(destructionCandidates.length, 1 + intensity * 2));
    for (const row of pickRandomRows(destructionCandidates, pickCount)) {
      upsertDelete(row);
    }
  } else if (type === 'meteor') {
    const impactCandidates = placeRows.filter((row) => {
      const tool = String(row.tool || '').trim().toLowerCase();
      if (tool === 'water') return false;
      return true;
    });
    const desiredX = Number(targetTile?.x);
    const desiredY = Number(targetTile?.y);
    const impactTile = Number.isFinite(desiredX) && Number.isFinite(desiredY)
      ? (placeByPos.get(`${Math.round(desiredX)},${Math.round(desiredY)}`) || null)
      : (pickRandomRows(impactCandidates, 1)[0] || null);
    if (impactTile) {
      const impactX = Number(impactTile.x);
      const impactY = Number(impactTile.y);
      const radius = Math.max(2, Math.min(6, 2 + Math.floor(intensity / 2) + 1));
      const impactRows = [];
      for (let y = impactY - radius; y <= impactY + radius; y += 1) {
        for (let x = impactX - radius; x <= impactX + radius; x += 1) {
          const distance = getDistance(x, y, impactX, impactY);
          if (distance > radius + 0.15) continue;
          const row = placeByPos.get(`${x},${y}`);
          if (!row) continue;
          impactRows.push({ row, distance });
        }
      }

      for (const entry of impactRows) {
        const row = entry.row;
        const distance = entry.distance;
        const normalized = Math.max(0, 1 - (distance / Math.max(1, radius)));
        const prevMeta = toJsonValue(row.metadata) || {};
        const isMapPersistent = Boolean(prevMeta.mapPersistent);

        const prevElevation = Math.max(0, Math.round(Number(metaValue(prevMeta, 'elevation') || 0)));
        // Meteor-Krater: bis zu 4 Hoehenstufen tiefer im Zentrum.
        const depression = Math.max(1, Math.round(4 * normalized));
        const nextElevation = Math.max(0, prevElevation - depression);

        const nextMeta = {
          ...prevMeta,
          elevation: nextElevation,
          meteorDamagedAt: Date.now(),
        };
        if (nextElevation !== prevElevation) {
          meteorRestoreById.set(Number(row.id), {
            id: Number(row.id),
            x: Number(row.x),
            y: Number(row.y),
            restore_elevation: prevElevation,
          });
        }

        const tool = String(row.tool || '').trim().toLowerCase();
        const destroyChance = Math.max(0, Math.min(0.92, (0.18 + intensity * 0.08) * normalized));
        if (!isMapPersistent && isDestructibleTool(tool) && Math.random() < destroyChance) {
          upsertDelete(row);
          continue;
        }

        if (!isMapPersistent && canBurnTool(tool) && normalized >= 0.35) {
          nextMeta.onFire = true;
          nextMeta.fireProgress = Math.max(
            0,
            Math.min(100, Math.round(Number(prevMeta.fireProgress || 0) + (8 + intensity * 3) * normalized))
          );
        }

        upsertUpdate(row, nextMeta);
      }

      disasterMeta = {
        impact_x: impactX,
        impact_y: impactY,
        impact_radius: radius,
      };
    }
  } else if (type === 'extinguish_all') {
    for (const row of burningRows) {
      const prevMeta = toJsonValue(row.metadata) || {};
      const nextMeta = { ...prevMeta, onFire: false, fireProgress: 0 };
      upsertUpdate(row, nextMeta);
    }
  }

  if (updatesById.size === 0 && deletesById.size === 0) {
    return { updated: 0, deleted: 0, changes: [] };
  }

  let currentVersion = await getRoomItemVersion(municipalityId, roomCode);
  const now = new Date();
  const timestamp = Date.now();
  let updated = 0;
  let deleted = 0;
  const changes = [];

  for (const mutation of deletesById.values()) {
    const [result] = await dbPool.query(
      `DELETE FROM game_items
       WHERE id = ?`,
      [mutation.row.id]
    );
    if ((result?.affectedRows || 0) > 0) {
      deleted += 1;
      changes.push({
        x: Number(mutation.row.x),
        y: Number(mutation.row.y),
        removed: true,
        elevation: 0,
      });
    }
  }

  for (const mutation of updatesById.values()) {
    const prevMeta = toJsonValue(mutation.row.metadata) || {};
    const nextMeta = mutation.meta || {};
    if (jsonEquals(prevMeta, nextMeta)) continue;

    currentVersion += 1;
    await dbPool.query(
      `UPDATE game_items
       SET metadata = ?, version = ?, client_timestamp = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [JSON.stringify(nextMeta), currentVersion, timestamp, now, mutation.row.id]
    );
    updated += 1;
    changes.push({
      x: Number(mutation.row.x),
      y: Number(mutation.row.y),
      on_fire: Boolean(nextMeta.onFire),
      fire_progress: Math.max(0, Math.min(100, Math.round(Number(nextMeta.fireProgress || 0)))),
      elevation: Math.max(0, Math.round(Number(metaValue(nextMeta, 'elevation') || 0))),
    });
  }

  if (updated > 0 || deleted > 0) {
    const municipality = await getMunicipalityById(municipalityId);
    if (municipality) {
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-disaster-debug');
    }
  }

  return {
    updated,
    deleted,
    changes,
    disasterType: type,
    intensity,
    meteor_restore_entries: Array.from(meteorRestoreById.values()),
    ...disasterMeta,
  };
}

// =========================
// WebSocket (Socket.io) im Core-Server
// =========================
const wsRoomPlayers = new Map(); // Map<roomKey, Map<playerId, { id, name, socketId, joinedAt, isViewOnly }>>
const wsRoomAuthoritativeStats = new Map(); // Map<roomKey, { revision, updatedAt, stats }>
const wsRoomAvatars = new Map(); // Map<roomKey, Map<avatarId, AvatarState>>
const wsRoomMetadata = new Map(); // Map<roomKey, { municipalityId, municipalitySlug, municipalityName, roomCode }>

// ─── Messenger: globale Zuordnung userId → Set<socketId> ───
const wsUserSockets = new Map(); // Map<number(userId), Set<string(socketId)>>
function wsRegisterUserSocket(userId, socketId) {
  if (!userId || !socketId) return;
  if (!wsUserSockets.has(userId)) wsUserSockets.set(userId, new Set());
  wsUserSockets.get(userId).add(socketId);
}
function wsUnregisterUserSocket(userId, socketId) {
  if (!userId || !socketId) return;
  const sockets = wsUserSockets.get(userId);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) wsUserSockets.delete(userId);
}
function wsEmitToUser(ioInstance, userId, event, data) {
  const sockets = wsUserSockets.get(userId);
  if (!sockets || sockets.size === 0) return false;
  for (const sid of sockets) {
    const s = ioInstance.sockets?.sockets?.get(sid);
    if (s) s.emit(event, data);
  }
  return true;
}

function wsRoomKey(municipalitySlug, roomCode) {
  return `${String(municipalitySlug || 'default').toLowerCase()}:${normalizeRoomCode(roomCode) || 'MAIN'}`;
}

function wsParseRoomKey(roomKey) {
  const raw = String(roomKey || '');
  const idx = raw.indexOf(':');
  if (idx <= 0) return { municipalitySlug: 'default', roomCode: 'MAIN' };
  return {
    municipalitySlug: raw.slice(0, idx).toLowerCase(),
    roomCode: normalizeRoomCode(raw.slice(idx + 1)) || 'MAIN',
  };
}

function wsGetRoomPlayerList(roomKey) {
  const players = wsRoomPlayers.get(roomKey);
  if (!players) return [];
  return Array.from(players.values())
    .filter((p) => !p.isViewOnly)
    .map((p) => ({
      id: p.id,
      name: p.name,
      isLocal: false,
      isViewOnly: !!p.isViewOnly,
    }));
}

function wsGetRoomAvatars(roomKey) {
  const avatars = wsRoomAvatars.get(roomKey);
  if (!avatars) return [];
  return Array.from(avatars.values());
}

function wsClampTile(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function wsSanitizeAvatarPath(path) {
  if (!Array.isArray(path)) return [];
  const out = [];
  for (const step of path) {
    const x = wsClampTile(step?.x);
    const y = wsClampTile(step?.y);
    if (x === null || y === null) continue;
    out.push({ x, y });
    if (out.length >= 2048) break;
  }
  return out;
}

function wsNormalizeAvatarColor(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const hex = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : fallback;
}

function wsSanitizeAvatarConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const normalizeAvatarFigure = (value, fallback) => {
    const rawFigure = String(value || '').trim();
    if (!rawFigure) return fallback;
    if (!/^[a-z]{2,3}-[0-9]+(?:-[0-9]+)*(?:\.[a-z]{2,3}-[0-9]+(?:-[0-9]+)*)*$/i.test(rawFigure)) {
      return fallback;
    }
    return rawFigure;
  };
  const headShape = src.headShape === 'square' ? 'square' : 'round';
  const eyeStyle = src.eyeStyle === 'line' || src.eyeStyle === 'big' ? src.eyeStyle : 'dot';
  const hatStyle =
    src.hatStyle === 'cap' || src.hatStyle === 'beanie' || src.hatStyle === 'crown'
      ? src.hatStyle
      : 'none';
  const hairStyle =
    src.hairStyle === 'none' || src.hairStyle === 'long' || src.hairStyle === 'mohawk'
      ? src.hairStyle
      : 'short';
  // Motto: optional string, max 100 chars, sanitized
  const motto = typeof src.motto === 'string' ? src.motto.slice(0, 100) : undefined;

  const result = {
    headShape,
    eyeStyle,
    hatStyle,
    hairStyle,
    figure: normalizeAvatarFigure(src.figure, 'hd-180-1.hr-828-61.ch-210-66.lg-270-82.sh-290-80'),
    skinColor: wsNormalizeAvatarColor(src.skinColor, '#f0c8a0'),
    shirtColor: wsNormalizeAvatarColor(src.shirtColor, '#7c3aed'),
    pantsColor: wsNormalizeAvatarColor(src.pantsColor, '#312e81'),
    hatColor: wsNormalizeAvatarColor(src.hatColor, '#7c3aed'),
    hairColor: wsNormalizeAvatarColor(src.hairColor, '#2d1b12'),
    eyeColor: wsNormalizeAvatarColor(src.eyeColor, '#1f2937'),
  };
  if (motto !== undefined) result.motto = motto;
  return result;
}

function wsMapStatsToRealtimePayload(rawStats) {
  const shaped = toStatsApiShape(rawStats || {});
  return {
    money: Number(shaped.finances?.money || 0),
    population: Number(shaped.population?.current || 0),
    income: Number(shaped.finances?.income || 0),
    expenses: Number(shaped.finances?.expenses || 0),
    jobs: Number(shaped.employment?.jobs || 0),
    happiness: Number(shaped.happiness?.overall || 50),
    tick: Number(shaped.time?.tick || 0),
    taxRate: Number(shaped.finances?.tax_rate || 10),
    gameSpeed: Number(shaped.time?.speed || 1),
    year: Number(rawStats?.year || 2026),
    month: Number(rawStats?.month || 1),
    gameMapData: shaped.game_map_data || null,
  };
}

async function wsPublishAuthoritativeStats(io, roomKey, sourcePlayerId = null) {
  const { municipalitySlug, roomCode } = wsParseRoomKey(roomKey);
  const municipality = await getMunicipalityBySlug(municipalitySlug);
  if (!municipality) return false;
  const rawStats = await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);
  const payloadBase = wsMapStatsToRealtimePayload(rawStats || {});
  const prev = wsRoomAuthoritativeStats.get(roomKey);
  const revision = (prev?.revision || 0) + 1;
  const payload = {
    ...payloadBase,
    revision,
    serverTimestamp: Date.now(),
    sourcePlayerId,
  };
  // Idle-Earnings aus recompute uebernehmen (einmalig beim ersten Join)
  if (rawStats && rawStats._idle_earnings) {
    payload.idle_earnings = rawStats._idle_earnings;
    payload.idle_days = rawStats._idle_days || 0;
    // Einmalig: nach dem Broadcast entfernen, damit es nicht erneut gesendet wird
    delete rawStats._idle_earnings;
    delete rawStats._idle_days;
  }
  // Meilenstein-Boni mitsenden (einmalig)
  if (rawStats && rawStats._milestones_awarded) {
    payload.milestones_awarded = rawStats._milestones_awarded;
    delete rawStats._milestones_awarded;
  }
  // Neue Economy-Felder mitsenden
  payload.tax_income = Number(rawStats?.tax_income || 0);
  payload.building_income = Number(rawStats?.building_income || 0);
  wsRoomAuthoritativeStats.set(roomKey, {
    revision,
    updatedAt: payload.serverTimestamp,
    stats: payload,
  });
  io.to(roomKey).emit('stats-authoritative', payload);
  return true;
}

function formatGameItemRow(row) {
  const metadata = toJsonValue(row.metadata);
  const state = extractItemState(metadata);
  return {
    id: row.id,
    action_type: row.action_type,
    tool: row.tool,
    zone_type: row.zone_type,
    x: row.x,
    y: row.y,
    player_id: row.player_id,
    user_id: row.user_id,
    version: row.version,
    metadata,
    ...state,
  };
}

async function fetchItemDetails(tool) {
  ensureDbEnabled();
  const fallbackItemDetails = {
    water_tower: {
      tool: 'water_tower',
      display_name: 'Water Tower',
      category: 'infrastructure',
      footprint_width: 1,
      footprint_height: 1,
      build_cost: 1000,
      price: 1000,
      build_time_seconds: 60,
      requires_power: 0,
      requires_water: 0,
      is_active: 1,
      updated_at: new Date().toISOString(),
    },
  };

  // Spalten-Liste: upgrade_build_time_seconds und pollution koennen fehlen wenn Migrationen 016/017 noch nicht gelaufen sind.
  // In dem Fall fangen wir den Fehler ab und lassen die Spalten weg.
  let hasUpgradeColumn = true;
  const colsFull = 'tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, daily_income, pollution, build_cost AS price, build_time_seconds, upgrade_build_time_seconds, requires_power, requires_water, is_active, updated_at';
  const colsSafe = 'tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, daily_income, build_cost AS price, build_time_seconds, requires_power, requires_water, is_active, updated_at';

  if (tool) {
    let rows;
    try {
      [rows] = await dbPool.query(
        `SELECT ${colsFull} FROM game_item_details WHERE tool = ? LIMIT 1`,
        [tool]
      );
    } catch (e) {
      hasUpgradeColumn = false;
      [rows] = await dbPool.query(
        `SELECT ${colsSafe} FROM game_item_details WHERE tool = ? LIMIT 1`,
        [tool]
      );
    }
    const row = rows[0] || null;
    if (row) return row;
    return fallbackItemDetails[tool] || null;
  }
  let rows;
  try {
    [rows] = await dbPool.query(
      `SELECT ${colsFull} FROM game_item_details WHERE is_active = 1 ORDER BY category ASC, tool ASC`
    );
  } catch (e) {
    hasUpgradeColumn = false;
    [rows] = await dbPool.query(
      `SELECT ${colsSafe} FROM game_item_details WHERE is_active = 1 ORDER BY category ASC, tool ASC`
    );
  }
  const list = Array.isArray(rows) ? rows.slice() : [];
  const existingTools = new Set(list.map((r) => String(r.tool)));
  for (const fallback of Object.values(fallbackItemDetails)) {
    if (!existingTools.has(fallback.tool)) {
      list.push(fallback);
    }
  }
  return list;
}

function toDisplayNameFromTool(tool) {
  return String(tool || '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function ensureItemDetailExists(tool, metadata = null) {
  ensureDbEnabled();
  const normalizedTool = String(tool || '').trim();
  if (!normalizedTool) return null;

  let detail = await fetchItemDetails(normalizedTool);
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const footprintWidth = Math.max(1, Math.round(Number(meta.footprintWidth ?? 1)));
  const footprintHeight = Math.max(1, Math.round(Number(meta.footprintHeight ?? 1)));
  const inferredCategory = inferCategoryFromTool(normalizedTool, String(meta.category || 'general'));
  const estimatedCost = estimateDefaultBuildCost(normalizedTool, meta, footprintWidth, footprintHeight, inferredCategory);

  if (detail) {
    const currentCost = Math.max(0, Math.round(toFiniteNumber(detail.build_cost, 0)));
    // Falls alte Datensaetze mit 0-Kosten existieren: automatisch hochziehen.
    if (currentCost <= 0 && estimatedCost > 0) {
      await dbPool.query(
        `UPDATE game_item_details
         SET build_cost = ?, category = COALESCE(NULLIF(category, ''), ?), updated_at = CURRENT_TIMESTAMP
         WHERE tool = ?`,
        [estimatedCost, inferredCategory, normalizedTool]
      );
      detail = await fetchItemDetails(normalizedTool);
    }
    return detail;
  }


  // Pollution-Wert aus BUILDING_STATS (hardcoded Client-Daten) lesen
  const hardcodedPollution = HARD_CODED_BUILDING_STATS.get(normalizedTool);
  const pollutionVal = hardcodedPollution ? Math.round(Number(hardcodedPollution.pollution || 0)) : 0;

  try {
    await dbPool.query(
      `INSERT INTO game_item_details (
        tool, display_name, category, footprint_width, footprint_height, build_cost, pollution, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
        display_name = VALUES(display_name),
        category = VALUES(category),
        footprint_width = VALUES(footprint_width),
        footprint_height = VALUES(footprint_height),
        build_cost = CASE
          WHEN COALESCE(build_cost, 0) <= 0 THEN VALUES(build_cost)
          ELSE build_cost
        END,
        pollution = VALUES(pollution),
        is_active = 1,
        updated_at = CURRENT_TIMESTAMP`,
      [normalizedTool, toDisplayNameFromTool(normalizedTool), inferredCategory, footprintWidth, footprintHeight, estimatedCost, pollutionVal]
    );
  } catch (_e) {
    // Fallback wenn pollution-Spalte noch nicht existiert (Migration 017)
    await dbPool.query(
      `INSERT INTO game_item_details (
        tool, display_name, category, footprint_width, footprint_height, build_cost, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
        display_name = VALUES(display_name),
        category = VALUES(category),
        footprint_width = VALUES(footprint_width),
        footprint_height = VALUES(footprint_height),
        build_cost = CASE
          WHEN COALESCE(build_cost, 0) <= 0 THEN VALUES(build_cost)
          ELSE build_cost
        END,
        is_active = 1,
        updated_at = CURRENT_TIMESTAMP`,
      [normalizedTool, toDisplayNameFromTool(normalizedTool), inferredCategory, footprintWidth, footprintHeight, estimatedCost]
    );
  }

  detail = await fetchItemDetails(normalizedTool);
  return detail;
}

async function fetchItemCatalogVersion() {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT UNIX_TIMESTAMP(MAX(updated_at)) AS catalog_version
     FROM game_item_details
     WHERE is_active = 1`
  );
  return Number(rows[0]?.catalog_version || 0);
}

async function fetchCatalogPages() {
  ensureDbEnabled();
  try {
    const [rows] = await dbPool.query(
      `SELECT id, parent_id, caption, slug, icon_image, sort_order
       FROM catalog_pages
       WHERE visible = 1
       ORDER BY sort_order ASC, caption ASC`
    );
    return Array.isArray(rows) ? rows : [];
  } catch (_e) {
    // Tabelle existiert noch nicht (Migration 019 nicht gelaufen)
    return [];
  }
}

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

  const newVersion = inserted > 0 || updated > 0 || deleted > 0
    ? version
    : await getRoomItemVersion(municipalityId, roomCode);

  return { inserted, updated, deleted, unchanged, newVersion };
}

function seededHash(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
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
  await createOrGetRoom(municipality.id, roomCode, municipality.name, null);
  const room = await getRoom(municipality.id, roomCode);
  const roomState = toJsonValue(room?.game_state);
  const isNavigatorPublic = Boolean(roomCode.startsWith('PUB') || roomState?.navigator_public === true);
  const roomSize = Math.max(6, Math.min(12, Math.round(Number(roomState?.room_size || 8))));
  const existingRows = await getRoomItemRows(municipality.id, roomCode);
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
      version: await getRoomItemVersion(municipality.id, roomCode),
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
    const imported = await importRoomItems(municipality.id, roomCode, 'public-room-marker', null, marker);
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
  const imported = await importRoomItems(municipality.id, roomCode, 'terrain', null, items);

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
  const rows = await getRoomItemRows(municipality.id, roomCode);
  const version = await getRoomItemVersion(municipality.id, roomCode);
  const formattedItems = rows.map(formatGameItemRow);
  const existingMap = await getGameMapForMunicipality(municipality.id);
  const savedBodies = toJsonValue(existingMap?.water_bodies);
  const waterItems = formattedItems.filter(
    (i) => i.action_type === 'place' && i.tool === 'water'
  );
  const waterBodies = buildWaterBodiesFromItems(waterItems, 50, savedBodies);

  await upsertGameMapForMunicipality(municipality.id, {
    gridSize: 50,
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

async function upsertPartnership({
  municipalityId,
  partnerMunicipalityId,
  status = 'discovered',
  direction = null,
  tradeIncome = 0,
  connectionBonusPaid = false,
  discoveredAt = null,
  connectedAt = null,
}) {
  ensureDbEnabled();
  await dbPool.query(
    `INSERT INTO game_partnerships
      (municipality_id, partner_municipality_id, status, direction, trade_income, connection_bonus_paid, discovered_at, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      direction = COALESCE(VALUES(direction), direction),
      trade_income = VALUES(trade_income),
      connection_bonus_paid = VALUES(connection_bonus_paid),
      discovered_at = COALESCE(discovered_at, VALUES(discovered_at)),
      connected_at = COALESCE(VALUES(connected_at), connected_at),
      updated_at = CURRENT_TIMESTAMP`,
    [
      municipalityId,
      partnerMunicipalityId,
      normalizePartnershipStatus(status),
      normalizeDirection(direction),
      Number(tradeIncome || 0),
      connectionBonusPaid ? 1 : 0,
      discoveredAt,
      connectedAt,
    ]
  );
}

async function getPartnershipRow(municipalityId, partnerMunicipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT *
     FROM game_partnerships
     WHERE municipality_id = ? AND partner_municipality_id = ?
     LIMIT 1`,
    [municipalityId, partnerMunicipalityId]
  );
  return rows[0] || null;
}

async function listPartnershipRows(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT
      p.id, p.status, p.direction, p.trade_income, p.connection_bonus_paid, p.discovered_at, p.connected_at,
      m.id AS partner_id, m.name AS partner_name, m.slug AS partner_slug, m.canton_code AS partner_canton
     FROM game_partnerships p
     INNER JOIN municipalities m ON m.id = p.partner_municipality_id
     WHERE p.municipality_id = ?
     ORDER BY m.name ASC`,
    [municipalityId]
  );
  return Array.isArray(rows) ? rows : [];
}

async function ensureAchievementTables() {
  ensureDbEnabled();
  await dbPool.query(
    `CREATE TABLE IF NOT EXISTS achievements (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      code VARCHAR(64) NOT NULL,
      title VARCHAR(160) NOT NULL,
      description TEXT NULL,
      goal_type VARCHAR(64) NOT NULL,
      goal_value BIGINT NOT NULL DEFAULT 1,
      reward_xp INT NOT NULL DEFAULT 0,
      reward_money BIGINT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_code (code),
      KEY idx_active_order (is_active, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await dbPool.query(
    `CREATE TABLE IF NOT EXISTS achievement_user (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      municipality_id BIGINT UNSIGNED NOT NULL,
      achievement_id BIGINT UNSIGNED NOT NULL,
      progress_value BIGINT NOT NULL DEFAULT 0,
      achieved TINYINT(1) NOT NULL DEFAULT 0,
      achieved_at TIMESTAMP NULL DEFAULT NULL,
      claimed TINYINT(1) NOT NULL DEFAULT 0,
      claimed_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_user_municipality_achievement (user_id, municipality_id, achievement_id),
      KEY idx_user_scope (user_id, municipality_id),
      KEY idx_achievement_scope (achievement_id, municipality_id),
      CONSTRAINT fk_achievement_user_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_achievement_user_municipality FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
      CONSTRAINT fk_achievement_user_achievement FOREIGN KEY (achievement_id) REFERENCES achievements(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

async function seedAchievementsCatalog() {
  ensureDbEnabled();
  await ensureAchievementTables();
  for (const def of DEFAULT_ACHIEVEMENTS) {
    await dbPool.query(
      `INSERT INTO achievements
        (code, title, description, goal_type, goal_value, reward_xp, reward_money, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         description = VALUES(description),
         goal_type = VALUES(goal_type),
         goal_value = VALUES(goal_value),
         reward_xp = VALUES(reward_xp),
         reward_money = VALUES(reward_money),
         is_active = 1,
         sort_order = VALUES(sort_order),
         updated_at = CURRENT_TIMESTAMP`,
      [
        String(def.code),
        String(def.title),
        String(def.description || ''),
        String(def.goal_type),
        Number(def.goal_value || 0),
        Number(def.reward_xp || 0),
        Number(def.reward_money || 0),
        Number(def.sort_order || 0),
      ]
    );
  }
}

async function getAchievementProgressSnapshot(municipalityId, roomCode) {
  const safeRoomCode = normalizeRoomCode(roomCode) || 'MAIN';
  const stats = await recomputeAuthoritativePopulationAndJobs(municipalityId, safeRoomCode);
  const partnerships = await listPartnershipRows(municipalityId);
  const connectedPartnerships = partnerships.filter((row) => String(row.status) === 'connected').length;

  const [buildingRows] = await dbPool.query(
    `SELECT
       COUNT(*) AS building_count,
       SUM(
         CASE WHEN LOWER(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.buildingType')), ''), NULLIF(tool, ''), '')) = 'city_hall'
           THEN 1 ELSE 0
         END
       ) AS city_hall_count
     FROM game_items
     WHERE municipality_id = ?
       AND room_code = ?
       AND action_type IN ('place', 'zone')
       AND LOWER(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.buildingType')), ''), NULLIF(tool, ''), '')) NOT IN ('', 'empty', 'grass', 'water')`,
    [municipalityId, safeRoomCode]
  );
  const row = Array.isArray(buildingRows) && buildingRows.length > 0 ? buildingRows[0] : {};
  const buildingCount = Number(row.building_count || 0);
  const cityHallCount = Number(row.city_hall_count || 0);

  return {
    room_code: safeRoomCode,
    population: Number(stats?.population || 0),
    jobs: Number(stats?.jobs || 0),
    money: Number(stats?.money || 0),
    connected_partnerships: connectedPartnerships,
    building_count: buildingCount,
    city_hall_count: cityHallCount,
  };
}

async function syncUserAchievements(userId, municipalityId, roomCode = 'MAIN') {
  ensureDbEnabled();
  await seedAchievementsCatalog();
  const [achievementRows] = await dbPool.query(
    `SELECT id, code, title, description, goal_type, goal_value, reward_xp, reward_money, is_active, sort_order
     FROM achievements
     WHERE is_active = 1
     ORDER BY sort_order ASC, id ASC`
  );
  const achievements = Array.isArray(achievementRows) ? achievementRows : [];
  if (achievements.length <= 0) {
    return { room_code: normalizeRoomCode(roomCode) || 'MAIN', achievements: [] };
  }

  const progress = await getAchievementProgressSnapshot(municipalityId, roomCode);
  const values = [];
  const params = [];
  for (const ach of achievements) {
    const goalType = String(ach.goal_type || '').trim();
    const goalValue = Math.max(1, Number(ach.goal_value || 1));
    const currentValue = Math.max(0, Number(progress[goalType] || 0));
    const achieved = currentValue >= goalValue ? 1 : 0;
    values.push('(?, ?, ?, ?, ?)');
    params.push(Number(userId), Number(municipalityId), Number(ach.id), currentValue, achieved);
  }
  if (values.length > 0) {
    await dbPool.query(
      `INSERT INTO achievement_user (user_id, municipality_id, achievement_id, progress_value, achieved)
       VALUES ${values.join(', ')}
       ON DUPLICATE KEY UPDATE
         progress_value = VALUES(progress_value),
         achieved = GREATEST(achievement_user.achieved, VALUES(achieved)),
         achieved_at = CASE
           WHEN achievement_user.achieved_at IS NULL AND VALUES(achieved) = 1 THEN CURRENT_TIMESTAMP
           ELSE achievement_user.achieved_at
         END,
         updated_at = CURRENT_TIMESTAMP`,
      params
    );
  }

  const [userRows] = await dbPool.query(
    `SELECT achievement_id, progress_value, achieved, achieved_at, claimed, claimed_at
     FROM achievement_user
     WHERE user_id = ? AND municipality_id = ?`,
    [Number(userId), Number(municipalityId)]
  );
  const byAchievementId = new Map();
  for (const row of Array.isArray(userRows) ? userRows : []) {
    byAchievementId.set(Number(row.achievement_id), row);
  }

  const result = achievements.map((ach) => {
    const row = byAchievementId.get(Number(ach.id)) || null;
    const goalValue = Math.max(1, Number(ach.goal_value || 1));
    const currentValue = Math.max(0, Number(row?.progress_value || 0));
    const achieved = Boolean(row?.achieved);
    const claimed = Boolean(row?.claimed);
    return {
      id: Number(ach.id),
      code: String(ach.code || ''),
      title: String(ach.title || ''),
      description: String(ach.description || ''),
      goal_type: String(ach.goal_type || ''),
      goal_value: goalValue,
      progress_value: currentValue,
      progress_percent: Math.min(100, Math.round((currentValue / goalValue) * 100)),
      reward_xp: Number(ach.reward_xp || 0),
      reward_money: Number(ach.reward_money || 0),
      achieved,
      achieved_at: row?.achieved_at || null,
      claimed,
      claimed_at: row?.claimed_at || null,
    };
  });

  return {
    room_code: progress.room_code,
    achievements: result,
  };
}

async function claimAchievementForUser({ userId, municipalityId, achievementCode, roomCode = 'MAIN' }) {
  ensureDbEnabled();
  const synced = await syncUserAchievements(userId, municipalityId, roomCode);
  const targetCode = String(achievementCode || '').trim().toLowerCase();
  const target = synced.achievements.find((entry) => String(entry.code || '').toLowerCase() === targetCode);
  if (!target) {
    return { ok: false, status: 404, error: 'Achievement nicht gefunden' };
  }
  if (!target.achieved) {
    return { ok: false, status: 409, error: 'Achievement noch nicht erreicht', achievement: target };
  }
  if (target.claimed) {
    return {
      ok: true,
      already_claimed: true,
      room_code: synced.room_code,
      achievement: target,
      reward_money_applied: 0,
      updated_stats: null,
    };
  }

  await dbPool.query(
    `UPDATE achievement_user
     SET claimed = 1,
         claimed_at = COALESCE(claimed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND municipality_id = ? AND achievement_id = ?`,
    [Number(userId), Number(municipalityId), Number(target.id)]
  );

  let updatedStats = null;
  const rewardMoney = Math.max(0, Number(target.reward_money || 0));
  if (rewardMoney > 0) {
    const rawStats = (await loadRoomStats(municipalityId, synced.room_code)) || {};
    const nextStats = { ...rawStats };
    nextStats.money = Math.max(0, Number(nextStats.money || 0) + rewardMoney);
    nextStats.achievement_rewards_total = Math.max(0, Number(nextStats.achievement_rewards_total || 0) + rewardMoney);
    await saveRoomStats(municipalityId, synced.room_code, nextStats);
    updatedStats = await recomputeAuthoritativePopulationAndJobs(municipalityId, synced.room_code);
  }

  let xpResult = null;
  const rewardXp = Math.max(0, Number(target.reward_xp || 0));
  if (rewardXp > 0) {
    xpResult = await awardXp(
      userId, rewardXp, 'achievement_claim',
      `Achievement: ${target.title}`, 'achievement', target.id
    );
  }

  const refreshed = await syncUserAchievements(userId, municipalityId, synced.room_code);
  const refreshedTarget = refreshed.achievements.find((entry) => Number(entry.id) === Number(target.id)) || target;
  return {
    ok: true,
    already_claimed: false,
    room_code: synced.room_code,
    achievement: refreshedTarget,
    reward_money_applied: rewardMoney,
    reward_xp_applied: rewardXp,
    xp: xpResult,
    updated_stats: updatedStats,
  };
}

function toPartnershipDto(row) {
  return {
    id: Number(row.id),
    partner: {
      id: Number(row.partner_id),
      name: row.partner_name,
      slug: row.partner_slug,
      canton: row.partner_canton || undefined,
      population: 0,
    },
    status: row.status === 'connected' ? 'connected' : 'discovered',
    direction: normalizeDirection(row.direction) || 'north',
    trade_income: Number(row.trade_income || 0),
    connection_bonus_paid: Boolean(row.connection_bonus_paid),
    discovered_at: row.discovered_at || null,
    connected_at: row.connected_at || null,
  };
}

async function listPartnershipRequestsForMunicipality(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT
      r.id, r.from_municipality_id, r.to_municipality_id, r.status, r.message, r.created_at, r.responded_at,
      fm.name AS from_name, fm.slug AS from_slug, fm.canton_code AS from_canton,
      tm.name AS to_name, tm.slug AS to_slug
     FROM game_partnership_requests r
     INNER JOIN municipalities fm ON fm.id = r.from_municipality_id
     INNER JOIN municipalities tm ON tm.id = r.to_municipality_id
     WHERE r.from_municipality_id = ? OR r.to_municipality_id = ?
     ORDER BY r.created_at DESC`,
    [municipalityId, municipalityId]
  );
  return Array.isArray(rows) ? rows : [];
}

async function getPartnershipRequestById(requestId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT *
     FROM game_partnership_requests
     WHERE id = ?
     LIMIT 1`,
    [requestId]
  );
  return rows[0] || null;
}

function toPartnershipRequestDto(row, fromOwner = null) {
  return {
    id: Number(row.id),
    from_municipality: {
      id: Number(row.from_municipality_id),
      name: row.from_name,
      slug: row.from_slug,
      canton: row.from_canton || undefined,
      population: 0,
      owner: fromOwner
        ? { id: Number(fromOwner.id), nickname: fromOwner.nickname }
        : null,
    },
    to_municipality: {
      id: Number(row.to_municipality_id),
      name: row.to_name,
      slug: row.to_slug,
    },
    status: ['accepted', 'declined', 'pending'].includes(String(row.status))
      ? row.status
      : 'pending',
    message: row.message || undefined,
    created_at: row.created_at,
    responded_at: row.responded_at || undefined,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = requestUrl.pathname;

    if (req.method === 'OPTIONS') {
      const hasAllowedOrigin = applyCorsHeaders(req, res);
      if (!hasAllowedOrigin && req.headers.origin) {
        res.writeHead(403);
        return res.end();
      }
      const requestHeaders = req.headers['access-control-request-headers'];
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': requestHeaders || 'Content-Type,Authorization,X-Game-Token',
      });
      return res.end();
    }

    const hasAllowedOrigin = applyCorsHeaders(req, res);
    if (!hasAllowedOrigin && req.headers.origin) {
      return sendJson(res, 403, { success: false, error: 'Origin nicht erlaubt' });
    }

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, phase: 1, service: 'auth-server' });
    }

    if (req.method === 'GET' && pathname === '/api/municipalities') {
      const municipalities = await fetchMunicipalities();
      return sendJson(res, 200, { ok: true, municipalities, member_limit: MUNICIPALITY_MEMBER_LIMIT });
    }

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

    const cantonMatch = pathname.match(/^\/api\/game\/canton\/([a-z]{2})$/i);
    if (req.method === 'GET' && cantonMatch) {
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

    if (req.method === 'GET' && pathname === '/api/game/switzerland') {
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

    if (req.method === 'GET' && pathname === '/api/game/municipalities/search') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const q = String(requestUrl.searchParams.get('q') || '');
      const limit = Number(requestUrl.searchParams.get('limit') || 500);
      const municipalities = await searchMunicipalitiesForPartnerships(q, limit);
      return sendJson(res, 200, {
        success: true,
        data: {
          municipalities,
          count: municipalities.length,
        },
      });
    }

    if (pathname === '/api/game/public-maps' && (req.method === 'GET' || req.method === 'POST')) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const resolvedGlobalRole = await getUserGlobalRole(authUser.id);
      const resolvedUserRank = await getUserRankValue(authUser.id);
      let hasMunicipalityCreateRights = false;
      try {
        const ownMunicipalityId = Number(authUser.municipality_id || 0);
        if (ownMunicipalityId > 0) {
          const municipalityRole = await getUserMunicipalityRole(authUser.id, ownMunicipalityId);
          hasMunicipalityCreateRights =
            municipalityRole === MUNICIPALITY_ROLE_OWNER || municipalityRole === MUNICIPALITY_ROLE_COUNCIL;
        }
      } catch {
        hasMunicipalityCreateRights = false;
      }
      const canCreateMaps =
        // Public Rooms sollen fuer alle eingeloggten Nutzer erstellbar sein.
        true ||
        Number(resolvedUserRank || 0) >= 7 ||
        String(resolvedGlobalRole || '').toLowerCase() === GLOBAL_ROLE_ADMINISTRATOR ||
        hasMunicipalityCreateRights;

      if (req.method === 'GET') {
        const q = String(requestUrl.searchParams.get('q') || '');
        const limit = Number(requestUrl.searchParams.get('limit') || 60);
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
        return sendJson(res, 403, { success: false, error: 'Nur Admins duerfen neue Maps erstellen' });
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
          // naechsten freien PUB-Code waehlen, damit wirklich neue Rooms entstehen.
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
        return sendJson(res, 500, {
          success: false,
          error: 'Interner Serverfehler',
          detail: `Public-Map create fehlgeschlagen: ${message}`,
        });
      }
    }

    if (pathname === '/api/game/user-data/avatar-config' && (req.method === 'GET' || req.method === 'PUT')) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      if (req.method === 'GET') {
        const avatarConfig = await getUserAvatarConfig(authUser.id);
        return sendJson(res, 200, {
          success: true,
          data: {
            user_id: Number(authUser.id),
            avatar_config: avatarConfig,
          avatar_figure: String(avatarConfig?.figure || ''),
          },
        });
      }

      const body = await readJsonBody(req);
      const avatarConfig = await upsertUserAvatarConfig(authUser.id, body?.avatar_config || body || {});
      return sendJson(res, 200, {
        success: true,
        data: {
          user_id: Number(authUser.id),
          avatar_config: avatarConfig,
          avatar_figure: String(avatarConfig?.figure || ''),
          message: 'Avatar-Konfiguration gespeichert',
        },
      });
    }

    // Inventory PATCH: Wird vom mapGame-Client beim Furni-Platzieren genutzt (Menge reduzieren).
    // GET/PUT/DELETE entfernt – Inventar-UI läuft über den Bobba-Client (WebSocket).
    if (pathname === '/api/game/user-data/inventory' && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });

      const body = await readJsonBody(req);
      const itemCode = normalizeInventoryItemCode(body?.item_code || body?.itemCode || body?.code);
      if (!itemCode) {
        return sendJson(res, 422, { success: false, error: 'item_code ist erforderlich' });
      }

      const delta = Math.round(Number(body?.delta || 0));
      if (!Number.isFinite(delta) || delta === 0) {
        return sendJson(res, 422, { success: false, error: 'delta muss ungleich 0 sein' });
      }
      const metadata = body?.metadata && typeof body.metadata === 'object' ? body.metadata : null;
      const item = await adjustUserInventoryItem(authUser.id, itemCode, delta, metadata);
      return sendJson(res, 200, {
        success: true,
        data: {
          user_id: Number(authUser.id),
          item,
          delta,
          message: 'Inventar angepasst',
        },
      });
    }

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

    const municipalityCoatOfArmsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/coat-of-arms$/i);
    if (municipalityCoatOfArmsMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const slug = municipalityCoatOfArmsMatch[1].toLowerCase();
      const municipality = await getMunicipalityBySlug(slug);
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const userRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (userRole !== MUNICIPALITY_ROLE_OWNER && userRole !== MUNICIPALITY_ROLE_COUNCIL) {
        return sendJson(res, 403, { success: false, error: 'Nur Besitzer oder Verwaltung duerfen das Wappen aendern' });
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
        return sendJson(res, 422, { success: false, error: 'png_data_url muss ein gueltiges data:image/png;base64 sein' });
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
          return sendJson(res, 400, { success: false, error: String(err?.message || err) });
        }
      }

      if (req.method === 'GET') {
        // Minimap-Bild direkt als PNG liefern
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
            bfs_number: '',
            canton: municipality.canton_code,
            canton_full: municipality.canton_name,
            postal_code: '',
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

    const municipalityAdministrationMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/administration$/i);
    if (municipalityAdministrationMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityAdministrationMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const administration = await getMunicipalityAdministration(municipality.id);
      return sendJson(res, 200, { success: true, data: administration });
    }

    const municipalityAdministrationRoleMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/administration\/members\/([0-9]+)\/role$/i);
    if (municipalityAdministrationRoleMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityAdministrationRoleMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }

      const requesterRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canManageMunicipality(requesterRole)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung Rollen zu aendern' });
      }

      const targetUserId = Number(municipalityAdministrationRoleMatch[2]);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return sendJson(res, 422, { success: false, error: 'user_id ungueltig' });
      }
      const body = await readJsonBody(req);
      const requestedRole = normalizeMunicipalityRole(body?.role);
      const allowedRoles = [MUNICIPALITY_ROLE_COUNCIL, MUNICIPALITY_ROLE_CITIZEN, MUNICIPALITY_ROLE_OBSERVER];
      if (!allowedRoles.includes(requestedRole)) {
        return sendJson(res, 422, { success: false, error: 'Ungueltige Rolle' });
      }
      // Council darf nur citizen/observer vergeben, nicht council
      if (requesterRole === MUNICIPALITY_ROLE_COUNCIL && requestedRole === MUNICIPALITY_ROLE_COUNCIL) {
        return sendJson(res, 403, { success: false, error: 'Gemeinderat kann keine weiteren Gemeinderaete ernennen' });
      }

      const targetRole = await getUserMunicipalityRole(targetUserId, municipality.id);
      if (!targetRole) {
        return sendJson(res, 404, { success: false, error: 'Mitglied nicht gefunden' });
      }
      if (targetRole === MUNICIPALITY_ROLE_OWNER) {
        return sendJson(res, 422, { success: false, error: 'Gemeindepraesident-Rolle kann nicht geaendert werden' });
      }
      // Council darf keine gleichrangigen oder hoeheren Raenge aendern
      if (requesterRole === MUNICIPALITY_ROLE_COUNCIL && municipalityRoleRank(targetRole) <= municipalityRoleRank(MUNICIPALITY_ROLE_COUNCIL)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung dieses Mitglied zu aendern' });
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

    const municipalityRoomsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/rooms$/i);
    if (municipalityRoomsMatch && req.method === 'POST') {
      const municipality = await getMunicipalityBySlug(municipalityRoomsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const body = await readJsonBody(req);
      const roomCode = normalizeRoomCode(body.room_code);
      if (!roomCode) return sendJson(res, 422, { success: false, error: 'room_code ungueltig' });
      const room = await createOrGetRoom(municipality.id, roomCode, String(body.city_name || municipality.name), body.game_state || null);
      return sendJson(res, 200, { success: true, data: room });
    }

    const municipalityRoomMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/rooms\/([a-z0-9-]+)$/i);
    if (municipalityRoomMatch && req.method === 'PUT') {
      const municipality = await getMunicipalityBySlug(municipalityRoomMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const roomCode = normalizeRoomCode(municipalityRoomMatch[2]);
      const body = await readJsonBody(req);
      const room = await updateRoomState(municipality.id, roomCode, body.game_state || null);
      return sendJson(res, 200, { success: true, data: room });
    }

    const zoneSettingsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/zone-settings$/i);
    if (zoneSettingsMatch && (req.method === 'GET' || req.method === 'PUT')) {
      ensureDbEnabled();
      const slug = zoneSettingsMatch[1].toLowerCase();
      const municipality = await getMunicipalityBySlug(slug);
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (req.method === 'GET') {
        const roomCode = normalizeRoomCode(new URL(req.url, `http://${req.headers.host}`).searchParams.get('room_code') || 'main');
        try {
          const [rows] = await dbPool.query(
            `SELECT bauzone_mode FROM municipality_zone_settings WHERE municipality_id = ? AND room_code = ? LIMIT 1`,
            [municipality.id, roomCode]
          );
          const mode = (Array.isArray(rows) && rows.length > 0) ? rows[0].bauzone_mode : 'disabled';
          return sendJson(res, 200, { ok: true, data: { bauzone_mode: mode } });
        } catch {
          return sendJson(res, 200, { ok: true, data: { bauzone_mode: 'disabled' } });
        }
      }
      if (req.method === 'PUT') {
        if (Number(authUser.municipality_id) !== Number(municipality.id)) {
          return sendJson(res, 403, { ok: false, error: 'Keine Berechtigung' });
        }
        const userRole = await getUserMunicipalityRole(authUser.id, municipality.id);
        if (!canManageMunicipality(userRole)) {
          return sendJson(res, 403, { ok: false, error: 'Nur Owner/Council' });
        }
        const body = await readJsonBody(req);
        const mode = ['disabled', 'members', 'all'].includes(body.bauzone_mode) ? body.bauzone_mode : 'disabled';
        const roomCode = normalizeRoomCode(body.room_code || 'main');
        await dbPool.query(
          `INSERT INTO municipality_zone_settings (municipality_id, room_code, bauzone_mode) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE bauzone_mode = VALUES(bauzone_mode)`,
          [municipality.id, roomCode, mode]
        );
        return sendJson(res, 200, { ok: true, data: { bauzone_mode: mode } });
      }
    }

    const municipalityDeltasPostMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/deltas$/i);
    if (municipalityDeltasPostMatch && req.method === 'POST') {
      const municipality = await getMunicipalityBySlug(municipalityDeltasPostMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        logInfo('SECURITY', `User ${authUser.id} versuchte Deltas fuer Gemeinde ${municipality.slug} zu senden (eigene municipality_id: ${authUser.municipality_id})`);
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const deltasUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(deltasUserRole)) {
        return sendJson(res, 403, { success: false, error: 'Beobachter duerfen die Map nicht veraendern' });
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
      const now = new Date();
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
      let _bauzoneMode = 'disabled';
      try {
        const [mzsRows] = await dbPool.query(
          `SELECT bauzone_mode FROM municipality_zone_settings WHERE municipality_id = ? AND room_code = ? LIMIT 1`,
          [municipality.id, roomCode]
        );
        if (Array.isArray(mzsRows) && mzsRows.length > 0) _bauzoneMode = mzsRows[0].bauzone_mode;
      } catch {}
      const userMustFollowBauzone = shouldEnforceBauzone(deltasUserRole, _bauzoneMode);
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
        if (!['place', 'zone', 'bulldoze', 'bauzone'].includes(type)) continue;
        if ((type === 'place' || type === 'zone' || type === 'bulldoze' || type === 'bauzone') && (!Number.isInteger(x) || !Number.isInteger(y))) {
          continue;
        }
        if (type === 'bauzone') {
          if (!canManageBauzones(deltasUserRole)) {
            rejectedDeltas.push({ type: 'bauzone', x, y, reason: 'insufficient_permission' });
            continue;
          }
          const enabled = delta.enabled !== false;
          if (!enabled) {
            await dbPool.query(
              `DELETE FROM game_items WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'bauzone'`,
              [municipality.id, roomCode, x, y]
            );
          } else {
            await dbPool.query(
              `DELETE FROM game_items WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'bauzone'`,
              [municipality.id, roomCode, x, y]
            );
            version += 1;
            await dbPool.query(
              `INSERT INTO game_items
               (municipality_id, room_code, player_id, user_id, action_type, tool, zone_type, x, y, version, client_timestamp, applied_at, metadata)
               VALUES (?, ?, ?, ?, 'bauzone', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
              [
                municipality.id, roomCode, clientId, authUser.id,
                x, y, version,
                delta.timestamp || null, now,
                JSON.stringify({ enabled: true }),
              ]
            );
          }
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
          // Kein platziertes Objekt auf dem Feld -> kein Abriss, keine Kosten.
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
        if (type === 'place') {
          const tool = String(persistedTool || '').trim();
          if (!tool) continue;
          const normalizedTool = tool.toLowerCase();
          const isTerrainTool = normalizedTool.startsWith('terrain_');
          const isPaintTool = normalizedTool.startsWith('paint_');

          if (!userCanBypassBauzone) {
            const hasBauzones = await bauzoneExistsForRoom();
            if (hasBauzones) {
              const [tileBZ] = await dbPool.query(
                `SELECT 1 FROM game_items WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'bauzone' LIMIT 1`,
                [municipality.id, roomCode, x, y]
              );
              if (!Array.isArray(tileBZ) || tileBZ.length === 0) {
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
            }
            await dbPool.query(
              `DELETE FROM game_items
               WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type IN ('place','zone')`,
              [municipality.id, roomCode, x, y]
            );
            mapChanged = true;
          }
        }
        if (type === 'zone') {
          const normalizedZone = String(persistedZone || '').trim().toLowerCase();
          if (!userCanBypassBauzone) {
            const hasBauzonesZ = await bauzoneExistsForRoom();
            if (hasBauzonesZ) {
              const [tileBZZ] = await dbPool.query(
                `SELECT 1 FROM game_items WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'bauzone' LIMIT 1`,
                [municipality.id, roomCode, x, y]
              );
              if (!Array.isArray(tileBZZ) || tileBZZ.length === 0) {
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
          if (!hasBuildingType || shouldReplaceStarter || shouldReplaceInvalid) {
            const randomizedTool = pickRandomZoneBuildingType(normalizedZone);
            if (randomizedTool) {
              persistedMetadata.buildingType = randomizedTool;
            }
          }
          if (typeof persistedMetadata.constructionProgress !== 'number') {
            persistedMetadata.constructionProgress = 0;
          }
          if (typeof persistedMetadata.constructed !== 'boolean') {
            persistedMetadata.constructed = false;
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

      if (statsChanged) {
        await saveRoomStats(municipality.id, roomCode, statsSnapshot);
        const totalCost = originalMoney - currentMoney;
        if (totalCost > 0) {
          await applyMunicipalityTransaction(municipality.id, {
            amount: -totalCost,
            type: 'building_cost',
            meta: { roomCode, deltasApplied: applied },
            actorUserId: authUser?.id || null,
            source: 'user',
          });
        } else {
          await setMunicipalityTreasury(municipality.id, currentMoney);
        }
      }

      await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);

      if (mapChanged) {
        await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
      }

      const [newRows] = await dbPool.query(
        `SELECT *
         FROM game_items
         WHERE municipality_id = ? AND room_code = ? AND version > ? AND player_id <> ?
         ORDER BY version ASC`,
        [municipality.id, roomCode, clientVersion, clientId]
      );
      const newDeltas = (Array.isArray(newRows) ? newRows : []).map(mapRowToDelta);
      const roomKey = wsRoomKey(municipality.slug, roomCode);
      // Echtzeit: Stats sofort nach Delta-Verarbeitung pushen (nicht erst im 3s-Intervall),
      // damit kein kurzfristiges Zurueckspringen im UI sichtbar ist.
      try {
        await wsPublishAuthoritativeStats(io, roomKey, clientId);
      } catch {
        // API-Antwort darf nicht fehlschlagen, wenn WS-Push gerade nicht verfuegbar ist.
      }

      return sendJson(res, 200, {
        success: true,
        data: {
          serverVersion: await getRoomItemVersion(municipality.id, roomCode),
          appliedDeltas: applied,
          rejectedDeltas,
          conflicts: [],
          newDeltas,
        },
      });
    }

    const municipalityDeltasGetMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/deltas\/([a-z0-9-]+)$/i);
    if (municipalityDeltasGetMatch && req.method === 'GET') {
      const municipality = await getMunicipalityBySlug(municipalityDeltasGetMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const roomCode = normalizeRoomCode(municipalityDeltasGetMatch[2]);
      await runServerDisasterTick(municipality.id, roomCode);
      await runServerBuildingUpgradeTick(municipality.id, roomCode);
      const since = Number(requestUrl.searchParams.get('since') || 0);
      const clientId = String(requestUrl.searchParams.get('client_id') || '');
      const [rows] = await dbPool.query(
        `SELECT *
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

    const municipalityStatsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/stats\/([a-z0-9-]+)$/i);
    if (municipalityStatsMatch) {
      const municipality = await getMunicipalityBySlug(municipalityStatsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const roomCode = normalizeRoomCode(municipalityStatsMatch[2]);
      if (req.method === 'POST') {
        ensureDbEnabled();
        const authUser = await getAuthenticatedUser(req);
        if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
        if (Number(authUser.municipality_id) !== Number(municipality.id)) {
          return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
        }
        const userRole = await getUserMunicipalityRole(authUser.id, municipality.id);
        if (userRole !== MUNICIPALITY_ROLE_OWNER && userRole !== MUNICIPALITY_ROLE_COUNCIL) {
          return sendJson(res, 403, { success: false, error: 'Nur Besitzer oder Verwaltung duerfen Steuern aendern' });
        }

        const body = await readJsonBody(req);
        const incomingTaxRate = Number(body?.taxRate);
        if (!Number.isFinite(incomingTaxRate)) {
          return sendJson(res, 422, { success: false, error: 'taxRate ist erforderlich' });
        }
        const taxRate = Math.max(0, Math.min(100, Math.round(incomingTaxRate)));

        const raw = (await loadRoomStats(municipality.id, roomCode)) || {};
        const next = { ...(raw || {}) };
        next.tax_rate = taxRate;
        next.taxRate = taxRate;

        const mapData = next.game_map_data && typeof next.game_map_data === 'object'
          ? { ...next.game_map_data }
          : {};
        const settings = mapData.settings && typeof mapData.settings === 'object'
          ? { ...mapData.settings }
          : {};
        settings.taxRate = taxRate;
        settings.effectiveTaxRate = Number.isFinite(Number(settings.effectiveTaxRate))
          ? Number(settings.effectiveTaxRate)
          : taxRate;
        mapData.settings = settings;
        next.game_map_data = mapData;

        await saveRoomStats(municipality.id, roomCode, next);
        const recomputed = await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);

        const roomKey = wsRoomKey(municipality.slug, roomCode);
        try {
          await wsPublishAuthoritativeStats(io, roomKey, String(authUser.id));
        } catch {
          // REST-Antwort nicht fehlschlagen lassen, falls WS kurz nicht verfuegbar ist.
        }

        return sendJson(res, 200, { success: true, data: toStatsApiShape(recomputed) });
      }
      if (req.method === 'GET') {
        await runServerDisasterTick(municipality.id, roomCode);
        await runServerBuildingUpgradeTick(municipality.id, roomCode);
        const raw = await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);
        const shaped = toStatsApiShape(raw);
        return sendJson(res, 200, { success: true, data: shaped });
      }
    }

    const municipalityTimeMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/time\/([a-z0-9-]+)$/i);
    if (municipalityTimeMatch && req.method === 'GET') {
      const municipality = await getMunicipalityBySlug(municipalityTimeMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      return sendJson(res, 200, { success: true, data: buildServerTimePayload() });
    }

    const municipalityDisasterTriggerMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/disasters\/([a-z0-9-]+)\/trigger$/i);
    if (municipalityDisasterTriggerMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityDisasterTriggerMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const roomCode = normalizeRoomCode(municipalityDisasterTriggerMatch[2]);
      if (!roomCode) return sendJson(res, 422, { success: false, error: 'room_code ungueltig' });

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
        return sendJson(res, 422, { success: false, error: 'Ungueltiger disaster type' });
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

    const municipalityAchievementsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/achievements$/i);
    if (municipalityAchievementsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityAchievementsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const roomCode = normalizeRoomCode(requestUrl.searchParams.get('room_code') || 'MAIN') || 'MAIN';
      const synced = await syncUserAchievements(authUser.id, municipality.id, roomCode);
      const total = synced.achievements.length;
      const achieved = synced.achievements.filter((a) => a.achieved).length;
      const claimed = synced.achievements.filter((a) => a.claimed).length;
      return sendJson(res, 200, {
        success: true,
        data: {
          room_code: synced.room_code,
          achievements: synced.achievements,
          totals: { total, achieved, claimed },
        },
      });
    }

    const municipalityAchievementClaimMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/achievements\/([a-z0-9_-]+)\/claim$/i);
    if (municipalityAchievementClaimMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityAchievementClaimMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const body = await readJsonBody(req);
      const roomCode = normalizeRoomCode(body?.room_code || 'MAIN') || 'MAIN';
      const result = await claimAchievementForUser({
        userId: authUser.id,
        municipalityId: municipality.id,
        achievementCode: municipalityAchievementClaimMatch[2],
        roomCode,
      });
      if (!result.ok) {
        return sendJson(res, result.status || 400, {
          success: false,
          error: result.error || 'Achievement konnte nicht geclaimed werden',
          achievement: result.achievement || null,
        });
      }
      if (result.updated_stats) {
        const roomKey = wsRoomKey(municipality.slug, result.room_code || roomCode);
        try {
          await wsPublishAuthoritativeStats(io, roomKey, String(authUser.id));
        } catch {
          // Antwort nicht fehlschlagen lassen, wenn WS kurzzeitig nicht verfuegbar ist.
        }
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          room_code: result.room_code,
          achievement: result.achievement,
          already_claimed: Boolean(result.already_claimed),
          reward_money_applied: Number(result.reward_money_applied || 0),
          updated_stats: result.updated_stats ? toStatsApiShape(result.updated_stats) : null,
        },
      });
    }

    const municipalityItemsConstructedMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/items\/constructed$/i);
    if (municipalityItemsConstructedMatch && req.method === 'PATCH') {
      const municipality = await getMunicipalityBySlug(municipalityItemsConstructedMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        logInfo('SECURITY', `User ${authUser.id} versuchte Construction-Sync fuer Gemeinde ${municipality.slug} (eigene municipality_id: ${authUser.municipality_id})`);
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const constructUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(constructUserRole)) {
        return sendJson(res, 403, { success: false, error: 'Beobachter duerfen die Map nicht veraendern' });
      }
      const body = await readJsonBody(req);
      const roomCode = normalizeRoomCode(body.room_code);
      const positions = Array.isArray(body.positions) ? body.positions : [];
      const data = await processConstructionSyncAndBroadcast({
        municipality,
        roomCode,
        positions,
        io,
        sourcePlayerId: 'construction-sync-http',
      });
      return sendJson(res, 200, {
        success: true,
        data,
      });
    }

    const municipalityItemsStatsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/items\/stats$/i);
    if (municipalityItemsStatsMatch && req.method === 'GET') {
      const municipality = await getMunicipalityBySlug(municipalityItemsStatsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const roomCode = normalizeRoomCode(requestUrl.searchParams.get('room_code') || '');
      const [rows] = await dbPool.query(
        `SELECT action_type, COUNT(*) AS count
         FROM game_items
         WHERE municipality_id = ? ${roomCode ? 'AND room_code = ?' : ''}
         GROUP BY action_type`,
        roomCode ? [municipality.id, roomCode] : [municipality.id]
      );
      const byType = {};
      for (const row of rows) byType[row.action_type] = Number(row.count);
      return sendJson(res, 200, {
        success: true,
        data: {
          total_items: Object.values(byType).reduce((s, n) => s + Number(n), 0),
          by_type: byType,
        },
      });
    }

    const municipalityPartnershipsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships$/i);
    if (municipalityPartnershipsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const rows = await listPartnershipRows(municipality.id);
      const partnerships = rows.map(toPartnershipDto);
      const discoveredCount = partnerships.filter((p) => p.status === 'discovered').length;
      const connectedCount = partnerships.filter((p) => p.status === 'connected').length;
      const totalTradeIncome = partnerships
        .filter((p) => p.status === 'connected')
        .reduce((sum, p) => sum + Number(p.trade_income || 0), 0);
      return sendJson(res, 200, {
        success: true,
        data: {
          partnerships,
          total_trade_income: totalTradeIncome,
          discovered_count: discoveredCount,
          connected_count: connectedCount,
        },
      });
    }

    const municipalityPartnershipsDiscoverMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/discover$/i);
    if (municipalityPartnershipsDiscoverMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipsDiscoverMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const body = await readJsonBody(req);
      const direction = normalizeDirection(body.direction) || 'north';
      const partnerSlug = String(body.partner_slug || '').trim().toLowerCase();
      let partner = partnerSlug ? await getMunicipalityBySlug(partnerSlug) : null;
      if (!partner && body.partner_name) {
        const [rows] = await dbPool.query(
          `SELECT id, name, slug, canton_code, canton_name
           FROM municipalities
           WHERE LOWER(name) = LOWER(?)
           LIMIT 1`,
          [String(body.partner_name).trim()]
        );
        partner = rows[0] || null;
      }
      if (!partner) return sendJson(res, 404, { success: false, error: 'Partner-Gemeinde nicht gefunden' });
      if (Number(partner.id) === Number(municipality.id)) {
        return sendJson(res, 422, { success: false, error: 'Partnerschaft mit sich selbst nicht moeglich' });
      }
      const existing = await getPartnershipRow(municipality.id, partner.id);
      if (!existing) {
        const now = new Date();
        await upsertPartnership({
          municipalityId: municipality.id,
          partnerMunicipalityId: partner.id,
          status: 'discovered',
          direction,
          tradeIncome: 0,
          connectionBonusPaid: false,
          discoveredAt: now,
          connectedAt: null,
        });
        await upsertPartnership({
          municipalityId: partner.id,
          partnerMunicipalityId: municipality.id,
          status: 'discovered',
          direction: oppositeDirection(direction),
          tradeIncome: 0,
          connectionBonusPaid: false,
          discoveredAt: now,
          connectedAt: null,
        });
      }
      const row = await getPartnershipRow(municipality.id, partner.id);
      const dto = toPartnershipDto({
        ...row,
        partner_id: partner.id,
        partner_name: partner.name,
        partner_slug: partner.slug,
        partner_canton: partner.canton_code,
      });
      const municipalityOwner = await getMunicipalityOwner(municipality.id);
      const partnerOwner = await getMunicipalityOwner(partner.id);
      if (municipalityOwner?.id && Number(municipalityOwner.id) !== Number(authUser.id)) {
        await createUserNotification(
          municipalityOwner.id,
          'partnership_discovered',
          'Neue Handelspartnerschaft entdeckt',
          `${partner.name} wurde als potenzieller Handelspartner entdeckt.`,
          { municipality_slug: municipality.slug, partner_slug: partner.slug, direction }
        );
      }
      if (partnerOwner?.id) {
        await createUserNotification(
          partnerOwner.id,
          'partnership_discovered_by_other',
          'Gemeinde hat dich entdeckt',
          `${municipality.name} hat deine Gemeinde als Handelspartner entdeckt.`,
          { municipality_slug: municipality.slug, partner_slug: partner.slug, direction: oppositeDirection(direction) }
        );
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          partnership: dto,
          already_discovered: Boolean(existing),
          message: existing ? 'Partnerschaft bereits entdeckt' : 'Partnerschaft entdeckt',
        },
      });
    }

    const municipalityPartnershipsConnectMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/([a-z0-9-]+)\/connect$/i);
    if (municipalityPartnershipsConnectMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipsConnectMatch[1].toLowerCase());
      const partner = await getMunicipalityBySlug(municipalityPartnershipsConnectMatch[2].toLowerCase());
      if (!municipality || !partner) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const existing = await getPartnershipRow(municipality.id, partner.id);
      const isAlreadyConnected = existing && existing.status === 'connected';
      const monthlyIncome = Number(existing?.trade_income || 200);
      const bonusPaid = isAlreadyConnected || existing?.connection_bonus_paid ? 0 : 5000;
      const now = new Date();
      const direction = normalizeDirection(existing?.direction) || 'north';

      await upsertPartnership({
        municipalityId: municipality.id,
        partnerMunicipalityId: partner.id,
        status: 'connected',
        direction,
        tradeIncome: monthlyIncome,
        connectionBonusPaid: true,
        discoveredAt: existing?.discovered_at || now,
        connectedAt: now,
      });
      await upsertPartnership({
        municipalityId: partner.id,
        partnerMunicipalityId: municipality.id,
        status: 'connected',
        direction: oppositeDirection(direction),
        tradeIncome: monthlyIncome,
        connectionBonusPaid: true,
        discoveredAt: now,
        connectedAt: now,
      });

      const row = await getPartnershipRow(municipality.id, partner.id);
      const dto = toPartnershipDto({
        ...row,
        partner_id: partner.id,
        partner_name: partner.name,
        partner_slug: partner.slug,
        partner_canton: partner.canton_code,
      });
      const municipalityOwner = await getMunicipalityOwner(municipality.id);
      const partnerOwner = await getMunicipalityOwner(partner.id);
      if (municipalityOwner?.id) {
        await createUserNotification(
          municipalityOwner.id,
          'partnership_connected',
          'Handelsroute aktiv',
          `Die Handelsroute mit ${partner.name} ist jetzt aktiv.`,
          { municipality_slug: municipality.slug, partner_slug: partner.slug, monthly_income: monthlyIncome, bonus_paid: bonusPaid }
        );
      }
      if (partnerOwner?.id) {
        await createUserNotification(
          partnerOwner.id,
          'partnership_connected',
          'Handelsroute aktiv',
          `Die Handelsroute mit ${municipality.name} ist jetzt aktiv.`,
          { municipality_slug: partner.slug, partner_slug: municipality.slug, monthly_income: monthlyIncome, bonus_paid: bonusPaid }
        );
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          partnership: dto,
          already_connected: Boolean(isAlreadyConnected),
          bonus_paid: bonusPaid,
          monthly_income: monthlyIncome,
          message: isAlreadyConnected ? 'Handelsroute bereits aktiv' : 'Handelsroute erfolgreich etabliert',
        },
      });
    }

    const municipalityPartnershipsTradeIncomeMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/trade-income$/i);
    if (municipalityPartnershipsTradeIncomeMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipsTradeIncomeMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const rows = (await listPartnershipRows(municipality.id)).filter((r) => r.status === 'connected');
      const list = rows.map((r) => ({
        partner_name: r.partner_name,
        partner_slug: r.partner_slug,
        income: Number(r.trade_income || 0),
      }));
      const totalMonthlyIncome = list.reduce((sum, p) => sum + Number(p.income), 0);
      return sendJson(res, 200, {
        success: true,
        data: {
          total_monthly_income: totalMonthlyIncome,
          partnerships: list,
          partnership_count: list.length,
        },
      });
    }

    const municipalityPartnershipRequestsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/requests$/i);
    if (municipalityPartnershipRequestsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipRequestsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const rows = await listPartnershipRequestsForMunicipality(municipality.id);
      const incoming = [];
      const outgoing = [];
      for (const row of rows) {
        const fromOwner = await getMunicipalityOwner(row.from_municipality_id);
        const dto = toPartnershipRequestDto(row, fromOwner);
        if (Number(row.to_municipality_id) === Number(municipality.id)) incoming.push(dto);
        if (Number(row.from_municipality_id) === Number(municipality.id)) outgoing.push(dto);
      }
      return sendJson(res, 200, { success: true, data: { incoming, outgoing } });
    }

    if (municipalityPartnershipRequestsMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipRequestsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const body = await readJsonBody(req);
      const targetSlug = String(body.target_slug || '').trim().toLowerCase();
      const target = await getMunicipalityBySlug(targetSlug);
      if (!target) return sendJson(res, 404, { success: false, error: 'Ziel-Gemeinde nicht gefunden' });
      const targetOwner = await getMunicipalityOwner(target.id);
      if (!targetOwner?.id) {
        return sendJson(res, 422, { success: false, error: 'Ziel-Gemeinde hat keinen aktiven Besitzer' });
      }
      if (Number(target.id) === Number(municipality.id)) {
        return sendJson(res, 422, { success: false, error: 'Anfrage an eigene Gemeinde nicht moeglich' });
      }
      const [dupRows] = await dbPool.query(
        `SELECT id
         FROM game_partnership_requests
         WHERE from_municipality_id = ? AND to_municipality_id = ? AND status = 'pending'
         LIMIT 1`,
        [municipality.id, target.id]
      );
      if (Array.isArray(dupRows) && dupRows.length > 0) {
        return sendJson(res, 409, { success: false, error: 'Anfrage bereits offen' });
      }
      const message = String(body.message || '').trim().slice(0, 500);
      const [result] = await dbPool.query(
        `INSERT INTO game_partnership_requests (from_municipality_id, to_municipality_id, from_user_id, status, message)
         VALUES (?, ?, ?, 'pending', ?)`,
        [municipality.id, target.id, authUser.id, message || null]
      );
      const [rows] = await dbPool.query(
        `SELECT
          r.id, r.from_municipality_id, r.to_municipality_id, r.status, r.message, r.created_at, r.responded_at,
          fm.name AS from_name, fm.slug AS from_slug, fm.canton_code AS from_canton,
          tm.name AS to_name, tm.slug AS to_slug
         FROM game_partnership_requests r
         INNER JOIN municipalities fm ON fm.id = r.from_municipality_id
         INNER JOIN municipalities tm ON tm.id = r.to_municipality_id
         WHERE r.id = ?
         LIMIT 1`,
        [result.insertId]
      );
      const row = rows[0];
      const fromOwner = await getMunicipalityOwner(municipality.id);
      const dto = toPartnershipRequestDto(row, fromOwner);
      if (targetOwner?.id) {
        await createUserNotification(
          targetOwner.id,
          'partnership_request_incoming',
          `Neue Partnerschaftsanfrage von ${municipality.name}`,
          message || `Die Gemeinde ${municipality.name} moechte eine Partnerschaft aufbauen.`,
          { request_id: Number(row.id), from_slug: municipality.slug, to_slug: target.slug }
        );
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          request: dto,
          message: 'Partnerschaftsanfrage gesendet',
        },
      });
    }

    const municipalityPartnershipRequestRespondMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/requests\/([0-9]+)\/(accept|decline)$/i);
    if (municipalityPartnershipRequestRespondMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipRequestRespondMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const requestId = Number(municipalityPartnershipRequestRespondMatch[2]);
      const action = municipalityPartnershipRequestRespondMatch[3].toLowerCase();
      const requestRow = await getPartnershipRequestById(requestId);
      if (!requestRow) return sendJson(res, 404, { success: false, error: 'Anfrage nicht gefunden' });
      if (String(requestRow.status) !== 'pending') {
        return sendJson(res, 409, { success: false, error: 'Anfrage bereits bearbeitet' });
      }
      if (Number(requestRow.to_municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Anfrage gehoert nicht zu dieser Gemeinde' });
      }

      const newStatus = action === 'accept' ? 'accepted' : 'declined';
      await dbPool.query(
        `UPDATE game_partnership_requests
         SET status = ?, responder_user_id = ?, responded_at = NOW(), updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [newStatus, authUser.id, requestId]
      );

      const [requestRows] = await dbPool.query(
        `SELECT
          r.id, r.from_municipality_id, r.to_municipality_id, r.status, r.message, r.created_at, r.responded_at,
          fm.name AS from_name, fm.slug AS from_slug, fm.canton_code AS from_canton,
          tm.name AS to_name, tm.slug AS to_slug
         FROM game_partnership_requests r
         INNER JOIN municipalities fm ON fm.id = r.from_municipality_id
         INNER JOIN municipalities tm ON tm.id = r.to_municipality_id
         WHERE r.id = ?
         LIMIT 1`,
        [requestId]
      );
      const dto = toPartnershipRequestDto(requestRows[0], await getMunicipalityOwner(requestRows[0].from_municipality_id));
      let partnershipDto = null;
      if (newStatus === 'accepted') {
        const monthlyIncome = 200;
        const now = new Date();
        const fromMunicipalityId = Number(requestRows[0].from_municipality_id);
        const toMunicipalityId = Number(requestRows[0].to_municipality_id);
        const existingForward = await getPartnershipRow(fromMunicipalityId, toMunicipalityId);
        const existingReverse = await getPartnershipRow(toMunicipalityId, fromMunicipalityId);
        const inferredFromReverse = normalizeDirection(oppositeDirection(existingReverse?.direction));
        const forwardDirection = normalizeDirection(existingForward?.direction) || inferredFromReverse || 'north';
        const reverseDirection = normalizeDirection(oppositeDirection(forwardDirection))
          || normalizeDirection(existingReverse?.direction)
          || 'south';
        await upsertPartnership({
          municipalityId: fromMunicipalityId,
          partnerMunicipalityId: toMunicipalityId,
          status: 'connected',
          direction: forwardDirection,
          tradeIncome: monthlyIncome,
          connectionBonusPaid: true,
          discoveredAt: existingForward?.discovered_at || now,
          connectedAt: now,
        });
        await upsertPartnership({
          municipalityId: toMunicipalityId,
          partnerMunicipalityId: fromMunicipalityId,
          status: 'connected',
          direction: reverseDirection,
          tradeIncome: monthlyIncome,
          connectionBonusPaid: true,
          discoveredAt: existingReverse?.discovered_at || now,
          connectedAt: now,
        });
        const toMunicipality = await getMunicipalityById(toMunicipalityId);
        const row = await getPartnershipRow(fromMunicipalityId, toMunicipalityId);
        partnershipDto = toPartnershipDto({
          ...row,
          partner_id: toMunicipality.id,
          partner_name: toMunicipality.name,
          partner_slug: toMunicipality.slug,
          partner_canton: toMunicipality.canton_code,
        });
      }

      const fromOwner = await getMunicipalityOwner(requestRows[0].from_municipality_id);
      if (fromOwner?.id) {
        await createUserNotification(
          fromOwner.id,
          newStatus === 'accepted' ? 'partnership_request_accepted' : 'partnership_request_declined',
          newStatus === 'accepted' ? 'Partnerschaftsanfrage akzeptiert' : 'Partnerschaftsanfrage abgelehnt',
          `${requestRows[0].to_name} hat deine Anfrage ${newStatus === 'accepted' ? 'angenommen' : 'abgelehnt'}.`,
          { request_id: requestId, status: newStatus }
        );
      }

      return sendJson(res, 200, {
        success: true,
        data: {
          request: dto,
          partnership: partnershipDto || undefined,
          message: newStatus === 'accepted' ? 'Anfrage akzeptiert' : 'Anfrage abgelehnt',
        },
      });
    }

    const municipalityChatMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/chat$/i);
    if (municipalityChatMatch) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityChatMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }

      if (req.method === 'GET') {
        const limit = Number(requestUrl.searchParams.get('limit') || 10);
        const before = Number(requestUrl.searchParams.get('before') || 0);
        const after = Number(requestUrl.searchParams.get('after') || 0);
        const owner = await getMunicipalityOwner(municipality.id);
        const ownerUserId = Number(owner?.id || 0);
        const roleByUserId = await getMunicipalityRoleMap(municipality.id);
        const result = await listMunicipalityChatMessages(municipality.id, { limit, before, after });
        const messages = result.rows.map((row) => mapChatMessageRowToDto(row, ownerUserId, roleByUserId));
        return sendJson(res, 200, {
          success: true,
          data: {
            messages,
            has_more: result.hasMore,
            municipality: {
              id: Number(municipality.id),
              name: municipality.name,
              slug: municipality.slug,
            },
          },
        });
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const messageText = String(body.message || '').trim();
        if (!messageText) return sendJson(res, 422, { success: false, error: 'Nachricht darf nicht leer sein' });
        const messageId = await createMunicipalityChatMessage({
          municipalityId: municipality.id,
          userId: authUser.id,
          message: messageText,
          replyToId: body.reply_to_id,
          ipAddress: req.socket?.remoteAddress || null,
          userAgent: req.headers['user-agent'] || null,
        });
        const owner = await getMunicipalityOwner(municipality.id);
        const ownerUserId = Number(owner?.id || 0);
        const roleByUserId = await getMunicipalityRoleMap(municipality.id);
        const row = await getMunicipalityChatMessageRowById(municipality.id, messageId);
        if (!row) {
          return sendJson(res, 500, { success: false, error: 'Interner Serverfehler', detail: 'Chat-Nachricht konnte nach Insert nicht geladen werden' });
        }
        const dto = mapChatMessageRowToDto(row, ownerUserId, roleByUserId);
        io.to(wsRoomKey(municipality.slug, 'MAIN')).emit('chat-message', {
          type: 'created',
          municipality_slug: municipality.slug,
          message: dto,
          serverTimestamp: Date.now(),
        });
        return sendJson(res, 200, { success: true, data: { message: dto } });
      }
    }

    const municipalityChatLogsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/chat\/logs$/i);
    if (municipalityChatLogsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityChatLogsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const owner = await getMunicipalityOwner(municipality.id);
      if (Number(owner?.id || 0) !== Number(authUser.id)) {
        return sendJson(res, 403, { success: false, error: 'Nur Eigentuemer darf Chat-Logs sehen' });
      }
      const limit = Number(requestUrl.searchParams.get('limit') || 100);
      const rows = await listMunicipalityChatLogs(municipality.id, limit);
      const logs = rows.map((row) => ({
        id: Number(row.id),
        message_id: Number(row.message_id),
        user: {
          id: Number(row.user_id),
          name: row.user_name || `User #${Number(row.user_id)}`,
        },
        action: row.action,
        old_content: row.old_content || null,
        new_content: row.new_content || null,
        ip_address: row.ip_address || null,
        created_at: row.created_at,
      }));
      return sendJson(res, 200, { success: true, data: { logs } });
    }

    const municipalityChatMessageMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/chat\/([0-9]+)$/i);
    if (municipalityChatMessageMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityChatMessageMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const messageId = Number(municipalityChatMessageMatch[2]);
      const row = await getMunicipalityChatMessageRowById(municipality.id, messageId);
      if (!row) return sendJson(res, 404, { success: false, error: 'Nachricht nicht gefunden' });
      const owner = await getMunicipalityOwner(municipality.id);
      const requesterRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      const canModerate = Number(owner?.id || 0) === Number(authUser.id) || requesterRole === MUNICIPALITY_ROLE_COUNCIL;
      const isOwnMessage = Number(row.user_id) === Number(authUser.id);
      if (!canModerate && !isOwnMessage) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Nachricht' });
      }

      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const newMessage = String(body.message || '').trim();
        if (!newMessage) return sendJson(res, 422, { success: false, error: 'Nachricht darf nicht leer sein' });
        await updateMunicipalityChatMessage({
          municipalityId: municipality.id,
          messageId,
          userId: authUser.id,
          newMessage,
          ipAddress: req.socket?.remoteAddress || null,
          userAgent: req.headers['user-agent'] || null,
        });
        const updatedRow = await getMunicipalityChatMessageRowById(municipality.id, messageId);
        if (!updatedRow) {
          return sendJson(res, 500, { success: false, error: 'Interner Serverfehler', detail: 'Chat-Nachricht konnte nach Update nicht geladen werden' });
        }
        const ownerUserId = Number(owner?.id || 0);
        const roleByUserId = await getMunicipalityRoleMap(municipality.id);
        const dto = mapChatMessageRowToDto(updatedRow, ownerUserId, roleByUserId);
        io.to(wsRoomKey(municipality.slug, 'MAIN')).emit('chat-message', {
          type: 'edited',
          municipality_slug: municipality.slug,
          message: dto,
          serverTimestamp: Date.now(),
        });
        return sendJson(res, 200, {
          success: true,
          data: {
            message: {
              id: dto.id,
              message: dto.message,
              is_edited: dto.is_edited,
              edited_at: dto.edited_at,
            },
          },
        });
      }

      await softDeleteMunicipalityChatMessage({
        municipalityId: municipality.id,
        messageId,
        userId: authUser.id,
        ipAddress: req.socket?.remoteAddress || null,
        userAgent: req.headers['user-agent'] || null,
      });
      io.to(wsRoomKey(municipality.slug, 'MAIN')).emit('chat-message', {
        type: 'deleted',
        municipality_slug: municipality.slug,
        message_id: messageId,
        serverTimestamp: Date.now(),
      });
      return sendJson(res, 200, { success: true, data: { message: 'Nachricht geloescht', deleted_id: messageId } });
    }

    if (req.method === 'GET' && pathname === '/api/notifications') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const unreadOnly = requestUrl.searchParams.get('unread_only') === '1';
      const [rows] = await dbPool.query(
        `SELECT id, notification_type, title, message, payload, is_read, created_at, read_at
         FROM user_notifications
         WHERE user_id = ? ${unreadOnly ? 'AND is_read = 0' : ''}
         ORDER BY created_at DESC
         LIMIT 200`,
        [authUser.id]
      );
      const notifications = (Array.isArray(rows) ? rows : []).map((row) => ({
        id: Number(row.id),
        notification_type: row.notification_type,
        title: row.title,
        message: row.message,
        payload: toJsonValue(row.payload),
        is_read: Boolean(row.is_read),
        created_at: row.created_at,
        read_at: row.read_at || null,
      }));
      return sendJson(res, 200, { success: true, data: { notifications, count: notifications.length } });
    }

    const notificationReadMatch = pathname.match(/^\/api\/notifications\/([0-9]+)\/read$/i);
    if (notificationReadMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const notificationId = Number(notificationReadMatch[1]);
      const [result] = await dbPool.query(
        `UPDATE user_notifications
         SET is_read = 1, read_at = NOW()
         WHERE id = ? AND user_id = ?`,
        [notificationId, authUser.id]
      );
      return sendJson(res, 200, { success: true, data: { updated: Number(result.affectedRows || 0) } });
    }

    // ── XP & LEVEL API ────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/xp/me') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const xpData = await getUserXp(authUser.id);
      const nextLevelXp = xpData.level < XP_LEVEL_CAP ? xpForLevel(xpData.level + 1) : null;
      return sendJson(res, 200, {
        ok: true,
        data: {
          total_xp: xpData.total_xp,
          level: xpData.level,
          max_level: XP_LEVEL_CAP,
          next_level_xp: nextLevelXp,
          xp_to_next: nextLevelXp ? nextLevelXp - xpData.total_xp : 0,
          login_streak: xpData.login_streak,
          best_streak: xpData.best_streak,
          last_login_date: xpData.last_login_date,
        },
      });
    }

    if (req.method === 'GET' && pathname === '/api/xp/log') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const limit = Math.min(100, Math.max(1, Number(requestUrl.searchParams.get('limit')) || 20));
      const [rows] = await dbPool.query(
        `SELECT id, xp_amount, reason, description, ref_type, ref_id, total_after, level_after, created_at
         FROM user_xp_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
        [authUser.id, limit]
      );
      return sendJson(res, 200, { ok: true, data: { log: rows } });
    }

    if (req.method === 'GET' && pathname === '/api/xp/leaderboard') {
      ensureDbEnabled();
      const limit = Math.min(50, Math.max(1, Number(requestUrl.searchParams.get('limit')) || 20));
      const [rows] = await dbPool.query(
        `SELECT ux.user_id, u.nickname, ux.total_xp, ux.level, ux.login_streak
         FROM user_xp ux
         JOIN users u ON u.id = ux.user_id AND u.is_active = 1
         ORDER BY ux.total_xp DESC
         LIMIT ?`,
        [limit]
      );
      return sendJson(res, 200, { ok: true, data: { leaderboard: rows } });
    }

    if (req.method === 'POST' && pathname === '/api/xp/daily-login') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const result = await processDailyLogin(authUser.id);
      if (!result) return sendJson(res, 200, { ok: true, data: { already_claimed: true } });
      return sendJson(res, 200, { ok: true, data: result });
    }

    // ── BUENZLI EVENT API ────────────────────────────────────
    if (!BUENZLI_EVENTS_ENABLED && (pathname.startsWith('/api/events') || pathname.startsWith('/api/inspections'))) {
      return sendJson(res, 503, { ok: false, error: 'Bünzli Event-System ist deaktiviert' });
    }

    // ── INSPECTIONS API ────────────────────────────────────

    // POST /api/inspections/start — Neue Inspektion starten
    if (req.method === 'POST' && pathname === '/api/inspections/start') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugeordnet' });

      const body = await readJsonBody(req);
      const tileX = Number(body.tile_x);
      const tileY = Number(body.tile_y);
      if (isNaN(tileX) || isNaN(tileY)) {
        return sendJson(res, 400, { ok: false, error: 'tile_x und tile_y erforderlich' });
      }

      // Prüfen ob bereits eine laufende Inspektion existiert
      const [existing] = await dbPool.query(
        `SELECT id, tile_x, tile_y, started_at, completes_at FROM inspections
         WHERE user_id = ? AND status = 'searching' LIMIT 1`,
        [authUser.id]
      );
      if (existing.length > 0) {
        const ex = existing[0];
        const remaining = new Date(ex.completes_at).getTime() - Date.now();
        return sendJson(res, 409, {
          ok: false,
          error: 'Es läuft bereits eine Inspektion',
          data: {
            inspection_id: ex.id,
            tile_x: ex.tile_x,
            tile_y: ex.tile_y,
            remaining_ms: Math.max(0, remaining),
            completes_at: ex.completes_at,
          }
        });
      }

      const now = new Date();
      const completesAt = new Date(now.getTime() + INSPECTION_DURATION_MS);

      const [result] = await dbPool.query(
        `INSERT INTO inspections (user_id, municipality_id, tile_x, tile_y, radius, status, started_at, completes_at)
         VALUES (?, ?, ?, ?, ?, 'searching', ?, ?)`,
        [authUser.id, authUser.municipality_id, tileX, tileY, INSPECTION_RADIUS, now, completesAt]
      );

      return sendJson(res, 200, {
        ok: true,
        data: {
          inspection_id: result.insertId,
          tile_x: tileX,
          tile_y: tileY,
          radius: INSPECTION_RADIUS,
          started_at: now.toISOString(),
          completes_at: completesAt.toISOString(),
          duration_ms: INSPECTION_DURATION_MS,
        }
      });
    }

    // GET /api/inspections/active — Laufende Inspektion des Users
    if (req.method === 'GET' && pathname === '/api/inspections/active') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `SELECT id, tile_x, tile_y, radius, status, started_at, completes_at
         FROM inspections
         WHERE user_id = ? AND status = 'searching'
         ORDER BY started_at DESC LIMIT 1`,
        [authUser.id]
      );

      if (rows.length === 0) {
        return sendJson(res, 200, { ok: true, data: { inspection: null } });
      }

      const insp = rows[0];
      const remaining = new Date(insp.completes_at).getTime() - Date.now();

      // Auto-complete wenn Zeit abgelaufen
      if (remaining <= 0 && insp.status === 'searching') {
        await dbPool.query(
          `UPDATE inspections SET status = 'completed', completed_at = NOW() WHERE id = ?`,
          [insp.id]
        );
        insp.status = 'completed';
      }

      return sendJson(res, 200, {
        ok: true,
        data: {
          inspection: {
            id: insp.id,
            tile_x: insp.tile_x,
            tile_y: insp.tile_y,
            radius: insp.radius,
            status: insp.status,
            started_at: insp.started_at,
            completes_at: insp.completes_at,
            remaining_ms: Math.max(0, remaining),
          }
        }
      });
    }

    // GET /api/inspections/:id/results — Ergebnisse einer abgeschlossenen Inspektion
    const inspResultsMatch = pathname.match(/^\/api\/inspections\/([0-9]+)\/results$/i);
    if (inspResultsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const inspId = Number(inspResultsMatch[1]);
      const [rows] = await dbPool.query(
        `SELECT * FROM inspections WHERE id = ? AND user_id = ?`,
        [inspId, authUser.id]
      );
      if (rows.length === 0) {
        return sendJson(res, 404, { ok: false, error: 'Inspektion nicht gefunden' });
      }

      const insp = rows[0];
      const remaining = new Date(insp.completes_at).getTime() - Date.now();

      // Noch nicht fertig?
      if (remaining > 0) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Inspektion noch nicht abgeschlossen',
          data: { remaining_ms: remaining }
        });
      }

      // Auto-complete
      if (insp.status === 'searching') {
        await dbPool.query(
          `UPDATE inspections SET status = 'completed', completed_at = NOW() WHERE id = ?`,
          [insp.id]
        );
      }

      // Events in der Nähe suchen (server-seitig!)
      const userXp = await getUserXp(authUser.id);
      const [events] = await dbPool.query(
        `SELECT me.id, me.event_type_id, me.status, me.severity, me.confidence,
                me.min_level, me.fix_cost, me.location_x, me.location_y,
                me.room_code, me.affected_item_id, me.building_snapshot,
                me.building_exists, me.building_verified_at,
                me.reported_by, me.resolved_by, me.spawned_at, me.expires_at,
                me.reported_at, me.resolved_at,
                et.code, et.name, et.description, et.emoji, et.category,
                et.company_type_required
         FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         WHERE me.municipality_id = ?
           AND me.status = 'detected'
           AND me.min_level <= ?
           AND me.location_x IS NOT NULL AND me.location_y IS NOT NULL
           AND ABS(me.location_x - ?) <= ?
           AND ABS(me.location_y - ?) <= ?
         ORDER BY me.severity DESC
         LIMIT 20`,
        [insp.municipality_id, userXp.level, insp.tile_x, insp.radius, insp.tile_y, insp.radius]
      );

      const parsedEvents = events.map(r => {
        let snapshot = r.building_snapshot;
        if (snapshot && typeof snapshot === 'string') {
          try { snapshot = JSON.parse(snapshot); } catch (_) {}
        }
        return { ...r, building_snapshot: snapshot };
      });

      return sendJson(res, 200, {
        ok: true,
        data: {
          inspection: {
            id: insp.id,
            tile_x: insp.tile_x,
            tile_y: insp.tile_y,
            radius: insp.radius,
            status: 'completed',
          },
          events: parsedEvents,
          user_level: userXp.level,
        }
      });
    }

    // POST /api/inspections/:id/cancel — Inspektion abbrechen
    const inspCancelMatch = pathname.match(/^\/api\/inspections\/([0-9]+)\/cancel$/i);
    if (inspCancelMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const inspId = Number(inspCancelMatch[1]);
      const [rows] = await dbPool.query(
        `SELECT id, status FROM inspections WHERE id = ? AND user_id = ? AND status = 'searching'`,
        [inspId, authUser.id]
      );
      if (rows.length === 0) {
        return sendJson(res, 404, { ok: false, error: 'Keine laufende Inspektion gefunden' });
      }

      await dbPool.query(
        `UPDATE inspections SET status = 'cancelled', cancelled_at = NOW() WHERE id = ?`,
        [inspId]
      );

      return sendJson(res, 200, { ok: true, data: { cancelled: true } });
    }

    // ── BUENZLI EVENT REPORT mit Inspektions-Prüfung ────────

    if (req.method === 'GET' && pathname === '/api/events') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugeordnet' });
      const userXp = await getUserXp(authUser.id);

      // Fremde Gemeinde besuchen? → nur detected Events zeigen
      const visitingMuniId = Number(requestUrl.searchParams.get('visiting_municipality_id') || 0);
      const targetMuniId = visitingMuniId && visitingMuniId !== authUser.municipality_id
        ? visitingMuniId : authUser.municipality_id;
      const isVisiting = targetMuniId !== authUser.municipality_id;

      const statusFilter = requestUrl.searchParams.get('status') || (isVisiting ? 'detected' : 'detected');
      const validStatuses = isVisiting
        ? ['detected']
        : ['detected', 'reported', 'investigating', 'assigned', 'resolved', 'expired', 'failed', 'false_alarm', 'external_reported', 'disputed'];
      const statuses = statusFilter.split(',').filter(s => validStatuses.includes(s));
      if (statuses.length === 0) return sendJson(res, 400, { ok: false, error: 'Ungueltiger Status-Filter' });
      const placeholders = statuses.map(() => '?').join(',');
      const [rows] = await dbPool.query(
        `SELECT me.id, me.event_type_id, me.status, me.severity, me.confidence,
                me.min_level, me.fix_cost, me.location_x, me.location_y,
                me.room_code, me.affected_item_id, me.building_snapshot,
                me.building_exists, me.building_verified_at,
                me.reported_by, me.resolved_by, me.spawned_at, me.expires_at,
                me.reported_at, me.resolved_at,
                et.code, et.name, et.description, et.emoji, et.category,
                et.company_type_required
         FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         WHERE me.municipality_id = ? AND me.status IN (${placeholders})
           AND me.min_level <= ?
         ORDER BY me.severity DESC, me.spawned_at DESC
         LIMIT 50`,
        [targetMuniId, ...statuses, userXp.level]
      );
      const events = rows.map(r => {
        let snapshot = r.building_snapshot;
        if (snapshot && typeof snapshot === 'string') {
          try { snapshot = JSON.parse(snapshot); } catch (_) {}
        }
        return { ...r, building_snapshot: snapshot };
      });
      return sendJson(res, 200, { ok: true, data: { events, user_level: userXp.level, is_visiting: isVisiting } });
    }

    if (req.method === 'GET' && pathname === '/api/events/types') {
      ensureDbEnabled();
      const [rows] = await dbPool.query(`SELECT * FROM event_types WHERE is_active = 1 ORDER BY category, severity`);
      return sendJson(res, 200, { ok: true, data: { event_types: rows } });
    }

    if (req.method === 'GET' && pathname === '/api/events/stats') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugeordnet' });
      const [stats] = await dbPool.query(
        `SELECT * FROM municipality_stats WHERE municipality_id = ?`, [authUser.municipality_id]
      );
      if (stats.length === 0) return sendJson(res, 200, { ok: true, data: { stats: null } });
      return sendJson(res, 200, { ok: true, data: { stats: stats[0] } });
    }

    const eventReportMatch = pathname.match(/^\/api\/events\/([0-9]+)\/report$/i);
    if (eventReportMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const eventId = Number(eventReportMatch[1]);
      const body = await readJsonBody(req);
      const reportType = body.report_type || 'confirm';
      const comment = body.comment || null;
      const inspectionId = body.inspection_id ? Number(body.inspection_id) : null;

      // Server-seitige Inspektions-Verifizierung
      if (inspectionId) {
        const [inspRows] = await dbPool.query(
          `SELECT i.*, me.location_x AS event_x, me.location_y AS event_y
           FROM inspections i
           LEFT JOIN municipality_events me ON me.id = ?
           WHERE i.id = ? AND i.user_id = ?`,
          [eventId, inspectionId, authUser.id]
        );
        if (inspRows.length === 0) {
          return sendJson(res, 403, { ok: false, error: 'Ungültige Inspektion' });
        }
        const insp = inspRows[0];
        if (new Date(insp.completes_at).getTime() > Date.now()) {
          return sendJson(res, 403, { ok: false, error: 'Inspektion noch nicht abgeschlossen' });
        }
        if (insp.status === 'cancelled') {
          return sendJson(res, 403, { ok: false, error: 'Inspektion wurde abgebrochen' });
        }
        // Proximity-Check: Event muss im Radius der Inspektion liegen
        if (insp.event_x !== null && insp.event_y !== null) {
          const dx = Math.abs(insp.event_x - insp.tile_x);
          const dy = Math.abs(insp.event_y - insp.tile_y);
          if (dx > insp.radius || dy > insp.radius) {
            return sendJson(res, 403, { ok: false, error: 'Event liegt ausserhalb des Inspektions-Radius' });
          }
        }
      }

      try {
        const result = await reportBuenzliEvent(eventId, authUser.id, reportType, comment);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    const eventResolveMatch = pathname.match(/^\/api\/events\/([0-9]+)\/resolve$/i);
    if (eventResolveMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const eventId = Number(eventResolveMatch[1]);
      try {
        const result = await resolveBuenzliEvent(eventId, authUser.id);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // ================================================================
    // COMPANY / FIRMA API ENDPOINTS
    // ================================================================

    // GET /api/companies/types — Alle Firmen-Typen
    if (req.method === 'GET' && pathname === '/api/companies/types') {
      ensureDbEnabled();
      const [rows] = await dbPool.query(`SELECT * FROM company_types WHERE is_active = 1 ORDER BY founding_cost ASC`);
      const types = rows.map(r => ({
        ...r,
        can_fix_categories: typeof r.can_fix_categories === 'string' ? JSON.parse(r.can_fix_categories) : (r.can_fix_categories || []),
      }));
      return sendJson(res, 200, { ok: true, data: { company_types: types } });
    }

    // GET /api/companies/my — Meine Firmen (als Owner oder Member)
    if (req.method === 'GET' && pathname === '/api/companies/my') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const [rows] = await dbPool.query(
        `SELECT c.*, ct.code AS type_code, ct.name AS type_name, ct.emoji AS type_emoji,
                cm.role AS my_role,
                (SELECT COUNT(*) FROM company_members WHERE company_id = c.id) AS member_count
         FROM company_members cm
         JOIN companies c ON c.id = cm.company_id
         JOIN company_types ct ON ct.id = c.company_type_id
         WHERE cm.user_id = ? AND c.is_active = 1
         ORDER BY cm.role = 'owner' DESC, c.name ASC`,
        [authUser.id]
      );
      return sendJson(res, 200, { ok: true, data: { companies: rows } });
    }

    // POST /api/companies — Firma gruenden
    if (req.method === 'POST' && pathname === '/api/companies') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Du musst einer Gemeinde angehoeren' });

      const body = await readJsonBody(req);
      const companyName = String(body.name || '').trim();
      const companyTypeId = Number(body.company_type_id || 0);

      if (!companyName || companyName.length < 3 || companyName.length > 64) {
        return sendJson(res, 422, { ok: false, error: 'Firmenname muss 3-64 Zeichen lang sein' });
      }

      // Firmen-Typ pruefen
      const [types] = await dbPool.query(`SELECT * FROM company_types WHERE id = ? AND is_active = 1`, [companyTypeId]);
      if (types.length === 0) return sendJson(res, 422, { ok: false, error: 'Ungueltiger Firmen-Typ' });
      const companyType = types[0];

      // Level pruefen
      const userXp = await getUserXp(authUser.id);
      if (userXp.level < companyType.min_level) {
        return sendJson(res, 400, { ok: false, error: `Level ${companyType.min_level} erforderlich (du bist Level ${userXp.level})` });
      }

      // Pruefen ob User schon eine Firma als Owner hat
      const [existing] = await dbPool.query(
        `SELECT c.id, c.name FROM companies c WHERE c.owner_id = ? AND c.is_active = 1`, [authUser.id]
      );
      if (existing.length > 0) {
        return sendJson(res, 400, { ok: false, error: `Du hast bereits eine Firma: "${existing[0].name}"` });
      }

      // Kosten aus Gemeindekasse pruefen
      const treasury = await getMunicipalityMoney(authUser.municipality_id);
      if (treasury < companyType.founding_cost) {
        return sendJson(res, 400, { ok: false, error: `Nicht genug CHF in der Gemeindekasse (${treasury.toLocaleString()}/${companyType.founding_cost.toLocaleString()})` });
      }

      // Slug erstellen
      const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 64) || 'firma';
      const [slugCheck] = await dbPool.query(`SELECT id FROM companies WHERE slug = ?`, [slug]);
      const finalSlug = slugCheck.length > 0 ? slug + '-' + Date.now() : slug;

      await applyMunicipalityTransaction(authUser.municipality_id, {
        amount: -companyType.founding_cost,
        type: 'company_founding',
        meta: { companyName, companyTypeCode: companyType.code },
        actorUserId: authUser.id,
        source: 'user',
      });

      // Firma erstellen
      const [result] = await dbPool.query(
        `INSERT INTO companies (company_type_id, name, slug, owner_id, municipality_id, balance, founded_at)
         VALUES (?, ?, ?, ?, ?, 0, NOW())`,
        [companyTypeId, companyName, finalSlug, authUser.id, authUser.municipality_id]
      );
      const companyId = result.insertId;

      // Owner als Mitglied eintragen
      await dbPool.query(
        `INSERT INTO company_members (company_id, user_id, role) VALUES (?, ?, 'owner')`,
        [companyId, authUser.id]
      );

      // Finanz-Log
      await dbPool.query(
        `INSERT INTO company_finances (company_id, amount, balance_after, reason, description)
         VALUES (?, ?, 0, 'founding_cost', ?)`,
        [companyId, -companyType.founding_cost, `Firmengruendung: ${companyName}`]
      );

      // Badge
      try {
        await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, 'ACH_Company1')`, [authUser.id]);
      } catch (_) {}

      const treasuryAfter = await getMunicipalityMoney(authUser.municipality_id);
      logInfo('COMPANY', `Firma gegruendet: "${companyName}" (${companyType.code}) von User ${authUser.id}, Kosten: ${companyType.founding_cost} CHF aus Gemeindekasse`, { companyId, cost: companyType.founding_cost });

      const [newCompany] = await dbPool.query(
        `SELECT c.*, ct.code AS type_code, ct.name AS type_name, ct.emoji AS type_emoji
         FROM companies c JOIN company_types ct ON ct.id = c.company_type_id WHERE c.id = ?`, [companyId]
      );

      return sendJson(res, 201, {
        ok: true,
        data: {
          company: newCompany[0],
          treasury_remaining: treasuryAfter,
        },
      });
    }

    // GET /api/companies/:id — Firma-Details
    const companyDetailMatch = pathname.match(/^\/api\/companies\/([0-9]+)$/i);
    if (companyDetailMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyDetailMatch[1]);

      const [companies] = await dbPool.query(
        `SELECT c.*, ct.code AS type_code, ct.name AS type_name, ct.emoji AS type_emoji,
                ct.can_fix_categories, ct.max_members
         FROM companies c
         JOIN company_types ct ON ct.id = c.company_type_id
         WHERE c.id = ? AND c.is_active = 1`, [companyId]
      );
      if (companies.length === 0) return sendJson(res, 404, { ok: false, error: 'Firma nicht gefunden' });
      const company = companies[0];
      company.can_fix_categories = typeof company.can_fix_categories === 'string'
        ? JSON.parse(company.can_fix_categories) : (company.can_fix_categories || []);

      // Mitglieder
      const [members] = await dbPool.query(
        `SELECT cm.*, u.nickname, u.email,
                (SELECT level FROM user_xp WHERE user_id = cm.user_id) AS user_level
         FROM company_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.company_id = ?
         ORDER BY FIELD(cm.role, 'owner', 'manager', 'employee'), cm.joined_at ASC`,
        [companyId]
      );

      // Letzte Finanzen
      const [finances] = await dbPool.query(
        `SELECT * FROM company_finances WHERE company_id = ? ORDER BY created_at DESC LIMIT 20`,
        [companyId]
      );

      // Aktive Vertraege — alle Timer-Daten direkt aus DB
      const [rawContracts] = await dbPool.query(
        `SELECT cc.*, et.name AS event_name, et.emoji AS event_emoji, me.status AS event_status,
                u.nickname AS assigned_nickname
         FROM company_contracts cc
         JOIN municipality_events me ON me.id = cc.event_id
         JOIN event_types et ON et.id = me.event_type_id
         LEFT JOIN users u ON u.id = cc.assigned_user_id
         WHERE cc.company_id = ?
         ORDER BY FIELD(cc.status, 'accepted','open','assigned','completed','failed','cancelled'), cc.deadline_at ASC
         LIMIT 30`,
        [companyId]
      );
      // Bei offenen Auftraegen: geschaetzte Dauer mitliefern (aus Firma-Level)
      const contracts = rawContracts.map(c => {
        if (c.status === 'open' && !c.work_duration_seconds) {
          c.work_duration_seconds = calcWorkDuration(c.difficulty, company.level || 1);
        }
        return c;
      });

      // Offene Bewerbungen (nur fuer Owner/Manager)
      let applications = [];
      const [myMembership] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      const myRole = myMembership[0]?.role || null;
      if (myRole === 'owner' || myRole === 'manager') {
        const [apps] = await dbPool.query(
          `SELECT ca.*, u.nickname FROM company_applications ca
           JOIN users u ON u.id = ca.user_id
           WHERE ca.company_id = ? AND ca.status = 'pending'
           ORDER BY ca.created_at ASC`,
          [companyId]
        );
        applications = apps;
      }

      return sendJson(res, 200, {
        ok: true,
        data: {
          company,
          members,
          finances,
          contracts,
          applications,
          my_role: myRole,
        },
      });
    }

    // PATCH /api/companies/:id — Firma bearbeiten (Name/Beschreibung)
    if (companyDetailMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyDetailMatch[1]);

      const [myRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myRole[0] || myRole[0].role !== 'owner') {
        return sendJson(res, 403, { ok: false, error: 'Nur der Inhaber kann die Firma bearbeiten' });
      }

      const body = await readJsonBody(req);
      const updates = [];
      const params = [];

      if (body.name && typeof body.name === 'string') {
        const newName = body.name.trim();
        if (newName.length < 3 || newName.length > 64) {
          return sendJson(res, 422, { ok: false, error: 'Firmenname muss 3-64 Zeichen lang sein' });
        }
        updates.push('name = ?');
        params.push(newName);
      }

      if (updates.length === 0) {
        return sendJson(res, 422, { ok: false, error: 'Keine Aenderungen angegeben' });
      }

      params.push(companyId);
      await dbPool.query(`UPDATE companies SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);

      const [updated] = await dbPool.query(`SELECT * FROM companies WHERE id = ?`, [companyId]);
      return sendJson(res, 200, { ok: true, data: { company: updated[0] } });
    }

    // DELETE /api/companies/:id — Firma aufloesen
    if (companyDetailMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyDetailMatch[1]);

      const [myRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myRole[0] || myRole[0].role !== 'owner') {
        return sendJson(res, 403, { ok: false, error: 'Nur der Inhaber kann die Firma aufloesen' });
      }

      // Pruefen ob aktive Vertraege existieren
      const [activeContracts] = await dbPool.query(
        `SELECT COUNT(*) AS cnt FROM company_contracts WHERE company_id = ? AND status IN ('open','accepted','assigned')`,
        [companyId]
      );
      if (activeContracts[0].cnt > 0) {
        return sendJson(res, 400, { ok: false, error: 'Firma hat noch aktive Auftraege — diese muessen erst abgeschlossen werden' });
      }

      const [company] = await dbPool.query(`SELECT balance, name, municipality_id FROM companies WHERE id = ?`, [companyId]);
      if (company[0]?.balance > 0) {
        await applyMunicipalityTransaction(company[0].municipality_id, {
          amount: company[0].balance,
          type: 'company_dissolve',
          meta: { companyId, companyName: company[0].name },
          actorUserId: authUser.id,
          source: 'user',
        });
      }

      // Soft-delete
      await dbPool.query(`UPDATE companies SET is_active = 0, updated_at = NOW() WHERE id = ?`, [companyId]);
      await dbPool.query(`DELETE FROM company_members WHERE company_id = ?`, [companyId]);

      logInfo('COMPANY', `Firma aufgeloest: "${company[0]?.name}" von User ${authUser.id}, ${company[0]?.balance || 0} CHF zurueck an Gemeindekasse`, { companyId, refund: company[0]?.balance || 0 });

      return sendJson(res, 200, { ok: true, data: { dissolved: true, refund_to_treasury: company[0]?.balance || 0 } });
    }

    // POST /api/companies/:id/members/invite — Mitglied einladen
    const companyMembersInviteMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/members\/invite$/i);
    if (companyMembersInviteMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyMembersInviteMatch[1]);

      // Berechtigung: Owner oder Manager
      const [myRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myRole[0] || !['owner', 'manager'].includes(myRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Inhaber oder Manager koennen Mitglieder einladen' });
      }

      const body = await readJsonBody(req);
      const targetUserId = Number(body.user_id || 0);
      if (!targetUserId) return sendJson(res, 422, { ok: false, error: 'user_id erforderlich' });

      // Pruefen ob User existiert
      const [targetUser] = await dbPool.query(`SELECT id, nickname FROM users WHERE id = ?`, [targetUserId]);
      if (targetUser.length === 0) return sendJson(res, 404, { ok: false, error: 'User nicht gefunden' });

      // Pruefen ob schon Mitglied
      const [existingMember] = await dbPool.query(
        `SELECT id FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, targetUserId]
      );
      if (existingMember.length > 0) return sendJson(res, 400, { ok: false, error: 'User ist bereits Mitglied' });

      // Max-Mitglieder pruefen
      const [companyInfo] = await dbPool.query(
        `SELECT c.id, ct.max_members, (SELECT COUNT(*) FROM company_members WHERE company_id = c.id) AS current_members
         FROM companies c JOIN company_types ct ON ct.id = c.company_type_id WHERE c.id = ?`, [companyId]
      );
      if (companyInfo[0]?.current_members >= companyInfo[0]?.max_members) {
        return sendJson(res, 400, { ok: false, error: `Firma ist voll (${companyInfo[0].max_members} Mitglieder max.)` });
      }

      const role = body.role === 'manager' ? 'manager' : 'employee';
      await dbPool.query(
        `INSERT INTO company_members (company_id, user_id, role) VALUES (?, ?, ?)`,
        [companyId, targetUserId, role]
      );

      return sendJson(res, 200, { ok: true, data: { invited: true, user_id: targetUserId, role } });
    }

    // DELETE /api/companies/:id/members/:userId — Mitglied entfernen
    const companyMemberRemoveMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/members\/([0-9]+)$/i);
    if (companyMemberRemoveMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyMemberRemoveMatch[1]);
      const targetUserId = Number(companyMemberRemoveMatch[2]);

      // Berechtigung: Owner oder Manager (Manager kann nur Employees kicken)
      const [myRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      const [targetRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, targetUserId]
      );
      if (!myRole[0]) return sendJson(res, 403, { ok: false, error: 'Keine Berechtigung' });
      if (!targetRole[0]) return sendJson(res, 404, { ok: false, error: 'Mitglied nicht gefunden' });
      if (targetRole[0].role === 'owner') return sendJson(res, 400, { ok: false, error: 'Inhaber kann nicht entfernt werden' });

      if (myRole[0].role === 'manager' && targetRole[0].role !== 'employee') {
        return sendJson(res, 403, { ok: false, error: 'Manager koennen nur Mitarbeiter entfernen' });
      }
      if (myRole[0].role === 'employee') {
        // Employee kann nur sich selbst entfernen (Firma verlassen)
        if (Number(authUser.id) !== targetUserId) {
          return sendJson(res, 403, { ok: false, error: 'Du kannst nur dich selbst aus der Firma entfernen' });
        }
      }

      await dbPool.query(
        `DELETE FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, targetUserId]
      );

      return sendJson(res, 200, { ok: true, data: { removed: true, user_id: targetUserId } });
    }

    // PATCH /api/companies/:id/members/:userId/role — Rolle aendern
    const companyMemberRoleMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/members\/([0-9]+)\/role$/i);
    if (companyMemberRoleMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyMemberRoleMatch[1]);
      const targetUserId = Number(companyMemberRoleMatch[2]);

      const [myRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myRole[0] || myRole[0].role !== 'owner') {
        return sendJson(res, 403, { ok: false, error: 'Nur der Inhaber kann Rollen aendern' });
      }

      const body = await readJsonBody(req);
      const newRole = body.role;
      if (!['manager', 'employee'].includes(newRole)) {
        return sendJson(res, 422, { ok: false, error: 'Rolle muss "manager" oder "employee" sein' });
      }

      const [targetMember] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, targetUserId]
      );
      if (!targetMember[0]) return sendJson(res, 404, { ok: false, error: 'Mitglied nicht gefunden' });
      if (targetMember[0].role === 'owner') return sendJson(res, 400, { ok: false, error: 'Inhaber-Rolle kann nicht geaendert werden' });

      await dbPool.query(
        `UPDATE company_members SET role = ?, updated_at = NOW() WHERE company_id = ? AND user_id = ?`,
        [newRole, companyId, targetUserId]
      );

      return sendJson(res, 200, { ok: true, data: { user_id: targetUserId, new_role: newRole } });
    }

    // GET /api/companies/:id/finances — Finanz-History
    const companyFinancesMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/finances$/i);
    if (companyFinancesMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyFinancesMatch[1]);

      // Nur Mitglieder sehen Finanzen
      const [myMembership] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myMembership[0]) return sendJson(res, 403, { ok: false, error: 'Nur Firmenmitglieder sehen Finanzen' });

      const limit = Math.min(Number(requestUrl.searchParams.get('limit') || 50), 100);
      const [rows] = await dbPool.query(
        `SELECT * FROM company_finances WHERE company_id = ? ORDER BY created_at DESC LIMIT ?`,
        [companyId, limit]
      );

      return sendJson(res, 200, { ok: true, data: { finances: rows } });
    }

    // GET /api/companies/:id/contracts — Auftraege
    const companyContractsMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/contracts$/i);
    if (companyContractsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyContractsMatch[1]);

      const [myMembership] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myMembership[0]) return sendJson(res, 403, { ok: false, error: 'Nur Firmenmitglieder sehen Auftraege' });

      const statusFilter = requestUrl.searchParams.get('status') || null;
      let query = `SELECT cc.*, et.name AS event_name, et.emoji AS event_emoji,
                          me.status AS event_status, m.name AS municipality_name
                   FROM company_contracts cc
                   JOIN municipality_events me ON me.id = cc.event_id
                   JOIN event_types et ON et.id = me.event_type_id
                   JOIN municipalities m ON m.id = cc.municipality_id
                   WHERE cc.company_id = ?`;
      const queryParams = [companyId];
      if (statusFilter) {
        query += ` AND cc.status = ?`;
        queryParams.push(statusFilter);
      }
      query += ` ORDER BY cc.created_at DESC LIMIT 50`;

      const [rows] = await dbPool.query(query, queryParams);
      return sendJson(res, 200, { ok: true, data: { contracts: rows } });
    }

    // Arbeitszeit berechnen: basiert auf Event-Schwere und Firma-Level
    // Basis-Zeiten pro Schwierigkeit (Sekunden):
    //   1 = 5 Min, 2 = 30 Min, 3 = 1 Std, 4 = 3 Std, 5 = 6 Std
    // Firma-Level reduziert die Zeit (max -50% bei Level 10)
    function calcWorkDuration(difficulty, companyLevel = 1) {
      const baseDurations = { 1: 300, 2: 1800, 3: 3600, 4: 10800, 5: 21600 };
      const base = baseDurations[difficulty] || 1800;
      const levelReduction = Math.min(0.5, (companyLevel - 1) * 0.05);
      return Math.max(60, Math.round(base * (1 - levelReduction)));
    }

    // POST /api/companies/:id/contracts/:cid/accept — Auftrag annehmen
    const contractAcceptMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/contracts\/([0-9]+)\/accept$/i);
    if (contractAcceptMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(contractAcceptMatch[1]);
      const contractId = Number(contractAcceptMatch[2]);

      const [membership] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!membership[0]) return sendJson(res, 403, { ok: false, error: 'Nur Firmenmitglieder' });

      // Pruefen ob der User bereits einen aktiven Auftrag hat
      const [activeContracts] = await dbPool.query(
        `SELECT cc.id, et.name AS event_name FROM company_contracts cc
         JOIN municipality_events me ON me.id = cc.event_id
         JOIN event_types et ON et.id = me.event_type_id
         WHERE cc.assigned_user_id = ? AND cc.status IN ('accepted','assigned')
         LIMIT 1`,
        [authUser.id]
      );
      if (activeContracts.length > 0) {
        return sendJson(res, 400, {
          ok: false,
          error: `Du hast bereits einen aktiven Auftrag: "${activeContracts[0].event_name}". Schliesse ihn zuerst ab.`,
          active_contract_id: activeContracts[0].id,
        });
      }

      const [contracts] = await dbPool.query(
        `SELECT * FROM company_contracts WHERE id = ? AND company_id = ? AND status = 'open'`, [contractId, companyId]
      );
      if (contracts.length === 0) return sendJson(res, 404, { ok: false, error: 'Auftrag nicht gefunden oder bereits angenommen' });

      const contract = contracts[0];

      // Firma-Level fuer Zeitberechnung holen
      const [companyRows] = await dbPool.query(`SELECT level FROM companies WHERE id = ?`, [companyId]);
      const companyLevel = companyRows[0]?.level || 1;

      // Arbeitszeit serverseitig berechnen und in DB speichern
      const workDuration = calcWorkDuration(contract.difficulty, companyLevel);
      const now = new Date();
      const completableAt = new Date(now.getTime() + workDuration * 1000);

      await dbPool.query(
        `UPDATE company_contracts
         SET status = 'accepted',
             assigned_user_id = ?,
             accepted_at = ?,
             started_at = ?,
             work_duration_seconds = ?,
             completable_at = ?
         WHERE id = ?`,
        [authUser.id, now, now, workDuration, completableAt, contractId]
      );

      logInfo('CONTRACT', `Auftrag #${contractId} angenommen von User ${authUser.id}, Arbeitszeit: ${workDuration}s (Schwere ${contract.difficulty}, Firma Lv.${companyLevel})`, {
        contractId, companyId, workDuration, difficulty: contract.difficulty, companyLevel,
        completableAt: completableAt.toISOString(),
      });

      return sendJson(res, 200, {
        ok: true,
        data: {
          accepted: true,
          work_duration_seconds: workDuration,
          completable_at: completableAt.toISOString(),
          assigned_user_id: authUser.id,
        },
      });
    }

    // POST /api/companies/:id/contracts/:cid/complete — Auftrag abschliessen
    const contractCompleteMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/contracts\/([0-9]+)\/complete$/i);
    if (contractCompleteMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(contractCompleteMatch[1]);
      const contractId = Number(contractCompleteMatch[2]);

      const [membership] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!membership[0]) return sendJson(res, 403, { ok: false, error: 'Nur Firmenmitglieder' });

      const [contracts] = await dbPool.query(
        `SELECT * FROM company_contracts WHERE id = ? AND company_id = ? AND status IN ('accepted','assigned')`, [contractId, companyId]
      );
      if (contracts.length === 0) return sendJson(res, 404, { ok: false, error: 'Kein aktiver Auftrag' });

      const contract = contracts[0];

      // Nur der zugewiesene User darf abschliessen
      if (contract.assigned_user_id && contract.assigned_user_id !== authUser.id) {
        return sendJson(res, 403, { ok: false, error: 'Nur der zugewiesene Mitarbeiter kann diesen Auftrag abschliessen' });
      }

      // Timer-Check: completable_at aus DB lesen (nicht berechnen!)
      const completableAt = contract.completable_at ? new Date(contract.completable_at) : null;
      if (completableAt) {
        const now = new Date();
        if (now < completableAt) {
          const remainingSec = Math.ceil((completableAt - now) / 1000);
          const hrs = Math.floor(remainingSec / 3600);
          const mins = Math.floor((remainingSec % 3600) / 60);
          const secs = remainingSec % 60;
          let timeStr = '';
          if (hrs > 0) timeStr += `${hrs} Std. `;
          if (mins > 0) timeStr += `${mins} Min. `;
          if (hrs === 0) timeStr += `${secs} Sek.`;
          return sendJson(res, 400, {
            ok: false,
            error: `Arbeitszeit laeuft noch! Noch ${timeStr.trim()} bis der Auftrag abgeschlossen werden kann.`,
            remaining_seconds: remainingSec,
            completable_at: completableAt.toISOString(),
          });
        }
      }

      // Vertrag abschliessen
      await dbPool.query(
        `UPDATE company_contracts SET status = 'completed', completed_at = NOW() WHERE id = ?`, [contractId]
      );

      // Bezahlung an Firma
      await dbPool.query(
        `UPDATE companies SET balance = balance + ?, total_contracts = total_contracts + 1, total_revenue = total_revenue + ?, reputation = reputation + ? WHERE id = ?`,
        [contract.payment, contract.payment, contract.difficulty * 2, companyId]
      );

      // Finanz-Log
      const [balanceRow] = await dbPool.query(`SELECT balance FROM companies WHERE id = ?`, [companyId]);
      await dbPool.query(
        `INSERT INTO company_finances (company_id, amount, balance_after, reason, description, ref_type, ref_id)
         VALUES (?, ?, ?, 'contract_payment', ?, 'contract', ?)`,
        [companyId, contract.payment, balanceRow[0].balance, `Auftrag #${contractId} abgeschlossen`, contractId]
      );

      // XP fuer den User
      if (contract.xp_reward > 0) {
        try {
          await awardXp(authUser.id, contract.xp_reward, 'contract_complete',
            `Firmenauftrag abgeschlossen`, 'contract', contractId);
        } catch (_) {}
      }

      // Event resolven
      try {
        await resolveBuenzliEvent(contract.event_id, authUser.id);
      } catch (_) {}

      // User contract counter erhoehen
      await dbPool.query(
        `UPDATE company_members SET contracts_done = contracts_done + 1, xp_earned = xp_earned + ? WHERE company_id = ? AND user_id = ?`,
        [contract.xp_reward || 0, companyId, authUser.id]
      );

      logInfo('CONTRACT', `Auftrag #${contractId} abgeschlossen von User ${authUser.id}`, { contractId, companyId, payment: contract.payment, xp: contract.xp_reward });

      return sendJson(res, 200, { ok: true, data: { completed: true, payment: contract.payment, xp: contract.xp_reward } });
    }

    // POST /api/companies/:id/contracts/create — Neuen Auftrag erstellen (aus Event)
    const contractCreateMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/contracts\/create$/i);
    if (contractCreateMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(contractCreateMatch[1]);

      const [membership] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!membership[0] || !['owner', 'manager'].includes(membership[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Owner/Manager koennen Auftraege erstellen' });
      }

      const body = await readJsonBody(req);
      const eventId = Number(body.event_id);
      if (!eventId) return sendJson(res, 400, { ok: false, error: 'event_id erforderlich' });

      // Event pruefen
      const [events] = await dbPool.query(
        `SELECT me.*, et.category FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         WHERE me.id = ? AND me.status IN ('detected','reported')`, [eventId]
      );
      if (events.length === 0) return sendJson(res, 404, { ok: false, error: 'Event nicht gefunden oder bereits behoben' });
      const event = events[0];

      // Pruefen ob bereits ein Vertrag existiert
      const [existingContract] = await dbPool.query(
        `SELECT id FROM company_contracts WHERE event_id = ?`, [eventId]
      );
      if (existingContract.length > 0) return sendJson(res, 400, { ok: false, error: 'Fuer dieses Event existiert bereits ein Auftrag' });

      const payment = event.fix_cost || event.severity * 500;
      // Deadline je nach Schwierigkeit: 1=6h, 2=12h, 3=24h, 4=48h, 5=72h
      const deadlineHours = { 1: 6, 2: 12, 3: 24, 4: 48, 5: 72 };
      const deadline = new Date(Date.now() + (deadlineHours[event.severity] || 24) * 60 * 60 * 1000);
      const xpReward = event.severity * 10;

      const [result] = await dbPool.query(
        `INSERT INTO company_contracts (company_id, event_id, municipality_id, status, payment, difficulty, xp_reward, deadline_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
        [companyId, eventId, event.municipality_id, payment, event.severity, xpReward, deadline]
      );

      // Event auf assigned setzen (Firma zugewiesen)
      await dbPool.query(
        `UPDATE municipality_events SET status = 'assigned', assigned_company_id = ?, updated_at = NOW() WHERE id = ?`, [companyId, eventId]
      );

      return sendJson(res, 200, { ok: true, data: { contract_id: result.insertId, payment, xp_reward: xpReward } });
    }

    // GET /api/events/reported — Gemeldete Events die beauftragt werden koennen
    if (req.method === 'GET' && pathname === '/api/events/reported') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [rows] = await dbPool.query(
        `SELECT me.id, me.severity, me.fix_cost, me.location_x, me.location_y, me.status,
                et.name, et.emoji, et.category, et.code
         FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         LEFT JOIN company_contracts cc ON cc.event_id = me.id
         WHERE me.municipality_id = ? AND me.status IN ('detected','reported') AND cc.id IS NULL
         ORDER BY me.severity DESC LIMIT 20`,
        [authUser.municipality_id]
      );
      return sendJson(res, 200, { ok: true, data: { events: rows } });
    }

    // ================================================================
    // VERWALTUNG (Meldungen/Missstände) API ENDPOINTS
    // ================================================================

    // GET /api/verwaltung/meldungen — Alle Meldungen/Events fuer Verwaltung
    if (req.method === 'GET' && pathname === '/api/verwaltung/meldungen') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde zugeordnet' });

      // Nur Owner/Admin/Council der Gemeinde darf Verwaltung sehen
      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin', 'council'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung/Gemeinderat hat Zugang' });
      }

      const statusFilter = requestUrl.searchParams.get('status') || 'reported,assigned,external_reported';
      const validStatuses = ['reported', 'investigating', 'assigned', 'resolved', 'expired', 'failed', 'false_alarm', 'external_reported', 'disputed'];
      const statuses = statusFilter.split(',').filter(s => validStatuses.includes(s));
      if (statuses.length === 0) return sendJson(res, 400, { ok: false, error: 'Ungueltiger Status-Filter' });
      const placeholders = statuses.map(() => '?').join(',');

      const [rows] = await dbPool.query(
        `SELECT me.id, me.event_type_id, me.status, me.severity, me.confidence, me.fix_cost,
                me.location_x, me.location_y, me.room_code,
                me.affected_item_id, me.building_snapshot, me.building_exists,
                me.reported_by, me.assigned_company_id, me.resolved_by,
                me.spawned_at, me.expires_at, me.reported_at, me.resolved_at,
                me.external_reporter_id, me.external_deadline, me.escalation_level,
                me.dispute_until, me.evidence_score,
                et.code, et.name, et.description, et.emoji, et.category,
                et.stat_impact, et.stat_damage, et.stat_fix_bonus,
                et.company_type_required,
                u_reporter.nickname AS reporter_nickname,
                u_ext.nickname AS external_reporter_nickname,
                c.name AS assigned_company_name, ct.emoji AS company_emoji
         FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         LEFT JOIN users u_reporter ON u_reporter.id = me.reported_by
         LEFT JOIN users u_ext ON u_ext.id = me.external_reporter_id
         LEFT JOIN companies c ON c.id = me.assigned_company_id
         LEFT JOIN company_types ct ON ct.id = c.company_type_id
         WHERE me.municipality_id = ? AND me.status IN (${placeholders})
         ORDER BY
           FIELD(me.status, 'external_reported', 'disputed', 'reported', 'detected', 'investigating', 'assigned', 'resolved', 'expired', 'failed', 'false_alarm'),
           me.severity DESC, me.spawned_at DESC
         LIMIT 100`,
        [authUser.municipality_id, ...statuses]
      );

      const events = rows.map(r => {
        let snapshot = r.building_snapshot;
        if (snapshot && typeof snapshot === 'string') {
          try { snapshot = JSON.parse(snapshot); } catch (_) {}
        }
        return { ...r, building_snapshot: snapshot };
      });

      // Stats auch mitliefern
      const [stats] = await dbPool.query(
        `SELECT * FROM municipality_stats WHERE municipality_id = ?`, [authUser.municipality_id]
      );

      // Firmen in der Gemeinde (fuer "Firma beauftragen")
      const [companies] = await dbPool.query(
        `SELECT c.id, c.name, c.level, c.reputation, ct.code AS type_code, ct.name AS type_name, ct.emoji AS type_emoji,
                ct.can_fix_categories
         FROM companies c
         JOIN company_types ct ON ct.id = c.company_type_id
         WHERE c.municipality_id = ? AND c.is_active = 1
         ORDER BY c.reputation DESC`,
        [authUser.municipality_id]
      );
      const companiesFormatted = companies.map(c => ({
        ...c,
        can_fix_categories: typeof c.can_fix_categories === 'string' ? JSON.parse(c.can_fix_categories) : (c.can_fix_categories || []),
      }));

      return sendJson(res, 200, {
        ok: true,
        data: { events, stats: stats[0] || null, companies: companiesFormatted },
      });
    }

    // POST /api/verwaltung/beauftragen — Verwaltung beauftragt Firma
    if (req.method === 'POST' && pathname === '/api/verwaltung/beauftragen') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin', 'council'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung darf Auftraege vergeben' });
      }

      const body = await readJsonBody(req);
      const eventId = Number(body.event_id);
      const companyId = Number(body.company_id);
      if (!eventId || !companyId) return sendJson(res, 400, { ok: false, error: 'event_id und company_id erforderlich' });

      // Event pruefen
      const [events] = await dbPool.query(
        `SELECT me.*, et.category, et.name AS event_name FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         WHERE me.id = ? AND me.municipality_id = ? AND me.status IN ('detected','reported','external_reported')`, [eventId, authUser.municipality_id]
      );
      if (events.length === 0) return sendJson(res, 404, { ok: false, error: 'Event nicht gefunden oder bereits bearbeitet' });
      const event = events[0];

      // Firma pruefen
      const [companyRows] = await dbPool.query(
        `SELECT c.*, ct.can_fix_categories FROM companies c
         JOIN company_types ct ON ct.id = c.company_type_id
         WHERE c.id = ? AND c.is_active = 1`, [companyId]
      );
      if (companyRows.length === 0) return sendJson(res, 404, { ok: false, error: 'Firma nicht gefunden' });

      // Pruefen ob bereits ein Vertrag existiert
      const [existingContract] = await dbPool.query(
        `SELECT id FROM company_contracts WHERE event_id = ?`, [eventId]
      );
      if (existingContract.length > 0) return sendJson(res, 400, { ok: false, error: 'Fuer dieses Event existiert bereits ein Auftrag' });

      const payment = event.fix_cost || event.severity * 500;
      const deadlineHrs = { 1: 6, 2: 12, 3: 24, 4: 48, 5: 72 };
      const deadline = new Date(Date.now() + (deadlineHrs[event.severity] || 24) * 60 * 60 * 1000);
      const xpReward = event.severity * 10;

      const [result] = await dbPool.query(
        `INSERT INTO company_contracts (company_id, event_id, municipality_id, status, payment, difficulty, xp_reward, deadline_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
        [companyId, eventId, authUser.municipality_id, payment, event.severity, xpReward, deadline]
      );

      // Event auf assigned setzen
      await dbPool.query(
        `UPDATE municipality_events SET status = 'assigned', assigned_company_id = ?, updated_at = NOW() WHERE id = ?`,
        [companyId, eventId]
      );

      // Notification an Firma-Owner
      const [companyOwner] = await dbPool.query(
        `SELECT user_id FROM company_members WHERE company_id = ? AND role = 'owner' LIMIT 1`, [companyId]
      );
      if (companyOwner[0]) {
        await createUserNotification(
          companyOwner[0].user_id, 'contract_created',
          'Neuer Auftrag fuer deine Firma!',
          `Die Verwaltung hat "${event.event_name}" an deine Firma delegiert. Bezahlung: ${payment} CHF.`,
          { event_id: eventId, contract_id: result.insertId, payment }
        );
      }

      return sendJson(res, 200, {
        ok: true,
        data: { contract_id: result.insertId, payment, xp_reward: xpReward, event_name: event.event_name },
      });
    }

    // POST /api/verwaltung/selbst-beheben — Verwaltung behebt Event direkt (zahlt aus Gemeindekasse)
    if (req.method === 'POST' && pathname === '/api/verwaltung/selbst-beheben') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin', 'council'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung darf Events direkt beheben' });
      }

      const body = await readJsonBody(req);
      const eventId = Number(body.event_id);
      if (!eventId) return sendJson(res, 400, { ok: false, error: 'event_id erforderlich' });

      try {
        const result = await resolveBuenzliEvent(eventId, authUser.id);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // POST /api/verwaltung/notfallreparatur — Abgelaufenes Event nachtraeglich beheben (2x Kosten)
    if (req.method === 'POST' && pathname === '/api/verwaltung/notfallreparatur') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin', 'council'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung darf Notfallreparaturen durchfuehren' });
      }

      const body = await readJsonBody(req);
      const eventId = Number(body.event_id);
      if (!eventId) return sendJson(res, 400, { ok: false, error: 'event_id erforderlich' });

      try {
        const [events] = await dbPool.query(
          `SELECT me.*, et.stat_impact, et.stat_fix_bonus, et.stat_damage,
                  et.name AS event_name, et.xp_reward_fix, et.coin_reward_fix
           FROM municipality_events me
           JOIN event_types et ON et.id = me.event_type_id
           WHERE me.id = ? AND me.municipality_id = ?`, [eventId, authUser.municipality_id]
        );
        if (events.length === 0) return sendJson(res, 404, { ok: false, error: 'Event nicht gefunden' });
        const event = events[0];

        if (event.status !== 'expired') {
          return sendJson(res, 400, { ok: false, error: `Notfallreparatur nur fuer abgelaufene Events (Status: ${event.status})` });
        }

        const emergencyCost = Math.round(event.fix_cost * 2);
        const treasury = await getMunicipalityMoney(authUser.municipality_id);
        if (treasury < emergencyCost) {
          return sendJson(res, 400, {
            ok: false,
            error: `Nicht genug Geld fuer Notfallreparatur (${emergencyCost.toLocaleString()} CHF noetig, Kasse: ${treasury.toLocaleString()} CHF)`
          });
        }

        await applyMunicipalityTransaction(authUser.municipality_id, {
          amount: -emergencyCost,
          type: 'emergency_repair',
          meta: { eventId, eventName: event.event_name, fixCost: event.fix_cost },
          actorUserId: authUser.id,
          source: 'user',
        });

        await dbPool.query(
          `UPDATE municipality_events SET status = 'resolved', resolved_by = ?, resolved_at = NOW(), updated_at = NOW() WHERE id = ?`,
          [authUser.id, eventId]
        );

        // Reports als korrekt markieren
        await dbPool.query(
          `UPDATE event_reports SET is_correct = 1 WHERE event_id = ? AND is_correct IS NULL`,
          [eventId]
        );

        // Fix-Bonus anwenden (hebt den Debuff vom Ablaufen teilweise auf)
        if (event.stat_impact && event.stat_fix_bonus) {
          await applyStatChange(event.municipality_id, event.stat_impact, event.stat_fix_bonus,
            'emergency_fix', 'event', eventId);
        }

        // Halbe XP fuer Notfallreparatur
        const xpReward = Math.round((event.xp_reward_fix || 0) * 0.5);
        if (xpReward > 0) {
          await awardXp(authUser.id, xpReward, 'emergency_fix',
            `Notfallreparatur: ${event.event_name}`, 'event', eventId);
        }

        return sendJson(res, 200, {
          ok: true,
          data: {
            event_id: eventId,
            cost: emergencyCost,
            original_cost: event.fix_cost,
            stat_recovered: event.stat_impact ? event.stat_fix_bonus : 0,
            xp_earned: xpReward,
            message: `Notfallreparatur erfolgreich! Kosten: ${emergencyCost.toLocaleString()} CHF (2x)`
          }
        });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // POST /api/verwaltung/schutzschild — Schutzschild kaufen (1/3/7 Tage)
    if (req.method === 'POST' && pathname === '/api/verwaltung/schutzschild') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Owner/Admin duerfen ein Schutzschild kaufen' });
      }

      const body = await readJsonBody(req);
      const days = Number(body.days);
      const SHIELD_PRICES = { 1: 2000, 3: 5000, 7: 10000 };
      if (![1, 3, 7].includes(days)) {
        return sendJson(res, 400, { ok: false, error: 'Ungueltige Dauer. Erlaubt: 1, 3 oder 7 Tage.' });
      }

      const cost = SHIELD_PRICES[days];
      const treasury = await getMunicipalityMoney(authUser.municipality_id);
      if (treasury < cost) {
        return sendJson(res, 400, {
          ok: false,
          error: `Nicht genug Geld (${cost.toLocaleString()} CHF noetig, Kasse: ${treasury.toLocaleString()} CHF)`
        });
      }

      // Pruefen ob schon ein Schild aktiv ist → verlaengern statt neu starten
      const [currentShield] = await dbPool.query(
        `SELECT shield_active_until FROM municipality_stats WHERE municipality_id = ?`,
        [authUser.municipality_id]
      );
      const now = new Date();
      let startFrom = now;
      if (currentShield[0]?.shield_active_until && new Date(currentShield[0].shield_active_until) > now) {
        startFrom = new Date(currentShield[0].shield_active_until);
      }
      const newEnd = new Date(startFrom.getTime() + days * 24 * 60 * 60 * 1000);

      await applyMunicipalityTransaction(authUser.municipality_id, {
        amount: -cost,
        type: 'shield',
        meta: { days, shieldEnd: newEnd.toISOString() },
        actorUserId: authUser.id,
        source: 'user',
      });

      await dbPool.query(
        `UPDATE municipality_stats SET shield_active_until = ?, updated_at = NOW() WHERE municipality_id = ?`,
        [newEnd, authUser.municipality_id]
      );

      logInfo('SHIELD', `Schutzschild aktiviert`, {
        municipality_id: authUser.municipality_id,
        days,
        cost,
        active_until: newEnd.toISOString(),
        extended: startFrom > now
      });

      return sendJson(res, 200, {
        ok: true,
        data: {
          shield_active_until: newEnd.toISOString(),
          cost,
          days,
          extended: startFrom > now,
          message: startFrom > now
            ? `Schutzschild um ${days} Tage verlaengert bis ${newEnd.toLocaleDateString('de-CH')}`
            : `Schutzschild fuer ${days} Tage aktiviert!`
        }
      });
    }

    // GET /api/verwaltung/schutzschild — Aktuellen Schild-Status abfragen
    if (req.method === 'GET' && pathname === '/api/verwaltung/schutzschild') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [rows] = await dbPool.query(
        `SELECT shield_active_until FROM municipality_stats WHERE municipality_id = ?`,
        [authUser.municipality_id]
      );
      const shieldUntil = rows[0]?.shield_active_until || null;
      const isActive = shieldUntil && new Date(shieldUntil) > new Date();

      return sendJson(res, 200, {
        ok: true,
        data: {
          shield_active: !!isActive,
          shield_active_until: shieldUntil,
          prices: { 1: 2000, 3: 5000, 7: 10000 }
        }
      });
    }

    // POST /api/verwaltung/external-response — Reaktion auf externen Report (accept/dispute)
    if (req.method === 'POST' && pathname === '/api/verwaltung/external-response') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [memberRole] = await dbPool.query(
        `SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`,
        [authUser.municipality_id, authUser.id]
      );
      if (!memberRole[0] || !['owner', 'admin', 'council'].includes(memberRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung darf auf externe Meldungen reagieren' });
      }

      const body = await readJsonBody(req);
      const eventId = Number(body.event_id);
      const action = body.action;
      if (!eventId || !['accept', 'dispute'].includes(action)) {
        return sendJson(res, 400, { ok: false, error: 'event_id und action (accept/dispute) erforderlich' });
      }

      try {
        const [events] = await dbPool.query(
          `SELECT me.*, et.name AS event_name, et.stat_impact, et.stat_damage, et.stat_fix_bonus,
                  et.base_confidence, me.external_reporter_id, me.confidence, me.actual_real
           FROM municipality_events me JOIN event_types et ON et.id = me.event_type_id
           WHERE me.id = ? AND me.municipality_id = ?`, [eventId, authUser.municipality_id]
        );
        if (events.length === 0) return sendJson(res, 404, { ok: false, error: 'Event nicht gefunden' });
        const event = events[0];

        if (event.status !== 'external_reported') {
          return sendJson(res, 400, { ok: false, error: `Nur external_reported Events (aktuell: ${event.status})` });
        }

        if (action === 'accept') {
          await dbPool.query(
            `UPDATE municipality_events SET status = 'reported', updated_at = NOW() WHERE id = ?`, [eventId]
          );
          if (event.external_reporter_id) {
            await awardXp(event.external_reporter_id, 20, 'external_report_accepted',
              `Externer Report akzeptiert: ${event.event_name}`, 'event', eventId);
            await createUserNotification(event.external_reporter_id, 'report_accepted',
              'Dein Report wurde akzeptiert!',
              `Die Gemeinde hat deinen Report "${event.event_name}" akzeptiert und kuemmert sich darum.`,
              { event_id: eventId });
          }
          return sendJson(res, 200, { ok: true, data: { action: 'accepted', event_id: eventId, new_status: 'reported' } });

        } else if (action === 'dispute') {
          let evidenceScore = 0;
          if (event.external_reporter_id) {
            const [inspections] = await dbPool.query(
              `SELECT COUNT(*) AS cnt FROM inspections
               WHERE user_id = ? AND status = 'completed' AND completes_at >= DATE_SUB(NOW(), INTERVAL 2 HOUR)`,
              [event.external_reporter_id]
            );
            if (inspections[0]?.cnt > 0) evidenceScore += 50;
          }
          if (event.actual_real === 1) evidenceScore += 40;
          if (Number(event.confidence) >= 0.8) evidenceScore += 10;

          const disputeHours = event.severity >= 3 ? 2 : event.severity >= 2 ? 4 : 6;
          await dbPool.query(
            `UPDATE municipality_events
             SET status = 'disputed', dispute_until = DATE_ADD(NOW(), INTERVAL ? HOUR),
                 evidence_score = ?, updated_at = NOW()
             WHERE id = ?`,
            [disputeHours, evidenceScore, eventId]
          );

          if (event.external_reporter_id) {
            await createUserNotification(event.external_reporter_id, 'report_disputed',
              'Einspruch gegen deinen Report!',
              `Die Gemeinde hat Einspruch gegen "${event.event_name}" eingelegt. Untersuchung laeuft (${disputeHours}h).`,
              { event_id: eventId, dispute_hours: disputeHours });
          }

          return sendJson(res, 200, {
            ok: true,
            data: {
              action: 'disputed', event_id: eventId, evidence_score: evidenceScore,
              dispute_hours: disputeHours, new_status: 'disputed',
              message: `Einspruch eingelegt. Untersuchung dauert ${disputeHours}h. Evidence-Score: ${evidenceScore}/100`
            }
          });
        }
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // GET /api/verwaltung/stats-history — Statistik-Verlauf fuer Verwaltung
    if (req.method === 'GET' && pathname === '/api/verwaltung/stats-history') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const days = Math.min(Number(requestUrl.searchParams.get('days') || 14), 30);
      const [rows] = await dbPool.query(
        `SELECT stat_name, old_value, new_value, change_amount, reason, ref_type, ref_id, created_at
         FROM municipality_stats_log
         WHERE municipality_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         ORDER BY created_at DESC LIMIT 200`,
        [authUser.municipality_id, days]
      );
      return sendJson(res, 200, { ok: true, data: { history: rows } });
    }

    // ================================================================
    // REPORTER (Meine Reports) API ENDPOINT
    // ================================================================

    // GET /api/reports/my — Meine gemeldeten Events
    if (req.method === 'GET' && pathname === '/api/reports/my') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      // Reports aus event_reports UND Events wo User reported_by ist (fuer Push-to-Verwaltung etc.)
      const [rows] = await dbPool.query(
        `SELECT * FROM (
           SELECT er.id AS report_id, er.report_type, er.comment, er.is_correct, er.xp_awarded, er.created_at AS reported_at,
                  me.id AS event_id, me.status AS event_status, me.severity, me.fix_cost,
                  me.location_x, me.location_y, me.resolved_at,
                  et.name AS event_name, et.emoji, et.category, et.code AS event_code,
                  m.name AS municipality_name
           FROM event_reports er
           JOIN municipality_events me ON me.id = er.event_id
           JOIN event_types et ON et.id = me.event_type_id
           JOIN municipalities m ON m.id = me.municipality_id
           WHERE er.user_id = ?
           UNION
           SELECT 0 AS report_id, 'confirm' AS report_type, NULL AS comment,
                  CASE WHEN me.status = 'resolved' THEN 1 WHEN me.status = 'false_alarm' THEN 0 ELSE NULL END AS is_correct,
                  0 AS xp_awarded, me.reported_at AS reported_at,
                  me.id AS event_id, me.status AS event_status, me.severity, me.fix_cost,
                  me.location_x, me.location_y, me.resolved_at,
                  et.name AS event_name, et.emoji, et.category, et.code AS event_code,
                  m.name AS municipality_name
           FROM municipality_events me
           JOIN event_types et ON et.id = me.event_type_id
           JOIN municipalities m ON m.id = me.municipality_id
           WHERE me.reported_by = ? AND NOT EXISTS (
             SELECT 1 FROM event_reports er2 WHERE er2.event_id = me.id AND er2.user_id = ?
           )
         ) combined ORDER BY reported_at DESC LIMIT 50`,
        [authUser.id, authUser.id, authUser.id]
      );

      // Zusammenfassung: event_reports + reported_by Events ohne report
      const [summary] = await dbPool.query(
        `SELECT
           COUNT(*) AS total_reports,
           SUM(CASE WHEN is_correct = 1 OR event_status = 'resolved' THEN 1 ELSE 0 END) AS correct_reports,
           SUM(CASE WHEN is_correct = 0 OR event_status = 'false_alarm' THEN 1 ELSE 0 END) AS wrong_reports,
           SUM(CASE WHEN is_correct IS NULL AND event_status NOT IN ('resolved','false_alarm','expired') THEN 1 ELSE 0 END) AS pending_reports,
           SUM(CASE WHEN xp_earned > 0 THEN xp_earned ELSE 0 END) AS total_xp_earned
         FROM (
           SELECT er.is_correct, me.status AS event_status, er.xp_awarded AS xp_earned
           FROM event_reports er
           JOIN municipality_events me ON me.id = er.event_id
           WHERE er.user_id = ?
           UNION
           SELECT
             CASE WHEN me.status = 'resolved' THEN 1 WHEN me.status = 'false_alarm' THEN 0 ELSE NULL END AS is_correct,
             me.status AS event_status, 0 AS xp_earned
           FROM municipality_events me
           WHERE me.reported_by = ? AND NOT EXISTS (
             SELECT 1 FROM event_reports er2 WHERE er2.event_id = me.id AND er2.user_id = ?
           )
         ) combined`,
        [authUser.id, authUser.id, authUser.id]
      );

      return sendJson(res, 200, {
        ok: true,
        data: { reports: rows, summary: summary[0] || { total_reports: 0, correct_reports: 0, wrong_reports: 0, pending_reports: 0, total_xp_earned: 0 } },
      });
    }

    // GET /api/tutorial/status — Tutorial-Status aus users_data.project_data (JSON)
    if (req.method === 'GET' && pathname === '/api/tutorial/status') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `SELECT JSON_EXTRACT(project_data, '$.tutorial_completed') AS tc,
                JSON_EXTRACT(project_data, '$.tutorial_step') AS ts
         FROM users_data WHERE user_id = ?`, [authUser.id]
      );
      const row = rows[0] || {};
      return sendJson(res, 200, {
        ok: true,
        data: {
          completed: !!(row.tc && Number(row.tc)),
          step: Number(row.ts) || 0,
        }
      });
    }

    // POST /api/tutorial/progress — Tutorial-Schritt in users_data.project_data speichern
    if (req.method === 'POST' && pathname === '/api/tutorial/progress') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const body = await readJsonBody(req);
      const step = Math.max(0, Number(body.step) || 0);

      await dbPool.query(
        `INSERT INTO users_data (user_id, project_data) VALUES (?, JSON_OBJECT('tutorial_step', ?))
         ON DUPLICATE KEY UPDATE project_data = JSON_SET(COALESCE(project_data, '{}'), '$.tutorial_step', ?)`,
        [authUser.id, step, step]
      );
      return sendJson(res, 200, { ok: true, data: { step } });
    }

    // POST /api/tutorial/complete — Tutorial als abgeschlossen in users_data.project_data
    if (req.method === 'POST' && pathname === '/api/tutorial/complete') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      await dbPool.query(
        `INSERT INTO users_data (user_id, project_data) VALUES (?, JSON_OBJECT('tutorial_completed', 1))
         ON DUPLICATE KEY UPDATE project_data = JSON_SET(COALESCE(project_data, '{}'), '$.tutorial_completed', 1)`,
        [authUser.id]
      );
      return sendJson(res, 200, { ok: true, data: { completed: true } });
    }

    // POST /api/tutorial/reset — Tutorial in users_data.project_data zuruecksetzen
    if (req.method === 'POST' && pathname === '/api/tutorial/reset') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      await dbPool.query(
        `INSERT INTO users_data (user_id, project_data) VALUES (?, JSON_OBJECT('tutorial_completed', 0, 'tutorial_step', 0))
         ON DUPLICATE KEY UPDATE project_data = JSON_SET(COALESCE(project_data, '{}'), '$.tutorial_completed', 0, '$.tutorial_step', 0)`,
        [authUser.id]
      );
      return sendJson(res, 200, { ok: true, data: { reset: true } });
    }

    // GET /api/leaderboard — Spieler- und Gemeinde-Ranglisten
    if (req.method === 'GET' && pathname === '/api/leaderboard') {
      ensureDbEnabled();
      const type = requestUrl.searchParams.get('type') || 'players';

      if (type === 'players') {
        const [rows] = await dbPool.query(
          `SELECT u.id, u.nickname, u.municipality_id, m.name AS municipality_name,
                  COALESCE(ux.total_xp, 0) AS xp, COALESCE(ux.level, 1) AS level
           FROM users u
           LEFT JOIN user_xp ux ON ux.user_id = u.id
           LEFT JOIN municipalities m ON m.id = u.municipality_id
           ORDER BY COALESCE(ux.total_xp, 0) DESC LIMIT 50`
        );
        return sendJson(res, 200, { ok: true, data: { entries: rows, type: 'players' } });
      } else {
        const [rows] = await dbPool.query(
          `SELECT m.id, m.name, m.slug,
                  COALESCE(agg.total_pop, 0) AS population,
                  COALESCE(agg.total_money, 0) AS money,
                  COALESCE(agg.avg_happiness, 50) AS happiness,
                  owner_u.nickname AS owner_name
           FROM municipalities m
           LEFT JOIN (
             SELECT municipality_id,
                    SUM(CAST(JSON_EXTRACT(stats_data, '$.population') AS UNSIGNED)) AS total_pop,
                    SUM(CAST(JSON_EXTRACT(stats_data, '$.money') AS SIGNED)) AS total_money,
                    ROUND(
                      CASE
                        WHEN SUM(CAST(JSON_EXTRACT(stats_data, '$.population') AS UNSIGNED)) > 0
                        THEN SUM(CAST(JSON_EXTRACT(stats_data, '$.population') AS UNSIGNED) * CAST(JSON_EXTRACT(stats_data, '$.happiness') AS UNSIGNED))
                             / SUM(CAST(JSON_EXTRACT(stats_data, '$.population') AS UNSIGNED))
                        ELSE AVG(CAST(JSON_EXTRACT(stats_data, '$.happiness') AS UNSIGNED))
                      END
                    ) AS avg_happiness
             FROM game_stats
             GROUP BY municipality_id
           ) agg ON agg.municipality_id = m.id
           LEFT JOIN municipality_memberships mm ON mm.municipality_id = m.id AND mm.role = 'owner'
           LEFT JOIN users owner_u ON owner_u.id = mm.user_id
           ORDER BY COALESCE(agg.total_pop, 0) DESC LIMIT 50`
        );
        return sendJson(res, 200, { ok: true, data: { entries: rows, type: 'municipalities' } });
      }
    }

    // GET /api/users/:id/profile oder /api/users/me/profile — Spielerprofil
    const profileMatch = pathname.match(/^\/api\/users\/([0-9]+|me)\/profile$/i);
    if (profileMatch && req.method === 'GET') {
      ensureDbEnabled();
      let userId;
      if (profileMatch[1] === 'me') {
        const authUser = await getAuthenticatedUser(req);
        if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
        userId = authUser.id;
      } else {
        userId = Number(profileMatch[1]);
      }
      const [users] = await dbPool.query(
        `SELECT u.id, u.nickname, u.municipality_id, u.created_at,
                m.name AS municipality_name, m.slug AS municipality_slug,
                COALESCE(ux.total_xp, 0) AS xp, COALESCE(ux.level, 1) AS level
         FROM users u
         LEFT JOIN municipalities m ON m.id = u.municipality_id
         LEFT JOIN user_xp ux ON ux.user_id = u.id
         WHERE u.id = ?`, [userId]
      );
      if (users.length === 0) return sendJson(res, 404, { ok: false, error: 'Spieler nicht gefunden' });

      const [badges] = await dbPool.query(
        `SELECT ub.badge_code, b.name, b.description, COALESCE(b.image_url, '') AS image_url, b.rarity, b.category
         FROM user_badges ub
         JOIN badges b ON b.code = ub.badge_code
         WHERE ub.user_id = ?
         ORDER BY b.rarity DESC`, [userId]
      );

      const [companies] = await dbPool.query(
        `SELECT c.name, c.level, c.reputation, ct.emoji, ct.name AS type_name, cm.role
         FROM company_members cm
         JOIN companies c ON c.id = cm.company_id
         JOIN company_types ct ON ct.id = c.company_type_id
         WHERE cm.user_id = ? AND c.is_active = 1`, [userId]
      );

      return sendJson(res, 200, {
        ok: true,
        data: {
          ...users[0],
          badges,
          companies,
        }
      });
    }

    // POST /api/companies/:id/apply — Sich bei Firma bewerben
    const companyApplyMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/apply$/i);
    if (companyApplyMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyApplyMatch[1]);

      // Pruefen ob Firma existiert
      const [companies] = await dbPool.query(`SELECT id, name FROM companies WHERE id = ? AND is_active = 1`, [companyId]);
      if (companies.length === 0) return sendJson(res, 404, { ok: false, error: 'Firma nicht gefunden' });

      // Pruefen ob schon Mitglied
      const [existingMember] = await dbPool.query(
        `SELECT id FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (existingMember.length > 0) return sendJson(res, 400, { ok: false, error: 'Du bist bereits Mitglied' });

      // Pruefen ob schon beworben
      const [existingApp] = await dbPool.query(
        `SELECT id, status FROM company_applications WHERE company_id = ? AND user_id = ? AND status = 'pending'`,
        [companyId, authUser.id]
      );
      if (existingApp.length > 0) return sendJson(res, 400, { ok: false, error: 'Du hast bereits eine offene Bewerbung' });

      const body = await readJsonBody(req);
      const message = String(body.message || '').trim().substring(0, 500) || null;

      await dbPool.query(
        `INSERT INTO company_applications (company_id, user_id, message) VALUES (?, ?, ?)`,
        [companyId, authUser.id, message]
      );

      return sendJson(res, 200, { ok: true, data: { applied: true, company_name: companies[0].name } });
    }

    // POST /api/companies/:id/applications/:appId/respond — Bewerbung annehmen/ablehnen
    const companyAppRespondMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/applications\/([0-9]+)\/respond$/i);
    if (companyAppRespondMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyAppRespondMatch[1]);
      const applicationId = Number(companyAppRespondMatch[2]);

      // Berechtigung: Owner oder Manager
      const [myRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myRole[0] || !['owner', 'manager'].includes(myRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Keine Berechtigung' });
      }

      const body = await readJsonBody(req);
      const decision = body.decision; // 'accepted' oder 'rejected'
      if (!['accepted', 'rejected'].includes(decision)) {
        return sendJson(res, 422, { ok: false, error: 'decision muss "accepted" oder "rejected" sein' });
      }

      const [apps] = await dbPool.query(
        `SELECT * FROM company_applications WHERE id = ? AND company_id = ? AND status = 'pending'`,
        [applicationId, companyId]
      );
      if (apps.length === 0) return sendJson(res, 404, { ok: false, error: 'Bewerbung nicht gefunden' });
      const application = apps[0];

      await dbPool.query(
        `UPDATE company_applications SET status = ?, responded_by = ?, responded_at = NOW(), updated_at = NOW() WHERE id = ?`,
        [decision, authUser.id, applicationId]
      );

      if (decision === 'accepted') {
        // Max-Mitglieder pruefen
        const [companyInfo] = await dbPool.query(
          `SELECT c.id, ct.max_members, (SELECT COUNT(*) FROM company_members WHERE company_id = c.id) AS current_members
           FROM companies c JOIN company_types ct ON ct.id = c.company_type_id WHERE c.id = ?`, [companyId]
        );
        if (companyInfo[0]?.current_members >= companyInfo[0]?.max_members) {
          return sendJson(res, 400, { ok: false, error: 'Firma ist voll — Bewerbung kann nicht angenommen werden' });
        }

        await dbPool.query(
          `INSERT IGNORE INTO company_members (company_id, user_id, role) VALUES (?, ?, 'employee')`,
          [companyId, application.user_id]
        );
      }

      return sendJson(res, 200, { ok: true, data: { application_id: applicationId, decision } });
    }

    // ================================================================
    // GEMEINDE STATISTIK-HISTORY
    // ================================================================

    // GET /api/game/municipality/:slug/stats-history — Taegliche Snapshots
    const statsHistoryMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/stats-history$/i);
    if (statsHistoryMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const municipality = await getMunicipalityBySlug(statsHistoryMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const days = Math.min(365, Math.max(1, parseInt(urlObj.searchParams.get('days') || '90', 10)));

      const [historyRows] = await dbPool.query(
        `SELECT snapshot_date AS date, population, jobs, money, income, expenses, happiness
         FROM municipality_stats_history
         WHERE municipality_id = ? AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         ORDER BY snapshot_date ASC`,
        [municipality.id, days]
      );

      return sendJson(res, 200, { ok: true, data: historyRows });
    }

    // ================================================================
    // BENUTZER-BENACHRICHTIGUNGEN
    // ================================================================

    // GET /api/game/notifications — Ungelesene Benachrichtigungen des Users
    if (pathname === '/api/game/notifications' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `SELECT id, notification_type AS type, title, message, icon, amount, municipality_id, is_read,
                created_at
         FROM user_notifications
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 50`,
        [authUser.id]
      );

      return sendJson(res, 200, { ok: true, data: rows });
    }

    // PATCH /api/game/notifications/:id/read — Einzelne Benachrichtigung als gelesen markieren
    const notifReadMatch = pathname.match(/^\/api\/game\/notifications\/(\d+)\/read$/);
    if (notifReadMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      await dbPool.query(
        `UPDATE user_notifications SET is_read = 1 WHERE id = ? AND user_id = ?`,
        [notifReadMatch[1], authUser.id]
      );

      return sendJson(res, 200, { ok: true });
    }

    // PATCH /api/game/notifications/read-all — Alle als gelesen markieren
    if (pathname === '/api/game/notifications/read-all' && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      await dbPool.query(
        `UPDATE user_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`,
        [authUser.id]
      );

      return sendJson(res, 200, { ok: true });
    }

    // DELETE /api/game/notifications/:id — Einzelne Benachrichtigung loeschen
    const notifDeleteMatch = pathname.match(/^\/api\/game\/notifications\/(\d+)$/);
    if (notifDeleteMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [result] = await dbPool.query(
        `DELETE FROM user_notifications WHERE id = ? AND user_id = ?`,
        [notifDeleteMatch[1], authUser.id]
      );

      return sendJson(res, 200, { ok: true, data: { deleted: Number(result.affectedRows || 0) } });
    }

    // DELETE /api/game/notifications — Alle Benachrichtigungen des Users loeschen
    if (pathname === '/api/game/notifications' && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [result] = await dbPool.query(
        `DELETE FROM user_notifications WHERE user_id = ?`,
        [authUser.id]
      );

      return sendJson(res, 200, { ok: true, data: { deleted: Number(result.affectedRows || 0) } });
    }

    // ================================================================
    // BANK / FINANZEN
    // ================================================================

    if (req.method === 'GET' && pathname === '/api/game/bank/status') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      try {
        const status = await getBank().getBankStatus(authUser.municipality_id);
        return sendJson(res, 200, { ok: true, data: status });
      } catch (err) {
        logError('BANK', 'getBankStatus failed', { municipalityId: authUser.municipality_id, error: err?.message });
        return sendJson(res, 500, { ok: false, error: 'Bank-Status konnte nicht geladen werden' });
      }
    }

    if (req.method === 'GET' && pathname === '/api/game/bank/ledger') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const role = await getUserMunicipalityRole(authUser.id, authUser.municipality_id);
      if (!role || !['owner', 'council', 'admin'].includes(role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung darf das Ledger einsehen' });
      }
      try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const limit = Number(url.searchParams.get('limit')) || 50;
        const offset = Number(url.searchParams.get('offset')) || 0;
        const filter = url.searchParams.get('filter') || 'all';
        const result = await getBank().getLedger(authUser.municipality_id, { limit, offset, typeFilter: filter });
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        logError('BANK', 'getLedger failed', { municipalityId: authUser.municipality_id, error: err?.message });
        return sendJson(res, 500, { ok: false, error: 'Ledger konnte nicht geladen werden' });
      }
    }

    if (req.method === 'POST' && pathname === '/api/game/bank/loan') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const role = await getUserMunicipalityRole(authUser.id, authUser.municipality_id);
      if (!role || !['owner', 'council'].includes(role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Gemeindepraesident oder Gemeinderat duerfen Kredite aufnehmen' });
      }
      const body = await readJsonBody(req);
      const amount = Math.round(Number(body.amount) || 0);
      if (amount <= 0) return sendJson(res, 400, { ok: false, error: 'Betrag muss groesser als 0 sein' });
      try {
        const result = await getBank().takeLoan(authUser.municipality_id, amount, authUser.id);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/game/bank/repay') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const role = await getUserMunicipalityRole(authUser.id, authUser.municipality_id);
      if (!role || !['owner', 'council'].includes(role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Gemeindepraesident oder Gemeinderat duerfen Kredite zurueckzahlen' });
      }
      const body = await readJsonBody(req);
      const amount = body.amount === 'all' ? 'all' : Math.round(Number(body.amount) || 0);
      if (amount !== 'all' && amount <= 0) return sendJson(res, 400, { ok: false, error: 'Betrag muss groesser als 0 sein' });
      try {
        const result = await getBank().repayLoan(authUser.municipality_id, amount, authUser.id);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // ================================================================
    // GEMEINDE MITGLIEDER-VERWALTUNG (ergaenzende Endpoints)
    // ================================================================

    // GET /api/game/municipality/:slug/members — Alle Mitglieder mit Rollen
    const municipalityMembersMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/members$/i);
    if (municipalityMembersMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityMembersMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const [members] = await dbPool.query(
        `SELECT mm.user_id, mm.role, mm.created_at AS joined_at, mm.updated_at,
                u.nickname, u.email,
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

    // DELETE /api/game/municipality/:slug/members/:userId — Mitglied kicken
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

      // Pruefen ob Ziel Mitglied ist
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

      logInfo('MUNICIPALITY', `User ${targetUserId} aus Gemeinde ${municipality.name} entfernt von ${authUser.id}`);

      return sendJson(res, 200, { ok: true, data: { removed: true, user_id: targetUserId } });
    }

    // POST /api/game/municipality/:slug/members/invite — Mitglied einladen
    const municipalityMemberInviteMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/members\/invite$/i);
    if (municipalityMemberInviteMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityMemberInviteMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });

      const requesterRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canInviteToMunicipality(requesterRole)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Gemeindepraesident oder Gemeinderat koennen einladen' });
      }

      const body = await readJsonBody(req);
      const targetUserId = Number(body.user_id || 0);
      if (!targetUserId) return sendJson(res, 422, { ok: false, error: 'user_id erforderlich' });

      // Pruefen ob User existiert
      const [targetUser] = await dbPool.query(`SELECT id, nickname, municipality_id FROM users WHERE id = ?`, [targetUserId]);
      if (targetUser.length === 0) return sendJson(res, 404, { ok: false, error: 'User nicht gefunden' });
      if (Number(targetUser[0].municipality_id) === Number(municipality.id)) {
        return sendJson(res, 400, { ok: false, error: 'User ist bereits Mitglied dieser Gemeinde' });
      }

      // Member-Limit pruefen
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

    // GET /api/users/search — User suchen (fuer Einladungen)
    if (req.method === 'GET' && pathname === '/api/users/search') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const query = String(requestUrl.searchParams.get('q') || '').trim();
      if (query.length < 2) return sendJson(res, 200, { ok: true, data: { users: [] } });

      const [rows] = await dbPool.query(
        `SELECT u.id, u.nickname, u.municipality_id, m.name AS municipality_name,
                (SELECT level FROM user_xp WHERE user_id = u.id) AS user_level
         FROM users u
         LEFT JOIN municipalities m ON m.id = u.municipality_id
         WHERE u.nickname LIKE ? AND u.id != ?
         ORDER BY u.nickname ASC LIMIT 20`,
        [`%${query}%`, authUser.id]
      );

      return sendJson(res, 200, { ok: true, data: { users: rows } });
    }

    // ================================================================
    // END COMPANY / GEMEINDE VERWALTUNG
    // ================================================================

    if (req.method === 'GET' && pathname === '/api/game-data/rivers') {
      ensureDbEnabled();
      const cantonQuery = requestUrl.searchParams.get('canton');
      const municipalitySlugQuery = requestUrl.searchParams.get('municipality_slug');
      let canton = cantonQuery || null;
      let municipality = null;
      if (!canton && municipalitySlugQuery) {
        municipality = await getMunicipalityBySlug(municipalitySlugQuery.trim().toLowerCase());
        if (municipality) canton = municipality.canton_code;
      }
      const rivers = await fetchRivers(canton);
      return sendJson(res, 200, {
        ok: true,
        canton: canton ? canton.toUpperCase() : null,
        municipality: municipality ? {
          id: municipality.id,
          slug: municipality.slug,
          name: municipality.name,
          canton_code: municipality.canton_code,
        } : null,
        rivers,
      });
    }

    if (req.method === 'GET' && pathname === '/api/game/item-details') {
      ensureDbEnabled();
      const details = await fetchItemDetails(null);
      const catalogVersion = await fetchItemCatalogVersion();
      const catalogPages = await fetchCatalogPages();
      return sendJson(res, 200, {
        ok: true,
        catalog_version: catalogVersion,
        items: details,
        count: details.length,
        catalog_pages: catalogPages,
      });
    }

    const itemDetailsMatch = pathname.match(/^\/api\/game\/item-details\/([^/]+)$/i);
    if (req.method === 'GET' && itemDetailsMatch) {
      ensureDbEnabled();
      const tool = decodeURIComponent(itemDetailsMatch[1]);
      const detail = await fetchItemDetails(tool);
      if (!detail) return sendJson(res, 404, { ok: false, error: 'Item-Detail nicht gefunden' });
      const catalogVersion = await fetchItemCatalogVersion();
      return sendJson(res, 200, { ok: true, catalog_version: catalogVersion, item: detail });
    }

    const itemsRoomMatch = pathname.match(/^\/api\/game\/items\/([a-z0-9-]+)\/([a-z0-9-]+)$/i);
    if (itemsRoomMatch) {
      ensureDbEnabled();
      const municipalitySlug = itemsRoomMatch[1].toLowerCase();
      const roomCode = normalizeRoomCode(itemsRoomMatch[2]);
      const municipality = await getMunicipalityBySlug(municipalitySlug);
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      if (!roomCode) return sendJson(res, 422, { ok: false, error: 'roomCode ungueltig' });

      if (req.method === 'GET') {
        await ensureServerGeneratedRoomMap(municipality, roomCode);
        await runServerDisasterTick(municipality.id, roomCode);
        await runServerBuildingUpgradeTick(municipality.id, roomCode);
        const room = await getRoom(municipality.id, roomCode);
        const roomState = toJsonValue(room?.game_state);
        const isNavigatorPublic = Boolean(roomCode.startsWith('PUB') || roomState?.navigator_public === true);
        const effectiveGridSize = isNavigatorPublic
          ? Math.max(6, Math.min(12, Math.round(Number(roomState?.room_size || 8))))
          : 50;
        const effectiveCityName = String(room?.city_name || municipality.name || roomCode);
        const rawStats = await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);
        const rows = await getRoomItemRows(municipality.id, roomCode);
        const version = await getRoomItemVersion(municipality.id, roomCode);
        const mapRow = await getGameMapForMunicipality(municipality.id);
        const formatted = rows.map(formatGameItemRow);
        const waterBodies = toJsonValue(mapRow?.water_bodies) || [];
        const stats = toItemsStatsShape(rawStats, waterBodies);
        return sendJson(res, 200, {
          ok: true,
          data: {
            room_code: roomCode,
            municipality_slug: municipality.slug,
            municipality_name: municipality.name,
            grid_size: effectiveGridSize,
            version,
            room_version: version,
            item_count: formatted.length,
            items: formatted,
            stats,
            city_name: effectiveCityName,
          },
        });
      }

      if (req.method === 'DELETE') {
        const deleted = await deleteRoomItems(municipality.id, roomCode);
        await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
        return sendJson(res, 200, { ok: true, data: { deleted } });
      }
    }

    const itemsImportMatch = pathname.match(/^\/api\/game\/items\/([a-z0-9-]+)\/([a-z0-9-]+)\/import$/i);
    if (req.method === 'POST' && itemsImportMatch) {
      ensureDbEnabled();
      const municipalitySlug = itemsImportMatch[1].toLowerCase();
      const roomCode = normalizeRoomCode(itemsImportMatch[2]);
      const municipality = await getMunicipalityBySlug(municipalitySlug);
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      const body = await readJsonBody(req);
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items) return sendJson(res, 422, { ok: false, error: 'items muss ein Array sein' });
      const result = await importRoomItems(
        municipality.id,
        roomCode,
        (body.client_id || 'system').toString(),
        authUser?.id || null,
        items
      );
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
      return sendJson(res, 200, {
        ok: true,
        data: {
          deleted_old: result.deletedOld,
          total_imported: result.totalImported,
          new_version: result.newVersion,
        },
      });
    }

    const itemsRegenerateMatch = pathname.match(/^\/api\/game\/items\/([a-z0-9-]+)\/([a-z0-9-]+)\/regenerate$/i);
    if (req.method === 'POST' && itemsRegenerateMatch) {
      ensureDbEnabled();
      const municipalitySlug = itemsRegenerateMatch[1].toLowerCase();
      const roomCode = normalizeRoomCode(itemsRegenerateMatch[2]);
      const municipality = await getMunicipalityBySlug(municipalitySlug);
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      if (!roomCode) return sendJson(res, 422, { ok: false, error: 'roomCode ungueltig' });

      const deleted = await deleteRoomItems(municipality.id, roomCode);
      const generated = await ensureServerGeneratedRoomMap(municipality, roomCode);
      const version = await getRoomItemVersion(municipality.id, roomCode);
      const rows = await getRoomItemRows(municipality.id, roomCode);
      const roomKey = wsRoomKey(municipality.slug, roomCode);
      try {
        await wsPublishAuthoritativeStats(io, roomKey, 'server-core-regenerate');
      } catch {
        // API-Antwort nicht fehlschlagen lassen.
      }
      return sendJson(res, 200, {
        ok: true,
        data: {
          deleted,
          generated: Boolean(generated?.generated),
          item_count: Array.isArray(rows) ? rows.length : 0,
          version,
          room_code: roomCode,
          municipality_slug: municipality.slug,
        },
      });
    }

    const itemsSyncMatch = pathname.match(/^\/api\/game\/items\/([a-z0-9-]+)\/([a-z0-9-]+)\/sync$/i);
    if (req.method === 'POST' && itemsSyncMatch) {
      ensureDbEnabled();
      const municipalitySlug = itemsSyncMatch[1].toLowerCase();
      const roomCode = normalizeRoomCode(itemsSyncMatch[2]);
      const municipality = await getMunicipalityBySlug(municipalitySlug);
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        logInfo('SECURITY', `User ${authUser.id} versuchte Items-Sync fuer Gemeinde ${municipality.slug} (eigene municipality_id: ${authUser.municipality_id})`);
        return sendJson(res, 403, { ok: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const syncUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(syncUserRole)) {
        return sendJson(res, 403, { ok: false, error: 'Beobachter duerfen die Map nicht veraendern' });
      }
      const body = await readJsonBody(req);
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items) return sendJson(res, 422, { ok: false, error: 'items muss ein Array sein' });
      const result = await syncRoomItems(
        municipality.id,
        roomCode,
        (body.client_id || 'system').toString(),
        authUser.id,
        items
      );
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
      return sendJson(res, 200, { ok: true, data: result });
    }

    // Laravel-kompatible Aliase fuer bestehendes mapGame
    const legacyItemsGetMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/items\/([a-z0-9-]+)$/i);
    if (legacyItemsGetMatch && req.method === 'GET') {
      req.url = `/api/game/items/${legacyItemsGetMatch[1]}/${legacyItemsGetMatch[2]}`;
      // Rekursion vermeiden: direkt gleich behandeln
      const municipality = await getMunicipalityBySlug(legacyItemsGetMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      const roomCode = normalizeRoomCode(legacyItemsGetMatch[2]);
      await ensureServerGeneratedRoomMap(municipality, roomCode);
      await runServerDisasterTick(municipality.id, roomCode);
      await runServerBuildingUpgradeTick(municipality.id, roomCode);
      const room = await getRoom(municipality.id, roomCode);
      const roomState = toJsonValue(room?.game_state);
      const isNavigatorPublic = Boolean(roomCode.startsWith('PUB') || roomState?.navigator_public === true);
      const effectiveGridSize = isNavigatorPublic
        ? Math.max(6, Math.min(12, Math.round(Number(roomState?.room_size || 8))))
        : 50;
      const effectiveCityName = String(room?.city_name || municipality.name || roomCode);
      const rawStats = await recomputeAuthoritativePopulationAndJobs(municipality.id, roomCode);
      const rows = await getRoomItemRows(municipality.id, roomCode);
      const version = await getRoomItemVersion(municipality.id, roomCode);
      const mapRow = await getGameMapForMunicipality(municipality.id);
      const formatted = rows.map(formatGameItemRow);
      const waterBodies = toJsonValue(mapRow?.water_bodies) || [];
      const stats = toItemsStatsShape(rawStats, waterBodies);
      return sendJson(res, 200, {
        success: true,
        data: {
          room_code: roomCode,
          municipality_slug: municipality.slug,
          municipality_name: municipality.name,
          grid_size: effectiveGridSize,
          version,
          room_version: version,
          item_count: formatted.length,
          items: formatted,
          stats,
          city_name: effectiveCityName,
        },
      });
    }
    if (legacyItemsGetMatch && req.method === 'DELETE') {
      const municipality = await getMunicipalityBySlug(legacyItemsGetMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        logInfo('SECURITY', `User ${authUser.id} versuchte Items-Delete fuer Gemeinde ${municipality.slug} (eigene municipality_id: ${authUser.municipality_id})`);
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const delUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(delUserRole)) {
        return sendJson(res, 403, { success: false, error: 'Beobachter duerfen die Map nicht veraendern' });
      }
      const roomCode = normalizeRoomCode(legacyItemsGetMatch[2]);
      const deleted = await deleteRoomItems(municipality.id, roomCode);
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
      return sendJson(res, 200, { success: true, data: { deleted } });
    }

    const legacyImportMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/items\/import$/i);
    if (legacyImportMatch && req.method === 'POST') {
      const municipality = await getMunicipalityBySlug(legacyImportMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        logInfo('SECURITY', `User ${authUser.id} versuchte Items-Import fuer Gemeinde ${municipality.slug} (eigene municipality_id: ${authUser.municipality_id})`);
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const importUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(importUserRole)) {
        return sendJson(res, 403, { success: false, error: 'Beobachter duerfen die Map nicht veraendern' });
      }
      const body = await readJsonBody(req);
      const roomCode = normalizeRoomCode(body.room_code);
      const items = Array.isArray(body.items) ? body.items : null;
      if (!roomCode || !items) return sendJson(res, 422, { success: false, error: 'room_code/items ungueltig' });
      const result = await importRoomItems(municipality.id, roomCode, (body.client_id || 'system').toString(), authUser.id, items);
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
      return sendJson(res, 200, {
        success: true,
        data: {
          deleted_old: result.deletedOld,
          total_imported: result.totalImported,
          new_version: result.newVersion,
        },
      });
    }

    const legacyRegenerateMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/items\/([a-z0-9-]+)\/regenerate$/i);
    if (legacyRegenerateMatch && req.method === 'POST') {
      const municipality = await getMunicipalityBySlug(legacyRegenerateMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const roomCode = normalizeRoomCode(legacyRegenerateMatch[2]);
      if (!roomCode) return sendJson(res, 422, { success: false, error: 'roomCode ungueltig' });

      const deleted = await deleteRoomItems(municipality.id, roomCode);
      const generated = await ensureServerGeneratedRoomMap(municipality, roomCode);
      const version = await getRoomItemVersion(municipality.id, roomCode);
      const rows = await getRoomItemRows(municipality.id, roomCode);
      const roomKey = wsRoomKey(municipality.slug, roomCode);
      try {
        await wsPublishAuthoritativeStats(io, roomKey, 'server-core-regenerate');
      } catch {
        // API-Antwort nicht fehlschlagen lassen.
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          deleted,
          generated: Boolean(generated?.generated),
          item_count: Array.isArray(rows) ? rows.length : 0,
          version,
          room_code: roomCode,
          municipality_slug: municipality.slug,
        },
      });
    }

    const legacySyncMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/items\/sync$/i);
    if (legacySyncMatch && req.method === 'POST') {
      const municipality = await getMunicipalityBySlug(legacySyncMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (Number(authUser.municipality_id) !== Number(municipality.id)) {
        logInfo('SECURITY', `User ${authUser.id} versuchte Legacy-Sync fuer Gemeinde ${municipality.slug} (eigene municipality_id: ${authUser.municipality_id})`);
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
      }
      const legSyncUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
      if (!canBuildInMunicipality(legSyncUserRole)) {
        return sendJson(res, 403, { success: false, error: 'Beobachter duerfen die Map nicht veraendern' });
      }
      const body = await readJsonBody(req);
      const roomCode = normalizeRoomCode(body.room_code);
      const items = Array.isArray(body.items) ? body.items : null;
      if (!roomCode || !items) return sendJson(res, 422, { success: false, error: 'room_code/items ungueltig' });
      const result = await syncRoomItems(municipality.id, roomCode, (body.client_id || 'system').toString(), authUser.id, items);
      await refreshGameDataMapFromItems(municipality, roomCode, 'server-core-live-v1');
      return sendJson(res, 200, { success: true, data: result });
    }

    const mapPathMatch = pathname.match(/^\/api\/game-data\/map\/([a-z0-9-]+)$/i);
    if (mapPathMatch) {
      ensureDbEnabled();
      const municipalitySlug = mapPathMatch[1].toLowerCase();
      const municipality = await getMunicipalityBySlug(municipalitySlug);
      if (!municipality) {
        return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      }

      if (req.method === 'GET') {
        const row = await getGameMapForMunicipality(municipality.id);
        if (!row) {
          return sendJson(res, 200, {
            ok: true,
            exists: false,
            municipality: {
              id: municipality.id,
              slug: municipality.slug,
              name: municipality.name,
              canton_code: municipality.canton_code,
            },
          });
        }
        return sendJson(res, 200, {
          ok: true,
          exists: true,
          municipality: {
            id: municipality.id,
            slug: municipality.slug,
            name: municipality.name,
            canton_code: municipality.canton_code,
          },
          map: {
            grid_size: row.grid_size,
            map_data: toJsonValue(row.map_data),
            water_bodies: toJsonValue(row.water_bodies),
            seed: row.seed,
            generator_version: row.generator_version,
            generated_at: row.generated_at,
            updated_at: row.updated_at,
          },
        });
      }

      if (req.method === 'POST') {
        const authUser = await getAuthenticatedUser(req);
        if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
        if (Number(authUser.municipality_id) !== Number(municipality.id)) {
          logInfo('SECURITY', `User ${authUser.id} versuchte Map-Daten fuer Gemeinde ${municipality.slug} zu speichern (eigene municipality_id: ${authUser.municipality_id})`);
          return sendJson(res, 403, { ok: false, error: 'Keine Berechtigung fuer diese Gemeinde' });
        }
        const mapUserRole = await getUserMunicipalityRole(authUser.id, municipality.id);
        if (!canBuildInMunicipality(mapUserRole)) {
          return sendJson(res, 403, { ok: false, error: 'Beobachter duerfen die Map nicht veraendern' });
        }
        const body = await readJsonBody(req);
        if (typeof body.map_data === 'undefined') {
          return sendJson(res, 422, { ok: false, error: 'map_data ist erforderlich' });
        }
        const gridSize = Number(body.grid_size || 50);
        if (!Number.isInteger(gridSize) || gridSize < 10 || gridSize > 500) {
          return sendJson(res, 422, { ok: false, error: 'grid_size ist ungueltig (10-500)' });
        }

        await upsertGameMapForMunicipality(municipality.id, {
          gridSize,
          mapData: body.map_data,
          waterBodies: body.water_bodies ?? null,
          seed: body.seed ? String(body.seed) : null,
          generatorVersion: body.generator_version ? String(body.generator_version) : null,
          generatedAt: body.generated_at ? new Date(body.generated_at) : new Date(),
        });

        return sendJson(res, 200, {
          ok: true,
          municipality: {
            id: municipality.id,
            slug: municipality.slug,
            name: municipality.name,
            canton_code: municipality.canton_code,
          },
          saved: true,
        });
      }
    }

    if (req.method === 'POST' && pathname === '/api/auth/register') {
      ensureDbEnabled();
      const body = await readJsonBody(req);
      const email = (body.email || '').toString().trim().toLowerCase();
      const password = (body.password || '').toString();
      const nickname = (body.nickname || '').toString().trim();
      const municipalityId = Number(body.municipality_id) || 0;
      const newMunicipalityName = (body.new_municipality_name || '').toString().trim();
      const isCreatingMunicipality = !!body.create_municipality && newMunicipalityName.length > 0;

      if (!validateEmail(email)) {
        return sendJson(res, 422, { ok: false, error: 'Ungueltige E-Mail' });
      }
      if (password.length < 8) {
        return sendJson(res, 422, { ok: false, error: 'Passwort muss mindestens 8 Zeichen haben' });
      }
      if (nickname.length < 2 || nickname.length > 32) {
        return sendJson(res, 422, { ok: false, error: 'Nickname muss 2-32 Zeichen haben' });
      }

      // Entweder bestehende Gemeinde waehlen oder neue erstellen
      let municipality = null;
      let municipalityMemberCount = 0;

      if (isCreatingMunicipality) {
        // Neue Gemeinde erstellen
        if (newMunicipalityName.length < 2 || newMunicipalityName.length > 100) {
          return sendJson(res, 422, { ok: false, error: 'Gemeindename muss 2-100 Zeichen haben' });
        }

        // Slug generieren
        const slug = newMunicipalityName
          .toLowerCase()
          .replace(/[äàâ]/g, 'ae').replace(/[öòô]/g, 'oe').replace(/[üùû]/g, 'ue')
          .replace(/[éèêë]/g, 'e').replace(/[íìîï]/g, 'i').replace(/[ß]/g, 'ss')
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        // Pruefen ob Gemeinde mit gleichem Slug bereits existiert
        const [existingSlug] = await dbPool.query(
          'SELECT id FROM municipalities WHERE slug = ? LIMIT 1',
          [slug]
        );
        if (Array.isArray(existingSlug) && existingSlug.length > 0) {
          return sendJson(res, 409, { ok: false, error: 'Eine Gemeinde mit diesem Namen existiert bereits' });
        }

        // Neue Gemeinde in DB anlegen (user-created, NICHT im normalen Dropdown sichtbar)
        const [insertMun] = await dbPool.query(
          `INSERT INTO municipalities (name, slug, canton_code, canton_name, is_active, is_user_created)
           VALUES (?, ?, '', '', 1, 1)`,
          [newMunicipalityName, slug]
        );
        municipality = {
          id: insertMun.insertId,
          name: newMunicipalityName,
          slug,
          canton_code: '',
          canton_name: '',
        };
        municipalityMemberCount = 0;
      } else {
        // Bestehende Gemeinde waehlen
        if (!Number.isInteger(municipalityId) || municipalityId <= 0) {
          return sendJson(res, 422, { ok: false, error: 'Bitte waehle eine Gemeinde oder erstelle eine neue' });
        }

        municipality = await getMunicipalityById(municipalityId);
        if (!municipality) {
          return sendJson(res, 422, { ok: false, error: 'Gemeinde nicht gefunden oder inaktiv' });
        }
        const [memberLimitRows] = await dbPool.query(
          `SELECT COUNT(*) AS cnt
           FROM users
           WHERE municipality_id = ? AND is_active = 1`,
          [municipality.id]
        );
        municipalityMemberCount = Number(memberLimitRows?.[0]?.cnt || 0);
        if (municipalityMemberCount >= MUNICIPALITY_MEMBER_LIMIT) {
          return sendJson(res, 409, {
            ok: false,
            error: `Gemeinde ist voll (maximal ${MUNICIPALITY_MEMBER_LIMIT} Mitbuerger)`,
          });
        }
      }

      const existingUser = await getUserByEmailWithMunicipality(email);
      if (existingUser) {
        return sendJson(res, 409, { ok: false, error: 'E-Mail bereits registriert' });
      }
      const [nicknameRows] = await dbPool.query(
        'SELECT id FROM users WHERE nickname = ? LIMIT 1',
        [nickname]
      );
      if (Array.isArray(nicknameRows) && nicknameRows.length > 0) {
        return sendJson(res, 409, { ok: false, error: 'Nickname bereits vergeben' });
      }

      const { salt, passwordHash } = createPasswordData(password);
      const uuid = crypto.randomUUID();
      const [insertResult] = await dbPool.query(
        `INSERT INTO users (uuid, email, nickname, municipality_id, password_hash, password_salt, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [uuid, email, nickname, municipality.id, passwordHash, salt]
      );
      const userId = insertResult.insertId;
      const rankRoleSync = await syncUserGlobalRoleFromRank(userId, GLOBAL_ROLE_USER);
      const globalRole = normalizeGlobalRole(rankRoleSync.role);
      await ensureAtLeastOneGlobalAdministrator();
      await ensureMunicipalityRoleTables();
      const initialRole = municipalityMemberCount === 0 ? MUNICIPALITY_ROLE_OWNER : MUNICIPALITY_ROLE_CITIZEN;
      await dbPool.query(
        `INSERT INTO municipality_memberships (municipality_id, user_id, role)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           role = VALUES(role),
           updated_at = CURRENT_TIMESTAMP`,
        [municipality.id, userId, initialRole]
      );
      await syncMunicipalityMemberships(municipality.id);
      const token = signToken({ sub: userId, email, nickname });
      await createAuthSession(userId, token, req);

      return sendJson(res, 201, {
        ok: true,
        token,
        municipality_created: isCreatingMunicipality,
        user: {
          id: userId,
          email,
          nickname,
          name: nickname,
          municipality_id: municipality.id,
          municipality_slug: municipality.slug,
          municipality_name: municipality.name,
          role: initialRole,
          global_role: globalRole,
          user_rank: Number(rankRoleSync.rank || 0),
        },
      });
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      ensureDbEnabled();
      const body = await readJsonBody(req);
      const email = (body.email || '').toString().trim().toLowerCase();
      const password = (body.password || '').toString();
      const rememberMe = !!body.remember_me;

      if (!validateEmail(email) || !password) {
        return sendJson(res, 422, { ok: false, error: 'E-Mail oder Passwort fehlt' });
      }

      const user = await getUserByEmailWithMunicipality(email);
      if (!user) {
        logInfo('AUTH', `Login fehlgeschlagen: E-Mail nicht gefunden: ${email}`);
        return sendJson(res, 401, { ok: false, error: 'E-Mail-Adresse nicht gefunden', reason: 'email_not_found' });
      }
      if (!user.is_active) {
        logInfo('AUTH', `Login fehlgeschlagen: User deaktiviert: ${email} (ID ${user.id})`);
        return sendJson(res, 403, { ok: false, error: 'Benutzer deaktiviert', reason: 'user_disabled' });
      }
      if (user.is_banned) {
        logInfo('AUTH', `Login fehlgeschlagen: User gebannt: ${email} (ID ${user.id})`);
        return sendJson(res, 403, { ok: false, error: 'Dein Account wurde gesperrt.' });
      }

      const inputHash = hashPassword(password, user.password_salt);
      if (inputHash !== user.password_hash) {
        logInfo('AUTH', `Login fehlgeschlagen: Falsches Passwort fuer ${email} (ID ${user.id})`);
        return sendJson(res, 401, { ok: false, error: 'Passwort ist falsch', reason: 'wrong_password' });
      }

      const ttl = rememberMe ? TOKEN_TTL_HOURS_REMEMBER : TOKEN_TTL_HOURS;
      const token = signToken({ sub: user.id, email: user.email, nickname: user.nickname, rem: rememberMe ? 1 : 0 }, ttl);
      await createAuthSession(user.id, token, req, ttl);
      await dbPool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
      const userRole = await getUserMunicipalityRole(user.id, user.municipality_id);
      const globalRole = await getUserGlobalRole(user.id);
      const userRank = await getUserRankValue(user.id);

      // XP: Daily Login bei Login verarbeiten
      let dailyLoginResult = null;
      try {
        dailyLoginResult = await processDailyLogin(user.id);
      } catch (_) {}
      const userXpData = await getUserXp(user.id);

      const loginResponse = {
        ok: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          name: user.nickname,
          municipality_id: user.municipality_id,
          municipality_slug: user.municipality_slug || null,
          municipality_name: user.municipality_name || null,
          role: userRole,
          global_role: globalRole,
          user_rank: Number(userRank || 0),
          xp: {
            total_xp: userXpData.total_xp,
            level: userXpData.level,
            max_level: XP_LEVEL_CAP,
            next_level_xp: userXpData.level < XP_LEVEL_CAP ? xpForLevel(userXpData.level + 1) : null,
            login_streak: userXpData.login_streak,
          },
        },
      };
      if (dailyLoginResult) loginResponse.daily_login = dailyLoginResult;
      return sendJson(res, 200, loginResponse);
    }

    if (req.method === 'GET' && pathname === '/api/auth/me') {
      ensureDbEnabled();
      const token = getBearerToken(req);
      if (!token) return sendJson(res, 401, { ok: false, error: 'Kein Token' });

      const payload = verifyToken(token);
      if (!payload) return sendJson(res, 401, { ok: false, error: 'Token ungueltig/abgelaufen' });
      const validSession = await isSessionValid(token);
      if (!validSession) return sendJson(res, 401, { ok: false, error: 'Session ungueltig oder abgelaufen' });
      const userId = Number(payload.sub);
      if (!Number.isInteger(userId) || userId <= 0) {
        return sendJson(res, 401, { ok: false, error: 'Token ungueltig' });
      }
      const user = await getUserByIdWithMunicipality(userId);
      if (!user || !user.is_active) {
        return sendJson(res, 401, { ok: false, error: 'Benutzer nicht gefunden oder deaktiviert' });
      }
      const userRole = await getUserMunicipalityRole(user.id, user.municipality_id);
      const globalRole = await getUserGlobalRole(user.id);
      const userRank = await getUserRankValue(user.id);

      // XP: Daily Login automatisch verarbeiten bei /me Aufruf
      let dailyLoginResult = null;
      try {
        dailyLoginResult = await processDailyLogin(user.id);
      } catch (_) {}

      const userXpData = await getUserXp(user.id);

      // Token-Refresh: Wenn Remember-Token weniger als 7 Tage uebrig hat, neuen ausstellen
      const isRemember = payload.rem === 1;
      let refreshedToken = undefined;
      if (isRemember && typeof payload.exp === 'number') {
        const now = Math.floor(Date.now() / 1000);
        const remaining = payload.exp - now;
        const sevenDaysInSeconds = 7 * 24 * 3600;
        if (remaining < sevenDaysInSeconds && remaining > 0) {
          refreshedToken = signToken({ sub: user.id, email: user.email, nickname: user.nickname, rem: 1 }, TOKEN_TTL_HOURS_REMEMBER);
          await revokeSession(token);
          await createAuthSession(user.id, refreshedToken, req, TOKEN_TTL_HOURS_REMEMBER);
        }
      }

      const responseBody = {
        ok: true,
        user: {
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          name: user.nickname,
          municipality_id: user.municipality_id,
          municipality_slug: user.municipality_slug || null,
          municipality_name: user.municipality_name || null,
          role: userRole,
          global_role: globalRole,
          user_rank: Number(userRank || 0),
          xp: {
            total_xp: userXpData.total_xp,
            level: userXpData.level,
            max_level: XP_LEVEL_CAP,
            next_level_xp: userXpData.level < XP_LEVEL_CAP ? xpForLevel(userXpData.level + 1) : null,
            login_streak: userXpData.login_streak,
          },
        },
      };
      if (dailyLoginResult) responseBody.daily_login = dailyLoginResult;
      if (refreshedToken) responseBody.token = refreshedToken;

      return sendJson(res, 200, responseBody);
    }

    const globalRolePatchMatch = pathname.match(/^\/api\/auth\/users\/([0-9]+)\/global-role$/i);
    if (globalRolePatchMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const token = getBearerToken(req);
      if (!token) return sendJson(res, 401, { ok: false, error: 'Kein Token' });
      const payload = verifyToken(token);
      if (!payload) return sendJson(res, 401, { ok: false, error: 'Token ungueltig/abgelaufen' });
      const validSession = await isSessionValid(token);
      if (!validSession) return sendJson(res, 401, { ok: false, error: 'Session ungueltig oder abgelaufen' });
      const requesterId = Number(payload.sub);
      if (!Number.isInteger(requesterId) || requesterId <= 0) {
        return sendJson(res, 401, { ok: false, error: 'Token ungueltig' });
      }
      const requester = await getUserByIdWithMunicipality(requesterId);
      if (!requester || !requester.is_active) {
        return sendJson(res, 401, { ok: false, error: 'Benutzer nicht gefunden oder deaktiviert' });
      }
      const requesterGlobalRole = await getUserGlobalRole(requesterId);
      if (requesterGlobalRole !== GLOBAL_ROLE_ADMINISTRATOR) {
        return sendJson(res, 403, { ok: false, error: 'Nur globale Administratoren duerfen globale Rollen aendern' });
      }
      const targetUserId = Number(globalRolePatchMatch[1]);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return sendJson(res, 422, { ok: false, error: 'user_id ist ungueltig' });
      }
      const targetUser = await getUserByIdWithMunicipality(targetUserId);
      if (!targetUser || !targetUser.is_active) {
        return sendJson(res, 404, { ok: false, error: 'Zielbenutzer nicht gefunden oder deaktiviert' });
      }
      const rankRoleSync = await syncUserGlobalRoleFromRank(targetUserId, GLOBAL_ROLE_USER);
      const resolvedGlobalRole = normalizeGlobalRole(rankRoleSync.role);
      return sendJson(res, 200, {
        ok: true,
        data: {
          user_id: targetUserId,
          global_role: resolvedGlobalRole,
          rank: Number(rankRoleSync.rank || 0),
        },
      });
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      ensureDbEnabled();
      const token = getBearerToken(req);
      if (!token) return sendJson(res, 401, { ok: false, error: 'Kein Token' });
      const revoked = await revokeSession(token);
      return sendJson(res, 200, { ok: true, revoked_sessions: revoked });
    }

    // ═══ MARKETPLACE / TRADE ENDPOINTS ═════════════════════════

    // GET /api/marketplace — Aktive Angebote
    if (req.method === 'GET' && pathname === '/api/marketplace') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const search = requestUrl.searchParams.get('q') || '';
      let query = `SELECT ml.*, u.nickname AS seller_name
                   FROM marketplace_listings ml
                   JOIN users u ON u.id = ml.seller_id
                   WHERE ml.status = 'active' AND ml.expires_at > NOW()`;
      const params = [];
      if (search) { query += ` AND ml.item_code LIKE ?`; params.push(`%${search}%`); }
      query += ` ORDER BY ml.created_at DESC LIMIT 50`;
      const [rows] = await dbPool.query(query, params);
      return sendJson(res, 200, { ok: true, data: { listings: rows } });
    }

    // POST /api/marketplace/list — Neues Angebot erstellen
    if (req.method === 'POST' && pathname === '/api/marketplace/list') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const body = await readJsonBody(req);
      const itemCode = String(body.item_code || '').trim();
      const quantity = Math.max(1, Number(body.quantity) || 1);
      const price = Math.max(1, Number(body.price_per_unit) || 1);
      if (!itemCode) return sendJson(res, 400, { ok: false, error: 'item_code erforderlich' });

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const [result] = await dbPool.query(
        `INSERT INTO marketplace_listings (seller_id, item_code, quantity, price_per_unit, expires_at) VALUES (?, ?, ?, ?, ?)`,
        [authUser.id, itemCode, quantity, price, expiresAt]
      );
      return sendJson(res, 200, { ok: true, data: { listing_id: result.insertId } });
    }

    // POST /api/marketplace/:id/buy — Angebot kaufen
    const marketBuyMatch = pathname.match(/^\/api\/marketplace\/([0-9]+)\/buy$/i);
    if (marketBuyMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const listingId = Number(marketBuyMatch[1]);

      const [listings] = await dbPool.query(
        `SELECT * FROM marketplace_listings WHERE id = ? AND status = 'active' AND expires_at > NOW()`, [listingId]
      );
      if (listings.length === 0) return sendJson(res, 404, { ok: false, error: 'Angebot nicht verfuegbar' });
      const listing = listings[0];
      if (listing.seller_id === authUser.id) return sendJson(res, 400, { ok: false, error: 'Eigene Angebote nicht kaufbar' });

      const totalCost = listing.quantity * listing.price_per_unit;

      // Check buyer balance
      const [stats] = await dbPool.query(`SELECT money FROM game_stats WHERE municipality_id = ?`, [authUser.municipality_id]);
      if (!stats[0] || stats[0].money < totalCost) return sendJson(res, 400, { ok: false, error: `Nicht genug Geld (${totalCost} CHF)` });

      // Execute trade
      await dbPool.query(`UPDATE game_stats SET money = money - ? WHERE municipality_id = ?`, [totalCost, authUser.municipality_id]);
      // Pay seller
      const [sellerMun] = await dbPool.query(`SELECT municipality_id FROM users WHERE id = ?`, [listing.seller_id]);
      if (sellerMun[0]?.municipality_id) {
        await dbPool.query(`UPDATE game_stats SET money = money + ? WHERE municipality_id = ?`, [totalCost, sellerMun[0].municipality_id]);
      }

      await dbPool.query(
        `UPDATE marketplace_listings SET status = 'sold', buyer_id = ?, sold_at = NOW() WHERE id = ?`, [authUser.id, listingId]
      );

      return sendJson(res, 200, { ok: true, data: { bought: true, cost: totalCost } });
    }

    // DELETE /api/marketplace/:id — Angebot stornieren
    const marketCancelMatch = pathname.match(/^\/api\/marketplace\/([0-9]+)$/i);
    if (marketCancelMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const listingId = Number(marketCancelMatch[1]);

      await dbPool.query(
        `UPDATE marketplace_listings SET status = 'cancelled' WHERE id = ? AND seller_id = ? AND status = 'active'`,
        [listingId, authUser.id]
      );
      return sendJson(res, 200, { ok: true, data: { cancelled: true } });
    }

    // GET /api/marketplace/my — Eigene Angebote
    if (req.method === 'GET' && pathname === '/api/marketplace/my') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `SELECT ml.*, u.nickname AS buyer_name
         FROM marketplace_listings ml
         LEFT JOIN users u ON u.id = ml.buyer_id
         WHERE ml.seller_id = ?
         ORDER BY ml.created_at DESC LIMIT 50`, [authUser.id]
      );
      return sendJson(res, 200, { ok: true, data: { listings: rows } });
    }

    // POST /api/trades/send — Direkten Handel senden
    if (req.method === 'POST' && pathname === '/api/trades/send') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const body = await readJsonBody(req);
      const receiverId = Number(body.receiver_id);
      const coinsOffered = Math.max(0, Number(body.coins_offered) || 0);
      const message = String(body.message || '').trim().substring(0, 255);
      if (!receiverId || receiverId === authUser.id) return sendJson(res, 400, { ok: false, error: 'Ungueltiger Empfaenger' });

      const [result] = await dbPool.query(
        `INSERT INTO direct_trades (sender_id, receiver_id, coins_offered, message) VALUES (?, ?, ?, ?)`,
        [authUser.id, receiverId, coinsOffered, message]
      );
      return sendJson(res, 200, { ok: true, data: { trade_id: result.insertId } });
    }

    // POST /api/trades/:id/respond — Handel annehmen/ablehnen
    const tradeRespondMatch = pathname.match(/^\/api\/trades\/([0-9]+)\/respond$/i);
    if (tradeRespondMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const tradeId = Number(tradeRespondMatch[1]);

      const body = await readJsonBody(req);
      const decision = body.decision === 'accepted' ? 'accepted' : 'rejected';

      const [trades] = await dbPool.query(
        `SELECT * FROM direct_trades WHERE id = ? AND receiver_id = ? AND status = 'pending'`, [tradeId, authUser.id]
      );
      if (trades.length === 0) return sendJson(res, 404, { ok: false, error: 'Handel nicht gefunden' });
      const trade = trades[0];

      if (decision === 'accepted' && trade.coins_offered > 0) {
        // Transfer coins
        const [senderMun] = await dbPool.query(`SELECT municipality_id FROM users WHERE id = ?`, [trade.sender_id]);
        if (senderMun[0]?.municipality_id) {
          await dbPool.query(`UPDATE game_stats SET money = GREATEST(0, money - ?) WHERE municipality_id = ?`, [trade.coins_offered, senderMun[0].municipality_id]);
        }
        if (authUser.municipality_id) {
          await dbPool.query(`UPDATE game_stats SET money = money + ? WHERE municipality_id = ?`, [trade.coins_offered, authUser.municipality_id]);
        }
      }

      await dbPool.query(
        `UPDATE direct_trades SET status = ?, responded_at = NOW() WHERE id = ?`, [decision, tradeId]
      );
      return sendJson(res, 200, { ok: true, data: { [decision]: true } });
    }

    // GET /api/trades/pending — Eingehende Handels-Anfragen
    if (req.method === 'GET' && pathname === '/api/trades/pending') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const [rows] = await dbPool.query(
        `SELECT dt.*, u.nickname AS sender_name
         FROM direct_trades dt
         JOIN users u ON u.id = dt.sender_id
         WHERE dt.receiver_id = ? AND dt.status = 'pending'
         ORDER BY dt.created_at DESC LIMIT 20`, [authUser.id]
      );
      return sendJson(res, 200, { ok: true, data: { trades: rows } });
    }

    // ═══ ADMIN ENDPOINTS ═══════════════════════════════════════
    // Require rank >= 7 (administrator)

    // GET /api/admin/users — User-Liste
    if (req.method === 'GET' && pathname === '/api/admin/users') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });

      const search = requestUrl.searchParams.get('q') || '';
      const limit = Math.min(Number(requestUrl.searchParams.get('limit') || 50), 200);
      let query = `SELECT u.id, u.nickname, u.email, u.municipality_id, u.created_at,
                          COALESCE(u.is_banned, 0) AS is_banned,
                          COALESCE(ux.level, 1) AS level, COALESCE(ux.total_xp, 0) AS xp,
                          m.name AS municipality_name
                   FROM users u
                   LEFT JOIN user_xp ux ON ux.user_id = u.id
                   LEFT JOIN municipalities m ON m.id = u.municipality_id`;
      const params = [];
      if (search) {
        query += ` WHERE u.nickname LIKE ? OR u.email LIKE ?`;
        params.push(`%${search}%`, `%${search}%`);
      }
      query += ` ORDER BY u.id DESC LIMIT ?`;
      params.push(limit);
      const [rows] = await dbPool.query(query, params);
      return sendJson(res, 200, { ok: true, data: { users: rows } });
    }

    // POST /api/admin/users/:id/ban — User bannen
    const adminBanMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/ban$/i);
    if (adminBanMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const userId = Number(adminBanMatch[1]);
      if (userId === authUser.id) return sendJson(res, 400, { ok: false, error: 'Du kannst dich nicht selbst bannen' });
      await dbPool.query(`UPDATE users SET is_banned = 1, updated_at = NOW() WHERE id = ?`, [userId]);
      await dbPool.query(`UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL`, [userId]);
      return sendJson(res, 200, { ok: true, data: { banned: true } });
    }

    // POST /api/admin/users/:id/unban — User entbannen
    const adminUnbanMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/unban$/i);
    if (adminUnbanMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const userId = Number(adminUnbanMatch[1]);
      await dbPool.query(`UPDATE users SET is_banned = 0, updated_at = NOW() WHERE id = ?`, [userId]);
      return sendJson(res, 200, { ok: true, data: { unbanned: true } });
    }

    // GET /api/admin/events — Alle Events mit Status-Filter
    if (req.method === 'GET' && pathname === '/api/admin/events') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });

      const status = requestUrl.searchParams.get('status') || 'all';
      const validStatuses = ['detected', 'reported', 'investigating', 'assigned', 'resolved', 'external_reported'];
      let statusClause = '';
      const evParams = [];
      if (status === 'active') {
        statusClause = `WHERE me.status IN ('detected','reported','investigating','assigned','external_reported')`;
      } else if (status !== 'all' && validStatuses.includes(status)) {
        statusClause = `WHERE me.status = ?`;
        evParams.push(status);
      }
      const [rows] = await dbPool.query(
        `SELECT me.id, me.severity, me.status, me.spawned_at, me.location_x, me.location_y,
                et.name, et.emoji, et.category, m.name AS municipality_name
         FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         JOIN municipalities m ON m.id = me.municipality_id
         ${statusClause}
         ORDER BY me.spawned_at DESC LIMIT 100`,
        evParams
      );
      return sendJson(res, 200, { ok: true, data: { events: rows } });
    }

    // DELETE /api/admin/events/:id — Event loeschen
    const adminDeleteEventMatch = pathname.match(/^\/api\/admin\/events\/([0-9]+)$/i);
    if (adminDeleteEventMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const eventId = Number(adminDeleteEventMatch[1]);
      await dbPool.query(`DELETE FROM municipality_events WHERE id = ?`, [eventId]);
      return sendJson(res, 200, { ok: true, data: { deleted: true } });
    }

    // POST /api/admin/events/push-to-verwaltung — Detected Events als reported markieren (Debug)
    if (req.method === 'POST' && pathname === '/api/admin/events/push-to-verwaltung') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });

      const body = await readJsonBody(req);
      const eventId = body.event_id ? Number(body.event_id) : null;

      if (eventId) {
        // Einzelnes Event pushen
        const [result] = await dbPool.query(
          `UPDATE municipality_events SET status = 'reported', reported_by = ?, reported_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'detected'`,
          [authUser.id, eventId]
        );
        if (result.affectedRows > 0) {
          await dbPool.query(
            `INSERT IGNORE INTO event_reports (event_id, user_id, report_type, created_at) VALUES (?, ?, 'confirm', NOW())`,
            [eventId, authUser.id]
          );
        }
        return sendJson(res, 200, { ok: true, data: { pushed: result.affectedRows } });
      } else {
        // Alle detected Events der eigenen Gemeinde pushen
        if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
        const [detectedEvents] = await dbPool.query(
          `SELECT id FROM municipality_events WHERE municipality_id = ? AND status = 'detected'`,
          [authUser.municipality_id]
        );
        const [result] = await dbPool.query(
          `UPDATE municipality_events SET status = 'reported', reported_by = ?, reported_at = NOW(), updated_at = NOW() WHERE municipality_id = ? AND status = 'detected'`,
          [authUser.id, authUser.municipality_id]
        );
        for (const ev of detectedEvents) {
          await dbPool.query(
            `INSERT IGNORE INTO event_reports (event_id, user_id, report_type, created_at) VALUES (?, ?, 'confirm', NOW())`,
            [ev.id, authUser.id]
          );
        }
        return sendJson(res, 200, { ok: true, data: { pushed: result.affectedRows } });
      }
    }

    // POST /api/admin/users/:id/municipality — User Gemeinde wechseln
    const adminChangeMuniMatch = pathname.match(/^\/api\/admin\/users\/([0-9]+)\/municipality$/i);
    if (adminChangeMuniMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });
      const userId = Number(adminChangeMuniMatch[1]);
      const body = await readJsonBody(req);
      const newMunicipalityId = body.municipality_id !== undefined ? (body.municipality_id === null ? null : Number(body.municipality_id)) : undefined;
      if (newMunicipalityId === undefined) return sendJson(res, 400, { ok: false, error: 'municipality_id erforderlich' });

      if (newMunicipalityId !== null) {
        const [[muni]] = await dbPool.query(`SELECT id, name FROM municipalities WHERE id = ?`, [newMunicipalityId]);
        if (!muni) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      }

      const oldMuniId = await (async () => {
        const [[u]] = await dbPool.query(`SELECT municipality_id FROM users WHERE id = ?`, [userId]);
        return u ? u.municipality_id : null;
      })();

      await dbPool.query(`UPDATE users SET municipality_id = ?, updated_at = NOW() WHERE id = ?`, [newMunicipalityId, userId]);

      if (oldMuniId && oldMuniId !== newMunicipalityId) {
        await dbPool.query(`DELETE FROM municipality_memberships WHERE municipality_id = ? AND user_id = ?`, [oldMuniId, userId]);
      }
      if (newMunicipalityId) {
        await dbPool.query(
          `INSERT IGNORE INTO municipality_memberships (municipality_id, user_id, role, joined_at, created_at) VALUES (?, ?, 'citizen', NOW(), NOW())`,
          [newMunicipalityId, userId]
        );
      }

      return sendJson(res, 200, { ok: true, data: { updated: true, municipality_id: newMunicipalityId } });
    }

    // GET /api/admin/municipalities — Alle Gemeinden (fuer Admin-Dropdowns)
    if (req.method === 'GET' && pathname === '/api/admin/municipalities') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });

      const [rows] = await dbPool.query(
        `SELECT m.id, m.name, m.slug, m.canton_code, COALESCE(mc.cnt, 0) AS members_count
         FROM municipalities m
         LEFT JOIN (SELECT municipality_id, COUNT(*) AS cnt FROM users WHERE is_active = 1 GROUP BY municipality_id) mc
           ON mc.municipality_id = m.id
         WHERE m.is_active = 1
         ORDER BY m.name ASC`
      );
      return sendJson(res, 200, { ok: true, data: { municipalities: rows } });
    }

    // POST /api/admin/rooms/rename — Game-Room (Map) umbenennen
    if (req.method === 'POST' && pathname === '/api/admin/rooms/rename') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });

      const body = await readJsonBody(req);
      const municipalityId = Number(body.municipality_id);
      const roomCode = String(body.room_code || 'MAIN').trim();
      const newCityName = String(body.city_name || '').trim();
      if (!municipalityId || !newCityName) return sendJson(res, 400, { ok: false, error: 'municipality_id und city_name erforderlich' });

      const [result] = await dbPool.query(
        `UPDATE game_rooms SET city_name = ?, updated_at = CURRENT_TIMESTAMP WHERE municipality_id = ? AND room_code = ?`,
        [newCityName, municipalityId, roomCode]
      );
      if (result.affectedRows === 0) return sendJson(res, 404, { ok: false, error: 'Room nicht gefunden' });
      return sendJson(res, 200, { ok: true, data: { renamed: true, city_name: newCityName } });
    }

    // GET /api/admin/rooms — Rooms einer Gemeinde auflisten
    if (req.method === 'GET' && pathname === '/api/admin/rooms') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });

      const municipalityId = Number(requestUrl.searchParams.get('municipality_id') || 0);
      if (!municipalityId) return sendJson(res, 400, { ok: false, error: 'municipality_id erforderlich' });

      const [rows] = await dbPool.query(
        `SELECT id, room_code, city_name, player_count, is_active, created_at FROM game_rooms WHERE municipality_id = ? ORDER BY room_code ASC`,
        [municipalityId]
      );
      return sendJson(res, 200, { ok: true, data: { rooms: rows } });
    }

    // GET /api/admin/stats — Server-Statistiken
    if (req.method === 'GET' && pathname === '/api/admin/stats') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (authUser.global_role !== 'administrator') return sendJson(res, 403, { ok: false, error: 'Nur Admins' });

      const safeCount = async (sql) => {
        try { const [[row]] = await dbPool.query(sql); return Object.values(row)[0] || 0; } catch { return 0; }
      };
      const user_count = await safeCount(`SELECT COUNT(*) AS c FROM users`);
      const municipality_count = await safeCount(`SELECT COUNT(*) AS c FROM municipalities`);
      const event_count = await safeCount(`SELECT COUNT(*) AS c FROM municipality_events WHERE status IN ('detected','reported','assigned')`);
      const company_count = await safeCount(`SELECT COUNT(*) AS c FROM companies WHERE is_active = 1`);
      let online_count = 0;
      for (const roomPlayers of wsRoomPlayers.values()) {
        online_count += roomPlayers.size;
      }

      return sendJson(res, 200, {
        ok: true,
        data: {
          users: user_count,
          municipalities: municipality_count,
          active_events: event_count,
          companies: company_count,
          online_users: online_count,
          uptime: Math.round(process.uptime()),
        }
      });
    }

    return sendJson(res, 404, { ok: false, error: 'Route nicht gefunden' });
  } catch (err) {
    console.error('[HTTP] Interner Serverfehler:', req.url, err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack : '');
    return sendJson(res, 500, {
      ok: false,
      error: 'Interner Serverfehler',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

const io = new SocketIOServer(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (CORS_ALLOW_ALL || CORS_ALLOWED_ORIGIN_SET.has(origin)) return callback(null, true);
      return callback(new Error('Origin nicht erlaubt'));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 60000,
});

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentRoomIsPublic = false;
  let playerId = socket.id;
  let playerName = 'Spieler';
  let isViewOnly = false;
  let canSendStatsUpdates = false;
  let socketGlobalRole = GLOBAL_ROLE_USER;
  let socketAuthUserId = null; // Messenger: DB-User-ID für diesen Socket
  let socketMunicipalityRole = null;
  logInfo('WS', 'Client verbunden', {
    socketId: socket.id,
    ip: socket.handshake?.address || null,
    transport: socket.conn?.transport?.name || null,
  });

  const leaveCurrentRoom = () => {
    if (!currentRoom) return;
    const roomLeaving = currentRoom;
    const roomKey = currentRoom;
    const roomMeta = wsRoomMetadata.get(roomLeaving) || null;
    socket.leave(currentRoom);
    const players = wsRoomPlayers.get(currentRoom);
    if (players) {
      players.delete(playerId);
      if (players.size === 0) {
        wsRoomPlayers.delete(currentRoom);
        wsRoomAuthoritativeStats.delete(currentRoom);
        wsRoomAvatars.delete(currentRoom);
        wsRoomMetadata.delete(currentRoom);
      }
    }
    const avatars = wsRoomAvatars.get(roomKey);
    if (avatars) {
      const removedAvatarIds = [];
      for (const [avatarId, avatar] of avatars.entries()) {
        if (avatar.ownerPlayerId !== playerId) continue;
        avatars.delete(avatarId);
        removedAvatarIds.push(avatarId);
      }
      for (const avatarId of removedAvatarIds) {
        io.to(roomKey).emit('avatar-removed', { avatarId });
      }
      if (avatars.size === 0) {
        wsRoomAvatars.delete(roomKey);
      }
    }
    const playerList = wsGetRoomPlayerList(currentRoom);
    socket.to(currentRoom).emit('player-left', {
      playerId,
      playerName,
      playerCount: playerList.length,
    });
    io.to(currentRoom).emit('players-list', {
      players: playerList,
      count: playerList.length,
    });
    if (roomMeta) {
      setRoomRuntimePlayers(roomMeta.municipalityId, roomMeta.roomCode, playerList.length);
      broadcastNavigatorRoomCount(io, roomMeta.roomCode, roomMeta.municipalitySlug, roomMeta.municipalityName, playerList.length);
    }
    logInfo('WS', 'Client hat Raum verlassen', {
      socketId: socket.id,
      playerId,
      playerName,
      room: roomLeaving,
      remainingPlayers: playerList.length,
    });
    currentRoom = null;
    currentRoomIsPublic = false;
  };

  socket.on('join-room', async (data = {}) => {
    const roomCode = normalizeRoomCode(data.roomCode || data.room_code || 'MAIN');
    const municipalitySlug = String(data.municipalitySlug || data.municipality_slug || 'default').toLowerCase();
    if (!roomCode) {
      socket.emit('error', { message: 'roomCode fehlt' });
      return;
    }

    leaveCurrentRoom();

    playerId = String(data.clientId || data.client_id || socket.id);
    playerName = String(data.name || 'Spieler');
    isViewOnly = !!data.isViewOnly;
    canSendStatsUpdates = !isViewOnly;
    socketGlobalRole = GLOBAL_ROLE_USER;
    currentRoom = wsRoomKey(municipalitySlug, roomCode);

    let municipality = null;
    try {
      municipality = await getMunicipalityBySlug(municipalitySlug);
    } catch {
      municipality = null;
    }
    if (municipality) {
      wsRoomMetadata.set(currentRoom, {
        municipalityId: Number(municipality.id),
        municipalitySlug: municipality.slug,
        municipalityName: municipality.name,
        roomCode,
      });
      await warmRoomRuntimeCache(municipality, roomCode, 'join-room');

      try {
        const room = await getRoom(municipality.id, roomCode);
        const roomState = toJsonValue(room?.game_state);
        currentRoomIsPublic = Boolean(roomCode.startsWith('PUB') || roomState?.navigator_public === true);
      } catch {
        currentRoomIsPublic = Boolean(roomCode.startsWith('PUB'));
      }
    } else {
      logWarn('WS', 'join-room ohne gueltige Gemeinde', { municipalitySlug, roomCode, currentRoom });
      currentRoomIsPublic = Boolean(roomCode.startsWith('PUB'));
    }

    if (currentRoomIsPublic && isViewOnly) {
      isViewOnly = false;
      canSendStatsUpdates = true;
    }

    // Optional WS-Auth: globale Moderation/Adminrechte erlauben Stats-Updates auch im View-Only Modus.
    const authToken = String(data.authToken || data.auth_token || '').trim();
    if (authToken) {
      try {
        const payload = verifyToken(authToken);
        const validSession = payload ? await isSessionValid(authToken) : false;
        const authUserId = Number(payload?.sub || 0);
        if (validSession && Number.isInteger(authUserId) && authUserId > 0) {
          const authUser = await getUserByIdWithMunicipality(authUserId);
          if (authUser && authUser.is_active) {
            socketGlobalRole = await getUserGlobalRole(authUser.id);
            // ── Duplikat-Login verhindern: bestehende Sockets dieses Users disconnecten ──
            if (socketAuthUserId && socketAuthUserId !== authUser.id) {
              wsUnregisterUserSocket(socketAuthUserId, socket.id);
            }
            const existingSockets = wsUserSockets.get(authUser.id);
            if (existingSockets && existingSockets.size > 0) {
              for (const oldSid of [...existingSockets]) {
                if (oldSid === socket.id) continue; // eigener Socket, nicht kicken
                const oldSocket = io.sockets?.sockets?.get(oldSid);
                if (oldSocket) {
                  logInfo('WS', 'Duplikat-Login: alter Socket wird disconnected', {
                    userId: authUser.id,
                    oldSocketId: oldSid,
                    newSocketId: socket.id,
                  });
                  oldSocket.emit('force-disconnect', { reason: 'Du wurdest abgemeldet, da du dich an einem anderen Ort eingeloggt hast.' });
                  oldSocket.disconnect(true);
                }
              }
            }
            socketAuthUserId = authUser.id;
            wsRegisterUserSocket(socketAuthUserId, socket.id);
            // Online-Status setzen
            try { await dbPool.query('UPDATE users SET is_online = 1, last_online_at = NOW() WHERE id = ?', [socketAuthUserId]); } catch {}
            const municipalityRole = municipality
              ? await getUserMunicipalityRole(authUser.id, municipality.id)
              : MUNICIPALITY_ROLE_OBSERVER;
            socketMunicipalityRole = municipalityRole;
            const hasMunicipalityStatsRights =
              municipalityRole === MUNICIPALITY_ROLE_OWNER || municipalityRole === MUNICIPALITY_ROLE_COUNCIL;
            const hasGlobalStatsRights =
              socketGlobalRole === GLOBAL_ROLE_MODERATOR || socketGlobalRole === GLOBAL_ROLE_ADMINISTRATOR;
            canSendStatsUpdates = !isViewOnly || hasMunicipalityStatsRights || hasGlobalStatsRights;
            logInfo('WS', 'join-room Auth ausgewertet', {
              socketId: socket.id,
              playerId,
              room: currentRoom,
              authUserId: authUser.id,
              municipalityRole,
              globalRole: socketGlobalRole,
              isViewOnly,
              canSendStatsUpdates,
            });
          }
        }
      } catch {
        logWarn('WS', 'join-room Auth-Auswertung fehlgeschlagen', {
          socketId: socket.id,
          playerId,
          room: currentRoom,
        });
        // WS-Join darf bei Auth-Problemen nicht scheitern.
      }
    } else {
      logWarn('WS', 'join-room ohne authToken', {
        socketId: socket.id,
        playerId,
        room: currentRoom,
        isViewOnly,
      });
    }

    socket.join(currentRoom);
    if (!wsRoomPlayers.has(currentRoom)) {
      wsRoomPlayers.set(currentRoom, new Map());
    }
    wsRoomPlayers.get(currentRoom).set(playerId, {
      id: playerId,
      name: playerName,
      socketId: socket.id,
      joinedAt: Date.now(),
      isViewOnly,
    });

    const playerList = wsGetRoomPlayerList(currentRoom);
    socket.emit('room-joined', {
      roomCode,
      playerId,
      playerCount: playerList.length,
      players: playerList,
      canSendStatsUpdates,
      isPublicRoom: currentRoomIsPublic,
      globalRole: socketGlobalRole,
    });
    socket.emit('avatars-snapshot', {
      avatars: wsGetRoomAvatars(currentRoom),
    });
    io.to(currentRoom).emit('players-list', {
      players: playerList,
      count: playerList.length,
    });
    socket.to(currentRoom).emit('player-joined', {
      playerId,
      playerName,
      playerCount: playerList.length,
    });

    const municipalityName = municipality?.name || municipalitySlug;
    if (municipality) {
      setRoomRuntimePlayers(municipality.id, roomCode, playerList.length);
      broadcastNavigatorRoomCount(io, roomCode, municipalitySlug, municipalityName, playerList.length);
    }
    logInfo('WS', 'Client Raum-Join abgeschlossen', {
      socketId: socket.id,
      playerId,
      playerName,
      roomCode,
      roomKey: currentRoom,
      municipalitySlug,
      municipalityName,
      isPublicRoom: currentRoomIsPublic,
      viewOnly: isViewOnly,
      canSendStatsUpdates,
      globalRole: socketGlobalRole,
      playerCount: playerList.length,
    });

    await wsPublishAuthoritativeStats(io, currentRoom, 'server-core');
  });

  socket.on('delta', (data = {}) => {
    if (!currentRoom || isViewOnly) return;
    if (!canBuildInMunicipality(socketMunicipalityRole)) {
      socket.emit('delta-rejected', { reason: 'insufficient_permission', delta: data });
      return;
    }
    socket.to(currentRoom).emit('delta', {
      ...data,
      playerId,
      timestamp: Date.now(),
    });
  });

  socket.on('deltas', (deltas = []) => {
    if (!currentRoom || isViewOnly) return;
    if (!Array.isArray(deltas) || deltas.length === 0) return;
    if (!canBuildInMunicipality(socketMunicipalityRole)) {
      socket.emit('delta-rejected', { reason: 'insufficient_permission', delta: deltas });
      return;
    }
    socket.to(currentRoom).emit('deltas', deltas);
  });

  socket.on('stats-update', async (data = {}, ack = null) => {
    if (!currentRoom) {
      if (typeof ack === 'function') ack({ success: false, error: 'not_in_room' });
      return;
    }
    if (!canSendStatsUpdates) {
      logWarn('WS', 'stats-update blockiert (fehlende Rechte)', {
        socketId: socket.id,
        playerId,
        room: currentRoom,
        isViewOnly,
        canSendStatsUpdates,
        globalRole: socketGlobalRole,
      });
      if (typeof ack === 'function') {
        ack({
          success: false,
          error: 'forbidden_missing_stats_rights',
          debug: {
            isViewOnly,
            canSendStatsUpdates,
            globalRole: socketGlobalRole,
          },
        });
      }
      return;
    }
    const roomMeta = wsRoomMetadata.get(currentRoom);
    if (!roomMeta) {
      if (typeof ack === 'function') ack({ success: false, error: 'room_meta_missing' });
      return;
    }
    try {
      const rawStats = (await loadRoomStats(roomMeta.municipalityId, roomMeta.roomCode)) || {};
      const patchedStats = applyStatsPatch(rawStats, data || {});
      const requestedMoney = Number(data?.money);
      const storedMoney = await getMunicipalityMoney(roomMeta.municipalityId);
      if (!jsonEquals(rawStats, patchedStats)) {
        await saveRoomStats(roomMeta.municipalityId, roomMeta.roomCode, patchedStats);
      }
      const recomputed = await recomputeAuthoritativePopulationAndJobs(roomMeta.municipalityId, roomMeta.roomCode);
      const authoritativeMoney = await getMunicipalityMoney(roomMeta.municipalityId);
      await wsPublishAuthoritativeStats(io, currentRoom, playerId);
      if (typeof ack === 'function') {
        ack({
          success: true,
          data: toStatsApiShape(recomputed),
          debug: {
            isViewOnly,
            canSendStatsUpdates,
            globalRole: socketGlobalRole,
            requestedMoney: Number.isFinite(requestedMoney) ? Math.round(requestedMoney) : null,
            storedMoney,
            authoritativeMoney,
          },
        });
      }
    } catch (err) {
      logError('WS', 'stats-update fehlgeschlagen', {
        socketId: socket.id,
        playerId,
        room: currentRoom,
        error: err?.message || String(err),
      });
      if (typeof ack === 'function') {
        ack({
          success: false,
          error: err?.message || 'stats_update_failed',
          debug: {
            isViewOnly,
            canSendStatsUpdates,
            globalRole: socketGlobalRole,
          },
        });
      }
    }
  });

  socket.on('stats-request', async () => {
    if (!currentRoom) return;
    await wsPublishAuthoritativeStats(io, currentRoom, playerId);
  });

  // ============ BUDGET-UPDATE (server-authoritative) ============
  socket.on('budget-update', async (data = {}, ack = null) => {
    if (!currentRoom) {
      if (typeof ack === 'function') ack({ success: false, error: 'not_in_room' });
      return;
    }
    if (!canSendStatsUpdates) {
      logWarn('WS', 'budget-update blockiert (fehlende Rechte)', {
        socketId: socket.id, playerId, room: currentRoom,
      });
      if (typeof ack === 'function') ack({ success: false, error: 'forbidden' });
      return;
    }
    const roomMeta = wsRoomMetadata.get(currentRoom);
    if (!roomMeta) {
      if (typeof ack === 'function') ack({ success: false, error: 'room_meta_missing' });
      return;
    }
    try {
      const incomingBudget = data.budget;
      if (!incomingBudget || typeof incomingBudget !== 'object') {
        if (typeof ack === 'function') ack({ success: false, error: 'invalid_budget_data' });
        return;
      }
      // Validierung: nur erlaubte Kategorien, funding 0-100
      const VALID_BUDGET_KEYS = ['police', 'fire', 'health', 'education', 'transportation', 'parks', 'power', 'water'];
      const validatedBudget = {};
      for (const key of VALID_BUDGET_KEYS) {
        const entry = incomingBudget[key];
        if (entry && typeof entry === 'object' && typeof entry.funding === 'number') {
          validatedBudget[key] = {
            funding: Math.max(0, Math.min(100, Math.round(entry.funding))),
          };
        }
      }
      if (Object.keys(validatedBudget).length === 0) {
        if (typeof ack === 'function') ack({ success: false, error: 'no_valid_budget_categories' });
        return;
      }

      // Stats laden und game_map_data.budget aktualisieren
      const rawStats = (await loadRoomStats(roomMeta.municipalityId, roomMeta.roomCode)) || {};
      const mapData = rawStats.game_map_data && typeof rawStats.game_map_data === 'object'
        ? { ...rawStats.game_map_data }
        : {};
      const existingBudget = mapData.budget && typeof mapData.budget === 'object'
        ? { ...mapData.budget }
        : {};

      // Funding-Werte mergen (bestehende Kosten beibehalten, nur funding aktualisieren)
      for (const [key, val] of Object.entries(validatedBudget)) {
        const existing = existingBudget[key] && typeof existingBudget[key] === 'object'
          ? { ...existingBudget[key] }
          : { name: key.charAt(0).toUpperCase() + key.slice(1), funding: 100, cost: 0 };
        existing.funding = val.funding;
        existingBudget[key] = existing;
      }

      mapData.budget = existingBudget;
      rawStats.game_map_data = mapData;
      await saveRoomStats(roomMeta.municipalityId, roomMeta.roomCode, rawStats);

      // Autoritative Stats neu berechnen (damit Expenses korrekt sind)
      await recomputeAuthoritativePopulationAndJobs(roomMeta.municipalityId, roomMeta.roomCode);

      // An alle Clients broadcasten (inkl. Sender)
      await wsPublishAuthoritativeStats(io, currentRoom, playerId);

      logInfo('WS', 'budget-update erfolgreich', {
        socketId: socket.id, playerId, room: currentRoom,
        categories: Object.keys(validatedBudget),
      });
      if (typeof ack === 'function') ack({ success: true });
    } catch (err) {
      logError('WS', 'budget-update fehlgeschlagen', {
        socketId: socket.id, playerId, room: currentRoom,
        error: err?.message || String(err),
      });
      if (typeof ack === 'function') ack({ success: false, error: err?.message || 'budget_update_failed' });
    }
  });

  socket.on('items-constructed-sync', async (data = {}, ack = null) => {
    if (!currentRoom) {
      if (typeof ack === 'function') {
        ack({ success: false, error: 'not_in_room' });
      }
      return;
    }
    if (!canBuildInMunicipality(socketMunicipalityRole)) {
      if (typeof ack === 'function') ack({ success: false, error: 'no_permission' });
      return;
    }
    const roomMeta = wsRoomMetadata.get(currentRoom);
    if (!roomMeta) {
      if (typeof ack === 'function') {
        ack({ success: false, error: 'room_meta_missing' });
      }
      return;
    }
    const positions = Array.isArray(data?.positions) ? data.positions : [];
    if (positions.length <= 0) {
      if (typeof ack === 'function') {
        ack({ success: true, data: { updated: 0, deleted: 0, authoritativeStats: null } });
      }
      return;
    }
    try {
      const municipality = {
        id: roomMeta.municipalityId,
        slug: roomMeta.municipalitySlug,
        name: roomMeta.municipalityName,
      };
      const result = await processConstructionSyncAndBroadcast({
        municipality,
        roomCode: roomMeta.roomCode,
        positions,
        io,
        sourcePlayerId: String(playerId || 'construction-sync-ws'),
      });
      if (typeof ack === 'function') {
        ack({ success: true, data: result });
      }
    } catch (err) {
      if (typeof ack === 'function') {
        ack({ success: false, error: err?.message || 'construction_sync_failed' });
      }
    }
  });

  // ══ SERVER-AUTHORITATIVE SERVICE BUILDING UPGRADE ══════════════════
  // Client sendet upgrade-request, Server validiert und startet den Timer.
  // Upgrade-Zeiten kommen aus der DB (game_item_details.upgrade_build_time_seconds).
  // Formel: upgrade_build_time_seconds * pow(2, targetLevel - 2)
  const UPGRADE_MAX_LEVELS = { woodcutter_house: 4 };
  const SERVICE_MAX_LEVEL = 5;

  socket.on('upgrade-building', async (data = {}, ack = null) => {
    if (!currentRoom || !socketAuthUserId) {
      if (typeof ack === 'function') ack({ success: false, error: 'not_authenticated' });
      return;
    }
    if (!canBuildInMunicipality(socketMunicipalityRole)) {
      logInfo('SECURITY', `User ${socketAuthUserId} versuchte Upgrade in fremder Gemeinde (Rolle: ${socketMunicipalityRole})`, { room: currentRoom });
      if (typeof ack === 'function') ack({ success: false, error: 'no_permission' });
      return;
    }
    const tileX = Number(data.x);
    const tileY = Number(data.y);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) {
      if (typeof ack === 'function') ack({ success: false, error: 'invalid_position' });
      return;
    }

    const roomMeta = wsRoomMetadata.get(currentRoom);
    if (!roomMeta) {
      if (typeof ack === 'function') ack({ success: false, error: 'room_not_found' });
      return;
    }

    try {
      // Gebaeude-Daten + Upgrade-Zeit aus DB laden (JOIN mit game_item_details)
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

      // Validierungen
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

      // Upgrade-Zeit aus DB holen (upgrade_build_time_seconds = Basis fuer L1→L2)
      const baseSeconds = Number(item.upgrade_build_time_seconds || 0);
      const targetLevel = currentLevel + 1;
      // Skalierung: L1→L2 = base, L2→L3 = 2x, L3→L4 = 4x, L4→L5 = 8x
      const upgradeSeconds = baseSeconds > 0
        ? Math.max(1, Math.round(baseSeconds * Math.pow(2, Math.max(0, targetLevel - 2))))
        : 0;

      const now = Date.now();
      const newMeta = {
        ...meta,
        upgrade_started_at: now,
        upgrade_target_level: targetLevel,
      };

      // Wenn upgradeSeconds == 0 → sofort fertig (z.B. woodcutter_house)
      if (upgradeSeconds === 0) {
        newMeta.level = targetLevel;
        delete newMeta.upgrade_started_at;
        delete newMeta.upgrade_target_level;
      }

      // In DB speichern
      await dbPool.query(
        `UPDATE game_items SET metadata = ? WHERE id = ?`,
        [JSON.stringify(newMeta), item.id]
      );

      logInfo('UPGRADE', 'Gebaeude-Upgrade gestartet', {
        userId: socketAuthUserId,
        buildingType,
        fromLevel: currentLevel,
        toLevel: targetLevel,
        upgradeSeconds,
        baseSecondsFromDB: baseSeconds,
        tileX,
        tileY,
      });

      if (typeof ack === 'function') {
        ack({
          success: true,
          data: {
            upgradeStartedAt: upgradeSeconds > 0 ? now : null,
            upgradeTargetLevel: targetLevel,
            upgradeSeconds,
            newLevel: upgradeSeconds === 0 ? targetLevel : currentLevel,
          },
        });
      }
    } catch (err) {
      logError('UPGRADE', 'Fehler beim Upgrade', { error: err?.message, tileX, tileY });
      if (typeof ack === 'function') ack({ success: false, error: 'server_error' });
    }
  });

  socket.on('partnership-discovered', (data = {}) => {
    if (!currentRoom) return;
    if (currentRoomIsPublic) return;
    socket.to(currentRoom).emit('partnership-discovered', {
      ...data,
      playerId,
      timestamp: Date.now(),
    });
  });

  socket.on('partnership-connected', (data = {}) => {
    if (!currentRoom) return;
    if (currentRoomIsPublic) return;
    socket.to(currentRoom).emit('partnership-connected', {
      ...data,
      playerId,
      timestamp: Date.now(),
    });
  });

  socket.on('cursor', (position = {}) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('cursor', {
      playerId,
      position,
    });
  });

  socket.on('avatar-spawn-request', (data = {}) => {
    if (!currentRoom) return;
    const x = wsClampTile(data.x);
    const y = wsClampTile(data.y);
    if (x === null || y === null) return;

    if (!wsRoomAvatars.has(currentRoom)) {
      wsRoomAvatars.set(currentRoom, new Map());
    }
    const avatars = wsRoomAvatars.get(currentRoom);
    const avatarId = String(data.avatarId || `avatar:${playerId}`);
    const existing = avatars.get(avatarId);
    const avatar = {
      id: avatarId,
      ownerPlayerId: playerId,
      ownerName: String(data.ownerName || playerName || 'Spieler'),
      avatarConfig: wsSanitizeAvatarConfig(data.avatarConfig || existing?.avatarConfig || {}),
      x,
      y,
      targetX: x,
      targetY: y,
      path: [],
      updatedAt: Date.now(),
      createdAt: existing?.createdAt || Date.now(),
    };
    avatars.set(avatarId, avatar);
    io.to(currentRoom).emit('avatar-updated', { avatar });
  });

  socket.on('avatar-move-request', (data = {}) => {
    if (!currentRoom) return;
    const avatarId = String(data.avatarId || '');
    if (!avatarId) return;
    const x = wsClampTile(data.x);
    const y = wsClampTile(data.y);
    if (x === null || y === null) return;

    if (!wsRoomAvatars.has(currentRoom)) {
      wsRoomAvatars.set(currentRoom, new Map());
    }
    const avatars = wsRoomAvatars.get(currentRoom);
    const current = avatars.get(avatarId);
    if (!current || current.ownerPlayerId !== playerId) return;

    const path = wsSanitizeAvatarPath(data.path);
    const avatar = {
      ...current,
      avatarConfig: wsSanitizeAvatarConfig(data.avatarConfig || current.avatarConfig || {}),
      targetX: x,
      targetY: y,
      path,
      updatedAt: Date.now(),
    };
    avatars.set(avatarId, avatar);
    io.to(currentRoom).emit('avatar-updated', { avatar });
  });

  // ── Room-Chat: Nachrichten nur innerhalb des aktuellen Raums ──
  socket.on('room-chat', (data = {}) => {
    if (!currentRoom) return;
    const text = String(data.text || '').trim().slice(0, 500);
    if (!text) return;
    io.to(currentRoom).emit('room-chat', {
      text,
      userName: playerName || 'Spieler',
      playerId,
      timestamp: Date.now(),
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ══ MESSENGER: WebSocket Events für Echtzeit-Nachrichten ══════
  // ═══════════════════════════════════════════════════════════════

  // Messenger-Nachricht senden (1:1 oder Gruppen-Chat)
  socket.on('messenger-send', async (data = {}) => {
    if (!socketAuthUserId) return;
    const conversationId = Number(data.conversationId || 0);
    const text = String(data.text || '').trim().slice(0, 2000);
    if (!conversationId || !text) return;
    try {
      // Prüfen ob User Teilnehmer ist
      const [partRows] = await dbPool.query(
        'SELECT id FROM user_messenger_participants WHERE conversation_id = ? AND user_id = ?',
        [conversationId, socketAuthUserId]
      );
      if (partRows.length === 0) return;
      // Nachricht speichern
      const [ins] = await dbPool.query(
        'INSERT INTO user_messenger_messages (conversation_id, sender_id, message) VALUES (?, ?, ?)',
        [conversationId, socketAuthUserId, text]
      );
      const messageId = ins.insertId;
      // last_read_at für Sender aktualisieren
      await dbPool.query(
        'UPDATE user_messenger_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?',
        [conversationId, socketAuthUserId]
      );
      // Alle Teilnehmer benachrichtigen
      const [participants] = await dbPool.query(
        'SELECT user_id FROM user_messenger_participants WHERE conversation_id = ?',
        [conversationId]
      );
      const messagePayload = {
        id: messageId,
        conversationId,
        senderId: socketAuthUserId,
        senderName: playerName,
        text,
        type: 'text',
        createdAt: new Date().toISOString(),
      };
      for (const p of participants) {
        wsEmitToUser(io, p.user_id, 'messenger-message', messagePayload);
      }
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Senden', { error: err?.message, conversationId, userId: socketAuthUserId });
    }
  });

  // Freundschaftsanfrage senden
  socket.on('messenger-friend-request', async (data = {}) => {
    if (!socketAuthUserId) return;
    const receiverId = Number(data.receiverId || 0);
    if (!receiverId || receiverId === socketAuthUserId) return;
    try {
      // Prüfen ob schon befreundet
      const [existFriend] = await dbPool.query(
        `SELECT id FROM user_friends
         WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) AND status = 'accepted'`,
        [Math.min(socketAuthUserId, receiverId), Math.max(socketAuthUserId, receiverId),
         Math.min(socketAuthUserId, receiverId), Math.max(socketAuthUserId, receiverId)]
      );
      if (existFriend.length > 0) return;
      // Prüfen ob schon eine Anfrage existiert
      await dbPool.query(
        `INSERT INTO user_friend_requests (sender_id, receiver_id, status, message)
         VALUES (?, ?, 'pending', ?)
         ON DUPLICATE KEY UPDATE status = IF(status = 'denied', 'pending', status), updated_at = NOW()`,
        [socketAuthUserId, receiverId, String(data.message || '').trim().slice(0, 255)]
      );
      // Sender-Info holen
      const [senderRows] = await dbPool.query('SELECT id, nickname, email FROM users WHERE id = ?', [socketAuthUserId]);
      const sender = senderRows[0];
      wsEmitToUser(io, receiverId, 'messenger-friend-request-received', {
        requestId: 0,
        senderId: socketAuthUserId,
        senderName: sender?.nickname || playerName,
        message: String(data.message || '').trim(),
      });
    } catch (err) {
      logError('MESSENGER', 'Fehler bei Freundschaftsanfrage', { error: err?.message });
    }
  });

  // Freundschaftsanfrage annehmen
  socket.on('messenger-accept-friend', async (data = {}) => {
    if (!socketAuthUserId) return;
    const senderId = Number(data.senderId || 0);
    if (!senderId) return;
    try {
      // Anfrage finden und aktualisieren
      const [upd] = await dbPool.query(
        `UPDATE user_friend_requests SET status = 'accepted', updated_at = NOW()
         WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'`,
        [senderId, socketAuthUserId]
      );
      if (upd.affectedRows === 0) return;
      // Freundschaft anlegen (normalisiert: kleinere ID zuerst)
      const uid1 = Math.min(socketAuthUserId, senderId);
      const uid2 = Math.max(socketAuthUserId, senderId);
      await dbPool.query(
        `INSERT INTO user_friends (user_id, friend_id, status)
         VALUES (?, ?, 'accepted')
         ON DUPLICATE KEY UPDATE status = 'accepted', updated_at = NOW()`,
        [uid1, uid2]
      );
      // Conversation erstellen für 1:1 Chat
      const [convIns] = await dbPool.query(
        'INSERT INTO user_messenger_conversations (is_group) VALUES (0)'
      );
      const convId = convIns.insertId;
      await dbPool.query(
        'INSERT INTO user_messenger_participants (conversation_id, user_id) VALUES (?, ?), (?, ?)',
        [convId, socketAuthUserId, convId, senderId]
      );
      // System-Nachricht
      await dbPool.query(
        `INSERT INTO user_messenger_messages (conversation_id, sender_id, message, type)
         VALUES (?, ?, 'Ihr seid jetzt Freunde!', 'system')`,
        [convId, socketAuthUserId]
      );
      // Beide benachrichtigen
      const [userRows] = await dbPool.query(
        'SELECT id, nickname, is_online FROM users WHERE id IN (?, ?)',
        [socketAuthUserId, senderId]
      );
      const userMap = {};
      for (const u of userRows) userMap[u.id] = u;
      wsEmitToUser(io, senderId, 'messenger-friend-accepted', {
        userId: socketAuthUserId,
        userName: userMap[socketAuthUserId]?.nickname || playerName,
        conversationId: convId,
        online: true,
      });
      wsEmitToUser(io, socketAuthUserId, 'messenger-friend-accepted', {
        userId: senderId,
        userName: userMap[senderId]?.nickname || 'Spieler',
        conversationId: convId,
        online: !!wsUserSockets.has(senderId),
      });
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Annehmen', { error: err?.message });
    }
  });

  // Freundschaftsanfrage ablehnen
  socket.on('messenger-deny-friend', async (data = {}) => {
    if (!socketAuthUserId) return;
    const senderId = Number(data.senderId || 0);
    if (!senderId) return;
    try {
      await dbPool.query(
        `UPDATE user_friend_requests SET status = 'denied', updated_at = NOW()
         WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'`,
        [senderId, socketAuthUserId]
      );
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Ablehnen', { error: err?.message });
    }
  });

  // Freund entfernen
  socket.on('messenger-remove-friend', async (data = {}) => {
    if (!socketAuthUserId) return;
    const friendId = Number(data.friendId || 0);
    if (!friendId) return;
    try {
      const uid1 = Math.min(socketAuthUserId, friendId);
      const uid2 = Math.max(socketAuthUserId, friendId);
      await dbPool.query('DELETE FROM user_friends WHERE user_id = ? AND friend_id = ?', [uid1, uid2]);
      wsEmitToUser(io, friendId, 'messenger-friend-removed', { userId: socketAuthUserId });
      wsEmitToUser(io, socketAuthUserId, 'messenger-friend-removed', { userId: friendId });
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Entfernen', { error: err?.message });
    }
  });

  // Chat starten / öffnen
  socket.on('messenger-start-chat', async (data = {}) => {
    if (!socketAuthUserId) return;
    const friendId = Number(data.friendId || 0);
    if (!friendId) return;
    try {
      // Conversation suchen
      const [convRows] = await dbPool.query(
        `SELECT p1.conversation_id FROM user_messenger_participants p1
         INNER JOIN user_messenger_participants p2 ON p1.conversation_id = p2.conversation_id
         INNER JOIN user_messenger_conversations c ON c.id = p1.conversation_id AND c.is_group = 0
         WHERE p1.user_id = ? AND p2.user_id = ?
         LIMIT 1`,
        [socketAuthUserId, friendId]
      );
      let conversationId;
      if (convRows.length > 0) {
        conversationId = convRows[0].conversation_id;
      } else {
        // Neue Conversation erstellen
        const [convIns] = await dbPool.query('INSERT INTO user_messenger_conversations (is_group) VALUES (0)');
        conversationId = convIns.insertId;
        await dbPool.query(
          'INSERT INTO user_messenger_participants (conversation_id, user_id) VALUES (?, ?), (?, ?)',
          [conversationId, socketAuthUserId, conversationId, friendId]
        );
      }
      // Letzte Nachrichten laden
      const [messages] = await dbPool.query(
        `SELECT m.id, m.sender_id AS senderId, u.nickname AS senderName, m.message AS text, m.type, m.created_at AS createdAt
         FROM user_messenger_messages m
         LEFT JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = ? AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC LIMIT 50`,
        [conversationId]
      );
      const [friendRow] = await dbPool.query('SELECT id, nickname, is_online FROM users WHERE id = ?', [friendId]);
      socket.emit('messenger-chat-opened', {
        conversationId,
        friendId,
        friendName: friendRow[0]?.nickname || 'Spieler',
        friendOnline: !!friendRow[0]?.is_online,
        messages: messages.reverse(),
      });
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Chat-Start', { error: err?.message });
    }
  });

  // Freundesliste laden
  socket.on('messenger-load-friends', async () => {
    if (!socketAuthUserId) return;
    try {
      const [friends] = await dbPool.query(
        `SELECT u.id, u.nickname, u.is_online, ud.avatar_config,
                CASE WHEN uf.user_id = ? THEN uf.friend_id ELSE uf.user_id END AS friend_id
         FROM user_friends uf
         INNER JOIN users u ON u.id = CASE WHEN uf.user_id = ? THEN uf.friend_id ELSE uf.user_id END
         LEFT JOIN users_data ud ON ud.user_id = u.id
         WHERE (uf.user_id = ? OR uf.friend_id = ?) AND uf.status = 'accepted'
         ORDER BY u.is_online DESC, u.nickname ASC`,
        [socketAuthUserId, socketAuthUserId, socketAuthUserId, socketAuthUserId]
      );
      // Conversations für jeden Freund laden
      const friendsWithConv = [];
      for (const f of friends) {
        const [convRow] = await dbPool.query(
          `SELECT p1.conversation_id FROM user_messenger_participants p1
           INNER JOIN user_messenger_participants p2 ON p1.conversation_id = p2.conversation_id
           INNER JOIN user_messenger_conversations c ON c.id = p1.conversation_id AND c.is_group = 0
           WHERE p1.user_id = ? AND p2.user_id = ? LIMIT 1`,
          [socketAuthUserId, f.id]
        );
        const ac = toJsonValue(f.avatar_config || null);
        friendsWithConv.push({
          id: f.id,
          name: f.nickname,
          online: !!f.is_online,
          figure: (ac && typeof ac === 'object' && ac.figure) ? String(ac.figure) : null,
          conversationId: convRow[0]?.conversation_id || null,
        });
      }
      socket.emit('messenger-friends-list', { friends: friendsWithConv });
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Laden der Freunde', { error: err?.message });
    }
  });

  // Pending Anfragen laden
  socket.on('messenger-load-requests', async () => {
    if (!socketAuthUserId) return;
    try {
      const [requests] = await dbPool.query(
        `SELECT fr.id, fr.sender_id AS senderId, u.nickname AS senderName, fr.message, fr.created_at AS createdAt,
                ud.avatar_config
         FROM user_friend_requests fr
         INNER JOIN users u ON u.id = fr.sender_id
         LEFT JOIN users_data ud ON ud.user_id = u.id
         WHERE fr.receiver_id = ? AND fr.status = 'pending'
         ORDER BY fr.created_at DESC`,
        [socketAuthUserId]
      );
      const requestsWithFigure = requests.map(r => {
        const ac = toJsonValue(r.avatar_config || null);
        return {
          id: r.id,
          senderId: r.senderId,
          senderName: r.senderName,
          message: r.message,
          createdAt: r.createdAt,
          figure: (ac && typeof ac === 'object' && ac.figure) ? String(ac.figure) : null,
        };
      });
      socket.emit('messenger-requests-list', { requests: requestsWithFigure });
    } catch (err) {
      logError('MESSENGER', 'Fehler beim Laden der Anfragen', { error: err?.message });
    }
  });

  // User suchen (für Freundschaftsanfragen)
  socket.on('messenger-search', async (data = {}) => {
    if (!socketAuthUserId) return;
    const query = String(data.query || '').trim().slice(0, 50);
    if (query.length < 2) { socket.emit('messenger-search-results', { results: [] }); return; }
    try {
      const [results] = await dbPool.query(
        `SELECT u.id, u.nickname, ud.avatar_config
         FROM users u
         LEFT JOIN users_data ud ON ud.user_id = u.id
         WHERE u.nickname LIKE ? AND u.id != ? AND u.is_active = 1
         ORDER BY u.nickname ASC LIMIT 20`,
        [`%${query}%`, socketAuthUserId]
      );
      socket.emit('messenger-search-results', {
        results: results.map(r => {
          const ac = toJsonValue(r.avatar_config || null);
          return {
            id: r.id,
            name: r.nickname,
            figure: (ac && typeof ac === 'object' && ac.figure) ? String(ac.figure) : null,
          };
        })
      });
    } catch (err) {
      logError('MESSENGER', 'Fehler bei Suche', { error: err?.message });
    }
  });

  socket.on('disconnect', () => {
    logInfo('WS', 'Client disconnected', {
      socketId: socket.id,
      playerId,
      playerName,
      room: currentRoom,
    });
    leaveCurrentRoom();
    // ── Messenger: Socket-Zuordnung aufräumen + Offline-Status ──
    if (socketAuthUserId) {
      wsUnregisterUserSocket(socketAuthUserId, socket.id);
      // Wenn keine Sockets mehr da → offline setzen
      const remainingSockets = wsUserSockets.get(socketAuthUserId);
      if (!remainingSockets || remainingSockets.size === 0) {
        (async () => {
          try { await dbPool.query('UPDATE users SET is_online = 0, last_online_at = NOW() WHERE id = ?', [socketAuthUserId]); } catch {}
          // Allen Freunden den Offline-Status mitteilen
          try {
            const [friends] = await dbPool.query(
              `SELECT CASE WHEN user_id = ? THEN friend_id ELSE user_id END AS fid
               FROM user_friends WHERE (user_id = ? OR friend_id = ?) AND status = 'accepted'`,
              [socketAuthUserId, socketAuthUserId, socketAuthUserId]
            );
            for (const f of friends) {
              wsEmitToUser(io, f.fid, 'messenger-friend-status', { userId: socketAuthUserId, online: false });
            }
          } catch {}
        })();
      }
    }
  });
});

setInterval(async () => {
  if (roomRuntimeCache.size <= 0) return;
  const now = Date.now();
  for (const entry of roomRuntimeCache.values()) {
    try {
      if (entry.statsDirty && now - Number(entry.lastFlushAttemptAt || 0) >= ROOM_CACHE_FLUSH_INTERVAL_MS) {
        await flushRoomRuntimeEntry(entry, 'periodic_flush');
      }

      // ── Sync-Check: RuntimeCache.activePlayers mit wsRoomPlayers abgleichen ──
      if (Number(entry.activePlayers || 0) > 0 && entry.municipalitySlug && entry.roomCode) {
        const roomKey = wsRoomKey(entry.municipalitySlug, entry.roomCode);
        const wsPlayers = wsRoomPlayers.get(roomKey);
        const actualWsCount = wsPlayers ? wsGetRoomPlayerList(roomKey).length : 0;
        if (actualWsCount <= 0 && Number(entry.activePlayers || 0) > 0) {
          // RuntimeCache sagt Spieler da, aber WS sagt 0 → korrigieren
          logInfo('ROOMCACHE', 'Player-Count Korrektur: RuntimeCache > 0, aber WS = 0', {
            municipalitySlug: entry.municipalitySlug,
            roomCode: entry.roomCode,
            cachedPlayers: entry.activePlayers,
          });
          entry.activePlayers = 0;
          entry.idleSince = entry.idleSince || now;
          updateRoomPlayerCount(entry.municipalityId, entry.roomCode, 0).catch(() => {});
          if (typeof io !== 'undefined' && io) {
            broadcastNavigatorRoomCount(io, entry.roomCode, entry.municipalitySlug, entry.municipalityName, 0);
          }
        }
      }

      if (
        Number(entry.activePlayers || 0) <= 0 &&
        Number(entry.idleSince || 0) > 0 &&
        now - Number(entry.idleSince || 0) >= ROOM_CACHE_UNLOAD_IDLE_MS
      ) {
        await unloadRoomRuntimeEntry(entry, 'idle_timeout');
      }
    } catch (err) {
      logError('ROOMCACHE', 'Fehler beim Cache-Maintenance', {
        municipalityId: entry.municipalityId,
        municipalitySlug: entry.municipalitySlug,
        roomCode: entry.roomCode,
        error: err?.message || String(err),
      });
    }
  }
}, 5000);

// ── Stale-Player Cleanup: Entferne verwaiste Spieler deren Sockets nicht mehr verbunden sind ──
setInterval(() => {
  if (!io || wsRoomPlayers.size <= 0) return;
  for (const [roomKey, players] of wsRoomPlayers.entries()) {
    const stalePlayerIds = [];
    for (const [pid, pdata] of players.entries()) {
      const sid = pdata.socketId;
      if (!sid) { stalePlayerIds.push(pid); continue; }
      const sock = io.sockets.sockets.get(sid);
      if (!sock || sock.disconnected) {
        stalePlayerIds.push(pid);
      }
    }
    if (stalePlayerIds.length === 0) continue;

    for (const pid of stalePlayerIds) {
      players.delete(pid);
      logInfo('WS', 'Stale Player entfernt (Socket nicht mehr verbunden)', { roomKey, playerId: pid });
    }

    // Avatare des verwaisten Spielers entfernen
    const avatars = wsRoomAvatars.get(roomKey);
    if (avatars) {
      for (const [avatarId, avatar] of avatars.entries()) {
        if (stalePlayerIds.includes(avatar.ownerPlayerId)) {
          avatars.delete(avatarId);
          io.to(roomKey).emit('avatar-removed', { avatarId });
        }
      }
      if (avatars.size === 0) wsRoomAvatars.delete(roomKey);
    }

    const remainingPlayerList = wsGetRoomPlayerList(roomKey);
    const remainingCount = remainingPlayerList.length;

    // Broadcast aktualisierte Spielerliste an verbleibende Clients
    io.to(roomKey).emit('players-list', {
      players: remainingPlayerList,
      count: remainingCount,
    });

    if (players.size === 0) {
      // Raum komplett leer → alle Maps bereinigen
      wsRoomPlayers.delete(roomKey);
      wsRoomAuthoritativeStats.delete(roomKey);
      wsRoomAvatars.delete(roomKey);
      wsRoomMetadata.delete(roomKey);
    }

    // Runtime-Cache und DB aktualisieren
    const meta = wsRoomMetadata.get(roomKey);
    if (meta) {
      setRoomRuntimePlayers(meta.municipalityId, meta.roomCode, remainingCount);
      broadcastNavigatorRoomCount(io, meta.roomCode, meta.municipalitySlug, meta.municipalityName, remainingCount);
    }

    logInfo('WS', 'Stale-Player Cleanup abgeschlossen', {
      roomKey,
      removedCount: stalePlayerIds.length,
      remainingCount,
    });
  }
}, 30000); // Alle 30 Sekunden

// Server-authoritative Broadcast: Stats + Katastrophen
setInterval(async () => {
  for (const roomKey of wsRoomPlayers.keys()) {
    try {
      const { municipalitySlug, roomCode } = wsParseRoomKey(roomKey);
      const municipality = await getMunicipalityBySlug(municipalitySlug);
      if (!municipality) continue;
      const disasterResult = await runServerDisasterTick(municipality.id, roomCode);
      const upgradeResult = await runServerBuildingUpgradeTick(municipality.id, roomCode);
      await wsPublishAuthoritativeStats(io, roomKey, 'server-core');
      // Gebäude-Upgrades (Level, Abandoned) an Clients broadcasten
      if (Array.isArray(upgradeResult?.changes) && upgradeResult.changes.length > 0) {
        io.to(roomKey).emit('buildings-authoritative', {
          changes: upgradeResult.changes,
          serverTimestamp: Date.now(),
        });
      }
      if (Array.isArray(disasterResult?.changes) && disasterResult.changes.length > 0) {
        io.to(roomKey).emit('disasters-authoritative', {
          changes: disasterResult.changes,
          serverTimestamp: Date.now(),
        });
      }
    } catch (err) {
      // Absichtlich schlucken, damit die Schleife für andere Räume weiterläuft.
    }
  }
}, 3000);

// Background-Tick: Alle aktiven Gemeinden ticken (auch ohne Spieler)
// Laeuft alle 30 Sekunden und stellt sicher, dass Discord-Events gefeuert werden
const bgTickActiveRooms = new Set(); // Raeume die bereits im WS-Tick laufen
setInterval(async () => {
  if (!dbPool || !DISCORD_BOT_WEBHOOK_URL) return;
  try {
    // Alle Gemeinden mit aktiven Raeumen aus der DB holen
    const [rooms] = await dbPool.query(
      `SELECT DISTINCT r.municipality_id, r.room_code, m.slug, m.name
       FROM game_rooms r
       JOIN municipalities m ON m.id = r.municipality_id AND m.is_active = 1
       WHERE r.is_active = 1
       LIMIT 50`
    );
    for (const room of rooms) {
      // Skip Raeume die bereits im WS-Tick (3s) abgedeckt sind
      const wsKey = `${String(room.slug).toLowerCase()}:${room.room_code}`;
      let alreadyCovered = false;
      for (const rk of wsRoomPlayers.keys()) {
        if (rk.toLowerCase() === wsKey) { alreadyCovered = true; break; }
      }
      if (alreadyCovered) continue;

      try {
        await runServerDisasterTick(room.municipality_id, room.room_code);
        await runServerBuildingUpgradeTick(room.municipality_id, room.room_code);
      } catch (_) { /* Ignoriert */ }
    }
  } catch (_) { /* Ignoriert */ }
}, 30000);

// ── Buenzli Event-Generierung: Laeuft jede Minute, generiert taegl. Events + expired ──
setInterval(async () => {
  try {
    await runBuenzliEventTick();
  } catch (err) {
    logError('BUENZLI', 'Tick-Fehler', { error: err?.message || String(err) });
  }
}, BUENZLI_EVENT_CHECK_INTERVAL_MS);

let isShuttingDown = false;
async function flushAllRoomRuntimeEntries(reason = 'shutdown') {
  const entries = Array.from(roomRuntimeCache.values());
  if (entries.length <= 0) return;
  logInfo('ROOMCACHE', 'Starte Flush aller RAM-Raeume', { count: entries.length, reason });
  for (const entry of entries) {
    try {
      await flushRoomRuntimeEntry(entry, reason);
    } catch (err) {
      logError('ROOMCACHE', 'Flush-Fehler fuer Raum', {
        reason,
        municipalityId: entry.municipalityId,
        municipalitySlug: entry.municipalitySlug,
        roomCode: entry.roomCode,
        error: err?.message || String(err),
      });
    }
  }
}

async function handleShutdownSignal(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logWarn('BOOT', `Shutdown-Signal empfangen: ${signal}`);
  try {
    await flushAllRoomRuntimeEntries(`signal_${signal}`);
  } finally {
    process.exit(0);
  }
}

// ============================================================
// BOBBA PROTOKOLL: Nativer WebSocket Endpoint fuer /bobba
// Pipe-separiertes Text-Protokoll (kompatibel mit bobba_client)
// ============================================================
const WebSocket = require('ws');
const bobbaWss = new WebSocket.Server({ noServer: true });

// Bobba OpCodes (Client -> Server)
const BOBBA_OP = {
  LOGIN: 1,
  REQUEST_HEIGHT_MAP: 2,
  REQUEST_MOVEMENT: 7,
  REQUEST_CHAT: 9,
  REQUEST_LOOK_AT: 12,
  REQUEST_WAVE: 13,
  REQUEST_ROOM_DATA: 15,
  REQUEST_ITEM_INTERACT: 18,
  REQUEST_ITEM_MOVE: 19,
  REQUEST_ITEM_PICK_UP: 20,
  REQUEST_CHANGE_LOOKS: 21,
  REQUEST_CHANGE_MOTTO: 22,
  REQUEST_INVENTORY_ITEMS: 23,
  REQUEST_ITEM_PLACE: 24,
  REQUEST_CATALOGUE_INDEX: 25,
  REQUEST_CATALOGUE_PAGE: 26,
  REQUEST_CATALOGUE_PURCHASE: 27,
  REQUEST_NAVIGATOR_POPULAR_ROOMS: 28,
  REQUEST_NAVIGATOR_OWN_ROOMS: 29,
  REQUEST_NAVIGATOR_SEARCH_ROOMS: 30,
  REQUEST_NAVIGATOR_MAKE_FAVOURITE: 31,
  REQUEST_NAVIGATOR_REMOVE_FAVOURITE: 32,
  REQUEST_NAVIGATOR_LEAVE_ROOM: 33,
  REQUEST_NAVIGATOR_GO_TO_ROOM: 34,
  REQUEST_NAVIGATOR_CREATE_ROOM: 35,
  REQUEST_MESSENGER_ACCEPT_FRIEND: 36,
  REQUEST_MESSENGER_DENY_FRIEND: 37,
  REQUEST_MESSENGER_FOLLOW_FRIEND: 38,
  REQUEST_MESSENGER_SEARCH_FRIEND: 39,
  REQUEST_MESSENGER_SEND_MESSAGE: 40,
  REQUEST_MESSENGER_REMOVE_FRIEND: 41,
  REQUEST_MESSENGER_LOAD_FRIENDS: 42,
};

// Bobba OpCodes (Server -> Client)
const BOBBA_SRV = {
  LOGIN_OK: 3,
  ROOM_DATA_HEIGHTMAP: 4,
  PLAYERS_DATA: 6,
  PLAYER_STATUS: 8,
  CHAT: 10,
  PLAYER_REMOVE: 11,
  PLAYER_WAVE: 14,
  ROOM_ITEM_DATA: 16,
  ITEM_REMOVE: 17,
  ITEM_STATE: 19,
  WALL_ITEM_DATA: 20,
  INVENTORY_ITEMS: 21,
  INVENTORY_ITEM_REMOVE: 22,
  CATALOGUE_INDEX: 23,
  CATALOGUE_PAGE: 24,
  CATALOGUE_PURCHASE_ERROR: 25,
  CATALOGUE_PURCHASE_INFO: 26,
  CREDITS_BALANCE: 27,
  ROOM_DATA_MODEL_INFO: 28,
  ROOM_DATA: 29,
  NAVIGATOR_ROOM_LIST: 30,
  NAVIGATOR_LEAVE_ROOM: 31,
  MESSENGER_FRIENDS: 32,
  MESSENGER_SEARCH_RESULT: 33,
  MESSENGER_MESSAGE: 34,
  MESSENGER_REQUESTS: 35,
  MESSENGER_UPDATE_FRIEND: 36,
};

const SEP = '|';
function bobbaMsg(opCode, ...tokens) {
  return [opCode, ...tokens].join(SEP);
}
function bobbaStr(str) {
  const pipes = (str.match(/\|/g) || []).length;
  return `${pipes}${SEP}${str}`;
}

// =============================================
// Bobba Room System (nach Original bobba_server)
// =============================================

const bobbaRooms = new Map(); // roomId -> BobbaRoom
let bobbaNextUserId = 1000;
const BOBBA_TICK_MS = 500; // Game-Tick alle 500ms (wie Original)

// Furniture-Daten Cache: spriteId -> { stackHeight, isWalkable, canSit, canStack, width, length }
const furniDataCache = new Map();

async function loadFurniDataCache() {
  if (!dbPool) return;
  try {
    const [rows] = await dbPool.query(
      `SELECT sprite_id, stack_height, is_walkable, can_sit, can_stack, width, length
       FROM furniture WHERE type = 's'`
    );
    for (const r of rows) {
      furniDataCache.set(r.sprite_id, {
        stackHeight: Number(r.stack_height) || 0,
        isWalkable: r.is_walkable === '1',
        canSit: r.can_sit === '1',
        canStack: r.can_stack === '1',
        width: Number(r.width) || 1,
        length: Number(r.length) || 1,
      });
    }
    logInfo('BOBBA', `${furniDataCache.size} Furniture-Daten geladen`);
  } catch (err) {
    logError('BOBBA', 'Fehler beim Laden der Furniture-Daten', { error: err?.message });
  }
}

function getFurniData(baseId) {
  return furniDataCache.get(baseId) || { stackHeight: 1, isWalkable: false, canSit: false, canStack: true, width: 1, length: 1 };
}

// SqState Enum (wie Original)
const SQ_WALKABLE = 1;
const SQ_CLOSED = 0;
const SQ_WALKABLE_LAST = 2; // Stuhl/Tuer (begehbar, aber letzter Schritt)

// Richtung berechnen (0-7, exakt wie GameMap.calculateRotation)
function calcDirection(x1, y1, x2, y2) {
  if (x1 > x2 && y1 > y2) return 7;
  if (x1 < x2 && y1 < y2) return 3;
  if (x1 > x2 && y1 < y2) return 5;
  if (x1 < x2 && y1 > y2) return 1;
  if (x1 > x2) return 6;
  if (x1 < x2) return 2;
  if (y1 < y2) return 4;
  if (y1 > y2) return 0;
  return 2;
}

// A* Pathfinding - gibt nur den NAECHSTEN Schritt zurueck (wie Original getUserNextStep)
// Pro Tick wird nur 1 Schritt berechnet, nicht der gesamte Pfad.
function getNextStep(sqMap, maxX, maxY, currentX, currentY, targetX, targetY) {
  if (currentX === targetX && currentY === targetY) return { x: currentX, y: currentY };
  if (targetX < 0 || targetX >= maxX || targetY < 0 || targetY >= maxY) return { x: currentX, y: currentY };
  if (sqMap[targetX][targetY] === SQ_CLOSED) return { x: currentX, y: currentY };

  const k = (x, y) => `${x},${y}`;
  const open = [];
  const closedSet = new Set();
  const gScore = new Map();
  const parentMap = new Map();
  const startKey = k(currentX, currentY);
  gScore.set(startKey, 0);
  open.push({ x: currentX, y: currentY, f: 0 });

  const dirs = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];

  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    const curKey = k(cur.x, cur.y);

    if (cur.x === targetX && cur.y === targetY) {
      // Pfad zurueckverfolgen bis zum ersten Schritt nach Start
      let nodeKey = curKey;
      let prevKey = nodeKey;
      while (parentMap.has(nodeKey) && parentMap.get(nodeKey) !== startKey) {
        prevKey = nodeKey;
        nodeKey = parentMap.get(nodeKey);
      }
      if (parentMap.has(nodeKey)) prevKey = nodeKey;
      const parts = prevKey.split(',');
      return { x: parseInt(parts[0]), y: parseInt(parts[1]) };
    }

    closedSet.add(curKey);

    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (nx < 0 || nx >= maxX || ny < 0 || ny >= maxY) continue;
      if (sqMap[nx][ny] === SQ_CLOSED) continue;
      const nKey = k(nx, ny);
      if (closedSet.has(nKey)) continue;
      const isDiag = dx !== 0 && dy !== 0;
      const moveCost = isDiag ? 14 : 10;
      const tentG = (gScore.get(curKey) || 0) + moveCost;
      if (!gScore.has(nKey) || tentG < gScore.get(nKey)) {
        gScore.set(nKey, tentG);
        parentMap.set(nKey, curKey);
        const h = (Math.abs(nx - targetX) + Math.abs(ny - targetY)) * 10;
        open.push({ x: nx, y: ny, f: tentG + h });
      }
    }
  }
  return { x: currentX, y: currentY };
}

// Heightmap parsen (exakt wie Original RoomModel.java)
// Format: Zeilen getrennt durch \n, Zeichen pro Tile: 'x'=blockiert, '0'-'9'=Hoehe 0-9, 'a'-'k'=Hoehe 10-20
function parseHeightmap(heightmapStr, doorX, doorY, doorZ, doorRot) {
  const rows = heightmapStr.replace(/\\n/g, '\n').split(/[\r\n]+/).filter(r => r.length > 0);
  const maxX = rows[0].length; // Spalten = X
  const maxY = rows.length;    // Zeilen = Y

  const sqState = [];
  const sqFloorHeight = [];
  const heightMap = []; // Fuer Client: sqFloorHeight + 1 bei walkable, 0 bei closed

  for (let x = 0; x < maxX; x++) {
    sqState[x] = [];
    sqFloorHeight[x] = [];
    heightMap[x] = [];
    for (let y = 0; y < maxY; y++) {
      const ch = (rows[y] && rows[y][x]) ? rows[y][x].toLowerCase() : 'x';
      if (ch === 'x') {
        sqState[x][y] = SQ_CLOSED;
        sqFloorHeight[x][y] = 0;
        heightMap[x][y] = 0; // Client: 0 = nicht begehbar
      } else {
        sqState[x][y] = SQ_WALKABLE;
        const h = (ch >= '0' && ch <= '9') ? parseInt(ch) :
                  (ch >= 'a' && ch <= 'k') ? (ch.charCodeAt(0) - 'a'.charCodeAt(0) + 10) : 0;
        sqFloorHeight[x][y] = h;
        heightMap[x][y] = h + 1; // Client: hoehe + 1 (wie Original HeightMapComposer)
      }
    }
  }
  // Tuer ist immer begehbar
  if (doorX >= 0 && doorX < maxX && doorY >= 0 && doorY < maxY) {
    sqState[doorX][doorY] = SQ_WALKABLE;
    sqFloorHeight[doorX][doorY] = doorZ || 0;
    heightMap[doorX][doorY] = (doorZ || 0) + 1;
  }

  return { maxX, maxY, doorX, doorY, doorZ: doorZ || 0, doorRot: doorRot || 2, heightMap, sqState, sqFloorHeight };
}

// Fallback: Einfaches 16x16 Raum-Model (falls DB nicht verfuegbar)
function getDefaultRoomModel() {
  return parseHeightmap(
    '0000000000000000\n0000000000000000\n0000000000000000\n0000000000000000\n' +
    '0000000000000000\n0000000000000000\n0000000000000000\n0000000000000000\n' +
    '0000000000000000\n0000000000000000\n0000000000000000\n0000000000000000\n' +
    '0000000000000000\n0000000000000000\n0000000000000000\n0000000000000000',
    0, 8, 0, 2
  );
}

// DB-geladene Room-Models und Rooms
const bobbaDbModels = new Map();  // modelId -> parsed model
const bobbaDbRooms = new Map();   // roomId -> { id, name, owner, description, modelId, capacity, lockType }

async function loadBobbaRoomModelsFromDb() {
  if (!dbPool) return;
  try {
    // rooms Tabelle sicherstellen (fuer User-erstellte Raeume)
    await dbPool.query(`CREATE TABLE IF NOT EXISTS rooms (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL,
      owner VARCHAR(100) NOT NULL DEFAULT 'Server',
      description VARCHAR(500) NOT NULL DEFAULT '',
      model_id VARCHAR(50) NOT NULL,
      capacity INT NOT NULL DEFAULT 25,
      lock_type TINYINT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_rooms_active (is_active, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    // Favourites-Tabelle sicherstellen
    await dbPool.query(`CREATE TABLE IF NOT EXISTS room_favourites (
      user_id BIGINT UNSIGNED NOT NULL,
      room_id INT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, room_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    // Room-Items Tabelle (platzierte Moebel in Raeumen)
    await dbPool.query(`CREATE TABLE IF NOT EXISTS room_items (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      room_id INT UNSIGNED NOT NULL,
      base_id INT NOT NULL,
      item_type CHAR(1) NOT NULL DEFAULT 'F',
      item_code VARCHAR(64) NOT NULL DEFAULT '',
      x INT NOT NULL DEFAULT 0,
      y INT NOT NULL DEFAULT 0,
      z DOUBLE NOT NULL DEFAULT 0,
      rot INT NOT NULL DEFAULT 0,
      state INT NOT NULL DEFAULT 0,
      owner_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_room_items_room (room_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    // Models aus room_models laden (Habbo-Original-Tabelle)
    const [models] = await dbPool.query('SELECT id, door_x, door_y, door_z, door_dir, heightmap FROM room_models');
    for (const m of models) {
      try {
        const parsed = parseHeightmap(m.heightmap, m.door_x, m.door_y, m.door_z, m.door_dir);
        bobbaDbModels.set(m.id, parsed);
      } catch (err) {
        logError('BOBBA', `Fehler beim Parsen von Model ${m.id}`, { error: err?.message });
      }
    }

    // Rooms laden
    const [rooms] = await dbPool.query('SELECT id, name, owner, description, model_id, capacity, lock_type FROM rooms WHERE is_active = 1 ORDER BY sort_order ASC');
    for (const r of rooms) {
      bobbaDbRooms.set(r.id, {
        id: r.id,
        name: r.name,
        owner: r.owner,
        description: r.description,
        modelId: r.model_id,
        capacity: r.capacity,
        lockType: r.lock_type || 0,
      });
    }

    logInfo('BOBBA', `${bobbaDbModels.size} Models (aus room_models) und ${bobbaDbRooms.size} Rooms geladen`);
  } catch (err) {
    logError('BOBBA', 'Fehler beim Laden der Room-Models/Rooms aus DB', { error: err?.message });
  }
}

// ============================================================
// Bobba Coins – gespeichert in users_data.project_data JSON
// ============================================================
const BOBBA_DEFAULT_COINS = 500;

async function getBobbaCoins(dbUserId) {
  if (!dbPool || !dbUserId) return BOBBA_DEFAULT_COINS;
  try {
    const [rows] = await dbPool.query(
      `SELECT JSON_EXTRACT(project_data, '$.bobba_coins') AS coins FROM users_data WHERE user_id = ?`,
      [dbUserId]
    );
    if (rows.length > 0 && rows[0].coins !== null && rows[0].coins !== undefined) {
      const val = Number(rows[0].coins);
      return Number.isFinite(val) ? val : BOBBA_DEFAULT_COINS;
    }
    // Kein Eintrag oder kein Feld → Default setzen
    await setBobbaCoins(dbUserId, BOBBA_DEFAULT_COINS);
    return BOBBA_DEFAULT_COINS;
  } catch (err) {
    logError('BOBBA', 'Fehler beim Lesen der Coins', { error: err?.message, userId: dbUserId });
    return BOBBA_DEFAULT_COINS;
  }
}

async function setBobbaCoins(dbUserId, amount) {
  if (!dbPool || !dbUserId) return;
  const safeAmount = Math.max(0, Math.round(Number(amount) || 0));
  try {
    await dbPool.query(
      `INSERT INTO users_data (user_id, project_data) VALUES (?, JSON_OBJECT('bobba_coins', ?))
       ON DUPLICATE KEY UPDATE project_data = JSON_SET(COALESCE(project_data, '{}'), '$.bobba_coins', ?)`,
      [dbUserId, safeAmount, safeAmount]
    );
  } catch (err) {
    logError('BOBBA', 'Fehler beim Schreiben der Coins', { error: err?.message, userId: dbUserId });
  }
}

async function addBobbaCoins(dbUserId, delta) {
  const current = await getBobbaCoins(dbUserId);
  const newAmount = Math.max(0, current + delta);
  await setBobbaCoins(dbUserId, newAmount);
  return newAmount;
}

// ============================================================
// Katalog-System (Moebel-Shop)
// ============================================================
const catalogPages = new Map();  // pageId -> page object
const catalogItems = new Map();  // itemId -> item object

async function loadCatalogFromDb() {
  if (!dbPool) return;
  try {
    // base_id + item_type Spalten zu user_inventory hinzufuegen (falls noch nicht vorhanden)
    try { await dbPool.query(`ALTER TABLE user_inventory ADD COLUMN base_id INT NOT NULL DEFAULT 0 AFTER item_code`); } catch (_) {}
    try { await dbPool.query(`ALTER TABLE user_inventory ADD COLUMN item_type CHAR(1) NOT NULL DEFAULT 'F' AFTER base_id`); } catch (_) {}

    catalogPages.clear();
    catalogItems.clear();

    // Pages laden (bobba.sql Tabelle: order_num, visible/enabled als enum '0'/'1')
    const [pages] = await dbPool.query(
      `SELECT id, parent_id, caption, icon_color, icon_image, visible, enabled,
              min_rank, club_only, order_num, page_layout,
              page_headline, page_teaser, page_special,
              page_text1, page_text2, page_text_details, page_text_teaser
       FROM catalog_pages
       ORDER BY order_num ASC, id ASC`
    );
    for (const p of pages) {
      const isVisible = String(p.visible) === '1';
      const isEnabled = String(p.enabled) === '1';
      if (!isVisible || !isEnabled) continue;

      catalogPages.set(p.id, {
        id: p.id,
        parentId: (p.parent_id == null || p.parent_id < 0) ? -1 : p.parent_id,
        caption: p.caption || '',
        visible: isVisible,
        enabled: isEnabled,
        minRank: Number(p.min_rank) || 1,
        clubOnly: String(p.club_only) === '1',
        iconColor: Number(p.icon_color) || 1,
        iconImage: Number(p.icon_image) || 1,
        layout: p.page_layout || 'default_3x3',
        headline: p.page_headline || '',
        teaser: p.page_teaser || '',
        special: p.page_special || '',
        text1: p.page_text1 || '',
        text2: p.page_text2 || '',
        textDetails: p.page_text_details || '',
        textTeaser: p.page_text_teaser || '',
        items: [],
      });
    }

    // Items laden mit furniture-Join fuer Item-Typ (Floor/Wall)
    const [items] = await dbPool.query(
      `SELECT ci.id, ci.page_id, ci.item_ids, ci.catalog_name, ci.cost_credits,
              ci.cost_pixels, ci.amount, ci.hc_state,
              f.item_name, f.type AS furni_type, f.sprite_id,
              f.width AS furni_width, f.length AS furni_length,
              f.interaction_type, f.interaction_modes_count
       FROM catalog_items ci
       LEFT JOIN furniture f ON f.id = CAST(ci.item_ids AS UNSIGNED)
       WHERE ci.page_id IN (SELECT id FROM catalog_pages WHERE visible = '1' AND enabled = '1')
       ORDER BY ci.page_id ASC, ci.id ASC`
    );
    for (const item of items) {
      const furniDbId = parseInt(item.item_ids, 10) || 0;
      const spriteId = Number(item.sprite_id) || furniDbId;
      // Item-Typ: 's' = Floor (Standing), 'i' = Wall (Item), 'e' = Effect
      const furniType = String(item.furni_type || 's').toLowerCase();
      const itemType = furniType === 'i' ? 'I' : 'F';
      const catalogItem = {
        id: item.id,
        pageId: item.page_id,
        baseId: spriteId,
        name: item.catalog_name || item.item_name || '',
        cost: Number(item.cost_credits) || 3,
        costPixels: Number(item.cost_pixels) || 0,
        amount: Number(item.amount) || 1,
        itemType,
        spriteId,
        furniName: item.item_name || '',
        hcState: String(item.hc_state || '0'),
      };
      catalogItems.set(item.id, catalogItem);
      const page = catalogPages.get(item.page_id);
      if (page) {
        page.items.push(catalogItem);
      }
    }

    logInfo('BOOT', `Katalog geladen: ${catalogPages.size} Seiten, ${catalogItems.size} Items`);
  } catch (err) {
    logError('BOOT', 'Fehler beim Laden des Katalogs aus DB', { error: err?.message, stack: err?.stack });
  }
}

// Catalogue Index serialisieren (wie CatalogueIndexComposer.java)
function serializeCatalogueIndex(rank) {
  const allPages = [...catalogPages.values()];
  // Hauptseiten (parent_id = -1)
  const mainPages = allPages.filter(p => p.parentId === -1 && p.visible && p.minRank <= rank);
  let msg = '' + BOBBA_SRV.CATALOGUE_INDEX;
  msg += SEP + mainPages.length;

  for (const mainPage of mainPages) {
    // Serialize main page
    msg += SEP + (mainPage.visible ? 1 : 0);
    msg += SEP + mainPage.iconColor;
    msg += SEP + mainPage.iconImage;
    msg += SEP + mainPage.id;
    msg += SEP + bobbaStr(mainPage.caption);

    // Children count
    const children = allPages.filter(p => p.parentId === mainPage.id && p.visible && p.minRank <= rank);
    msg += SEP + children.length;

    for (const child of children) {
      msg += SEP + (child.visible ? 1 : 0);
      msg += SEP + child.iconColor;
      msg += SEP + child.iconImage;
      msg += SEP + child.id;
      msg += SEP + bobbaStr(child.caption);
      msg += SEP + 0; // keine Sub-Kinder
    }
  }
  return msg;
}

// Catalogue Page serialisieren (wie CataloguePageComposer.java)
function serializeCataloguePage(page) {
  let msg = '' + BOBBA_SRV.CATALOGUE_PAGE;
  msg += SEP + page.id;
  msg += SEP + bobbaStr(page.layout || 'default_3x3');
  msg += SEP + bobbaStr(page.headline || '');
  msg += SEP + bobbaStr(page.teaser || '');
  msg += SEP + bobbaStr(page.text1 || '');
  msg += SEP + bobbaStr(page.textDetails || '');
  msg += SEP + bobbaStr(page.textTeaser || '');
  msg += SEP + bobbaStr(page.text2 || '');
  msg += SEP + page.items.length;

  for (const item of page.items) {
    msg += SEP + item.id;
    msg += SEP + bobbaStr(item.name || '');
    msg += SEP + item.cost;
    msg += SEP + bobbaStr(item.itemType || 'F');
    msg += SEP + (item.spriteId || item.baseId);
    msg += SEP + item.amount;
  }
  return msg;
}

// BobbaRoom Klasse (wie Original Room + GameMap)
class BobbaRoom {
  constructor(roomId, model) {
    this.roomId = roomId;
    this.model = model;
    this.users = new Map();
    this.items = [];
    this.nextItemId = 1;
    this.tickTimer = null;
    // SqState-Map (kopie von model.sqState, dynamisch mit Users/Items)
    this.sqMap = [];
    this.itemHeightMap = []; // Hoehe durch platzierte Items pro Tile
    this.userSqState = new Map(); // userId -> vorheriger SqState des Feldes
    for (let i = 0; i < model.maxX; i++) {
      this.sqMap[i] = [];
      this.itemHeightMap[i] = [];
      for (let j = 0; j < model.maxY; j++) {
        this.sqMap[i][j] = model.sqState[i][j];
        this.itemHeightMap[i][j] = 0;
      }
    }
  }

  canWalkTo(x, y) {
    if (x < 0 || y < 0 || x >= this.model.maxX || y >= this.model.maxY) return false;
    return this.sqMap[x][y] !== SQ_CLOSED;
  }

  sqAbsoluteHeight(x, y) {
    const floorH = this.model.sqFloorHeight[x] ? (this.model.sqFloorHeight[x][y] || 0) : 0;
    const itemH = (this.itemHeightMap[x] && this.itemHeightMap[x][y]) ? this.itemHeightMap[x][y] : 0;
    return floorH + itemH;
  }

  // Item-Tiles auf der sqMap und itemHeightMap aktualisieren
  placeItemOnMap(item) {
    const furni = getFurniData(item.baseId);
    const tiles = this._getItemTiles(item.x, item.y, furni.width, furni.length, item.rot);
    for (const [tx, ty] of tiles) {
      if (tx < 0 || ty < 0 || tx >= this.model.maxX || ty >= this.model.maxY) continue;
      this.itemHeightMap[tx][ty] = Math.max(this.itemHeightMap[tx][ty], Number(item.z) + furni.stackHeight);
      if (furni.isWalkable || furni.canSit) {
        this.sqMap[tx][ty] = furni.canSit ? SQ_WALKABLE_LAST : SQ_WALKABLE;
      } else {
        this.sqMap[tx][ty] = SQ_CLOSED;
      }
    }
  }

  removeItemFromMap(item) {
    const furni = getFurniData(item.baseId);
    const tiles = this._getItemTiles(item.x, item.y, furni.width, furni.length, item.rot);
    for (const [tx, ty] of tiles) {
      if (tx < 0 || ty < 0 || tx >= this.model.maxX || ty >= this.model.maxY) continue;
      // Auf Original-State zuruecksetzen
      this.sqMap[tx][ty] = this.model.sqState[tx][ty];
      this.itemHeightMap[tx][ty] = 0;
    }
    // Rekalkulieren: andere Items die auf diesen Tiles liegen koennten
    for (const otherItem of this.items) {
      if (otherItem.id === item.id) continue;
      const otherFurni = getFurniData(otherItem.baseId);
      const otherTiles = this._getItemTiles(otherItem.x, otherItem.y, otherFurni.width, otherFurni.length, otherItem.rot);
      for (const [ox, oy] of otherTiles) {
        for (const [tx, ty] of tiles) {
          if (ox === tx && oy === ty) {
            this.itemHeightMap[tx][ty] = Math.max(this.itemHeightMap[tx][ty], Number(otherItem.z) + otherFurni.stackHeight);
            if (otherFurni.isWalkable || otherFurni.canSit) {
              this.sqMap[tx][ty] = otherFurni.canSit ? SQ_WALKABLE_LAST : SQ_WALKABLE;
            } else {
              this.sqMap[tx][ty] = SQ_CLOSED;
            }
          }
        }
      }
    }
  }

  // Finde ein sittable/layable Item auf einem Tile
  getInteractableItemAt(x, y) {
    for (const item of this.items) {
      const furni = getFurniData(item.baseId);
      if (!furni.canSit) continue;
      const tiles = this._getItemTiles(item.x, item.y, furni.width, furni.length, item.rot);
      for (const [tx, ty] of tiles) {
        if (tx === x && ty === y) {
          return { item, furni };
        }
      }
    }
    return null;
  }

  _getItemTiles(x, y, width, length, rot) {
    const tiles = [];
    const w = (rot === 2 || rot === 6) ? width : length;
    const l = (rot === 2 || rot === 6) ? length : width;
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < l; dy++) {
        tiles.push([x + dx, y + dy]);
      }
    }
    return tiles;
  }

  addUserToMap(user) {
    const { x, y } = user;
    user.currentSqState = this.sqMap[x][y];
    if (x !== this.model.doorX || y !== this.model.doorY) {
      this.sqMap[x][y] = SQ_CLOSED;
    }
  }

  removeUserFromMap(user) {
    const { x, y } = user;
    this.sqMap[x][y] = user.currentSqState || SQ_WALKABLE;
  }

  updateUserMovement(user, oldX, oldY, newX, newY) {
    // Altes Feld freigeben
    if (oldX !== this.model.doorX || oldY !== this.model.doorY) {
      this.sqMap[oldX][oldY] = user.currentSqState || SQ_WALKABLE;
    }
    // Neues Feld blockieren
    user.currentSqState = this.sqMap[newX][newY];
    if (newX !== this.model.doorX || newY !== this.model.doorY) {
      this.sqMap[newX][newY] = SQ_CLOSED;
    }
  }

  // Wie Original handleWalkingUser
  handleWalkingUser(user) {
    // SCHRITT 1: Wenn nextX/Y != aktueller Position → dort ankommen
    if (user.x !== user.nextX || user.y !== user.nextY) {
      if (this.canWalkTo(user.nextX, user.nextY)) {
        const oldX = user.x, oldY = user.y;
        this.updateUserMovement(user, oldX, oldY, user.nextX, user.nextY);
        user.x = user.nextX;
        user.y = user.nextY;
        user.z = user.nextZ;
      } else {
        user.walking = false;
        delete user.statuses.mv;
      }
    }

    // Sitz-/Liege-Check: wenn User aufhoert zu laufen und auf einem Stuhl/Bett steht
    if (!user.walking || (user.x === user.targetX && user.y === user.targetY)) {
      const interactable = this.getInteractableItemAt(user.x, user.y);
      if (interactable) {
        const { item, furni } = interactable;
        const sitHeight = furni.stackHeight;
        user.statuses.sit = `${sitHeight.toFixed(1)}`;
        user.z = Number(item.z || 0);
        // Rotation des Stuhls uebernehmen
        user.rot = item.rot;
        user.needsUpdate = true;
      } else if (user.statuses.sit) {
        delete user.statuses.sit;
        user.needsUpdate = true;
      }
    }

    // SCHRITT 2: Naechsten Schritt berechnen
    const next = getNextStep(this.sqMap, this.model.maxX, this.model.maxY, user.x, user.y, user.targetX, user.targetY);
    if (next.x === user.x && next.y === user.y) {
      // Am Ziel oder kein Pfad
      user.walking = false;
      delete user.statuses.mv;
    } else if (this.canWalkTo(next.x, next.y)) {
      user.nextX = next.x;
      user.nextY = next.y;
      user.nextZ = this.sqAbsoluteHeight(next.x, next.y);
      user.statuses.mv = `${next.x},${next.y},${user.nextZ}`;
      user.rot = calcDirection(user.x, user.y, user.nextX, user.nextY);
    } else {
      user.walking = false;
      delete user.statuses.mv;
    }
    user.needsUpdate = true;
  }

  // Game-Tick (wie Original onCycle)
  onCycle() {
    const usersToUpdate = [];
    for (const [, user] of this.users) {
      if (user.walking) {
        this.handleWalkingUser(user);
      } else if (user.statuses.mv) {
        delete user.statuses.mv;
        user.needsUpdate = true;
      }
      if (user.needsUpdate) {
        usersToUpdate.push(user);
        user.needsUpdate = false;
      }
    }
    // Batch-Broadcast aller geaenderten User (wie Original broadcastStatusUpdates)
    if (usersToUpdate.length > 0) {
      let msg = `${BOBBA_SRV.PLAYER_STATUS}${SEP}${usersToUpdate.length}`;
      for (const u of usersToUpdate) {
        msg += `${SEP}${u.id}${SEP}${u.x}${SEP}${u.y}${SEP}${u.z}${SEP}${u.rot}`;
        const statusKeys = Object.keys(u.statuses);
        msg += `${SEP}${statusKeys.length}`;
        for (const key of statusKeys) {
          msg += `${SEP}${bobbaStr(key)}${SEP}${bobbaStr(u.statuses[key])}`;
        }
      }
      for (const [, user] of this.users) {
        if (user.ws && user.ws.readyState === WebSocket.OPEN) {
          user.ws.send(msg);
        }
      }
    }
  }

  startTick() {
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.onCycle(), BOBBA_TICK_MS);
    }
  }

  stopTick() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
}

async function getBobbaRoom(roomId) {
  if (!bobbaRooms.has(roomId)) {
    // Model aus DB laden (falls vorhanden)
    let model = getDefaultRoomModel();
    const dbRoom = bobbaDbRooms.get(roomId);
    if (dbRoom && bobbaDbModels.has(dbRoom.modelId)) {
      model = bobbaDbModels.get(dbRoom.modelId);
      logInfo('BOBBA', `Raum #${roomId} nutzt DB-Model "${dbRoom.modelId}" (${model.maxX}x${model.maxY})`);
    } else {
      logInfo('BOBBA', `Raum #${roomId} nutzt Standard-Model (kein DB-Eintrag)`);
    }
    const room = new BobbaRoom(roomId, model);

    // Items aus DB laden
    if (dbPool) {
      try {
        const [dbItems] = await dbPool.query(
          'SELECT id, base_id, item_type, item_code, x, y, z, rot, state, owner_id FROM room_items WHERE room_id = ?',
          [roomId]
        );
        for (const di of dbItems) {
          room.items.push({
            id: di.id,
            x: di.x,
            y: di.y,
            z: Number(di.z) || 0,
            rot: di.rot || 0,
            baseId: di.base_id,
            state: di.state || 0,
            ownerId: di.owner_id,
          });
          if (di.id >= room.nextItemId) room.nextItemId = di.id + 1;
        }
        // Item-Map aufbauen
        for (const item of room.items) {
          room.placeItemOnMap(item);
        }
        if (dbItems.length > 0) {
          logInfo('BOBBA', `Raum #${roomId}: ${dbItems.length} Items aus DB geladen`);
        }
      } catch (err) {
        logError('BOBBA', `Fehler beim Laden der Room-Items fuer Raum #${roomId}`, { error: err?.message });
      }
    }

    bobbaRooms.set(roomId, room);
  }
  return bobbaRooms.get(roomId);
}

function broadcastToBobbaRoom(roomId, message, excludeWs) {
  const room = bobbaRooms.get(roomId);
  if (!room) return;
  for (const [, user] of room.users) {
    if (user.ws !== excludeWs && user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(message);
    }
  }
}

// Bobba WebSocket Handler
bobbaWss.on('connection', (ws) => {
  let userId = null;
  let dbUserId = null; // Echte DB-User-ID fuer Queries (Freunde, Inventar etc.)
  let userName = null;
  let userLook = 'hd-190-10.lg-3023-1408.ch-215-91.hr-893-45';
  let userMotto = '';
  let currentRoomId = null;
  let loadingRoomId = null; // Raum der gerade geladen wird (wie Original User.loadingRoomId)

  logInfo('BOBBA', 'Neue Bobba-Verbindung');

  ws.on('message', async (raw) => {
    try {
      const data = String(raw);
      const tokens = data.split(SEP);
      let ptr = 0;
      const popToken = () => tokens[ptr++] || '';
      const popInt = () => parseInt(popToken()) || 0;
      const popFloat = () => parseFloat(popToken()) || 0;
      const popString = () => {
        const pipes = popInt();
        let str = popToken();
        for (let i = 0; i < pipes; i++) str += SEP + popToken();
        return str;
      };

      const opCode = popInt();

      switch (opCode) {
        case BOBBA_OP.LOGIN: {
          const token = popString();
          const roomIdStr = popString();

          logInfo('BOBBA', 'LOGIN empfangen', { tokenLen: token.length, roomIdStr });

          // Token validieren ueber bestehende Auth
          const payload = verifyToken(token);
          if (!payload) {
            logError('BOBBA', 'Token ungueltig oder abgelaufen');
            ws.send(bobbaMsg(BOBBA_SRV.NAVIGATOR_LEAVE_ROOM));
            ws.close();
            return;
          }

          // User-ID: JWT nutzt "sub" als Standard-Claim
          dbUserId = Number(payload.sub || payload.userId || payload.id || 0);
          if (!dbUserId) {
            logError('BOBBA', 'Keine User-ID im Token-Payload', { payloadKeys: Object.keys(payload) });
            ws.send(bobbaMsg(BOBBA_SRV.NAVIGATOR_LEAVE_ROOM));
            ws.close();
            return;
          }

          userId = bobbaNextUserId++;
          logInfo('BOBBA', 'Token OK', { dbUserId, bobbaUserId: userId });

          // User-Daten aus DB laden (bestehende Funktionen nutzen)
          if (dbPool) {
            try {
              const [rows] = await dbPool.query('SELECT id, nickname, email FROM users WHERE id = ?', [dbUserId]);
              if (rows.length > 0) {
                userName = rows[0].nickname || `Spieler_${dbUserId}`;
              } else {
                userName = `Spieler_${dbUserId}`;
              }
            } catch (err) {
              userName = `Spieler_${dbUserId}`;
              logError('BOBBA', 'DB-Fehler beim User-Laden', { error: err?.message });
            }
            // Avatar-Look ueber bestehende getUserAvatarConfig laden
            try {
              const avatarCfg = await getUserAvatarConfig(dbUserId);
              if (avatarCfg && avatarCfg.figure) {
                userLook = avatarCfg.figure;
              }
              if (avatarCfg && avatarCfg.motto) {
                userMotto = avatarCfg.motto;
              }
              logInfo('BOBBA', 'Avatar geladen', { figure: userLook, motto: userMotto });
            } catch (err) {
              logInfo('BOBBA', 'Avatar-Config Fallback (Standard-Look)', { error: err?.message });
            }
          } else {
            userName = `Spieler_${dbUserId}`;
          }

          logInfo('BOBBA', 'Login OK', { userId, userName, roomId: roomIdStr });

          // LOGIN_OK senden: id|name|look|motto (wie Original UserManager.tryLogin)
          ws.send(bobbaMsg(BOBBA_SRV.LOGIN_OK, userId, bobbaStr(userName), bobbaStr(userLook), bobbaStr(userMotto)));

          // Credits aus users_data laden und senden
          const loginCoins = await getBobbaCoins(dbUserId);
          ws.send(bobbaMsg(BOBBA_SRV.CREDITS_BALANCE, loginCoins));

          // NICHT direkt in den Raum gehen!
          // Der Client sendet nach LOGIN_OK automatisch GoToRoom(-1)
          // Das startet den 3-Schritt-Handshake: MODEL_INFO -> HEIGHTMAP -> ROOM_DATA
          logInfo('BOBBA', 'Warte auf GoToRoom vom Client', { userId, userName });
          break;
        }

        case BOBBA_OP.REQUEST_HEIGHT_MAP: {
          // Wie Original prepareHeightMapForUser: nutzt loadingRoomId
          if (loadingRoomId == null) {
            logInfo('BOBBA', 'REQUEST_HEIGHT_MAP ignoriert - kein loadingRoomId', { userId });
            break;
          }
          logInfo('BOBBA', 'Sende HeightMap', { userId, loadingRoomId });
          sendHeightMap(ws, loadingRoomId);
          break;
        }

        case BOBBA_OP.REQUEST_ROOM_DATA: {
          // === finishRoomLoadingForUser (wie Original RoomManager.finishRoomLoadingForUser) ===
          // Hier wird der User erst zum Raum hinzugefuegt!
          if (loadingRoomId == null && currentRoomId == null) {
            logInfo('BOBBA', 'REQUEST_ROOM_DATA ignoriert - kein loadingRoomId/currentRoomId', { userId });
            break;
          }

          const targetId = loadingRoomId || currentRoomId;
          const room = await getBobbaRoom(targetId);

          // Raum-State setzen (wie Original: user.setLoadingRoomId(0), user.setCurrentRoom(room))
          currentRoomId = targetId;
          loadingRoomId = null;

          // RoomUser erstellen (wie Original RoomUserManager.addUserToRoom)
          const model = room.model;
          const startX = model.doorX;
          const startY = model.doorY;
          const roomUser = {
            ws, id: userId, name: userName, look: userLook, motto: userMotto,
            x: startX, y: startY, z: model.doorZ || 0, rot: model.doorRot || 2,
            targetX: startX, targetY: startY,
            nextX: startX, nextY: startY, nextZ: model.doorZ || 0,
            walking: false, needsUpdate: false,
            currentSqState: SQ_WALKABLE_LAST,
            statuses: {},
          };

          // 1. Neuen Spieler an alle BESTEHENDEN User broadcasten (BEVOR er zur Map hinzugefuegt wird)
          //    Wie Original: room.sendMessage(new SerializeRoomUserComposer(roomUser))
          const joinMsg = bobbaMsg(BOBBA_SRV.PLAYERS_DATA, 1,
            roomUser.id, roomUser.x, roomUser.y, roomUser.z, roomUser.rot,
            bobbaStr(roomUser.name), bobbaStr(roomUser.look), bobbaStr(roomUser.motto));
          for (const [, existingUser] of room.users) {
            if (existingUser.ws && existingUser.ws.readyState === WebSocket.OPEN) {
              existingUser.ws.send(joinMsg);
            }
          }

          // 2. User zur Map hinzufuegen (wie Original: users.put + addUserToMap)
          room.users.set(userId, roomUser);
          room.addUserToMap(roomUser);
          room.startTick();

          // 3. Floor-Items an neuen User senden (wie Original: SerializeFloorItemComposer)
          if (room.items.length > 0) {
            let itemsMsg = `${BOBBA_SRV.ROOM_ITEM_DATA}${SEP}${room.items.length}`;
            for (const item of room.items) {
              itemsMsg += `${SEP}${item.id}${SEP}${item.x}${SEP}${item.y}${SEP}${item.z}${SEP}${item.rot}${SEP}${item.baseId}${SEP}${item.state}`;
            }
            ws.send(itemsMsg);
          }

          // 4. ALLE Spieler im Raum an neuen User senden (inkl. sich selbst)
          //    Wie Original: SerializeRoomUserComposer(getUsers())
          const allUsers = Array.from(room.users.values());
          let usersMsg = `${BOBBA_SRV.PLAYERS_DATA}${SEP}${allUsers.length}`;
          for (const u of allUsers) {
            usersMsg += `${SEP}${u.id}${SEP}${u.x}${SEP}${u.y}${SEP}${u.z}${SEP}${u.rot}${SEP}${bobbaStr(u.name)}${SEP}${bobbaStr(u.look)}${SEP}${bobbaStr(u.motto)}`;
          }
          ws.send(usersMsg);
          logInfo('BOBBA', 'PLAYERS_DATA gesendet', { roomId: currentRoomId, users: allUsers.length, msg: usersMsg.substring(0, 120) });

          // 5. Initiale User-Status senden (wie Original: SerializeRoomUserStatus(getUsers()))
          let statusMsg = `${BOBBA_SRV.PLAYER_STATUS}${SEP}${allUsers.length}`;
          for (const u of allUsers) {
            statusMsg += `${SEP}${u.id}${SEP}${u.x}${SEP}${u.y}${SEP}${u.z}${SEP}${u.rot}`;
            const statusKeys = Object.keys(u.statuses);
            statusMsg += `${SEP}${statusKeys.length}`;
            for (const key of statusKeys) {
              statusMsg += `${SEP}${bobbaStr(key)}${SEP}${bobbaStr(u.statuses[key])}`;
            }
          }
          ws.send(statusMsg);

          // 6. Raum-Info senden (wie Original: RoomDataComposer → NavigatorRoomListComposer.serializeRoomData)
          //    Format: id | name(str) | owner(str) | description(str) | lockType(int) | userCount(int) | capacity(int)
          const roomInfo = bobbaDbRooms.get(currentRoomId);
          const roomName = roomInfo ? roomInfo.name : `Public Room ${currentRoomId}`;
          const roomOwner = roomInfo ? roomInfo.owner : 'Server';
          const roomDesc = roomInfo ? roomInfo.description : 'Willkommen!';
          const roomLockType = roomInfo ? roomInfo.lockType : 0;
          const roomCapacity = roomInfo ? roomInfo.capacity : 25;
          ws.send(bobbaMsg(BOBBA_SRV.ROOM_DATA,
            currentRoomId,
            bobbaStr(roomName),
            bobbaStr(roomOwner),
            bobbaStr(roomDesc),
            roomLockType,
            allUsers.length,
            roomCapacity
          ));

          logInfo('BOBBA', 'finishRoomLoading komplett', { userId, roomId: currentRoomId, users: allUsers.length, items: room.items.length });
          break;
        }

        case BOBBA_OP.REQUEST_MOVEMENT: {
          // Wie Original: moveTo() setzt nur targetX/Y und walking=true
          // Der Game-Tick (onCycle) berechnet dann Schritt fuer Schritt
          if (currentRoomId == null || userId == null) break;
          const targetX = popInt();
          const targetY = popInt();
          const room = bobbaRooms.get(currentRoomId);
          if (!room) break;
          const user = room.users.get(userId);
          if (!user) break;
          if (room.canWalkTo(targetX, targetY)) {
            user.targetX = targetX;
            user.targetY = targetY;
            user.walking = true;
            // Aufstehen wenn gesessen
            if (user.statuses.sit) {
              delete user.statuses.sit;
              user.needsUpdate = true;
            }
          }
          break;
        }

        case BOBBA_OP.REQUEST_CHAT: {
          if (currentRoomId == null || userId == null) break;
          const chatText = popString();
          if (!chatText.trim()) break;
          // Wie Original: o/ im Chat loest Wave aus
          if (chatText.toLowerCase().includes('o/')) {
            broadcastToBobbaRoom(currentRoomId, bobbaMsg(BOBBA_SRV.PLAYER_WAVE, userId));
          }
          broadcastToBobbaRoom(currentRoomId, bobbaMsg(BOBBA_SRV.CHAT, userId, bobbaStr(chatText)));
          break;
        }

        case BOBBA_OP.REQUEST_WAVE: {
          if (currentRoomId == null || userId == null) break;
          broadcastToBobbaRoom(currentRoomId, bobbaMsg(BOBBA_SRV.PLAYER_WAVE, userId));
          break;
        }

        case BOBBA_OP.REQUEST_LOOK_AT: {
          // Wie Original: lookAt() dreht den Spieler zum Ziel (wenn nicht sitzend)
          if (currentRoomId == null || userId == null) break;
          const lookAtUserId = popInt();
          const room = bobbaRooms.get(currentRoomId);
          if (!room) break;
          const me = room.users.get(userId);
          const target = room.users.get(lookAtUserId);
          if (!me || !target || me === target) break;
          if (me.statuses.sit) break; // Sitzende User drehen sich nicht
          me.rot = calcDirection(me.x, me.y, target.x, target.y);
          me.needsUpdate = true; // Wird beim naechsten Tick gebroadcastet
          break;
        }

        case BOBBA_OP.REQUEST_CHANGE_LOOKS: {
          if (userId == null || dbUserId == null) break;
          const newLook = popString();
          const newGender = popString();
          if (!newLook.trim()) break;
          userLook = newLook;
          logInfo('BOBBA', 'Look geaendert', { userId, newLook, newGender });
          // In DB persistieren (avatar_config.figure updaten)
          if (dbPool) {
            try {
              const [existing] = await dbPool.query('SELECT avatar_config FROM users_data WHERE user_id = ?', [dbUserId]);
              let cfg = {};
              if (existing.length > 0 && existing[0].avatar_config) {
                cfg = typeof existing[0].avatar_config === 'string' ? JSON.parse(existing[0].avatar_config) : existing[0].avatar_config;
              }
              cfg.figure = newLook;
              if (newGender) cfg.gender = newGender;
              if (existing.length > 0) {
                await dbPool.query('UPDATE users_data SET avatar_config = ? WHERE user_id = ?', [JSON.stringify(cfg), dbUserId]);
              } else {
                await dbPool.query('INSERT INTO users_data (user_id, avatar_config) VALUES (?, ?)', [dbUserId, JSON.stringify(cfg)]);
              }
            } catch (err) {
              logError('BOBBA', 'DB-Fehler beim Look-Update', { error: err?.message });
            }
          }
          // Allen im Raum den neuen Look mitteilen (User erneut senden)
          if (currentRoomId != null) {
            const room = bobbaRooms.get(currentRoomId);
            if (room) {
              const u = room.users.get(userId);
              if (u) {
                u.look = newLook;
                broadcastToBobbaRoom(currentRoomId, bobbaMsg(BOBBA_SRV.PLAYERS_DATA,
                  1, userId, u.x, u.y, 0, u.rot, bobbaStr(u.name), bobbaStr(newLook), bobbaStr(u.motto)
                ));
              }
            }
          }
          break;
        }

        case BOBBA_OP.REQUEST_CHANGE_MOTTO: {
          if (userId == null || dbUserId == null) break;
          const newMotto = popString();
          userMotto = newMotto;
          logInfo('BOBBA', 'Motto geaendert', { userId, newMotto });
          // In DB persistieren
          if (dbPool) {
            try {
              const [existing] = await dbPool.query('SELECT avatar_config FROM users_data WHERE user_id = ?', [dbUserId]);
              let cfg = {};
              if (existing.length > 0 && existing[0].avatar_config) {
                cfg = typeof existing[0].avatar_config === 'string' ? JSON.parse(existing[0].avatar_config) : existing[0].avatar_config;
              }
              cfg.motto = newMotto;
              if (existing.length > 0) {
                await dbPool.query('UPDATE users_data SET avatar_config = ? WHERE user_id = ?', [JSON.stringify(cfg), dbUserId]);
              } else {
                await dbPool.query('INSERT INTO users_data (user_id, avatar_config) VALUES (?, ?)', [dbUserId, JSON.stringify(cfg)]);
              }
            } catch (err) {
              logError('BOBBA', 'DB-Fehler beim Motto-Update', { error: err?.message });
            }
          }
          // Allen im Raum das neue Motto mitteilen
          if (currentRoomId != null) {
            const room = bobbaRooms.get(currentRoomId);
            if (room) {
              const u = room.users.get(userId);
              if (u) {
                u.motto = newMotto;
                broadcastToBobbaRoom(currentRoomId, bobbaMsg(BOBBA_SRV.PLAYERS_DATA,
                  1, userId, u.x, u.y, 0, u.rot, bobbaStr(u.name), bobbaStr(u.look), bobbaStr(newMotto)
                ));
              }
            }
          }
          break;
        }

        case BOBBA_OP.REQUEST_ITEM_PLACE: {
          if (currentRoomId == null || userId == null || !dbPool || !dbUserId) break;
          const placeItemId = popInt();
          const placeX = popInt();
          const placeY = popInt();
          const placeRot = popInt();
          const room = bobbaRooms.get(currentRoomId);
          if (!room) break;
          if (!room.model.heightMap[placeX] || room.model.heightMap[placeX][placeY] === 0) break;
          const placeZ = room.sqAbsoluteHeight(placeX, placeY);

          try {
            // Inventar-Item aus DB holen (placeItemId = user_inventory.id)
            const [[invItem]] = await dbPool.query(
              'SELECT id, item_code, base_id, item_type FROM user_inventory WHERE id = ? AND user_id = ? AND quantity > 0',
              [placeItemId, dbUserId]
            );
            if (!invItem) { logInfo('BOBBA', 'Place: Item nicht im Inventar', { placeItemId, dbUserId }); break; }

            // In room_items speichern
            const [insertRes] = await dbPool.query(
              `INSERT INTO room_items (room_id, base_id, item_type, item_code, x, y, z, rot, state, owner_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
              [currentRoomId, invItem.base_id, invItem.item_type || 'F', invItem.item_code, placeX, placeY, placeZ, placeRot, dbUserId]
            );
            const newItemId = insertRes.insertId;

            // Aus user_inventory entfernen (quantity - 1, bei 0 loeschen)
            await dbPool.query(
              'UPDATE user_inventory SET quantity = quantity - 1 WHERE id = ? AND user_id = ?',
              [placeItemId, dbUserId]
            );
            await dbPool.query(
              'DELETE FROM user_inventory WHERE id = ? AND user_id = ? AND quantity <= 0',
              [placeItemId, dbUserId]
            );

            // RAM-Item anlegen + Map updaten
            const newItem = { id: newItemId, x: placeX, y: placeY, z: placeZ, rot: placeRot, baseId: invItem.base_id, state: 0, ownerId: userId };
            room.items.push(newItem);
            room.placeItemOnMap(newItem);

            // Allen das neue Item mitteilen
            broadcastToBobbaRoom(currentRoomId, bobbaMsg(BOBBA_SRV.ROOM_ITEM_DATA,
              1, newItemId, placeX, placeY, placeZ, placeRot, invItem.base_id, 0
            ));
            // Item aus Client-Inventar entfernen
            ws.send(bobbaMsg(BOBBA_SRV.INVENTORY_ITEM_REMOVE, placeItemId));
            logInfo('BOBBA', 'Item platziert (DB)', { userId, roomItemId: newItemId, baseId: invItem.base_id, x: placeX, y: placeY });
          } catch (err) {
            logError('BOBBA', 'Fehler beim Platzieren', { error: err?.message, placeItemId });
          }
          break;
        }

        case BOBBA_OP.REQUEST_ITEM_MOVE: {
          if (currentRoomId == null || userId == null) break;
          const moveItemId = popInt();
          const moveX = popInt();
          const moveY = popInt();
          const moveRot = popInt();
          const room = bobbaRooms.get(currentRoomId);
          if (!room) break;
          const movingItem = room.items.find(i => i.id === moveItemId);
          if (!movingItem) break;
          if (!room.model.heightMap[moveX] || room.model.heightMap[moveX][moveY] === 0) break;
          room.removeItemFromMap(movingItem);
          movingItem.x = moveX;
          movingItem.y = moveY;
          movingItem.z = room.sqAbsoluteHeight(moveX, moveY);
          movingItem.rot = moveRot;
          room.placeItemOnMap(movingItem);
          // Position in DB updaten
          if (dbPool) {
            dbPool.query('UPDATE room_items SET x = ?, y = ?, z = ?, rot = ? WHERE id = ?',
              [moveX, moveY, movingItem.z, moveRot, moveItemId]
            ).catch(err => logError('BOBBA', 'Fehler beim Verschieben (DB)', { error: err?.message }));
          }
          // Allen die neue Position mitteilen (Item-Daten erneut senden)
          broadcastToBobbaRoom(currentRoomId, bobbaMsg(BOBBA_SRV.ROOM_ITEM_DATA,
            1, moveItemId, movingItem.x, movingItem.y, movingItem.z, movingItem.rot, movingItem.baseId, movingItem.state
          ));
          logInfo('BOBBA', 'Item verschoben', { userId, itemId: moveItemId, x: moveX, y: moveY });
          break;
        }

        case BOBBA_OP.REQUEST_ITEM_PICK_UP: {
          if (currentRoomId == null || userId == null || !dbPool || !dbUserId) break;
          const pickUpItemId = popInt();
          const room = bobbaRooms.get(currentRoomId);
          if (!room) break;
          const pickIndex = room.items.findIndex(i => i.id === pickUpItemId);
          if (pickIndex === -1) break;

          try {
            // Room-Item aus DB holen
            const [[roomItem]] = await dbPool.query(
              'SELECT id, base_id, item_type, item_code FROM room_items WHERE id = ? AND room_id = ?',
              [pickUpItemId, currentRoomId]
            );
            if (roomItem) {
              // Zurueck in user_inventory legen
              await dbPool.query(
                `INSERT INTO user_inventory (user_id, item_code, base_id, item_type, quantity)
                 VALUES (?, ?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE quantity = quantity + 1`,
                [dbUserId, roomItem.item_code, roomItem.base_id, roomItem.item_type || 'F']
              );
              // Aus room_items loeschen
              await dbPool.query('DELETE FROM room_items WHERE id = ?', [pickUpItemId]);

              // Inventar-Update an Client senden (neues Item)
              const [[invRow]] = await dbPool.query(
                'SELECT id, base_id, item_type FROM user_inventory WHERE user_id = ? AND item_code = ? LIMIT 1',
                [dbUserId, roomItem.item_code]
              );
              if (invRow) {
                ws.send(bobbaMsg(BOBBA_SRV.INVENTORY_ITEMS, 1,
                  invRow.id, bobbaStr(invRow.item_type || 'F'), invRow.base_id, 0, 1
                ));
              }
            }
          } catch (err) {
            logError('BOBBA', 'Fehler beim Aufheben (DB)', { error: err?.message, pickUpItemId });
          }

          // Aus RAM + Map entfernen
          room.removeItemFromMap(room.items[pickIndex]);
          room.items.splice(pickIndex, 1);
          broadcastToBobbaRoom(currentRoomId, bobbaMsg(BOBBA_SRV.ITEM_REMOVE, pickUpItemId));
          logInfo('BOBBA', 'Item aufgehoben (DB)', { userId, itemId: pickUpItemId });
          break;
        }

        case BOBBA_OP.REQUEST_NAVIGATOR_POPULAR_ROOMS: {
          // Liste der Bobba-Rooms aus DB senden
          const roomList = Array.from(bobbaDbRooms.values());
          if (roomList.length > 0) {
            let msg = `${BOBBA_SRV.NAVIGATOR_ROOM_LIST}${SEP}${roomList.length}`;
            for (const r of roomList) {
              // Aktuelle Spieleranzahl aus dem aktiven BobbaRoom holen
              const activeRoom = bobbaRooms.get(r.id);
              const userCount = activeRoom ? activeRoom.users.size : 0;
              // Format wie Original serializeRoomData: id|name|owner|description|lockType|userCount|capacity
              msg += `${SEP}${r.id}${SEP}${bobbaStr(r.name)}${SEP}${bobbaStr(r.owner)}${SEP}${bobbaStr(r.description)}${SEP}${r.lockType}${SEP}${userCount}${SEP}${r.capacity}`;
            }
            ws.send(msg);
          } else {
            // Fallback wenn keine DB-Rooms vorhanden
            ws.send(bobbaMsg(BOBBA_SRV.NAVIGATOR_ROOM_LIST, 1,
              1, bobbaStr('Lobby'), bobbaStr('Server'), bobbaStr('Willkommen!'), 0, 0, 25));
          }
          break;
        }

        case BOBBA_OP.REQUEST_NAVIGATOR_GO_TO_ROOM: {
          // Wie Original: RequestNavigatorGoToRoom → RoomManager.prepareRoomForUser
          const targetRoomId = popInt();
          if (userId == null) break;

          // Alten Raum verlassen (wenn vorhanden)
          if (currentRoomId != null) {
            leaveBobbaRoom(ws, userId);
          }

          // roomId == -1 bedeutet "Home Room" → ersten verfuegbaren Raum (= Raum 1)
          // Wie Original: if (roomId == -1 && rooms.size() > 0) newRoom = rooms.get(0)
          const roomId = (targetRoomId === -1) ? 1 : targetRoomId;
          if (roomId <= 0) break;

          // prepareRoomForUser: loadingRoomId setzen und MODEL_INFO senden
          loadingRoomId = roomId;
          await getBobbaRoom(roomId); // Raum erstellen falls er noch nicht existiert
          const dbRoomInfo = bobbaDbRooms.get(roomId);
          const modelIdStr = (dbRoomInfo && dbRoomInfo.modelId) ? dbRoomInfo.modelId : 'model_a';
          ws.send(bobbaMsg(BOBBA_SRV.ROOM_DATA_MODEL_INFO, bobbaStr(modelIdStr), roomId));

          logInfo('BOBBA', 'prepareRoomForUser (GoToRoom)', { userId, targetRoomId, resolvedRoomId: roomId });
          break;
        }

        case BOBBA_OP.REQUEST_NAVIGATOR_LEAVE_ROOM: {
          leaveBobbaRoom(ws, userId);
          ws.send(bobbaMsg(BOBBA_SRV.NAVIGATOR_LEAVE_ROOM));
          break;
        }

        case BOBBA_OP.REQUEST_INVENTORY_ITEMS: {
          if (!dbPool || !dbUserId) {
            ws.send(bobbaMsg(BOBBA_SRV.INVENTORY_ITEMS, 0));
            break;
          }
          try {
            const [items] = await dbPool.query(
              `SELECT id, item_code, base_id, item_type, quantity
               FROM user_inventory
               WHERE user_id = ? AND quantity > 0 AND base_id > 0
               ORDER BY updated_at DESC`,
              [dbUserId]
            );
            let msg = `${BOBBA_SRV.INVENTORY_ITEMS}${SEP}${items.length}`;
            for (const item of items) {
              const type = item.item_type || 'F';
              msg += `${SEP}${item.id}${SEP}${bobbaStr(type)}${SEP}${item.base_id}${SEP}0${SEP}1`;
            }
            ws.send(msg);
            logInfo('BOBBA', 'Inventar gesendet', { count: items.length, dbUserId });
          } catch (err) {
            logError('BOBBA', 'Fehler beim Laden des Inventars', { error: err?.message });
            ws.send(bobbaMsg(BOBBA_SRV.INVENTORY_ITEMS, 0));
          }
          break;
        }

        case BOBBA_OP.REQUEST_ITEM_INTERACT: {
          if (currentRoomId == null) break;
          const itemId = popInt();
          const room = bobbaRooms.get(currentRoomId);
          if (!room) break;
          const item = room.items.find(i => i.id === itemId);
          if (!item) break;
          item.state = item.state === 0 ? 1 : 0;
          broadcastToBobbaRoom(currentRoomId, bobbaMsg(BOBBA_SRV.ITEM_STATE, itemId, item.state));
          break;
        }

        case BOBBA_OP.REQUEST_CATALOGUE_INDEX: {
          const indexMsg = serializeCatalogueIndex(1); // rank=1 fuer alle
          ws.send(indexMsg);
          break;
        }

        case BOBBA_OP.REQUEST_CATALOGUE_PAGE: {
          const pageId = popInt();
          const page = catalogPages.get(pageId);
          if (page && page.enabled && page.visible) {
            ws.send(serializeCataloguePage(page));
          } else {
            // Leere Seite senden
            ws.send(bobbaMsg(BOBBA_SRV.CATALOGUE_PAGE, pageId, bobbaStr('default_3x3'), bobbaStr(''), bobbaStr(''), bobbaStr(''), bobbaStr(''), bobbaStr(''), bobbaStr(''), 0));
          }
          break;
        }

        case BOBBA_OP.REQUEST_MESSENGER_LOAD_FRIENDS: {
          // Echte Freundesliste aus DB laden
          if (!dbPool || !dbUserId) {
            ws.send(bobbaMsg(BOBBA_SRV.MESSENGER_FRIENDS, 0));
            break;
          }
          try {
            const [friends] = await dbPool.query(
              `SELECT u.id, u.nickname, u.is_online, ud.avatar_config
               FROM user_friends uf
               INNER JOIN users u ON u.id = CASE WHEN uf.user_id = ? THEN uf.friend_id ELSE uf.user_id END
               LEFT JOIN users_data ud ON ud.user_id = u.id
               WHERE (uf.user_id = ? OR uf.friend_id = ?) AND uf.status = 'accepted'
               ORDER BY u.is_online DESC, u.nickname ASC`,
              [dbUserId, dbUserId, dbUserId]
            );
            // Bobba-Protokoll: MESSENGER_FRIENDS (32) | count | [id|name|look|motto|online] ...
            let msg = `${BOBBA_SRV.MESSENGER_FRIENDS}${SEP}${friends.length}`;
            for (const f of friends) {
              const ac = typeof f.avatar_config === 'string' ? JSON.parse(f.avatar_config) : (f.avatar_config || {});
              const look = (ac && ac.figure) ? String(ac.figure) : 'hd-180-1.hr-828-61.ch-210-66.lg-270-82.sh-290-80';
              const motto = (ac && ac.motto) ? String(ac.motto) : '';
              msg += `${SEP}${f.id}${SEP}${bobbaStr(f.nickname || 'Unbekannt')}${SEP}${bobbaStr(look)}${SEP}${bobbaStr(motto)}${SEP}${f.is_online ? 1 : 0}`;
            }
            ws.send(msg);
            logInfo('BOBBA', 'Freundesliste gesendet', { count: friends.length, dbUserId });
          } catch (err) {
            logError('BOBBA', 'Fehler beim Laden der Freundesliste', { error: err?.message });
            ws.send(bobbaMsg(BOBBA_SRV.MESSENGER_FRIENDS, 0));
          }
          break;
        }

        case BOBBA_OP.REQUEST_NAVIGATOR_OWN_ROOMS: {
          // Leere eigene Raum-Liste
          ws.send(bobbaMsg(BOBBA_SRV.NAVIGATOR_ROOM_LIST, 0));
          break;
        }

        case BOBBA_OP.REQUEST_NAVIGATOR_SEARCH_ROOMS: {
          popString(); // Search query ignorieren
          ws.send(bobbaMsg(BOBBA_SRV.NAVIGATOR_ROOM_LIST, 0));
          break;
        }

        case BOBBA_OP.REQUEST_NAVIGATOR_CREATE_ROOM: {
          const newRoomName = popString();
          const newRoomModelId = popString();
          if (!dbPool || !dbUserId || !userId) break;

          // Model validieren
          if (!bobbaDbModels.has(newRoomModelId)) {
            logInfo('BOBBA', 'Create Room: ungueltiges Model', { userId, modelId: newRoomModelId });
            break;
          }

          // Raumname validieren
          const safeName = (newRoomName || '').trim().substring(0, 100);
          if (safeName.length === 0) break;

          try {
            // Username fuer Owner-Feld holen
            const [[ownerRow]] = await dbPool.query('SELECT nickname FROM users WHERE id = ?', [dbUserId]);
            const ownerName = ownerRow?.nickname || `User_${dbUserId}`;

            // Raum in DB anlegen
            const [insertResult] = await dbPool.query(
              'INSERT INTO rooms (name, owner, model_id, is_active) VALUES (?, ?, ?, 1)',
              [safeName, ownerName, newRoomModelId]
            );
            const newRoomId = insertResult.insertId;

            // In den RAM-Cache aufnehmen
            bobbaDbRooms.set(newRoomId, {
              id: newRoomId,
              name: safeName,
              owner: ownerName,
              description: '',
              modelId: newRoomModelId,
              capacity: 25,
              lockType: 0,
            });

            logInfo('BOBBA', 'Raum erstellt', { userId, roomId: newRoomId, name: safeName, modelId: newRoomModelId });

            // Client direkt in den neuen Raum schicken (wie GoToRoom)
            if (currentRoomId != null) {
              leaveBobbaRoom(ws, userId);
            }
            loadingRoomId = newRoomId;
            await getBobbaRoom(newRoomId);
            ws.send(bobbaMsg(BOBBA_SRV.ROOM_DATA_MODEL_INFO, bobbaStr(newRoomModelId), newRoomId));
          } catch (err) {
            logError('BOBBA', 'Fehler beim Erstellen des Raums', { error: err?.message, userId });
          }
          break;
        }

        case BOBBA_OP.REQUEST_NAVIGATOR_MAKE_FAVOURITE: {
          const favRoomId = popInt();
          if (!dbPool || !dbUserId || !favRoomId) break;
          try {
            await dbPool.query(
              'INSERT IGNORE INTO room_favourites (user_id, room_id) VALUES (?, ?)',
              [dbUserId, favRoomId]
            );
            logInfo('BOBBA', 'Raum als Favorit gesetzt', { userId, roomId: favRoomId });
          } catch (err) {
            logError('BOBBA', 'Fehler beim Setzen des Favoriten', { error: err?.message });
          }
          break;
        }

        case BOBBA_OP.REQUEST_NAVIGATOR_REMOVE_FAVOURITE: {
          const unfavRoomId = popInt();
          if (!dbPool || !dbUserId || !unfavRoomId) break;
          try {
            await dbPool.query(
              'DELETE FROM room_favourites WHERE user_id = ? AND room_id = ?',
              [dbUserId, unfavRoomId]
            );
            logInfo('BOBBA', 'Raum-Favorit entfernt', { userId, roomId: unfavRoomId });
          } catch (err) {
            logError('BOBBA', 'Fehler beim Entfernen des Favoriten', { error: err?.message });
          }
          break;
        }

        case BOBBA_OP.REQUEST_CATALOGUE_PURCHASE: {
          const purchasePageId = popInt();
          const purchaseItemId = popInt();
          if (!dbPool || !dbUserId) {
            ws.send(bobbaMsg(BOBBA_SRV.CATALOGUE_PURCHASE_ERROR, 1));
            break;
          }
          const purchasePage = catalogPages.get(purchasePageId);
          if (!purchasePage || !purchasePage.enabled) {
            ws.send(bobbaMsg(BOBBA_SRV.CATALOGUE_PURCHASE_ERROR, 1));
            break;
          }
          const purchaseItem = purchasePage.items.find(i => i.id === purchaseItemId);
          if (!purchaseItem) {
            ws.send(bobbaMsg(BOBBA_SRV.CATALOGUE_PURCHASE_ERROR, 1));
            break;
          }
          try {
            // Credits (Bobba Coins) aus users_data.project_data lesen
            const currentCoins = await getBobbaCoins(dbUserId);
            if (currentCoins < purchaseItem.cost) {
              ws.send(bobbaMsg(BOBBA_SRV.CATALOGUE_PURCHASE_ERROR, 1)); // not enough credits
              break;
            }
            // Coins abziehen
            const newBalance = await addBobbaCoins(dbUserId, -purchaseItem.cost);

            // Item ins Inventar legen (bestehende user_inventory Tabelle)
            const purchaseItemType = purchaseItem.itemType || 'F';
            for (let i = 0; i < purchaseItem.amount; i++) {
              await dbPool.query(
                `INSERT INTO user_inventory (user_id, item_code, base_id, item_type, quantity)
                 VALUES (?, ?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE quantity = quantity + 1`,
                [dbUserId, purchaseItem.name, purchaseItem.baseId, purchaseItemType]
              );
            }

            // Purchase-Info senden (Client zeigt Bestaetigung)
            ws.send(bobbaMsg(BOBBA_SRV.CATALOGUE_PURCHASE_INFO,
              purchaseItem.id,
              bobbaStr(purchaseItem.name),
              purchaseItem.cost,
              bobbaStr(purchaseItemType),
              purchaseItem.spriteId || purchaseItem.baseId
            ));

            // Neuen Kontostand senden
            ws.send(bobbaMsg(BOBBA_SRV.CREDITS_BALANCE, newBalance));

            // Inventar-Update senden: neu gekauftes Item an Client schicken
            const [[boughtRow]] = await dbPool.query(
              `SELECT id, base_id, item_type FROM user_inventory WHERE user_id = ? AND item_code = ? LIMIT 1`,
              [dbUserId, purchaseItem.name]
            );
            if (boughtRow) {
              const bType = boughtRow.item_type || 'F';
              ws.send(bobbaMsg(BOBBA_SRV.INVENTORY_ITEMS, 1,
                boughtRow.id, bobbaStr(bType), boughtRow.base_id, 0, 1
              ));
            }

            logInfo('BOBBA', `Kauf: User ${dbUserId} kaufte ${purchaseItem.name} fuer ${purchaseItem.cost} CHF (Rest: ${newBalance})`);
          } catch (err) {
            logError('BOBBA', 'Fehler beim Katalog-Kauf', { error: err?.message });
            ws.send(bobbaMsg(BOBBA_SRV.CATALOGUE_PURCHASE_ERROR, 1));
          }
          break;
        }

        case BOBBA_OP.REQUEST_MESSENGER_SEARCH_FRIEND: {
          const searchQuery = popString();
          // Leeres Suchergebnis senden
          ws.send(bobbaMsg(BOBBA_SRV.MESSENGER_SEARCH_RESULT, 0));
          break;
        }

        case BOBBA_OP.REQUEST_MESSENGER_SEND_MESSAGE: {
          const msgTargetId = popInt();
          const msgText = popString();
          logInfo('BOBBA', 'Messenger-Nachricht', { from: userId, to: msgTargetId, text: msgText });
          // Nachricht an den Empfaenger weiterleiten (falls online im Bobba)
          for (const [, room] of bobbaRooms) {
            const targetUser = room.users.get(msgTargetId);
            if (targetUser && targetUser.ws && targetUser.ws.readyState === WebSocket.OPEN) {
              targetUser.ws.send(bobbaMsg(BOBBA_SRV.MESSENGER_MESSAGE, userId, bobbaStr(msgText)));
              break;
            }
          }
          break;
        }

        case BOBBA_OP.REQUEST_MESSENGER_ACCEPT_FRIEND:
        case BOBBA_OP.REQUEST_MESSENGER_DENY_FRIEND:
        case BOBBA_OP.REQUEST_MESSENGER_FOLLOW_FRIEND:
        case BOBBA_OP.REQUEST_MESSENGER_REMOVE_FRIEND: {
          // Stub: Freundesanfragen/Follow/Remove noch nicht implementiert
          logInfo('BOBBA', 'Messenger-Aktion (Stub)', { opCode, userId });
          break;
        }

        default:
          logInfo('BOBBA', `Unbekannter OpCode: ${opCode}`, { raw: data.substring(0, 100) });
      }
    } catch (err) {
      logError('BOBBA', 'Nachricht-Fehler', { error: err?.message || String(err) });
    }
  });

  ws.on('close', () => {
    if (currentRoomId != null && userId != null) {
      leaveBobbaRoom(ws, userId);
    }
    logInfo('BOBBA', 'Verbindung geschlossen', { userId, userName });
  });

  // joinBobbaRoom entfernt - User wird jetzt erst in REQUEST_ROOM_DATA zum Raum hinzugefuegt
  // (wie Original: finishRoomLoadingForUser → addUserToRoom)

  function leaveBobbaRoom(wsConn, uid) {
    loadingRoomId = null; // Ladevorgang abbrechen
    if (currentRoomId == null || uid == null) return;
    const room = bobbaRooms.get(currentRoomId);
    if (room) {
      const user = room.users.get(uid);
      if (user) {
        room.removeUserFromMap(user);
        room.users.delete(uid);
      }
      broadcastToBobbaRoom(currentRoomId, bobbaMsg(BOBBA_SRV.PLAYER_REMOVE, uid));
      if (room.users.size === 0) {
        room.stopTick();
        bobbaRooms.delete(currentRoomId);
      }
    }
    logInfo('BOBBA', 'Spieler verlaesst Raum', { userId: uid, roomId: currentRoomId });
    currentRoomId = null;
  }

  async function sendHeightMap(wsConn, roomId) {
    const room = await getBobbaRoom(roomId);
    const model = room.model;
    let msg = `${BOBBA_SRV.ROOM_DATA_HEIGHTMAP}${SEP}${model.maxX}${SEP}${model.maxY}${SEP}${model.doorX}${SEP}${model.doorY}`;
    for (let i = 0; i < model.maxX; i++) {
      for (let j = 0; j < model.maxY; j++) {
        msg += `${SEP}${model.heightMap[i][j]}`;
      }
    }
    wsConn.send(msg);
  }
});

// HTTP Upgrade: Bobba-WS auf /bobba, alles andere geht an Socket.IO
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);
  if (url.pathname === '/bobba') {
    bobbaWss.handleUpgrade(request, socket, head, (ws) => {
      bobbaWss.emit('connection', ws, request);
    });
  }
  // Socket.IO handled sein eigenes Upgrade intern
});

process.on('SIGINT', () => {
  handleShutdownSignal('SIGINT').catch(() => process.exit(1));
});
process.on('SIGTERM', () => {
  handleShutdownSignal('SIGTERM').catch(() => process.exit(1));
});

server.listen(PORT, HOST, () => {
  logInfo('BOOT', 'Serverstart initialisiert');
  logInfo('BOOT', `HTTP Endpoint: http://${HOST}:${PORT}`);
  logInfo('BOOT', `Health Endpoint: http://${HOST}:${PORT}/health`);
  logInfo('BOOT', `WebSocket Endpoint: ws://${HOST}:${PORT}`);
  logInfo('BOOT', `Bobba WS Endpoint: ws://${HOST}:${PORT}/bobba`);
  logInfo('BOOT', `DB aktiv: ${dbPool ? 'ja' : 'nein'}`);
  logInfo('BOOT', `Room-Cache aktiv: idle_unload=${ROOM_CACHE_UNLOAD_IDLE_MS}ms, flush_interval=${ROOM_CACHE_FLUSH_INTERVAL_MS}ms`);
  logInfo('BOOT', `Buenzli Events: ${BUENZLI_EVENTS_ENABLED ? 'AKTIV' : 'DEAKTIVIERT'}`);
  if (dbPool) {
    (async () => {
      const results = [];
      results.push(await runStartupTask('Municipality is_user_created Spalte', async () => {
        await ensureMunicipalityIsUserCreatedColumn();
      }));
      results.push(await runStartupTask('Rollen-Tabellen (municipality_memberships)', async () => {
        await ensureMunicipalityRoleTables();
      }));
      results.push(await runStartupTask('Globale Rollen-Sync (rank -> global_role)', async () => {
        await ensureAtLeastOneGlobalAdministrator();
      }));
      results.push(await runStartupTask('Chat-Tabellen (municipality_chat_messages, municipality_chat_logs)', async () => {
        await ensureMunicipalityChatTables();
      }));
      results.push(await runStartupTask('User-Daten-Tabelle (users_data)', async () => {
        await ensureUsersDataTable();
      }));
      results.push(await runStartupTask('User-Inventar-Tabelle (user_inventory)', async () => {
        await ensureUserInventoryTable();
      }));
      results.push(await runStartupTask('Wappen-Tabelle (municipality_coat_of_arms)', async () => {
        await ensureMunicipalityCoatOfArmsTable();
        ensureCoatOfArmsUploadDir();
        ensureMinimapUploadDir();
      }));
      results.push(await runStartupTask('Achievement-Tabellen + Seed', async () => {
        await ensureAchievementTables();
        await seedAchievementsCatalog();
      }));

      // Beim Serverstart alle player_counts auf 0 setzen (keine WS-Verbindungen existieren)
      results.push(await runStartupTask('Player-Counts auf 0 zuruecksetzen', async () => {
        await dbPool.query(`UPDATE game_rooms SET player_count = 0 WHERE player_count > 0`);
        logInfo('BOOT', 'Alle player_counts auf 0 zurueckgesetzt');
      }));

      results.push(await runStartupTask('Bobba Room-Models + Rooms laden', async () => {
        await loadBobbaRoomModelsFromDb();
      }));

      results.push(await runStartupTask('Furniture-Daten Cache', async () => {
        await loadFurniDataCache();
      }));

      results.push(await runStartupTask('Katalog laden', async () => {
        await loadCatalogFromDb();
      }));

      results.push(await runStartupTask('Wetter-Service starten (Open-Meteo CH)', async () => {
        const { startWeatherUpdater } = require('./game/weather');
        startWeatherUpdater();
      }));

      const okCount = results.filter((entry) => entry.ok).length;
      const failed = results.filter((entry) => !entry.ok).map((entry) => entry.name);
      logInfo('BOOT', `Startup abgeschlossen: ${okCount}/${results.length} Schritte erfolgreich`);
      if (failed.length > 0) {
        logWarn('BOOT', 'Folgende Startschritte sind fehlgeschlagen', { failed });
      }
    })().catch((err) => {
      logError('BOOT', 'Unerwarteter Fehler im Startup-Prozess', { error: err?.message || String(err) });
    });
  }
});
