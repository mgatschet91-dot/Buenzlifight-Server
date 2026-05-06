# MeinOrt Service Architecture

## Systemübersicht

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND                                 │
│                    (Next.js / React)                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Game      │  │   Trade     │  │   Debug                 │  │
│  │   Context   │  │   Panel     │  │   Panel                 │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘  │
│         │                │                      │                │
│  ┌──────┴────────────────┴──────────────────────┴─────────────┐  │
│  │                    API Services                             │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │  │
│  │  │ partnership  │  │ laravelApi   │  │ deltaSync        │  │  │
│  │  │ Api.ts       │  │ .ts          │  │ .ts              │  │  │
│  │  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │  │
│  └─────────┼─────────────────┼───────────────────┼────────────┘  │
└────────────┼─────────────────┼───────────────────┼───────────────┘
             │                 │                   │
             │ HTTP/REST       │ HTTP/REST         │ WebSocket
             │                 │                   │
┌────────────┼─────────────────┼───────────────────┼───────────────┐
│            ▼                 ▼                   ▼               │
│  ┌─────────────────────────────────┐  ┌─────────────────────┐   │
│  │        LARAVEL BACKEND          │  │   SYNC SERVER       │   │
│  │       (PHP / Laravel)           │  │   (Node.js)         │   │
│  │  ┌───────────────────────────┐  │  │  ┌───────────────┐  │   │
│  │  │  GameMapApiController     │  │  │  │  Socket.io    │  │   │
│  │  │  - getPartnerships()      │  │  │  │  Server       │  │   │
│  │  │  - discoverPartnership()  │  │  │  │               │  │   │
│  │  │  - connectPartnership()   │  │  │  │  Events:      │  │   │
│  │  │  - getTradeIncome()       │  │  │  │  - delta      │  │   │
│  │  └───────────┬───────────────┘  │  │  │  - stats      │  │   │
│  │              │                  │  │  │  - partner-   │  │   │
│  │  ┌───────────▼───────────────┐  │  │  │    ship-*     │  │   │
│  │  │  Models                   │  │  │  └───────────────┘  │   │
│  │  │  - Municipality           │  │  └─────────────────────┘   │
│  │  │  - MunicipalityPartnership│  │                            │
│  │  └───────────┬───────────────┘  │                            │
│  │              │                  │                            │
│  └──────────────┼──────────────────┘                            │
│                 │                                                │
│  ┌──────────────▼──────────────────────────────────────────────┐│
│  │                     MySQL DATABASE                           ││
│  │  ┌────────────────┐  ┌─────────────────────────────────────┐││
│  │  │ municipalities │  │ municipality_partnerships           │││
│  │  │                │  │                                     │││
│  │  │ - id           │  │ - id                                │││
│  │  │ - name         │◄─┼─- municipality_id                   │││
│  │  │ - slug         │  │ - partner_municipality_id ──────────┼┼┤
│  │  │ - canton       │  │ - status (discovered/connected)     │││
│  │  │ - population   │  │ - direction (N/S/E/W)               │││
│  │  │ - ...          │  │ - trade_income                      │││
│  │  └────────────────┘  │ - connection_bonus_paid             │││
│  │                      │ - discovered_at                     │││
│  │                      │ - connected_at                      │││
│  │                      └─────────────────────────────────────┘││
│  └──────────────────────────────────────────────────────────────┘│
│                            BACKEND                               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Frontend Services

### 1. partnershipApi.ts

**Zweck:** Kommunikation mit der Laravel API für Handelspartner.

**Funktionen:**

| Funktion | HTTP | Endpoint | Beschreibung |
|----------|------|----------|--------------|
| `getPartnerships()` | GET | `/partnerships` | Alle Partner laden |
| `discoverPartnership()` | POST | `/partnerships/discover` | Stadt entdecken |
| `connectPartnership()` | POST | `/partnerships/{slug}/connect` | Verbindung herstellen |
| `getTradeIncome()` | GET | `/partnerships/trade-income` | Einkommen abrufen |

