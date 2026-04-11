# MeinOrt — Projekt-Plan

## Bereits vorhanden (funktional)

### Kern-Gameplay
- **Stadtbau**: 100+ Gebaeude/Tools, Zonen (Wohn/Gewerbe/Industrie), Terrain-Editing, Paint-Tools
- **Budget-System**: 8 Kategorien (Polizei, Feuerwehr, Gesundheit, Bildung, Transport, Parks, Strom, Wasser)
- **Service-Coverage**: Overlay-Visualisierung fuer alle 12 Overlay-Modi
- **Statistiken**: Bevoelkerung, Geld, Zufriedenheit mit historischen Charts (90 Tage)
- **Wirtschaft**: Taeglich Einkommen pro Gebaeude, Steuern, Unterhalt, Milestones

### Buenzli Event-System
- **Server-seitig**: Auto-Generierung 4-10 Events/Tag, 20+ Event-Typen, Severity 1-5
- **Inspektions-Tool**: Server-verifiziert, 10-Min Timer, Proximity-Check
- **Belohnungen**: XP + Coins fuer Reports, Fremd-Gemeinde-Bonus
- **Firmen-Integration**: Events koennen von Firmen behoben werden

### Firmen-System
- **4 Firmentypen**: Bau, Sicherheit, Reinigung, Medien
- **Verwaltung**: Owner/Manager/Employee Rollen, Mitglieder-Management
- **Vertraege**: Annehmen, Fortschritt anzeigen, Bezahlung

### Sozial/Multiplayer
- **Echtzeit-Multiplayer**: Co-op Stadtbau via WebSocket
- **Gemeinde-Verwaltung**: Rollen (Owner/Council/Citizen/Observer), Einladen/Kicken
- **Chat**: Gemeinde-Chat mit Antworten, Bearbeiten, Loeschen, Ankuendigungen
- **Messenger**: Freundesliste, Anfragen, Private Nachrichten, Online-Status
- **Partnerschaften**: Staedte entdecken/verbinden, Handels-Einkommen

### Progression
- **XP/Level-System**: Max Level 25, XP-Log, Login-Streaks
- **Badges**: 20+ Badges mit Raritaetssystem, 4 Badge-Slots
- **Achievements**: Achievement-Center UI vorhanden

### NPC/Pedestrian-System
- **6 NPC-Typen**: Holzfaeller, Gaertner, Polizei, Gangster, Buenzli, Avatar-Test
- **Aktivitaeten**: Sitzen, Picknicken, Joggen, Sport, Einkaufen, Arbeiten
- **Gebaeude-Interaktion**: Betreten von Shops, Bueros, Schulen etc.

### Discord Bot
- **4 Slash-Commands**: `/status`, `/gemeinde`, `/events`, `/inspect`
- **Event-Notifications**: Katastrophen, Gebaeude, Partnerschaften, Buenzli-Events
- **Dual-Integration**: Webhook (Push) + DB-Polling (Fallback)
- **Channel-Routing**: Eigener Buenzli-Channel

### Technisch
- **Mobile UI**: MobileToolbar + MobileTopBar, optimierte Panels
- **Bobba/Habbo Rooms**: Katalog, Moebel, Room-Models
- **Benachrichtigungen**: Server-persistent + Session-lokal, Loeschen moeglich

---

## Feature-Plan — Status

| # | Feature | Prio | Status |
|---|---------|------|--------|
| 1 | Firmen-Vertraege UI (annehmen, Fortschritt, Workflow) | Hoch | ✅ Erledigt |
| 2 | Event-Resolution Flow (Beheben-Button im InspectionPanel) | Hoch | ✅ Erledigt |
| 3 | Discord Bot Buenzli (Formatter, Channel, /inspect) | Mittel | ✅ Erledigt |
| 4 | Inventar-UI | Mittel | ⛔ Entfaellt (im Babbo Client) |
| 5 | Tutorial/Onboarding (Server-gesichert in users_data) | Mittel | ✅ Erledigt |
| 6 | Leaderboard (Spieler- und Gemeinde-Ranglisten) | Mittel | ✅ Erledigt |
| 7 | Admin-Dashboard (User-Management, Events, Server-Stats) | Mittel | ✅ Erledigt |
| 8 | Militaer-System (Angriff/Verteidigung, UI) | Niedrig | ✅ Erledigt |
| 9 | Wetter-System (Regen, Schnee, Sturm, Nebel) | Niedrig | ✅ Erledigt |
| 10 | Spielerprofil (Stats, Badges, Gemeinde-Info) | Niedrig | ✅ Erledigt |
| 11 | Handel/Marktplatz (Listings, Direkthandel) | Niedrig | ✅ Erledigt |
| 12 | Settings erweitern (Grafik, Sound, Benachrichtigungen) | Niedrig | ✅ Erledigt |
| 13 | Mobile Panel-Optimierung | Niedrig | ✅ Erledigt |
| 14 | Katastrophen Visuals (DisasterOverlay) | Niedrig | ✅ Erledigt |

