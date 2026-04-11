# 🏛️ Buenzlifight — Server Core

> Autoritativer Game-Server für **Buenzlifight** — das Schweizer Städtebau-MMO.  
> Echtzeit-Multiplayer via Socket.IO, vollständiger Server-Game-Loop und REST-API auf Basis von rohem Node.js + MySQL.

🌐 **Live:** [core.buenzlifight.ch](https://core.buenzlifight.ch) · **Frontend:** [buenzlifight.ch](https://buenzlifight.ch)

---

## ⚡ Tech Stack

| Technologie | Verwendung |
|-------------|-----------|
| **Node.js 18+** | Laufzeitumgebung |
| **Socket.IO** | Echtzeit-Multiplayer (Avatare, Chat, NPCs, Events) |
| **MySQL 8** | Datenbank — raw SQL, kein ORM |
| **mysql2** | DB-Treiber mit Connection Pool |
| **Raw HTTP** | REST-API ohne Framework (kein Express) |
| **PM2** | Prozessmanager (Produktion) |

---

## 🗂️ Projektstruktur

```
server-core/
├── auth/                    # JWT-Authentifizierung & Middleware
├── config/                  # Konfiguration, Konstanten, Mansion-Stats
├── game/                    # Game-Logik (Server-autoritativ)
│   ├── disasters.js         # Feuer, Crime-NPCs, Zonen-Wachstum, Woodcutter
│   ├── partyEvents.js       # Party-System (Polizei-Besuche, Bussen)
│   ├── stats.js             # Autoritativer Stats-Tick (Bevölkerung, Budget)
│   ├── userBanking.js       # Spieler-Bankkonto (Debit/Credit)
│   ├── rooms.js             # Room-Cache & Möbel-Verwaltung
│   ├── buenzli.js           # Büenzli-Event-System
│   └── ...
├── http/
│   └── routes/              # REST-API Routen (game, auth, social, bank)
├── infra/                   # DB-Pool, Logger, CORS, HTTP-Helpers
├── jobs/
│   └── intervals.js         # 3s Game-Loop (Stats, Crime, Party, Werkhof)
├── sql/                     # SQL-Migrationen (001 → 140+)
├── ws/
│   └── socketio/            # Socket.IO Handler (Room, Chat, Avatar, GameState)
├── config.cfg.example       # ⚙️ Konfigurationsvorlage
└── index.js                 # Server-Einstiegspunkt
```

---

## 🚀 Schnellstart

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
# config.cfg mit eigenen Werten befüllen (DB-Passwort, JWT-Secret, Google OAuth)

# 3. Datenbank & Migrationen
node migrate.js

# 4. Server starten
node index.js
# → Läuft auf http://127.0.0.1:4100
```

### Mit PM2 (Produktion)
```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

---

## ⚙️ Konfiguration

Kopiere `config.cfg.example` → `config.cfg`:

```ini
HOST=127.0.0.1
PORT=4100

# JWT (langen zufälligen String wählen!)
JWT_SECRET=DEIN_GEHEIMER_JWT_KEY

# MySQL
DB_HOST=127.0.0.1
DB_NAME=buenzlifight
DB_USER=root
DB_PASSWORD=DEIN_DB_PASSWORT

# Google OAuth 2.0
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://deine-domain.ch/api/auth/google/callback
```

> ⚠️ `config.cfg` **niemals** ins Git committen — bereits in `.gitignore` eingetragen.

---

## 🎮 Server Game-Loop

Der Server führt alle **3 Sekunden** pro aktivem Room einen autoritativen Tick aus:

```
Alle 3s pro Room:
├── 📊 Stats berechnen        (Bevölkerung, Jobs, Happiness, Budget, LandValue)
├── 🔥 Disaster-Tick          (Feuer, Gebäudeschäden)
├── 🏗️  Building-Upgrade-Tick  (Baufortschritt, Zonen-Wachstum)
├── 🪓 Woodcutter-Tick        (Holzfäller-Ernte)
├── 🔫 Crime-Tick             (Gangster/Dealer spawnen, Polizei jagt)
├── 🎉 Party-Tick             (Polizei-Warnungen, Bussen abbuchen)
├── 🚛 Werkhof-Status         (Reparatur-Queue, Müllabfuhr)
└── 📡 Broadcast              (alle Daten via Socket.IO an Clients)
```

---

## 🔌 WebSocket Events (Auswahl)

| Event | Richtung | Beschreibung |
|-------|----------|--------------|
| `join-room` | C → S | Raum beitreten |
| `avatar-spawn-request` | C → S | Avatar mit Outfit & Motto spawnen |
| `avatar-move-request` | C → S | Avatar bewegen |
| `room-chat` | C ↔ S | Chat-Nachrichten |
| `stats-authoritative` | S → C | Game-Stats Update |
| `criminals-authoritative` | S → C | Crime-NPC Positionen & Events |
| `party-authoritative` | S → C | Party-Status (aktive Parties) |
| `party-police-warning` | S → C | Polizeibesuch + Busse ausgelöst |
| `buildings-authoritative` | S → C | Gebäude-Änderungen (Upgrades, Zonen) |
| `avatars-snapshot` | S → C | Alle Avatare beim Room-Join |

---

## 🗄️ Datenbankmigrationen

Migrationen in `sql/` werden aufsteigend ausgeführt. Status wird mit SHA256-Checksum in `_migrations` gespeichert.

```bash
# Alle ausstehenden Migrationen ausführen
node migrate.js

# Einzelne Migration manuell
node migrate-single.js sql/141_neue_tabelle.sql
```

---

## 📡 REST-API (Auswahl)

| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| `POST` | `/api/auth/login` | Login |
| `POST` | `/api/auth/register` | Registrierung |
| `GET` | `/api/game/municipality/:slug/map` | Kartendaten laden |
| `POST` | `/api/game/municipality/:slug/items` | Gebäude platzieren |
| `POST` | `/api/game/municipality/:slug/mansion-party/start` | Party starten |
| `POST` | `/api/game/municipality/:slug/mansion-party/stop` | Party beenden |
| `GET` | `/api/users/me/profile` | Eigenes Profil |
| `PUT` | `/api/users/me/motto` | Motto speichern |
| `GET` | `/api/bank/me` | Kontostand & Transaktionen |

---

*Made with ❤️ in der Schweiz 🇨🇭*
