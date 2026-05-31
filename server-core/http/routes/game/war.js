'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { ensureDbEnabled } = require('../../../infra/db');
const {
  executeAttack,
  getMunicipalityWarStatus,
  getAttackCosts,
  ATTACK_COSTS,
} = require('../../../game/warRelations');
const { getUserMunicipalityRole } = require('../../../game/municipality');

module.exports = function registerWarRoutes(deps) {
  return async function warRouteHandler(req, res, pathname) {

    // GET /api/game/war/:municipalityId/status — Krieg-Status einer Gemeinde
    const statusMatch = pathname.match(/^\/api\/game\/war\/(\d+)\/status$/i);
    if (statusMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const municipalityId = Number(statusMatch[1]);
      const status = await getMunicipalityWarStatus(municipalityId);
      return sendJson(res, 200, { ok: true, data: status });
    }

    // GET /api/game/war/costs — Angriffskosten
    const costsMatch = pathname.match(/^\/api\/game\/war\/costs$/i);
    if (costsMatch && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, data: ATTACK_COSTS });
    }

    // POST /api/game/war/attack — Angriff ausführen
    const attackMatch = pathname.match(/^\/api\/game\/war\/attack$/i);
    if (attackMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const body = await readJsonBody(req);
      const attackerId   = Number(body?.attacker_municipality_id || 0);
      const targetId     = Number(body?.target_municipality_id || 0);
      const attackType   = String(body?.attack_type || '');
      const minigameScore = Math.max(0, Math.min(100, Number(body?.minigame_score || 0)));

      if (!attackerId || !targetId || !attackType) {
        return sendJson(res, 422, { ok: false, error: 'attacker_municipality_id, target_municipality_id und attack_type erforderlich' });
      }
      if (attackerId === targetId) {
        return sendJson(res, 400, { ok: false, error: 'Eigene Gemeinde kann nicht angegriffen werden' });
      }

      // Nur Owner/Council darf angreifen
      const role = await getUserMunicipalityRole(authUser.id, attackerId);
      if (role !== 'owner' && role !== 'council') {
        return sendJson(res, 403, { ok: false, error: 'Nur Bürgermeister oder Gemeinderat kann angreifen' });
      }

      try {
        const result = await executeAttack({ attackerId, targetId, attackType, minigameScore });
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        const msgs = {
          INVALID_ATTACK_TYPE: 'Ungültiger Angriffs-Typ',
          ATTACKER_NOT_FOUND: 'Angreifer-Gemeinde nicht gefunden',
          INSUFFICIENT_FUNDS: 'Nicht genug Geld in der Treasury',
          ATTACK_COOLDOWN: 'Angriff erst in 6 Stunden wieder möglich',
        };
        return sendJson(res, 400, { ok: false, error: msgs[err.message] || err.message });
      }
    }

    return null;
  };
};
