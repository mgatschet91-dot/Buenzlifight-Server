# MeinOrt Discord Bot

Discord Bot für MeinOrt Spielbenachrichtigungen. Informiert dich über wichtige Spielereignisse wie Katastrophen, Gebäude-Updates, Angriffe und Partnerschaften.

## Features

- **Katastrophen-Alerts**: Feuer, Meteore, Erdbeben, Tornados, Überschwemmungen
- **Gebäude-Updates**: Bau abgeschlossen, Upgrades, verlassene Gebäude
- **Angriffe**: Eingehende Angriffe, Kampfergebnisse
- **Partnerschaften**: Neue Handelspartner, aktive Routen, Anfragen
- **Slash-Commands**: `/status`, `/gemeinde`, `/events`
- **Datenbank-Polling**: Überwacht neue Benachrichtigungen automatisch
- **Webhook-Empfänger**: Empfängt Push-Events direkt vom Spielserver

## Setup

### 1. Discord Bot erstellen

1. Gehe zu [Discord Developer Portal](https://discord.com/developers/applications)
2. Klicke auf "New Application" und gib einen Namen ein (z.B. "MeinOrt Bot")
3. Gehe zu "Bot" im linken Menü
4. Klicke "Reset Token" und kopiere den **Bot Token**
5. Aktiviere unter "Privileged Gateway Intents":
   - **Server Members Intent** (optional)
   - **Message Content Intent** (optional)

### 2. Bot zum Server einladen

1. Gehe zu "OAuth2" → "URL Generator"
2. Wähle die Scopes: `bot`, `applications.commands`
3. Wähle Bot-Berechtigungen:
   - Send Messages
   - Embed Links
   - Read Message History
   - Use Slash Commands
4. Kopiere die generierte URL und öffne sie im Browser
5. Wähle deinen Discord-Server aus

### 3. Channel-ID holen

1. Aktiviere in Discord: Einstellungen → App-Einstellungen → Erweitert → **Entwicklermodus**
2. Rechtsklick auf den gewünschten Channel → "ID kopieren"

### 4. Bot konfigurieren

```bash
cd discord-bot
copy .env.example .env
```

Öffne `.env` und fülle die Werte aus:

```env
DISCORD_TOKEN=dein-bot-token-hier
DISCORD_CHANNEL_ID=dein-channel-id-hier
```

### 5. Dependencies installieren

```bash
npm install
```

### 6. Bot starten

```bash
npm start
```

Oder im Entwicklungsmodus (mit Auto-Reload):

```bash
npm run dev
```

## Konfiguration

| Variable | Beschreibung | Standard |
|---|---|---|
| `DISCORD_TOKEN` | Discord Bot Token (Pflicht) | - |
| `DISCORD_CHANNEL_ID` | Haupt-Channel für Benachrichtigungen (Pflicht) | - |
| `DISCORD_CHANNEL_DISASTERS` | Separater Channel für Katastrophen | = DISCORD_CHANNEL_ID |
| `DISCORD_CHANNEL_BUILDINGS` | Separater Channel für Gebäude | = DISCORD_CHANNEL_ID |
| `DISCORD_CHANNEL_PARTNERSHIPS` | Separater Channel für Partnerschaften | = DISCORD_CHANNEL_ID |
| `DB_HOST` | MySQL Host | 127.0.0.1 |
| `DB_PORT` | MySQL Port | 3306 |
| `DB_NAME` | Datenbankname | buenzlifight |
| `DB_USER` | DB Benutzer | root |
| `DB_PASSWORD` | DB Passwort | - |
| `WEBHOOK_PORT` | Port für internen Webhook-Server | 4200 |
| `POLL_INTERVAL` | Polling-Intervall in ms | 5000 |

## Slash Commands

| Command | Beschreibung |
|---|---|
| `/status` | Zeigt Bot-Status, Uptime und DB-Verbindung |
| `/gemeinde <name>` | Zeigt Infos zu einer Gemeinde |
| `/events [anzahl]` | Zeigt die letzten Spielereignisse (1-10) |

## Architektur

```
┌──────────────────┐     HTTP POST      ┌──────────────────┐
│  MeinOrt Server  │ ──────────────────→ │  Discord Bot     │
│  (server.js)     │   /event Webhook    │  (bot.js)        │
│                  │                     │                  │
│  - Katastrophen  │                     │  - Formatiert    │
│  - Gebäude       │     MySQL Poll      │    Embeds        │
│  - Partnerschaften│ ←─────────────────  │  - Sendet an     │
│  - Angriffe      │  user_notifications │    Discord       │
└──────────────────┘                     └──────────────────┘
                                                │
                                                ▼
                                         ┌──────────────────┐
                                         │  Discord Server  │
                                         │                  │
                                         │  #katastrophen   │
                                         │  #gebaeude       │
                                         │  #angriffe       │
                                         │  #allgemein      │
                                         └──────────────────┘
```

**Zwei Wege für Events:**

1. **Push (Webhook)**: Der Spielserver sendet HTTP POST an `http://127.0.0.1:4200/event`. Sofort und zuverlässig für Echtzeit-Events.
2. **Poll (Datenbank)**: Der Bot prüft alle 5 Sekunden die `user_notifications`-Tabelle. Fängt alle Events auf, auch wenn der Bot kurz offline war.

## Server-Integration

Der Spielserver (`server-core/server.js`) wurde um folgendes erweitert:

- `DISCORD_BOT_WEBHOOK_URL` Config-Variable in `config.cfg`
- `pushDiscordEvent(type, data)` Funktion (fire-and-forget HTTP POST)
- Automatische Discord-Pushes bei:
  - Neuen Benutzer-Benachrichtigungen (`createUserNotification`)
  - Gebäude-Fertigstellung, Upgrades, Verlassen
  - Katastrophen (Feuer, Meteore, etc.)
  - Manuell ausgelösten Katastrophen
