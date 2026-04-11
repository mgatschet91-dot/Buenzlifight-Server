# Server-Core Architektur

> Zuletzt aktualisiert: 2026-02-18

## Verzeichnisstruktur

```
server-core/
├── index.js                  # Entry Point – Bootstrap, HTTP + WS Server
├── server.js                 # Legacy-Monolith (nicht mehr aktiv)
├── migrate.js                # CLI: Migrationen ausführen
├── migrate-single.js         # CLI: Einzelne Migration ausführen
├── config.cfg                # Konfiguration (DB, JWT, CORS, etc.)
│
├── config/
│   ├── constants.js          # Alle Server-Konstanten
│   └── loadConfig.js         # config.cfg Parser
│
├── infra/
│   ├── db.js                 # MySQL Pool + ensureDbEnabled()
│   ├── logger.js             # Log-Funktionen + runStartupTask()
│   ├── http.js               # sendJson, readJsonBody, getBearerToken
│   └── cors.js               # CORS Origin + Header
│
├── auth/
│   ├── middleware.js          # User-Auflösung, Sessions, Admin-Sync
│   ├── permissions.js         # Rollen-Prüfungen (Build, Manage, Invite)
│   └── tokens.js             # JWT Sign/Verify, Passwort-Hashing
│
├── http/
│   ├── handler.js            # Alle HTTP-Routen (5900+ Zeilen)
│   └── router.js             # Router-Klasse (Method + Pattern Matching)
│
├── game/
│   ├── achievements.js       # Achievements: Seed, Progress, Claim
│   ├── building.js           # Item-Details, Katalog, Bauzeiten
│   ├── buenzli.js            # Buenzli-Events, Inspektionen, Reports
│   ├── disasters.js          # Feuer, Katastrophen, Upgrade-Ticks
│   ├── map.js                # Karte: Load/Save, Wasser, Server-Map
│   ├── municipality.js       # Gemeinden, Mitglieder, Wappen, Chat, Inventar
│   ├── notifications.js      # Benachrichtigungen + Discord
│   ├── partnerships.js       # Partnerschaften CRUD
│   ├── rooms.js              # Room-Cache, Stats, Items, Geld, Sync
│   ├── stats.js              # Population/Jobs Berechnung, Meilensteine
│   └── xp.js                 # XP-System, Level, Login-Streak
│
├── shared/
│   ├── helpers.js            # Validierung, JSON, RNG, Normalisierung
│   └── discord.js            # Discord-Webhook
│
├── jobs/
│   ├── intervals.js          # Periodische Jobs (Flush, Disaster, Buenzli)
│   └── shutdown.js           # Graceful Shutdown
│
├── ws/
│   ├── socketio/
│   │   ├── index.js          # Socket.IO Server + Event-Handler (Skeleton)
│   │   └── helpers.js        # Room-Keys, Avatar, Emit-Helpers
│   └── bobba/
│       └── index.js          # Bobba WS: Login, Movement, Chat, Katalog
│
└── sql/                      # SQL-Migrationen (001-043 + Seed-Dateien)
```

---

## Bootstrap-Flow (index.js)

```
1. Constants + Infra laden
2. HTTP Server erstellen → createRequestHandler(deps)
3. Socket.IO Server erstellen → deps.io
4. Bobba WS Server erstellen
5. Intervalle registrieren (Room-Flush, Disaster, Buenzli, Stats)
6. Shutdown-Handler registrieren (SIGINT/SIGTERM)
7. server.listen()
8. Startup-Tasks (wenn DB aktiv):
   ├── Globale Rollen-Sync
   ├── Upload-Verzeichnisse erstellen
   ├── Achievement-Seed
   ├── Player-Counts zurücksetzen
   ├── Bobba Room-Models laden
   ├── Furniture-Cache laden
   └── Katalog laden
```

---

## Module im Detail

