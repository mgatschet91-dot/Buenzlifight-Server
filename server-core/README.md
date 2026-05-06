# Buenzlifight — Server Core

Autoritativer Game-Server für **Buenzlifight**, das Schweizer Städtebau-MMO.  
Echtzeit-Multiplayer via Socket.IO, vollständiger Server-Game-Loop und REST-API — reines Node.js ohne Framework, MySQL ohne ORM.

**Live:** [core.buenzlifight.ch](https://core.buenzlifight.ch) · **Frontend:** [buenzlifight.ch](https://buenzlifight.ch)

---

## Tech Stack

| Technologie | Verwendung |
|-------------|-----------|
| **Node.js 18+** | Laufzeitumgebung |
| **Socket.IO** | Echtzeit-Multiplayer (Avatare, Chat, NPCs, Events) |
| **MySQL 8** | Datenbank — raw SQL, kein ORM |
| **mysql2** | DB-Treiber mit Connection Pool |
| **Raw HTTP** | REST-API ohne Framework (kein Express) |
| **PM2** | Prozessmanager (Produktion) |

---

## Projektstruktur

```
server-core/
├── auth/                        # JWT-Authentifizierung & Middleware
├── config/
│   └── constants.js             # Spielbalance-Konstanten (Preise, Limits, Timings)
├── game/                        # Server-autoritäre Game-Logik
│   ├── stats.js                 # Stats-Tick: Bevölkerung, Budget, LandValue, Happiness
│   ├── disasters.js             # Crime-NPCs, Feuer, Zonen-Wachstum, Woodcutter
│   ├── rooms.js                 # Room-Cache, Avatar-Positionen, Möbel-State
│   ├── bank.js                  # Transaktionen, Gemeinde-Kasse, Kontoführung
│   ├── partnerships.js          # Partnerschafts-System (Tiers, Trade, Payout)
│   ├── parkingSystem.js         # Parkraum-Management & Bussensystem
│   └── ...
├── http/
│   ├── handler.js               # HTTP-Dispatcher (registriert alle Routen)
│   ├── shared.js                # Auth-Middleware, Response-Helpers
│   └── routes/
│       ├── game/                # Karten, Gebäude, Items, Rooms, Furniture, Stats ...
│       ├── social/              # Chat, Global Chat, Partnerships, Profil, Reporter
│       ├── bank.js              # Kontostand, Transaktionen, Überweisungen
│       ├── companies/           # Firmen, Darlehen, Werkhof
│       ├── marketplace.js       # Marktplatz (Handel zwischen Spielern)
│       ├── admin.js             # Admin-Panel (Bans, Gemeinde-Verwaltung)
│       └── support.js           # Support-Tickets
├── jobs/
│   └── intervals.js             # 3s Game-Loop (Stats, Crime, Party, Income-Scheduler)
├── ws/
│   └── socketio/
│       ├── handlers/
│       │   ├── room.js          # Avatar spawn/move, join/leave
│       │   ├── construction.js  # Gebäude platzieren, Teleporter, Reparatur
│       │   └── messenger.js     # Ingame-Messenger, Nachrichten
│       └── rateLimit.js         # WS Rate-Limiting pro Socket
├── sql/                         # SQL-Migrationen 001 → 155
├── public/
│   └── badges/                  # Badge-Bilder (PNG, lokal serviert)
├── uploads/
│   └── minimaps/                # Minimap-PNGs pro Gemeinde
├── config.cfg.example           # Konfigurationsvorlage
├── index.js                     # Server-Einstiegspunkt
└── migrate.js                   # Migrations-Runner
```

---

## Schnellstart

### Voraussetzungen

- Node.js 18+
- MySQL 8.0+

### Setup

```bash
# 1. Abhängigkeiten installieren
cd server-core
npm install

# 2. Konfiguration anlegen
cp config.cfg.example config.cfg
# config.cfg mit eigenen Werten füllen

# 3. Migrationen ausführen
node migrate.js

# 4. Server starten
node index.js
# → http://127.0.0.1:4100
```

### Mit PM2 (Produktion)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

---

## Konfiguration (`config.cfg`)

```ini
HOST=127.0.0.1
PORT=4100

JWT_SECRET=langer-zufaelliger-string

DB_HOST=127.0.0.1
DB_NAME=buenzlifight
DB_USER=root
DB_PASSWORD=dein-passwort

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://deine-domain.ch/api/auth/google/callback
```

> `config.cfg` ist in `.gitignore` — niemals committen.

---

## Server Game-Loop

Alle **3 Sekunden** pro aktivem Room:

```
├── Stats-Tick          Bevölkerung, Jobs, Happiness, Budget, LandValue
├── Disaster-Tick       Feuer, Gebäudeschäden
├── Building-Tick       Baufortschritt, Zonen-Wachstum
├── Woodcutter-Tick     Holzfäller-Ernte
├── Crime-Tick          Dealer/Gangster spawnen, Polizei jagt (12s Delay)
├── Party-Tick          Polizei-Warnungen, Bussgelder abbuchen
├── Income-Scheduler    Firmen-Einkommen, Partnership-Trade-Payout
└── Broadcast           Alle Daten via Socket.IO an Clients
```

**Crime-NPCs:** Dealer macht nur Deals (kein Diebstahl). Einbrüche nur nachts. Polizei startet Verfolgung nach 12s Delay.  
**Partnerships:** Tiers (Bronze/Silber/Gold/Platin) mit gestaffelten Trade-Vorteilen und automatischem wöchentlichem Payout.

---

## WebSocket Events

| Event | Richtung | Beschreibung |
|-------|----------|--------------|
| `join-room` | C → S | Raum beitreten |
| `avatar-spawn-request` | C → S | Avatar mit Outfit & Motto spawnen |
| `avatar-move-request` | C → S | Avatar bewegen |
| `room-chat` | C ↔ S | Raum-Chat |
| `stats-authoritative` | S → C | Game-Stats Update |
| `criminals-authoritative` | S → C | Crime-NPC Positionen & Events |
| `buildings-authoritative` | S → C | Gebäude-Updates (Upgrades, Zonen) |
| `avatars-snapshot` | S → C | Alle Avatare beim Room-Join |
| `party-authoritative` | S → C | Aktive Parties |
| `party-police-warning` | S → C | Polizeibesuch + Busse |
| `teleporter-pair` | C → S | Teleporter-Verknüpfung setzen |

---

## REST-API (Auswahl)

### Auth
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| `POST` | `/api/auth/login` | Login |
| `POST` | `/api/auth/register` | Registrierung |
| `GET` | `/api/auth/google` | Google OAuth Start |
| `GET` | `/api/auth/google/callback` | Google OAuth Callback |
| `POST` | `/api/auth/steam` | Steam-Auth |

### Game
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| `GET` | `/api/game/municipality/:slug/map` | Kartendaten |
| `POST` | `/api/game/municipality/:slug/items` | Gebäude platzieren |
| `DELETE` | `/api/game/municipality/:slug/items/:id` | Gebäude abreissen |
| `GET` | `/api/game/municipality/:slug/stats` | Aktuelle Stats |
| `GET` | `/api/game/municipality/:slug/deltas` | Delta-Updates (Sync) |
| `GET` | `/api/game/room/:id/furniture` | Möbel im Raum |
| `POST` | `/api/game/room/:id/furniture` | Möbel platzieren |
| `GET` | `/api/game/shop/furniture` | Shop-Katalog |
| `POST` | `/api/game/room/:id/moderation/ban` | Spieler aus Raum sperren |

### Social
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| `GET` | `/api/social/global-chat` | Globaler Chat (neueste Nachrichten) |
| `POST` | `/api/social/global-chat` | Nachricht in globalem Chat senden |
| `GET` | `/api/social/municipality-chat/:slug` | Gemeinde-Chat |
| `GET` | `/api/social/partnerships` | Eigene Partnerschaften |
| `POST` | `/api/social/partnerships/request` | Partnerschaftsanfrage senden |
| `POST` | `/api/social/partnerships/trade` | Trade-Angebot erstellen |
| `GET` | `/api/social/profile/:uuid` | Spielerprofil |
| `POST` | `/api/social/block` | Spieler blockieren |

### Bank
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| `GET` | `/api/bank/me` | Kontostand & Transaktionen |
| `POST` | `/api/bank/transfer` | Überweisung |
| `GET` | `/api/bank/municipality/:slug/treasury` | Gemeindekasse |

### Firmen & Marktplatz
| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| `POST` | `/api/companies/found` | Firma gründen |
| `GET` | `/api/companies/my` | Eigene Firmen |
| `POST` | `/api/companies/:id/loan` | Darlehen aufnehmen |
| `GET` | `/api/marketplace` | Marktplatz-Angebote |

---

## Datenbankmigrationen

Migrationen liegen in `sql/` (001–155) und werden aufsteigend ausgeführt. Jede Migration wird mit SHA256-Checksum in der `_migrations`-Tabelle gespeichert — bereits ausgeführte Migrationen werden übersprungen.

```bash
# Alle ausstehenden Migrationen
node migrate.js

# Einzelne Migration manuell
node migrate-single.js sql/155_user_blocks.sql

# Status anzeigen
npm run migrate:status
```

---

## Weitere Dienste

| Dienst | Verzeichnis | Beschreibung |
|--------|-------------|--------------|
| **Discord-Bot** | `../discord-bot/` | Ingame-Events → Discord-Kanal |
| **Electron-App** | `../electron-app/` | Windows-Desktop-Client (Steam-Build) |
| **Frontend** | `../mapGame/` | Next.js Client ([Buenzli-Game](https://github.com/mgatschet91-dot/Buenzli-Game)) |

---

*Made in der Schweiz 🇨🇭*