**Verwendung:**
```typescript
import * as partnershipApi from '@/lib/api/partnershipApi';

// Partnerschaften laden
const response = await partnershipApi.getPartnerships('solothurn');
console.log(response.data.partnerships);

// Stadt entdecken
await partnershipApi.discoverPartnership('solothurn', 'biezwil', 'east', 'Biezwil');

// Verbinden
await partnershipApi.connectPartnership('solothurn', 'biezwil');
```

---

### 2. deltaSync.ts

**Zweck:** WebSocket-Verbindung für Echtzeit-Multiplayer-Synchronisation.

**Klasse:** `DeltaQueue`

**Events:**

| Event | Richtung | Beschreibung |
|-------|----------|--------------|
| `delta` | bidirektional | Spielaktionen (Gebäude, Straßen) |
| `full-state` | bidirektional | Kompletter Spielstand |
| `stats-update` | bidirektional | Statistik-Updates |
| `partnership-discovered` | bidirektional | Stadt entdeckt |
| `partnership-connected` | bidirektional | Handelsroute etabliert |

**Verwendung:**
```typescript
import { deltaQueue } from '@/lib/deltaSync';

// Initialisieren
deltaQueue.init('room-code', 'player-id');

// Delta senden
deltaQueue.sendDelta({ type: 'place-building', ... });

// Partnership-Event senden
deltaQueue.sendPartnershipDiscovered({
  partnerSlug: 'biezwil',
  partnerName: 'Biezwil',
  direction: 'east'
});

// Callbacks registrieren
deltaQueue.setOnPartnershipDiscovered((data) => {
  console.log('Andere Spieler hat entdeckt:', data.partnerName);
});
```

---

### 3. laravelApi.ts

**Zweck:** Allgemeine Laravel API-Kommunikation.

**Funktionen:**

| Funktion | Beschreibung |
|----------|--------------|
| `loadGameState()` | Spielstand aus DB laden |
| `saveGameState()` | Spielstand in DB speichern |
| `getMunicipality()` | Gemeinde-Infos abrufen |
| `getCurrentUser()` | Aktueller Benutzer |

---

## Backend Services

### 1. GameMapApiController.php

**Pfad:** `meinort/app/Http/Controllers/Api/GameMapApiController.php`

**Partnership-Methoden:**

```php
// GET /municipality/{slug}/partnerships
public function getPartnerships(Municipality $municipality): JsonResponse

// POST /municipality/{slug}/partnerships/discover
public function discoverPartnership(Request $request, Municipality $municipality): JsonResponse

// POST /municipality/{slug}/partnerships/{partnerSlug}/connect
public function connectPartnership(Request $request, Municipality $municipality, string $partnerSlug): JsonResponse

// GET /municipality/{slug}/partnerships/trade-income
public function getTradeIncome(Municipality $municipality): JsonResponse
```

---

### 2. MunicipalityPartnership.php (Model)

**Pfad:** `meinort/app/Models/MunicipalityPartnership.php`

**Beziehungen:**
```php
// Die Gemeinde, die diese Partnerschaft hat
public function municipality(): BelongsTo

// Die Partner-Gemeinde
public function partner(): BelongsTo
```

**Scopes:**
```php
scopeDiscovered($query)  // Nur entdeckte
scopeConnected($query)   // Nur verbundene
scopeForMunicipality($query, $id)  // Für bestimmte Gemeinde
```

**Methoden:**
```php
isConnected(): bool
connect(): self
static getTotalTradeIncomeForMunicipality($id): int
static discoverPartner($municipalityId, $partnerId, $direction): self
```

---

### 3. Sync Server (Node.js)

**Pfad:** `sync-server/server.js`

**Socket.io Events:**

```javascript
// Raum-Management
socket.on('join-room', (roomCode) => { ... })
socket.on('leave-room', () => { ... })

// Game Sync
socket.on('delta', (delta) => { ... })
socket.on('full-state', (state) => { ... })
socket.on('stats-update', (stats) => { ... })

// Partnerships
socket.on('partnership-discovered', (data) => {
  socket.to(currentRoom).emit('partnership-discovered', data);
})
socket.on('partnership-connected', (data) => {
  socket.to(currentRoom).emit('partnership-connected', data);
})
```

