'use strict';

const https = require('https');
const { dbPool } = require('../infra/db');
const { logWarn, logError } = require('../infra/logger');

// ─── Swiss city sources ──────────────────────────────────────────────────

const CITIES = [
  { name: 'Bern',   lat: 46.9481, lon: 7.4474 },
  { name: 'Zürich', lat: 47.3769, lon: 8.5417 },
  { name: 'Basel',  lat: 47.5596, lon: 7.5886 },
];

const FETCH_URL = (lat, lon) =>
  `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;

const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MEMORY_CACHE_MS     = 60 * 1000;       // read DB max once per minute

// ─── WMO code → game weather type mapping ────────────────────────────────

const WMO_MAP = {
  0:  { type: 'clear',        intensity: 0.0 },
  1:  { type: 'clear',        intensity: 0.1 },
  2:  { type: 'clear',        intensity: 0.2 },
  3:  { type: 'fog',          intensity: 0.2 },
  45: { type: 'fog',          intensity: 0.6 },
  48: { type: 'fog',          intensity: 0.8 },
  51: { type: 'drizzle',      intensity: 0.3 },
  53: { type: 'drizzle',      intensity: 0.5 },
  55: { type: 'drizzle',      intensity: 0.7 },
  56: { type: 'drizzle',      intensity: 0.5 },
  57: { type: 'drizzle',      intensity: 0.7 },
  61: { type: 'rain',         intensity: 0.4 },
  63: { type: 'rain',         intensity: 0.6 },
  65: { type: 'storm',        intensity: 0.8 },
  66: { type: 'rain',         intensity: 0.5 },
  67: { type: 'storm',        intensity: 0.7 },
  71: { type: 'snow',         intensity: 0.4 },
  73: { type: 'snow',         intensity: 0.6 },
  75: { type: 'blizzard',     intensity: 0.8 },
  77: { type: 'snow',         intensity: 0.5 },
  80: { type: 'rain',         intensity: 0.5 },
  81: { type: 'rain',         intensity: 0.7 },
  82: { type: 'storm',        intensity: 0.9 },
  85: { type: 'snow',         intensity: 0.6 },
  86: { type: 'blizzard',     intensity: 0.9 },
  95: { type: 'thunderstorm', intensity: 0.8 },
  96: { type: 'thunderstorm', intensity: 0.9 },
  99: { type: 'thunderstorm', intensity: 1.0 },
};

const TYPE_SEVERITY = {
  clear: 0, fog: 1, drizzle: 2, rain: 3,
  snow: 4, storm: 5, blizzard: 6, thunderstorm: 7,
};

const FALLBACK_WEATHER = {
  type: 'clear', intensity: 0, temperature: 5.0,
  temperature_min: 5.0, temperature_max: 5.0,
  windspeed: 0, winddirection: 225, is_day: 1, wmo_codes: [0], source_cities: [],
};

// ─── In-memory cache (fast reads, populated from DB) ─────────────────────

let _memCache = null;   // { weather, loadedAt }
let _refreshing = false;
let _intervalHandle = null;

// ─── HTTPS GET (works on all Node.js versions) ──────────────────────────

function httpsGetJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Fetch from Open-Meteo ──────────────────────────────────────────────

async function fetchCityWeather(city) {
  const json = await httpsGetJson(FETCH_URL(city.lat, city.lon));
  const cw = json.current_weather;
  if (!cw) throw new Error(`${city.name}: no current_weather`);
  return {
    city: city.name,
    temperature: cw.temperature,
    windspeed: cw.windspeed,
    winddirection: cw.winddirection,
    weathercode: cw.weathercode,
    is_day: cw.is_day,
  };
}

function mapWmo(code) {
  return WMO_MAP[code] || { type: 'clear', intensity: 0 };
}

function averageWindDirection(directions) {
  let sinSum = 0, cosSum = 0;
  for (const d of directions) {
    const rad = d * Math.PI / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
  }
  let avg = Math.atan2(sinSum / directions.length, cosSum / directions.length) * 180 / Math.PI;
  if (avg < 0) avg += 360;
  return Math.round(avg);
}

function combineCities(results) {
  const temps = results.map(r => r.temperature);
  const winds = results.map(r => r.windspeed);
  const windDirs = results.map(r => r.winddirection);
  const codes = results.map(r => r.weathercode);

  let dominantType = 'clear';
  let dominantIntensity = 0;
  for (const code of codes) {
    const mapped = mapWmo(code);
    const sev = TYPE_SEVERITY[mapped.type] ?? 0;
    const domSev = TYPE_SEVERITY[dominantType] ?? 0;
    if (sev > domSev || (sev === domSev && mapped.intensity > dominantIntensity)) {
      dominantType = mapped.type;
      dominantIntensity = mapped.intensity;
    }
  }

  const minTemp = Math.min(...temps);
  const maxTemp = Math.max(...temps);
  const temperature = +(minTemp + Math.random() * (maxTemp - minTemp)).toFixed(1);
  const avgWind = +(winds.reduce((a, b) => a + b, 0) / winds.length).toFixed(1);
  const avgDir = averageWindDirection(windDirs);

  return {
    type: dominantType,
    intensity: dominantIntensity,
    temperature,
    temperature_min: minTemp,
    temperature_max: maxTemp,
    windspeed: avgWind,
    winddirection: avgDir,
    is_day: results[0].is_day,
    wmo_codes: codes,
    source_cities: results.map(r => ({
      city: r.city, temperature: r.temperature,
      windspeed: r.windspeed, winddirection: r.winddirection, weathercode: r.weathercode,
    })),
  };
}

// ─── DB operations ──────────────────────────────────────────────────────

async function saveWeatherToDb(weather) {
  if (!dbPool) return;
  try {
    await dbPool.query(
      `INSERT INTO game_weather (id, weather_data, fetched_at)
       VALUES (1, ?, NOW())
       ON DUPLICATE KEY UPDATE weather_data = VALUES(weather_data), fetched_at = NOW()`,
      [JSON.stringify(weather)]
    );
  } catch (err) {
    logError('WEATHER', 'DB-Speichern fehlgeschlagen', { error: err.message });
  }
}

async function loadWeatherFromDb() {
  if (!dbPool) return null;
  try {
    const [rows] = await dbPool.query(
      'SELECT weather_data, fetched_at FROM game_weather WHERE id = 1 LIMIT 1'
    );
    if (!rows[0]) return null;
    const data = typeof rows[0].weather_data === 'string'
      ? JSON.parse(rows[0].weather_data)
      : rows[0].weather_data;
    return data;
  } catch (err) {
    logError('WEATHER', 'DB-Laden fehlgeschlagen', { error: err.message });
    return null;
  }
}

// ─── Refresh: fetch from API → save to DB → update memory ──────────────

async function refreshWeather() {
  if (_refreshing) return;
  _refreshing = true;

  try {
    const results = [];
    const errors = [];

    await Promise.allSettled(
      CITIES.map(async (city) => {
        try { results.push(await fetchCityWeather(city)); }
        catch (err) { errors.push({ city: city.name, error: err.message }); }
      })
    );

    if (errors.length > 0) {
      logWarn('WEATHER', 'Einige Städte fehlgeschlagen', { errors });
    }

    if (results.length === 0) {
      logError('WEATHER', 'Alle 3 Städte fehlgeschlagen');
      return;
    }

    const weather = combineCities(results);

    // Save to DB
    await saveWeatherToDb(weather);

    // Update memory cache
    _memCache = { weather, loadedAt: Date.now() };

  } catch (err) {
    logError('WEATHER', 'Refresh fehlgeschlagen', { error: err.message });
  } finally {
    _refreshing = false;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

function getWeatherSync() {
  // Return memory cache if fresh
  if (_memCache && (Date.now() - _memCache.loadedAt) < MEMORY_CACHE_MS) {
    return _memCache.weather;
  }
  // Trigger background reload from DB
  _loadFromDbBackground();
  // Return stale cache or fallback
  return _memCache?.weather || FALLBACK_WEATHER;
}

async function getWeather() {
  if (_memCache && (Date.now() - _memCache.loadedAt) < MEMORY_CACHE_MS) {
    return _memCache.weather;
  }
  const fromDb = await loadWeatherFromDb();
  if (fromDb) {
    _memCache = { weather: fromDb, loadedAt: Date.now() };
    return fromDb;
  }
  return _memCache?.weather || FALLBACK_WEATHER;
}

let _dbLoadInFlight = false;
function _loadFromDbBackground() {
  if (_dbLoadInFlight) return;
  _dbLoadInFlight = true;
  loadWeatherFromDb()
    .then((data) => {
      if (data) _memCache = { weather: data, loadedAt: Date.now() };
    })
    .catch(() => {})
    .finally(() => { _dbLoadInFlight = false; });
}

// ─── Start background refresh interval ──────────────────────────────────

function startWeatherUpdater() {
  // Load from DB immediately on start
  loadWeatherFromDb()
    .then((data) => {
      if (data) {
        _memCache = { weather: data, loadedAt: Date.now() };
      }
    })
    .catch(() => {})
    .then(() => refreshWeather())
    .catch(() => {});

  // Refresh every 15 minutes
  if (_intervalHandle) clearInterval(_intervalHandle);
  _intervalHandle = setInterval(() => {
    refreshWeather().catch(() => {});
  }, REFRESH_INTERVAL_MS);

}

function stopWeatherUpdater() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

module.exports = {
  getWeather,
  getWeatherSync,
  refreshWeather,
  startWeatherUpdater,
  stopWeatherUpdater,
  loadWeatherFromDb,
};
