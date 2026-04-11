# Server Core - Phase 1

Eigenstaendiger Server ohne Laravel.

## Inhalt Phase 1

- Login / Registration
- Token-Auth (HMAC, JWT-aehnlich)
- Nutzerdatei in `storage/users.json`
- Konfiguration ueber `config.cfg`

## Start

```bash
cd server-core
npm start
```

## Migrationen ausfuehren (MySQL)

```bash
cd server-core
npm run migrate
```

Status pruefen:

```bash
npm run migrate:status
```

## Endpunkte

- `GET /health`
- `GET /api/municipalities`
- `GET /api/game-data/rivers?canton=ZH`
- `GET /api/game-data/rivers?municipality_slug=zurich`
- `GET /api/game-data/map/:municipalitySlug`
- `POST /api/game-data/map/:municipalitySlug`
- `GET /api/game/item-details`
- `GET /api/game/item-details/:tool`
- `GET /api/game/items/:municipalitySlug/:roomCode`
- `POST /api/game/items/:municipalitySlug/:roomCode/import`
- `POST /api/game/items/:municipalitySlug/:roomCode/sync`
- `DELETE /api/game/items/:municipalitySlug/:roomCode`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me` (Bearer Token)
- `POST /api/auth/logout` (Bearer Token, Session wird revoked)

## Beispiel Register

```json
{
  "email": "test@example.com",
  "password": "12345678",
  "nickname": "Marc"
}
```

## Start per BAT (Windows)

Im Projekt-Root:

```bat
start_core_server.bat
```