---

## Datenfluss-Beispiele

### Beispiel 1: Stadt entdecken

```
┌──────────┐     ┌──────────────┐     ┌──────────┐     ┌─────────┐
│  User    │     │   Frontend   │     │  Laravel │     │  MySQL  │
│  Action  │     │   Service    │     │   API    │     │   DB    │
└────┬─────┘     └──────┬───────┘     └────┬─────┘     └────┬────┘
     │                  │                  │                │
     │ Baut Straße      │                  │                │
     │ zum Rand         │                  │                │
     ├─────────────────►│                  │                │
     │                  │                  │                │
     │                  │ discoverPartner  │                │
     │                  │ ship()           │                │
     │                  ├─────────────────►│                │
     │                  │                  │                │
     │                  │                  │ INSERT INTO    │
     │                  │                  │ municipality_  │
     │                  │                  │ partnerships   │
     │                  │                  ├───────────────►│
     │                  │                  │                │
     │                  │                  │◄───────────────┤
     │                  │◄─────────────────┤                │
     │                  │                  │                │
     │                  │ WebSocket:       │                │
     │                  │ partnership-     │                │
     │                  │ discovered       │                │
     │                  ├─────────────────►│ (Sync Server)  │
     │                  │                  │                │
     │◄─────────────────┤                  │                │
     │ Notification     │                  │                │
     │ "Stadt entdeckt" │                  │                │
     │                  │                  │                │
```

### Beispiel 2: Handelsroute etablieren

```
┌──────────┐     ┌──────────────┐     ┌──────────┐     ┌─────────┐
│  User    │     │   Frontend   │     │  Laravel │     │  MySQL  │
│  Action  │     │   Service    │     │   API    │     │   DB    │
└────┬─────┘     └──────┬───────┘     └────┬─────┘     └────┬────┘
     │                  │                  │                │
     │ Klick            │                  │                │
     │ "Verbinden"      │                  │                │
     ├─────────────────►│                  │                │
     │                  │                  │                │
     │                  │ connectPartner   │                │
     │                  │ ship()           │                │
     │                  ├─────────────────►│                │
     │                  │                  │                │
     │                  │                  │ UPDATE         │
     │                  │                  │ SET status=    │
     │                  │                  │ 'connected'    │
     │                  │                  ├───────────────►│
     │                  │                  │                │
     │                  │◄─────────────────┤                │
     │                  │ bonus: 5000      │                │
     │                  │ income: 200/mo   │                │
     │                  │                  │                │
     │◄─────────────────┤                  │                │
     │ +5000 CHF        │                  │                │
     │ +200 CHF/Monat   │                  │                │
     │                  │                  │                │
```

---

## API Routes (Laravel)

**Datei:** `meinort/routes/api_game.php`

```php
Route::prefix('/municipality/{municipality}/partnerships')->group(function () {
    // GET  /partnerships           → getPartnerships
    // POST /partnerships/discover  → discoverPartnership
    // POST /partnerships/{slug}/connect → connectPartnership
    // GET  /partnerships/trade-income → getTradeIncome
});
```

---

## Hooks (Frontend)

### useMultiplayerSync.ts

Verbindet GameContext mit WebSocket.

```typescript
// Registriert Callbacks für Partnership-Events
game.setPartnershipDiscoveredCallback((data) => {
  deltaQueue.sendPartnershipDiscovered(data);
});

// Empfängt Events von anderen Spielern
deltaQueue.setOnPartnershipDiscovered((data) => {
  game.discoverCity(cityId);
});
```

---

## Fehlerbehandlung

### Frontend
```typescript
try {
  await partnershipApi.discoverPartnership(...);
} catch (error) {
  console.error('API Fehler:', error.message);
  // Fallback auf lokale Logik
}
```

### Backend
```php
if (!$partner) {
    return response()->json([
        'success' => false,
        'error' => 'Partner municipality not found',
    ], 404);
}
```

---

*Letzte Aktualisierung: Februar 2026*