---

## Game Loops — Wie das Spiel funktioniert

Das Spiel laeuft ueber mehrere ineinandergreifende Schleifen (Loops), die gleichzeitig auf **Client** und **Server** ticken.

### Uebersicht

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT                               │
│                                                             │
│  Rendering (60fps)          Simulation (500ms)              │
│  ┌─────────────┐            ┌──────────────────┐            │
│  │ Fahrzeuge   │            │ Bevoelkerung     │            │
│  │ Fussgaenger │            │ Wirtschaft       │            │
│  │ Ampeln      │            │ Gebaeude-Wachstum│            │
│  │ Feuer       │            │ Feuer-Simulation │            │
│  │ Wolken      │            │ Verschmutzung    │            │
│  │ Smog        │            │ Nachfrage (R/C/I)│            │
│  └──────┬──────┘            └────────┬─────────┘            │
│         │                            │                      │
│         │    Stats-Sync (5s)         │                      │
│         │    ┌──────────┐            │                      │
│         └───►│ WebSocket├────────────┘                      │
│              └─────┬────┘                                   │
└────────────────────┼────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                        SERVER                               │
│                                                             │
│  Authoritative Stats (3s)    Room-Cache (5s)                │
│  ┌──────────────────┐        ┌──────────────────┐           │
│  │ Population neu   │        │ Dirty Stats → DB │           │
│  │ berechnen        │        │ Idle Rooms       │           │
│  │ Einkommen/Kosten │        │ entladen (3min)  │           │
│  │ Katastrophen-Tick│        └──────────────────┘           │
│  │ Upgrade-Tick     │                                       │
│  │ → Broadcast an   │        Buenzli Events (1min)          │
│  │   alle Clients   │        ┌──────────────────┐           │
│  └──────────────────┘        │ Taeglich 4-10    │           │
│                              │ Events generieren│           │
│  Background-Tick (30s)       │ Abgelaufene      │           │
│  ┌──────────────────┐        │ Events entfernen │           │
│  │ Raeume ohne      │        └──────────────────┘           │
│  │ Spieler updaten  │                                       │
│  │ (fuer Discord)   │        Stale-Player (30s)             │
│  └──────────────────┘        ┌──────────────────┐           │
│                              │ Disconnected     │           │
│                              │ Spieler entfernen│           │
│                              └──────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

### Client-Loops

#### 1. Rendering Loop (~60fps / ~16ms)
- **Was**: Zeichnet alles auf den Canvas
- **Inhalt**: Fahrzeuge (Autos, Busse, Zuege, Boote, Flugzeuge, Helikopter), Fussgaenger, NPCs, Ampeln, Schranken, Feuerwerk, Smog, Wolken, Kriminalitaet, Einsatzfahrzeuge
- **Datei**: `mapGame/src/components/game/CanvasIsometricGrid.tsx`
- **Mobil**: Reduziert auf ~30fps

#### 2. Simulations-Tick (500ms Desktop / 750ms Mobil)
- **Was**: Kernlogik der Stadt-Simulation
- **Datei**: `mapGame/src/lib/simulation.ts` → `simulateTick()`
- **Berechnet pro Tick**:
  - **Gebaeude-Evolution**: Zonen entwickeln Gebaeude basierend auf Nachfrage
  - **Bau-Fortschritt**: Gebaeude im Bau schreiten voran
  - **Bevoelkerungswachstum**: Abhaengig von Wohngebaeuden + Zufriedenheit
  - **Geld-Updates**: Tageseinkommen (1/30 des Monatlichen) bei Tageswechsel
  - **Steuer-Glaettung**: `effectiveTaxRate` bewegt sich 3% pro Tick Richtung `taxRate`
  - **Nachfrage-Glaettung**: Nachfrage aendert sich 12% pro Tick (kein Flackern)
  - **Feuer-Simulation**: Zufaellige Feuer, Ausbreitung, Loeschung
  - **Verschmutzung**: Baut sich um 5% pro Tick ab
  - **Holzfaeller**: Plantagen-Phasen, Ernte → Geld
  - **History**: Quartals-Snapshots (alle 3 Monate)

#### 3. Stats-Sync (5 Sekunden)
- **Was**: Synchronisiert lokale Statistiken mit dem Server via WebSocket
- **Datei**: `mapGame/src/hooks/useStatsSync.ts`
- **Zweck**: Echtzeit-Multiplayer — alle Spieler sehen die gleichen Werte