### config/constants.js
| Konstante | Beschreibung |
|-----------|-------------|
| `HOST`, `PORT` | Server Bind-Adresse |
| `JWT_SECRET`, `TOKEN_TTL_HOURS` | Auth-Token Konfiguration |
| `DB_*` | Datenbank-Verbindung |
| `CORS_ALLOWED_ORIGINS` | Erlaubte Origins |
| `SERVICE_UPGRADE_TOOLS` | Set: Buildings mit manuellem Upgrade |
| `HARD_CODED_BUILDING_STATS` | Map: Building → {maxPop, maxJobs, pollution} |
| `DEFAULT_ACHIEVEMENTS` | Achievement-Definitionen |
| `POPULATION_MILESTONES` | Bevölkerungs-Meilensteine + Bonus |
| `MUNICIPALITY_ROLE_*` | Rollen-Konstanten |
| `GLOBAL_ROLE_*` | Globale Rollen |
| `BUENZLI_*` | Buenzli-Event Konfiguration |
| `XP_LEVEL_CAP`, `XP_DAILY_LOGIN` | XP-System |

### infra/ – Infrastruktur

| Datei | Exports | Zweck |
|-------|---------|-------|
| `db.js` | `dbPool`, `ensureDbEnabled` | MySQL Connection Pool |
| `logger.js` | `logInfo`, `logWarn`, `logError`, `runStartupTask` | Logging mit Timestamp |
| `http.js` | `sendJson`, `readJsonBody`, `getBearerToken` | HTTP Request/Response Helpers |
| `cors.js` | `resolveCorsOrigin`, `applyCorsHeaders` | CORS-Handling |

### auth/ – Authentifizierung

| Datei | Exports | Zweck |
|-------|---------|-------|
| `middleware.js` | `getAuthenticatedUser`, `createAuthSession`, `ensureAtLeastOneGlobalAdministrator`, ... | User aus Request auflösen, Sessions |
| `permissions.js` | `canBuildInMunicipality`, `canManageMunicipality`, `normalizeGlobalRole`, ... | Berechtigungsprüfungen |
| `tokens.js` | `signToken`, `verifyToken`, `hashPassword`, `createPasswordData` | JWT + Krypto |

### game/ – Spiellogik

| Datei | Exports | Zweck |
|-------|---------|-------|
| `rooms.js` | `getRoomItemRows`, `saveRoomStats`, `loadRoomStats`, `syncRoomItems`, `getMunicipalityMoney`, `addMunicipalityMoney`, `flushAllRoomRuntimeEntries`, ... | Room-Cache, Stats, Items, Geld |
| `stats.js` | `recomputeAuthoritativePopulationAndJobs`, `checkAndAwardMilestones` | Server-autoritative Stats-Berechnung |
| `building.js` | `inferCategoryFromTool`, `estimateBuildingBaseStats`, `fetchItemDetails`, `ensureItemDetailExists`, `fetchCatalogPages`, ... | Building-Katalog + Tool-Erkennung |
| `municipality.js` | `getMunicipalityBySlug`, `getUserMunicipalityRole`, `getUserAvatarConfig`, `upsertUserInventoryItem`, ... | Gemeinden, Chat, Wappen, Inventar |
| `map.js` | `getGameMapForMunicipality`, `refreshGameDataMapFromItems`, `ensureServerGeneratedRoomMap`, ... | Karten-Verwaltung |
| `disasters.js` | `runServerDisasterTick`, `runServerBuildingUpgradeTick`, `triggerManualDisaster`, `buildRoomGrid`, ... | Katastrophen + Auto-Upgrade |
| `achievements.js` | `seedAchievementsCatalog`, `syncUserAchievements`, `claimAchievementForUser` | Achievements |
| `buenzli.js` | `runBuenzliEventTick`, `reportBuenzliEvent`, `resolveBuenzliEvent`, ... | Buenzli-Events |
| `partnerships.js` | `upsertPartnership`, `listPartnershipRows`, `toPartnershipDto`, ... | Partnerschaften |
| `notifications.js` | `createUserNotification`, `createNotificationForAllMembers` | Benachrichtigungen |
| `xp.js` | `getUserXp`, `awardXp`, `processDailyLogin`, `xpForLevel` | XP + Level |

