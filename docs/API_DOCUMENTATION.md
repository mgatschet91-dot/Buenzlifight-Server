# MeinOrt Game API & Services Documentation

## Übersicht

Diese Dokumentation beschreibt die API-Endpunkte, Services und WebSocket-Events des MeinOrt Spiels.

---

## 1. Laravel Backend API

**Base URL:** `http://game.localhost:8000/api/game`

### 1.1 Authentifizierung

#### GET `/user`
Aktuellen Benutzer abrufen.

**Response:**
```json
{
  "success": true,
  "authenticated": true,
  "data": {
    "id": 1,
    "name": "Max Mustermann",
    "email": "max@example.com",
    "municipality_id": 107,
    "is_municipality_owner": true
  }
}
```

---

### 1.2 Municipality (Gemeinde)

#### GET `/municipality/{slug}`
Gemeinde-Daten abrufen.

**Parameter:**
| Name | Typ | Beschreibung |
|------|-----|--------------|
| slug | string | Gemeinde-Slug (z.B. "solothurn") |

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 107,
    "name": "Solothurn",
    "slug": "solothurn",
    "canton": "SO",
    "population": 16800,
    "owner": { "id": 1, "name": "Max" }
  }
}
```

---

### 1.3 Game State

#### GET `/municipality/{slug}/state`
Aktuellen Spielstand laden.

**Response:**
```json
{
  "success": true,
  "data": {
    "grid": [...],
    "gridSize": 50,
    "stats": {
      "money": 150000,
      "population": 1200,
      "jobs": 800,
      "happiness": 75
    },
    "buildings": [...],
    "adjacentCities": [...]
  }
}
```

#### POST `/municipality/{slug}/state`
Spielstand speichern.

**Body:**
```json
{
  "state": "<compressed-state-string>"
}
```

---

### 1.4 Partnerships (Handelspartner)

#### GET `/municipality/{slug}/partnerships`
Alle Partnerschaften einer Gemeinde laden.

**Response:**
```json
{
  "success": true,
  "data": {
    "partnerships": [
      {
        "id": 1,
        "partner": {
          "id": 377,
          "name": "Biezwil",
          "slug": "biezwil",
          "canton": "SO"
        },
        "status": "connected",
        "direction": "east",
        "trade_income": 200,
        "connection_bonus_paid": true,
        "discovered_at": "2026-02-06T14:56:39.000Z",
        "connected_at": "2026-02-06T14:56:40.000Z"
      }
    ],
    "total_trade_income": 400,
    "discovered_count": 2,
    "connected_count": 2
  }
}
```

#### POST `/municipality/{slug}/partnerships/discover`
Neue Partnerschaft entdecken (Stadt gefunden durch Straßenbau).

**Body:**
```json
{
  "partner_slug": "biezwil",
  "partner_name": "Biezwil",
  "direction": "east"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "partnership": {
      "id": 1,
      "partner": { "id": 377, "name": "Biezwil", "slug": "biezwil" },
      "status": "discovered",
      "direction": "east",
      "discovered_at": "2026-02-06T14:56:39.000Z"
    },
    "already_discovered": false,
    "message": "Du hast Biezwil entdeckt!"
  }
}
```

#### POST `/municipality/{slug}/partnerships/{partnerSlug}/connect`
Handelsroute mit Partner etablieren.

**Response:**
```json
{
  "success": true,
  "data": {
    "partnership": {
      "id": 1,
      "status": "connected",
      "connected_at": "2026-02-06T14:56:40.000Z"
    },
    "already_connected": false,
    "bonus_paid": 5000,
    "monthly_income": 200,
    "message": "Handelsroute mit Biezwil etabliert!"
  }
}
```

#### GET `/municipality/{slug}/partnerships/trade-income`
Gesamt-Handelseinkommen abrufen.

**Response:**
```json
{
  "success": true,
  "data": {
    "total_monthly_income": 400,
    "partnerships": [
      { "partner_name": "Biezwil", "partner_slug": "biezwil", "income": 200 },
      { "partner_name": "Hauenstein-Ifenthal", "partner_slug": "hauenstein-ifenthal", "income": 200 }
    ],
    "partnership_count": 2
  }
}
```

---

## 2. Frontend Services

### 2.1 Partnership API Service

**Datei:** `mapGame/src/lib/api/partnershipApi.ts`

```typescript
// Alle Partnerschaften laden
getPartnerships(municipalitySlug: string): Promise<PartnershipsResponse>

