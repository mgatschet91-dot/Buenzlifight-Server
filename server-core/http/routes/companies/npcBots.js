'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { hireNpcBot, fireNpcBot, getCompanyNpcBots } = require('../../../game/npcBots');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');

module.exports = function registerNpcBotRoutes(deps) {
  return async function handleNpcBots(req, res, pathname, requestUrl) {

    // GET /api/companies/:id/npc-bots — Liste aller NPCs dieser Firma
    const listMatch = pathname.match(/^\/api\/companies\/(\d+)\/npc-bots$/);
    if (req.method === 'GET' && listMatch) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(listMatch[1]);

      // Mitgliedschaft prüfen
      const [[member]] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`,
        [companyId, authUser.id]
      );
      if (!member) return sendJson(res, 403, { ok: false, error: 'Kein Mitglied dieser Firma' });

      // Firmentyp laden, damit nur passende NPC-Typen zurückgegeben werden
      const [[companyRow]] = await dbPool.query(
        `SELECT ct.code AS type_code FROM companies c
         JOIN company_types ct ON ct.id = c.company_type_id
         WHERE c.id = ?`, [companyId]
      );
      const typeCode = companyRow?.type_code || null;

      // Hat dieser Firmentyp eigene NPC-Typen? → nur diese zeigen
      // Sonst: universelle Typen (company_type_code IS NULL)
      const [[{ hasOwn }]] = await dbPool.query(
        `SELECT COUNT(*) AS hasOwn FROM npc_bot_types WHERE company_type_code = ?`,
        [typeCode]
      );
      const [types] = await dbPool.query(
        hasOwn > 0
          ? `SELECT * FROM npc_bot_types WHERE company_type_code = ? ORDER BY hire_cost ASC`
          : `SELECT * FROM npc_bot_types WHERE company_type_code IS NULL ORDER BY hire_cost ASC`,
        [typeCode]
      );
      const bots = await getCompanyNpcBots(companyId);
      return sendJson(res, 200, { ok: true, data: { bots, types } });
    }

    // POST /api/companies/:id/npc-bots/hire — NPC einstellen
    const hireMatch = pathname.match(/^\/api\/companies\/(\d+)\/npc-bots\/hire$/);
    if (req.method === 'POST' && hireMatch) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(hireMatch[1]);

      // Nur Owner/Manager dürfen einstellen
      const [[member]] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`,
        [companyId, authUser.id]
      );
      if (!member || !['owner', 'manager'].includes(member.role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Inhaber oder Manager können NPCs einstellen' });
      }

      const body = await readJsonBody(req);
      const botType = String(body?.bot_type || '');

      // Firma + Firmentyp laden
      const [[company]] = await dbPool.query(
        `SELECT c.municipality_id, ct.code AS type_code
         FROM companies c JOIN company_types ct ON ct.id = c.company_type_id
         WHERE c.id = ? AND c.is_active = 1`, [companyId]
      );
      if (!company) return sendJson(res, 404, { ok: false, error: 'Firma nicht gefunden' });

      // NPC-Typ validieren: muss in DB existieren und für diesen Firmentyp erlaubt sein
      const [[typeRow]] = await dbPool.query(
        `SELECT bot_type FROM npc_bot_types
         WHERE bot_type = ? AND (company_type_code IS NULL OR company_type_code = ?)`,
        [botType, company.type_code]
      );
      if (!typeRow) return sendJson(res, 400, { ok: false, error: 'Ungültiger NPC-Typ für diesen Firmentyp' });

      try {
        const result = await hireNpcBot(companyId, company.municipality_id, botType);
        return sendJson(res, 200, { ok: true, data: result, message: `${result.name} eingestellt!` });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // DELETE /api/companies/:id/npc-bots/:botId — NPC entlassen
    const fireMatch = pathname.match(/^\/api\/companies\/(\d+)\/npc-bots\/(\d+)$/);
    if (req.method === 'DELETE' && fireMatch) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(fireMatch[1]);
      const botId = Number(fireMatch[2]);

      const [[member]] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`,
        [companyId, authUser.id]
      );
      if (!member || !['owner', 'manager'].includes(member.role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Inhaber oder Manager können NPCs entlassen' });
      }

      await fireNpcBot(botId, companyId);
      return sendJson(res, 200, { ok: true, message: 'NPC entlassen.' });
    }

    // POST /api/companies/:id/npc-bots/:botId/patrol — Patrol-Modus umschalten
    const patrolMatch = pathname.match(/^\/api\/companies\/(\d+)\/npc-bots\/(\d+)\/patrol$/);
    if (req.method === 'POST' && patrolMatch) {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(patrolMatch[1]);
      const botId = Number(patrolMatch[2]);

      const [[member]] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`,
        [companyId, authUser.id]
      );
      if (!member || !['owner', 'manager'].includes(member.role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Inhaber oder Manager können den Patrol-Modus setzen' });
      }

      // NPC muss zur Firma gehören
      const [[bot]] = await dbPool.query(
        `SELECT id, patrol_mode, status FROM npc_bots WHERE id = ? AND company_id = ? AND status != 'fired'`,
        [botId, companyId]
      );
      if (!bot) return sendJson(res, 404, { ok: false, error: 'NPC nicht gefunden' });

      const newMode = bot.patrol_mode ? 0 : 1;

      if (newMode === 1) {
        // Aktuellen Patrol-NPC der Firma deaktivieren (max 1)
        await dbPool.query(
          `UPDATE npc_bots SET patrol_mode = 0 WHERE company_id = ? AND patrol_mode = 1`,
          [companyId]
        );
        // NPC aus laufendem Vertrag herauslösen wenn nötig
        if (bot.status === 'working') {
          await dbPool.query(
            `UPDATE company_contracts SET status = 'open', assigned_user_id = NULL, accepted_at = NULL, started_at = NULL, completable_at = NULL, work_duration_seconds = NULL
             WHERE id = (SELECT current_contract_id FROM npc_bots WHERE id = ?)
               AND status = 'in_progress'`,
            [botId]
          );
        }
        await dbPool.query(
          `UPDATE npc_bots SET patrol_mode = 1, status = 'idle', current_contract_id = NULL, contract_started_at = NULL WHERE id = ?`,
          [botId]
        );
      } else {
        await dbPool.query(
          `UPDATE npc_bots SET patrol_mode = 0 WHERE id = ?`, [botId]
        );
      }

      return sendJson(res, 200, {
        ok: true,
        data: { patrol_mode: newMode },
        message: newMode ? `${bot.id} ist jetzt Reparatur-Patrouille 🔧` : 'Patrol-Modus deaktiviert',
      });
    }
  };
};