### http/handler.js – HTTP-Routen

Die zentrale Datei für alle API-Endpoints. Wichtige Routen-Gruppen:

| Pfad-Prefix | Beschreibung |
|-------------|-------------|
| `/health` | Health-Check |
| `/api/municipalities` | Gemeinden-Liste, Suche |
| `/api/game/municipality/:slug/*` | Gemeinde-spezifisch (Stats, Items, Coat of Arms) |
| `/api/game/items/:slug/:room/*` | Item-Sync, Import, Delete |
| `/api/game/map/:slug/:room` | Karten-Daten |
| `/api/auth/*` | Login, Register, Me, Logout |
| `/api/partnerships/*` | Partnerschaften |
| `/api/achievements/*` | Achievements |
| `/api/xp/*` | XP + Level |
| `/api/notifications/*` | Benachrichtigungen |
| `/api/buenzli/*` | Buenzli-Events |
| `/api/marketplace/*` | Marktplatz / Handel |
| `/api/admin/*` | Admin-Endpoints |

Zusätzlich definiert `handler.js` lokale Helper:
- `fetchRivers` – Fluss-Daten laden
- `hasAdjacentWaterForFootprint` – Wasser-Nachbar-Check
- `markItemsConstructed` – Bau-Fortschritt + Upgrades verarbeiten
- `processConstructionSyncAndBroadcast` – Construction-Sync + Stats-Recompute
- `wsPublishAuthoritativeStats` – Stats an alle Clients broadcasten

### ws/ – WebSocket

| Datei | Exports | Zweck |
|-------|---------|-------|
| `socketio/index.js` | `createSocketIOServer`, `wsRoomPlayers`, `wsRoomMetadata`, ... | Socket.IO: Join, Delta, Stats, Upgrade, Chat |
| `socketio/helpers.js` | `wsRoomKey`, `wsSanitizeAvatarConfig`, `wsEmitToUser`, ... | Room-Keys, Sanitization, Emit |
| `bobba/index.js` | `createBobbaServer`, `loadBobbaRoomModelsFromDb`, `loadCatalogFromDb`, ... | Bobba-Protokoll: Login, Movement, Chat, Katalog |

### jobs/ – Hintergrund-Jobs

| Datei | Exports | Zweck |
|-------|---------|-------|
| `intervals.js` | `registerIntervals` | Room-Flush (10s), Idle-Unload (3min), Disaster-Tick (60s), Upgrade-Tick (30s), Buenzli (konfigurierbar), Stats-Recompute |
| `shutdown.js` | `registerShutdownHandlers` | SIGINT/SIGTERM → Flush → Exit |

### shared/ – Geteilte Utilities

| Datei | Exports | Zweck |
|-------|---------|-------|
| `helpers.js` | `validateEmail`, `toJsonValue`, `toFiniteNumber`, `normalizeRoomCode`, `readMoneyFromStats`, `seededHash`, ... | Allgemeine Hilfsfunktionen |
| `discord.js` | `pushDiscordEvent` | Discord-Webhook |

---

## SQL-Migrationen (sql/)

Nummerierte Migrationen werden von `migrate.js` in Reihenfolge ausgeführt:

