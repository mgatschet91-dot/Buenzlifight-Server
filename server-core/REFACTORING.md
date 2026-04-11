# server.js Refactoring-Plan

> **Status:** `server.js` ist ein **15.684-Zeilen-Monolith** mit ~165 Funktionen, ~130 HTTP-Routen, ~25 Socket.IO-Events und ~35 Bobba-OpCodes.  
> Die modulare Struktur existiert bereits zu **~70%** — sie muss nur aktiviert werden.

---

## Überblick: Was steckt wo?

| Sektion | Zeilen (ca.) | Beschreibung |
|---|---|---|
| Imports, Config, Konstanten | 1–185 | Alles inline statt aus `config/` |
| Auth/Crypto/Logging/CORS | 187–380 | Dupliziert aus `infra/` und `auth/` |
| Client-Datei-Parser & Seed | 382–591 | Parsing von Client-TS-Dateien |
| Municipality-Funktionen | 593–1798 | Dupliziert aus `game/municipality.js` |
| XP & Level System | 1812–1951 | Dupliziert aus `game/xp.js` |
| Büenzli Event System | 1953–2759 | ~800 Zeilen, dupliziert aus `game/buenzli.js` |
| Room-System | 2822–3065 | Dupliziert aus `game/rooms.js` |
| Stats-Berechnung | 3067–3346 | Dupliziert aus `game/stats.js` |
| Item-Platzierung & Construction | 3348–3703 | ~350 Zeilen, dupliziert aus `game/building.js` |
| Auth User-Funktionen | 3705–3815 | Dupliziert aus `auth/middleware.js` |
| **Autoritäre Stats** | **3954–4496** | **540 Zeilen — grösste Einzelfunktion!** |
| Disaster & Upgrade System | 4577–5734 | ~1.160 Zeilen |
| Item Details & Katalog | 5924–6290 | |
| Map-Generierung | 6273–6539 | Dupliziert aus `game/map.js` |
| Partnerships & Achievements | 6540–6936 | |
| **HTTP Request Handler** | **6938–12604** | **5.666 Zeilen — der Kern** |
| **Socket.IO Handler** | **12606–13870** | **1.264 Zeilen** |
| **Bobba Protokoll** | **13902–15590** | **1.688 Zeilen** |

---

## Was ist bereits modular vorhanden (aber NICHT aktiv)?

| Modulare Datei | Zeilen | Duplikat in server.js | Status |
|---|---|---|---|
| `config/constants.js` | ~130 | Z. 26–101 | Dupliziert |
| `infra/logger.js` | ~50 | Z. 321–347 | Dupliziert |
| `infra/http.js` | ~40 | Z. 255–289 | Dupliziert |
| `infra/cors.js` | ~30 | Z. 364–380 | Dupliziert |
| `auth/tokens.js` | ~70 | Z. 187–253 | Dupliziert |
| `auth/middleware.js` | ~160 | Z. 3705–3815 | Dupliziert |
| `game/municipality.js` | ~840 | Z. 593–1798 | Dupliziert |
| `game/rooms.js` | ~900 | Z. 2822–3065 | Teilweise Proxy |
| `game/buenzli.js` | ~850 | Z. 1953–2759 | Dupliziert |
| `http/handler.js` | ~6.400 | Z. 6938–12604 | **Parallel, nicht aktiv!** |
| `ws/socketio/index.js` | ~750 | Z. 12606–13870 | **Parallel, nicht aktiv!** |
| `ws/bobba/index.js` | — | Z. 13902–15590 | Nur in server.js |

---

## Refactoring-Phasen

### Phase 1: Schalter umlegen (Aufwand: klein)

**Ziel:** `index.js` statt `server.js` als Einstiegspunkt verwenden.

`index.js` existiert bereits und importiert die modularen Dateien. Dafür nötig:
- [ ] Alle neuen Änderungen aus `server.js` in die modularen Dateien synchronisieren
- [ ] `package.json` → `"start": "node index.js"` ändern
- [ ] Testen, dass `index.js` alle Features abdeckt
- [ ] `server.js` als Backup behalten, aber nicht mehr starten

### Phase 2: Die 5 grössten Blöcke extrahieren (Aufwand: mittel)

| Prio | Block | Zeilen | Zielmodul |
|---|---|---|---|
| P1 | `recomputeAuthoritativePopulationAndJobs` | 540 | `game/stats.js` |
| P2 | Bobba-Protokoll komplett | 1.688 | `ws/bobba/index.js` |
| P3 | `markItemsConstructed` + Upgrade-Tick | 627 | `game/building.js` |
| P4 | Disaster-Ticks | 520 | `game/disasters.js` |
| P5 | Map-Generierung | 270 | `game/map.js` |

### Phase 3: HTTP Handler aufteilen (Aufwand: mittel)

Die 5.666 Zeilen im HTTP Handler nach API-Bereich aufteilen:

```
http/
├── handler.js          ← Router-Kern (~200 Z.)
├── routes/
│   ├── auth.js         ← Register, Login, Me, Logout (~400 Z.)
│   ├── game.js         ← Deltas, Stats, Items, Rooms (~2.000 Z.)
│   ├── municipality.js ← Verwaltung, Members, Assets (~1.000 Z.)
│   ├── companies.js    ← Companies CRUD (~700 Z.)
│   ├── verwaltung.js   ← Meldungen, Events (~500 Z.)
│   ├── marketplace.js  ← Marktplatz, Trades (~300 Z.)
│   └── admin.js        ← Admin-Dashboard (~300 Z.)
```

### Phase 4: Restliche Duplikate entfernen (Aufwand: klein)

- [ ] Inline-Konstanten → `require('./config/constants')`
- [ ] Inline-Logger → `require('./infra/logger')`
- [ ] Inline-Auth → `require('./auth/middleware')`
- [ ] Inline-Helpers → `require('./shared/helpers')`

---

## Endziel

Nach dem Refactoring sollte `server.js` (oder besser `index.js`) nur noch **~200 Zeilen** sein:

```
- Imports der Module
- HTTP Server erstellen
- Socket.IO/Bobba Server erstellen
- Startup-Tasks ausführen
- Signal-Handler registrieren
- server.listen()
```

Alle Logik lebt in den jeweiligen Modulen.

---

## Quick-Wins (sofort umsetzbar)

1. **`package.json`** → `"start": "node index.js"` (wenn `index.js` getestet)
2. **Neue Features nur noch in `handler.js`** schreiben, nicht in `server.js`
3. **Admin-Routen** sind bereits in beiden Dateien synchronisiert
