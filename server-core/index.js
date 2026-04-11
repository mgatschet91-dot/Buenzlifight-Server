'use strict';

const http = require('http');
const { HOST, PORT, BUENZLI_EVENTS_ENABLED, ROOM_CACHE_UNLOAD_IDLE_MS, ROOM_CACHE_FLUSH_INTERVAL_MS } = require('./config/constants');
const { logInfo, logWarn, logError, runStartupTask } = require('./infra/logger');
const { dbPool } = require('./infra/db');

// HTTP
const { createRequestHandler } = require('./http/handler');

// WebSocket
const { createSocketIOServer } = require('./ws/socketio/index');

// Migrations
const { runPendingMigrations } = require('./infra/migrate');

// Game services (for startup tasks)
const municipality = require('./game/municipality');
const achievements = require('./game/achievements');
const building = require('./game/building');
const auth = require('./auth/middleware');
const { startWeatherUpdater } = require('./game/weather');

// Jobs
const { registerIntervals } = require('./jobs/intervals');
const { registerShutdownHandlers } = require('./jobs/shutdown');

// ─── Bootstrap ──────────────────────────────────────────────────

// Shared deps object – io gets assigned after Socket.IO is created
const deps = { io: null };

const server = http.createServer(createRequestHandler(deps));

deps.io = createSocketIOServer(server);

const intervals = registerIntervals(deps);
registerShutdownHandlers(server, intervals);

// ─── Start ──────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  logInfo('BOOT', 'Serverstart initialisiert');
  logInfo('BOOT', `HTTP Endpoint: http://${HOST}:${PORT}`);
  logInfo('BOOT', `Health Endpoint: http://${HOST}:${PORT}/health`);
  logInfo('BOOT', `WebSocket Endpoint: ws://${HOST}:${PORT}`);
  logInfo('BOOT', `DB aktiv: ${dbPool ? 'ja' : 'nein'}`);
  logInfo('BOOT', `Room-Cache aktiv: idle_unload=${ROOM_CACHE_UNLOAD_IDLE_MS}ms, flush_interval=${ROOM_CACHE_FLUSH_INTERVAL_MS}ms`);
  logInfo('BOOT', `Buenzli Events: ${BUENZLI_EVENTS_ENABLED ? 'AKTIV' : 'DEAKTIVIERT'}`);

  if (dbPool) {
    (async () => {
      const results = [];

      results.push(await runStartupTask('DB-Migrationen ausfuehren', async () => {
        const migResult = await runPendingMigrations();
        if (migResult.applied > 0) {
          logInfo('BOOT', `${migResult.applied} Migration(en) ausgefuehrt, ${migResult.skipped} uebersprungen`);
        } else {
          logInfo('BOOT', `Alle ${migResult.total} Migrationen bereits ausgefuehrt`);
        }
        if (migResult.errors > 0) {
          throw new Error(`${migResult.errors} Migration(en) fehlgeschlagen`);
        }
      }));
      results.push(await runStartupTask('Globale Rollen-Sync (rank -> global_role)', async () => {
        await auth.ensureAtLeastOneGlobalAdministrator();
      }));
      results.push(await runStartupTask('Upload-Verzeichnisse erstellen', async () => {
        municipality.ensureCoatOfArmsUploadDir();
        municipality.ensureMinimapUploadDir();
      }));
      results.push(await runStartupTask('Achievement-Seed', async () => {
        await achievements.seedAchievementsCatalog();
      }));
      results.push(await runStartupTask('Building-Stats-Seed (DB)', async () => {
        const result = await building.seedBuildingStatsToDb();
        if (result.skipped) {
          logWarn('BOOT', 'Building-Stats-Seed übersprungen: Migration 069 noch nicht gelaufen');
        } else {
          logInfo('BOOT', `Building-Stats in DB aktualisiert: ${result.seeded} Einträge`);
        }
      }));
      results.push(await runStartupTask('Player-Counts auf 0 zurücksetzen', async () => {
        await dbPool.query(`UPDATE game_rooms SET player_count = 0 WHERE player_count > 0`);
        logInfo('BOOT', 'Alle player_counts auf 0 zurückgesetzt');
      }));
      results.push(await runStartupTask('Wetter-Service starten (Open-Meteo CH)', async () => {
        startWeatherUpdater();
      }));

      // Cache-Logs: Zusammenfassung geladener Daten
      results.push(await runStartupTask('Cache-Uebersicht loggen', async () => {
        const [[municipalities]] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM municipalities`);
        const [[items]] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM game_item_details WHERE is_active = 1`);
        const [[rooms]] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM game_rooms`);
        const [[users]] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM users`);
        const [[events]] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM municipality_events WHERE status IN ('active','reported')`);
        const [[companies]] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM companies`);
        logInfo('CACHE', `Gemeinden: ${municipalities.cnt} | Items: ${items.cnt} | Rooms: ${rooms.cnt} | Users: ${users.cnt} | Events: ${events.cnt} | Firmen: ${companies.cnt}`);
      }));

      const okCount = results.filter(e => e.ok).length;
      const failed = results.filter(e => !e.ok).map(e => e.name);
      logInfo('BOOT', `Startup abgeschlossen: ${okCount}/${results.length} Schritte erfolgreich`);
      if (failed.length > 0) {
        logWarn('BOOT', 'Folgende Startschritte sind fehlgeschlagen', { failed });
      }
    })().catch((err) => {
      logError('BOOT', 'Unerwarteter Fehler im Startup-Prozess', { error: err?.message || String(err) });
    });
  }
});