#### 4. Partnerschaften-Refresh (15 Sekunden)
- **Was**: Aktualisiert Partnerschafts-Daten von der API
- **Datei**: `mapGame/src/context/GameContext.tsx`

### Server-Loops

#### 5. Authoritative Stats Broadcast (3 Sekunden)
- **Was**: Der Server ist die "Wahrheit" — berechnet Population, Jobs, Einkommen/Ausgaben neu und sendet es an alle Clients
- **Datei**: `server-core/server.js` → `wsPublishAuthoritativeStats()`
- **Berechnet**:
  - Population aus Wohngebaeuden
  - Jobs aus Gewerbe-/Industriegebaeuden
  - Einkommen/Ausgaben aus Gebaeuden und Steuern
  - Idle-Earnings (Geld verdient waehrend offline)
  - Taeglicher Snapshot in `municipality_stats_history`
- **Fuehrt auch aus**: Katastrophen-Tick, Gebaeude-Upgrade-Tick

#### 6. Room-Cache Flush (5 Sekunden)
- **Was**: Speichert geaenderte Raum-Daten in die Datenbank
- **Intervall**: Prueft alle 5s, flusht alle 10s wenn dirty
- **Idle-Unload**: Raeume ohne Spieler werden nach 3 Minuten aus dem RAM entladen

#### 7. Buenzli Event-Tick (1 Minute)
- **Was**: Prueft einmal pro Tag ob neue Events generiert werden muessen
- **Ablauf**: 4-10 Events pro Tag pro Gemeinde, basierend auf Gemeindegroesse und Zufriedenheit
- **Expiry**: Abgelaufene Events werden automatisch entfernt

#### 8. Background-Tick (30 Sekunden)
- **Was**: Holt Gemeinden ohne aktive Spieler nach und fuehrt Ticks aus
- **Zweck**: Discord-Events und Katastrophen laufen auch wenn niemand online ist

#### 9. Stale-Player Cleanup (30 Sekunden)
- **Was**: Entfernt Spieler deren WebSocket-Verbindung abgebrochen ist
- **Aktion**: Avatar entfernen, Raum-Zaehler aktualisieren

### Wie die Loops zusammenhaengen

```
Spieler baut Gebaeude
        │
        ▼
Client simulateTick() ──► Bevoelkerung waechst, Geld fliesst
        │
        ▼ (alle 5s)
Stats-Sync via WebSocket ──► Server empfaengt Stats
        │
        ▼ (alle 3s)
Server berechnet neu ──► Authoritative Werte zurueck an ALLE Clients
        │
        ▼ (alle 10s)
Room-Cache flusht ──► Daten in MySQL gespeichert
        │
        ▼ (taeglich)
Stats-History ──► 90-Tage Verlauf fuer Charts
```

### Wirtschafts-Kreislauf

```
Wohnzonen ──► Bevoelkerung ──► Steuereinnahmen
    │                              │
    ▼                              ▼
Zufriedenheit ◄── Services    Budget verteilen
    │              (Polizei,       │
    │               Feuer,         ▼
    │               Bildung...)  Gewerbe/Industrie ──► Jobs + Einkommen
    │                              │
    ▼                              ▼
Nachfrage (R/C/I) ◄───────── Balance bestimmt Wachstum
```

- **Wohnzonen (R)** → Bevoelkerung → Arbeitskraefte fuer Gewerbe/Industrie
- **Gewerbezonen (C)** → Shops/Bueros → Einkommen + Jobs
- **Industriezonen (I)** → Fabriken → Hohes Einkommen, aber Verschmutzung
- **Steuern** → Prozentsatz des Einkommens, zu hoch = Unzufriedenheit
- **Services** → Budget → Coverage → Zufriedenheit
- **Zufriedenheit** → Beeinflusst Bevoelkerungswachstum und Nachfrage

### Timer & Intervalle (Zusammenfassung)

| Loop | Intervall | Ort |
|------|-----------|-----|
| Canvas Rendering | ~16ms (60fps) | Client |
| Simulations-Tick | 500ms / 750ms | Client |
| Stats-Sync (WebSocket) | 5s | Client → Server |
| Authoritative Broadcast | 3s | Server → Clients |
| Room-Cache Flush | 5-10s | Server → DB |
| Stale-Player Cleanup | 30s | Server |
| Background-Tick | 30s | Server |
| Buenzli Event Check | 60s (1x taeglich) | Server |
| Partnerschaften Refresh | 15s | Client |
| Bobba Protocol Tick | 500ms | Server |