| Nr. | Datei | Inhalt |
|-----|-------|--------|
| 001 | `auth_schema` | Users, Sessions |
| 002 | `municipalities` | Gemeinden-Tabelle |
| 003 | `users_add_municipality` | FK users → municipalities |
| 004 | `game_data_rivers` | Fluss-Daten |
| 005 | `game_data_map` | Karten-Daten |
| 006 | `game_item_details` | Item-Katalog |
| 007 | `game_items` | Platzierte Items |
| 008 | `set_default_build_times` | Bauzeiten-Defaults |
| 009 | `game_rooms` | Spielräume |
| 010 | `game_stats` | Gemeinde-Stats |
| 011 | `partnerships` | Partnerschaften |
| 012 | `user_notifications` | Benachrichtigungen |
| 013 | `item_prices_and_defaults` | Preise + Defaults |
| 014 | `user_rank_and_global_roles` | Rang + globale Rollen |
| 015 | `user_inventory` | Inventar |
| 016 | `upgrade_build_times` | Upgrade-Zeiten |
| 017 | `pollution_column` | Verschmutzungs-Spalte |
| 018 | `furni_classname` | Furniture-Klassennamen |
| 019 | `catalog_pages` | Katalog-Seiten |
| 020 | `messenger` | Messenger-System |
| 021 | `badges` | Abzeichen |
| 022 | `insert_furni_moebel` | Möbel-Seed-Daten |
| 023 | `bobba_room_models` | Room-Models |
| 024 | `bobba_catalog` | Bobba-Katalog |
| 025 | `fix_service_building_levels` | Level-Fix |
| 026 | `user_xp_levels` | XP-Tabelle |
| 027 | `buenzli_events` | Buenzli-Events |
| 028 | `companies` | Firmen |
| 029 | `events_building_snapshot` | Event-Snapshots |
| 030 | `house_defect_events` | Haus-Defekte |
| 031 | `event_coin_rewards` | Event-Belohnungen |
| 032 | `daily_economy` | Tages-Wirtschaft |
| 033 | `stats_history` | Stats-Historie |
| 034 | `user_notifications` | Benachrichtigungen v2 |
| 035 | `inspections` | Inspektionen |
| 037 | `marketplace` | Marktplatz |
| 038 | `user_tutorial` | Tutorial |
| 039 | `event_status_refactor` | Event-Status Refactor |
| 040 | `remove_military` | Militär entfernt |
| 041 | `contract_work_duration` | Vertrags-Arbeitszeit |
| 042 | `shield_system` | Schild-System |
| 043 | `consolidate_inline_schema` | Inline-DDL → Migration |

Seed-Dateien (nicht nummeriert): `municipalities.sql`, `users.sql`, `insert_furni_ads_calip_cola.sql`

---

## Datenfluss: Client ↔ Server

```
Client (mapGame)
  │
  ├─ HTTP ──────────────→ handler.js ──→ game/*.js ──→ MySQL
  │   POST /api/game/items/.../sync
  │   POST /api/auth/login
  │   GET  /api/municipalities
  │
  ├─ Socket.IO ─────────→ ws/socketio/index.js
  │   emit('items-constructed-sync')  →  markItemsConstructed()
  │   emit('upgrade-building')        →  DB + Ack
  │   emit('stats-update')            →  Room-Cache
  │   emit('join-room')               →  Room-Management
  │
  └─ Bobba WS ──────────→ ws/bobba/index.js
      Opcodes: LOGIN, MOVE, CHAT, CATALOG, ROOM_NAV, ...
```

---

## Wichtige Konzepte

### Room-Cache (`game/rooms.js`)
In-Memory Cache für Room-Stats. Wird periodisch in die DB geflusht (alle 10s) und bei Inaktivität entladen (nach 3min).

### Authoritative Stats (`game/stats.js`)
Server berechnet Population, Jobs, Happiness etc. aus den platzierten Items. Client-Werte werden als Hinweise genutzt, aber der Server hat die letzte Autorität.

### Construction Sync (`handler.js → markItemsConstructed`)
Client meldet Baufortschritt per WebSocket. Server validiert Level-Änderungen für Service-Buildings (police, fire, woodcutter_house etc.) und zieht Kosten ab.

### Migrations (`migrate.js`)
Checksummen-basiert. Jede Migration wird nur einmal ausgeführt. Änderungen an bereits ausgeführten Dateien werden erkannt und blockieren neue Migrationen.