// Partnerschaft entdecken
discoverPartnership(
  municipalitySlug: string,
  partnerSlug: string,
  direction: 'north' | 'south' | 'east' | 'west',
  partnerName?: string
): Promise<DiscoverResponse>

// Partnerschaft verbinden
connectPartnership(
  municipalitySlug: string,
  partnerSlug: string
): Promise<ConnectResponse>

// Handelseinkommen abrufen
getTradeIncome(municipalitySlug: string): Promise<TradeIncomeResponse>
```

### 2.2 Laravel API Service

**Datei:** `mapGame/src/lib/api/laravelApi.ts`

```typescript
// Spielstand laden
loadGameState(municipalitySlug: string): Promise<GameState>

// Spielstand speichern
saveGameState(municipalitySlug: string, state: GameState): Promise<void>

// Gemeinde-Daten laden
getMunicipality(slug: string): Promise<Municipality>
```

### 2.3 Delta Sync Service

**Datei:** `mapGame/src/lib/deltaSync.ts`

Verwaltet die WebSocket-Verbindung für Echtzeit-Synchronisation.

```typescript
class DeltaQueue {
  // Verbindung initialisieren
  init(roomCode: string, playerId: string): void
  
  // Delta senden (Gebäude platzieren, etc.)
  sendDelta(delta: GameDelta): void
  
  // Partnerschaft-Events
  sendPartnershipDiscovered(data: PartnershipDiscoveredData): void
  sendPartnershipConnected(data: PartnershipConnectedData): void
  
  // Callbacks registrieren
  setOnDelta(callback: (delta: GameDelta) => void): void
  setOnPartnershipDiscovered(callback: (data) => void): void
  setOnPartnershipConnected(callback: (data) => void): void
}
```

---

## 3. WebSocket Events

**Server:** `sync-server/server.js` (Socket.io)

### 3.1 Verbindung

| Event | Richtung | Beschreibung |
|-------|----------|--------------|
| `join-room` | Client → Server | Raum beitreten |
| `leave-room` | Client → Server | Raum verlassen |
| `player-joined` | Server → Client | Spieler ist beigetreten |
| `player-left` | Server → Client | Spieler hat verlassen |

### 3.2 Game Sync

| Event | Richtung | Beschreibung |
|-------|----------|--------------|
| `delta` | Client ↔ Server | Spielaktion (Gebäude, Straße, etc.) |
| `full-state` | Client ↔ Server | Vollständiger Spielstand |
| `stats-update` | Client ↔ Server | Statistik-Update |

### 3.3 Partnerships

| Event | Richtung | Payload |
|-------|----------|---------|
| `partnership-discovered` | Client ↔ Server | `{ partnerSlug, partnerName, direction }` |
| `partnership-connected` | Client ↔ Server | `{ partnerSlug, partnerName, bonusPaid, monthlyIncome }` |

---

## 4. Datenbank-Struktur

### 4.1 municipality_partnerships

Speichert Handelsbeziehungen zwischen Gemeinden.

| Spalte | Typ | Beschreibung |
|--------|-----|--------------|
| id | bigint | Primary Key |
| municipality_id | bigint | FK → municipalities.id |
| partner_municipality_id | bigint | FK → municipalities.id |
| status | enum | 'discovered' oder 'connected' |
| direction | enum | 'north', 'south', 'east', 'west' |
| trade_income | int | Monatliches Einkommen (Standard: 200) |
| connection_bonus_paid | boolean | Einmalbonus ausgezahlt? |
| connection_bonus_amount | int | Bonusbetrag (Standard: 5000) |
| discovered_at | timestamp | Wann entdeckt |
| connected_at | timestamp | Wann verbunden |
| created_at | timestamp | Erstellt |
| updated_at | timestamp | Aktualisiert |

**Indexes:**
- `unique(municipality_id, partner_municipality_id)`
- `index(municipality_id, status)`
- `index(partner_municipality_id, status)`

---

## 5. Game Context (Frontend)

**Datei:** `mapGame/src/context/GameContext.tsx`

### 5.1 Partnership-Funktionen

```typescript
// Partnerschaften aus DB laden
loadPartnershipsFromApi(): Promise<void>

// Stadt entdecken (mit API-Call)
discoverCityWithApi(cityId: string): Promise<void>

// Stadt verbinden (mit API-Call)
connectToCityWithApi(cityId: string): Promise<void>

// WebSocket-Callbacks setzen
setPartnershipDiscoveredCallback(callback): void
setPartnershipConnectedCallback(callback): void
```

### 5.2 State-Struktur

```typescript
interface GameState {
  // ... andere Felder
  adjacentCities: AdjacentCity[];
  tradeIncome?: number;
}

interface AdjacentCity {
  id: string;
  name: string;
  slug?: string;
  direction: 'north' | 'south' | 'east' | 'west';
  population: number;
  distance: number;
  discovered: boolean;
  connected: boolean;
}
```

---

## 6. Beispiel-Flows

### 6.1 Stadt entdecken

1. Spieler baut Straße zum Kartenrand
2. `checkAndDiscoverCities()` wird aufgerufen
3. Frontend: `partnershipApi.discoverPartnership()` → Laravel API
4. API erstellt Eintrag in `municipality_partnerships`
5. WebSocket: `partnership-discovered` Event wird gesendet
6. Andere Spieler im Raum erhalten das Event

### 6.2 Handelsroute etablieren

1. Spieler klickt "Verbinden" bei entdeckter Stadt
2. `connectToCityWithApi(cityId)` wird aufgerufen
3. Frontend: `partnershipApi.connectPartnership()` → Laravel API
4. API aktualisiert Status auf 'connected', zahlt Bonus
5. WebSocket: `partnership-connected` Event wird gesendet
6. Spieler erhält 5000 CHF Bonus + 200 CHF/Monat

### 6.3 Spielstart - Partnerschaften laden

1. Spieler öffnet Gemeinde-Seite
2. `page.tsx` lädt Gemeinde-Daten
3. `setAdjacentCities()` setzt initiale Nachbarstädte
4. `loadPartnershipsFromApi()` lädt DB-Status
5. `adjacentCities` werden mit `discovered`/`connected` Flags aktualisiert

---

## 7. Fehlerbehandlung

### API-Fehler

```json
{
  "success": false,
  "error": "Fehlerbeschreibung"
}
```

### HTTP Status Codes

| Code | Bedeutung |
|------|-----------|
| 200 | Erfolg |
| 201 | Erstellt |
| 400 | Ungültige Anfrage |
| 401 | Nicht authentifiziert |
| 403 | Keine Berechtigung |
| 404 | Nicht gefunden |
| 500 | Server-Fehler |

---

## 8. Konfiguration

### Environment Variables

**Frontend (.env.local):**
```env
NEXT_PUBLIC_LARAVEL_API_URL=http://game.localhost:8000/api/game
NEXT_PUBLIC_WEBSOCKET_URL=http://localhost:3001
```

**Backend (.env):**
```env
APP_URL=http://game.localhost:8000
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_DATABASE=meinort
```

---

## 9. Debug-Panel

Das Debug-Panel (`Sidebar → Bug Icon`) bietet:

- **API-Test**: Verbindung zur Laravel API testen
- **Migration**: GameSave → MySQL migrieren
- **Status**: Aktuelle Gemeinde, Nachbarstädte, Partnerschaften

---

*Letzte Aktualisierung: Februar 2026*
