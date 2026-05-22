'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { logError } = require('../../../infra/logger');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { getUserXp } = require('../../../game/xp');
const { applyMunicipalityTransaction } = require('../../../game/bank');
const { getUserBalance, debitUserBankAccount } = require('../../../game/userBanking');
const { calcCompanyLevel } = require('./helpers');
const { defaultLoanOnDissolution } = require('../../../game/companyLoans');

module.exports = function registerManagementRoutes(deps) {
  return async function handleManagement(req, res, pathname, requestUrl) {

    // GET /api/companies/types — Alle Firmen-Typen
    if (req.method === 'GET' && pathname === '/api/companies/types') {
      ensureDbEnabled();
      const [rows] = await dbPool.query(`SELECT * FROM company_types WHERE is_active = 1 ORDER BY founding_cost ASC`);
      const types = rows.map(r => ({
        ...r,
        can_fix_categories: typeof r.can_fix_categories === 'string' ? JSON.parse(r.can_fix_categories) : (r.can_fix_categories || []),
      }));
      return sendJson(res, 200, { ok: true, data: { company_types: types } });
    }

    // GET /api/companies/my — Meine Firmen (als Owner oder Member)
    if (req.method === 'GET' && pathname === '/api/companies/my') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const [rows] = await dbPool.query(
        `SELECT c.*, ct.code AS type_code, ct.name AS type_name, ct.emoji AS type_emoji,
                cm.role AS my_role,
                (SELECT COUNT(*) FROM company_members WHERE company_id = c.id) AS member_count
         FROM company_members cm
         JOIN companies c ON c.id = cm.company_id
         JOIN company_types ct ON ct.id = c.company_type_id
         WHERE cm.user_id = ? AND c.is_active = 1
         ORDER BY cm.role = 'owner' DESC, c.name ASC`,
        [authUser.id]
      );
      for (const row of rows) {
        const correctLevel = calcCompanyLevel(row.reputation || 0);
        if (correctLevel !== (row.level || 1)) {
          await dbPool.query(`UPDATE companies SET level = ? WHERE id = ?`, [correctLevel, row.id]);
          row.level = correctLevel;
        }
      }
      return sendJson(res, 200, { ok: true, data: { companies: rows } });
    }

    // POST /api/companies — Firma gründen
    if (req.method === 'POST' && pathname === '/api/companies') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Du musst einer Gemeinde angehören' });

      const body = await readJsonBody(req);
      const companyName = String(body.name || '').trim();
      const companyTypeId = Number(body.company_type_id || 0);

      if (!companyName || companyName.length < 3 || companyName.length > 64) {
        return sendJson(res, 422, { ok: false, error: 'Firmenname muss 3-64 Zeichen lang sein' });
      }

      const [types] = await dbPool.query(`SELECT * FROM company_types WHERE id = ? AND is_active = 1`, [companyTypeId]);
      if (types.length === 0) return sendJson(res, 422, { ok: false, error: 'Ungültiger Firmen-Typ' });
      const companyType = types[0];

      const userXp = await getUserXp(authUser.id);
      if (userXp.level < companyType.min_level) {
        return sendJson(res, 400, { ok: false, error: `Level ${companyType.min_level} erforderlich (du bist Level ${userXp.level})` });
      }

      const [existing] = await dbPool.query(
        `SELECT c.id, c.name FROM companies c WHERE c.owner_id = ? AND c.is_active = 1`, [authUser.id]
      );
      if (existing.length >= 3) {
        return sendJson(res, 400, { ok: false, error: `Du hast bereits 3 Firmen — das ist das Maximum.` });
      }

      // Werkhof: nur 1× pro Gemeinde erlaubt, keine Gründungskosten (Gemeinde ist der Träger)
      if (companyType.code === 'werkhof') {
        const [werkhofExisting] = await dbPool.query(
          `SELECT c.id, c.name FROM companies c
           JOIN company_types ct ON ct.id = c.company_type_id
           WHERE c.municipality_id = ? AND ct.code = 'werkhof' AND c.is_active = 1`,
          [authUser.municipality_id]
        );
        if (werkhofExisting.length > 0) {
          return sendJson(res, 400, {
            ok: false,
            error: `Diese Gemeinde hat bereits einen Werkhof: "${werkhofExisting[0].name}". Pro Gemeinde ist nur ein Werkhof erlaubt.`,
          });
        }
        // Werkhof ist kostenlos — Gemeinde gründet ihn direkt
      } else {
        // User-Konto prüfen (Firmengründung wird vom persönlichen Konto bezahlt)
        const userBalance = await getUserBalance(authUser.id);
        if (userBalance < companyType.founding_cost) {
          return sendJson(res, 400, {
            ok: false,
            error: `Nicht genug CHF auf deinem Konto (${userBalance.toLocaleString()}/${companyType.founding_cost.toLocaleString()})`,
            data: {
              insufficient_funds: true,
              user_balance: userBalance,
              founding_cost: companyType.founding_cost,
              gap: companyType.founding_cost - userBalance,
              can_request_loan: true,
            },
          });
        }
      }

      const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 64) || 'firma';
      const [slugCheck] = await dbPool.query(`SELECT id FROM companies WHERE slug = ?`, [slug]);
      const finalSlug = slugCheck.length > 0 ? slug + '-' + Date.now() : slug;

      // Gründungskosten vom User-Konto abziehen (nicht bei Werkhof — kostenlos)
      if (companyType.code !== 'werkhof') {
        await debitUserBankAccount(authUser.id, {
          amount: companyType.founding_cost,
          type: 'company_founding',
          description: `Firmengründung: ${companyName} (${companyType.name})`,
          reference: `company_founding`,
          meta: { companyName, companyTypeCode: companyType.code },
        });
      }

      const [result] = await dbPool.query(
        `INSERT INTO companies (company_type_id, name, slug, owner_id, municipality_id, balance, founded_at)
         VALUES (?, ?, ?, ?, ?, 0, NOW())`,
        [companyTypeId, companyName, finalSlug, authUser.id, authUser.municipality_id]
      );
      const companyId = result.insertId;

      await dbPool.query(
        `INSERT INTO company_members (company_id, user_id, role) VALUES (?, ?, 'owner')`,
        [companyId, authUser.id]
      );

      if (companyType.code !== 'werkhof' && companyType.founding_cost > 0) {
        await dbPool.query(
          `INSERT INTO company_finances (company_id, amount, balance_after, reason, description)
           VALUES (?, ?, 0, 'founding_cost', ?)`,
          [companyId, -companyType.founding_cost, `Firmengründung: ${companyName}`]
        );
      }

      try {
        await dbPool.query(`INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, 'ACH_Company1')`, [authUser.id]);
      } catch (_) {}

      const [newCompany] = await dbPool.query(
        `SELECT c.*, ct.code AS type_code, ct.name AS type_name, ct.emoji AS type_emoji
         FROM companies c JOIN company_types ct ON ct.id = c.company_type_id WHERE c.id = ?`, [companyId]
      );

      return sendJson(res, 201, {
        ok: true,
        data: {
          company: newCompany[0],
        },
      });
    }

    // GET /api/companies/:id — Firma-Details
    const companyDetailMatch = pathname.match(/^\/api\/companies\/([0-9]+)$/i);
    if (companyDetailMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyDetailMatch[1]);

      const [companies] = await dbPool.query(
        `SELECT c.*, ct.code AS type_code, ct.name AS type_name, ct.emoji AS type_emoji,
                ct.can_fix_categories, ct.max_members
         FROM companies c
         JOIN company_types ct ON ct.id = c.company_type_id
         WHERE c.id = ? AND c.is_active = 1`, [companyId]
      );
      if (companies.length === 0) return sendJson(res, 404, { ok: false, error: 'Firma nicht gefunden' });
      const company = companies[0];
      company.can_fix_categories = typeof company.can_fix_categories === 'string'
        ? JSON.parse(company.can_fix_categories) : (company.can_fix_categories || []);

      const correctLevel = calcCompanyLevel(company.reputation || 0);
      if (correctLevel !== (company.level || 1)) {
        await dbPool.query(`UPDATE companies SET level = ? WHERE id = ?`, [correctLevel, companyId]);
        company.level = correctLevel;
      }

      const [members] = await dbPool.query(
        `SELECT cm.*, u.nickname,
                (SELECT level FROM user_xp WHERE user_id = cm.user_id) AS user_level
         FROM company_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.company_id = ?
         ORDER BY FIELD(cm.role, 'owner', 'manager', 'employee'), cm.joined_at ASC`,
        [companyId]
      );

      const [finances] = await dbPool.query(
        `SELECT * FROM company_finances WHERE company_id = ? ORDER BY created_at DESC LIMIT 20`,
        [companyId]
      );

      const { calcWorkDuration } = require('./helpers');
      const [rawContracts] = await dbPool.query(
        `SELECT cc.*, et.name AS event_name, et.emoji AS event_emoji, me.status AS event_status,
                u.nickname AS assigned_nickname,
                nb.name AS npc_name, nb.bot_type AS npc_bot_type
         FROM company_contracts cc
         JOIN municipality_events me ON me.id = cc.event_id
         JOIN event_types et ON et.id = me.event_type_id
         LEFT JOIN users u ON u.id = cc.assigned_user_id
         LEFT JOIN npc_bots nb ON nb.current_contract_id = cc.id AND nb.status = 'working'
         WHERE cc.company_id = ?
         ORDER BY FIELD(cc.status, 'accepted','in_progress','open','assigned','completed','failed','cancelled'), cc.deadline_at ASC
         LIMIT 50`,
        [companyId]
      );
      const contracts = rawContracts.map(c => {
        if (c.status === 'open' && !c.work_duration_seconds) {
          c.work_duration_seconds = calcWorkDuration(c.difficulty, company.level || 1);
        }
        return c;
      });

      let applications = [];
      const [myMembership] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      const myRole = myMembership[0]?.role || null;
      if (myRole === 'owner' || myRole === 'manager') {
        const [apps] = await dbPool.query(
          `SELECT ca.*, u.nickname FROM company_applications ca
           JOIN users u ON u.id = ca.user_id
           WHERE ca.company_id = ? AND ca.status = 'pending'
           ORDER BY ca.created_at ASC`,
          [companyId]
        );
        applications = apps;
      }

      return sendJson(res, 200, {
        ok: true,
        data: {
          company,
          members,
          finances,
          contracts,
          applications,
          my_role: myRole,
          my_user_id: authUser.id,
        },
      });
    }

    // PATCH /api/companies/:id — Firma bearbeiten (Name/Beschreibung)
    if (companyDetailMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyDetailMatch[1]);

      const [myRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myRole[0] || myRole[0].role !== 'owner') {
        return sendJson(res, 403, { ok: false, error: 'Nur der Inhaber kann die Firma bearbeiten' });
      }

      const body = await readJsonBody(req);
      const updates = [];
      const params = [];

      if (body.name && typeof body.name === 'string') {
        const newName = body.name.trim();
        if (newName.length < 3 || newName.length > 64) {
          return sendJson(res, 422, { ok: false, error: 'Firmenname muss 3-64 Zeichen lang sein' });
        }
        updates.push('name = ?');
        params.push(newName);
      }

      if (updates.length === 0) {
        return sendJson(res, 422, { ok: false, error: 'Keine Änderungen angegeben' });
      }

      params.push(companyId);
      await dbPool.query(`UPDATE companies SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);

      const [updated] = await dbPool.query(`SELECT * FROM companies WHERE id = ?`, [companyId]);
      return sendJson(res, 200, { ok: true, data: { company: updated[0] } });
    }

    // DELETE /api/companies/:id — Firma auflösen
    if (companyDetailMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyDetailMatch[1]);

      const [myRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myRole[0] || myRole[0].role !== 'owner') {
        return sendJson(res, 403, { ok: false, error: 'Nur der Inhaber kann die Firma auflösen' });
      }

      const [activeContracts] = await dbPool.query(
        `SELECT COUNT(*) AS cnt FROM company_contracts WHERE company_id = ? AND status IN ('open','accepted','assigned')`,
        [companyId]
      );
      if (activeContracts[0].cnt > 0) {
        return sendJson(res, 400, { ok: false, error: 'Firma hat noch aktive Aufträge — diese müssen erst abgeschlossen werden' });
      }

      const [company] = await dbPool.query(`SELECT balance, name, municipality_id FROM companies WHERE id = ?`, [companyId]);
      if (company[0]?.balance > 0) {
        await applyMunicipalityTransaction(company[0].municipality_id, {
          amount: company[0].balance,
          type: 'company_dissolve',
          meta: { companyId, companyName: company[0].name },
          actorUserId: authUser.id,
          source: 'user',
        });
      }

      // Offenen Kredit als defaulted markieren (Verlust für Gemeinde)
      let loanLoss = 0;
      try {
        const loanResult = await defaultLoanOnDissolution(companyId);
        if (loanResult) {
          loanLoss = loanResult.remainingDebt;
        }
      } catch (err) {
        logError('COMPANY', `Kredit-Default bei Auflösung fehlgeschlagen: ${err.message}`, { companyId });
      }

      await dbPool.query(`UPDATE companies SET is_active = 0, updated_at = NOW() WHERE id = ?`, [companyId]);
      await dbPool.query(`DELETE FROM company_members WHERE company_id = ?`, [companyId]);

      return sendJson(res, 200, { ok: true, data: { dissolved: true, refund_to_treasury: company[0]?.balance || 0, loan_loss: loanLoss } });
    }

    // POST /api/companies/:id/members/invite — Mitglied einladen
    const companyMembersInviteMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/members\/invite$/i);
    if (companyMembersInviteMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyMembersInviteMatch[1]);

      const [myRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myRole[0] || !['owner', 'manager'].includes(myRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Inhaber oder Manager können Mitglieder einladen' });
      }

      const body = await readJsonBody(req);
      const targetUserId = Number(body.user_id || 0);
      if (!targetUserId) return sendJson(res, 422, { ok: false, error: 'user_id erforderlich' });

      const [targetUser] = await dbPool.query(`SELECT id, nickname FROM users WHERE id = ?`, [targetUserId]);
      if (targetUser.length === 0) return sendJson(res, 404, { ok: false, error: 'User nicht gefunden' });

      const [existingMember] = await dbPool.query(
        `SELECT id FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, targetUserId]
      );
      if (existingMember.length > 0) return sendJson(res, 400, { ok: false, error: 'User ist bereits Mitglied' });

      // Max 3 Mitgliedschaften als Angestellter/Manager (nicht als Inhaber)
      const [nonOwnerMemberships] = await dbPool.query(
        `SELECT COUNT(*) AS cnt FROM company_members cm
         JOIN companies c ON c.id = cm.company_id
         WHERE cm.user_id = ? AND cm.role != 'owner' AND c.is_active = 1`,
        [targetUserId]
      );
      if ((nonOwnerMemberships[0]?.cnt || 0) >= 3) {
        return sendJson(res, 400, { ok: false, error: `${targetUser[0].nickname} ist bereits in 3 Firmen als Mitarbeiter/Manager — das ist das Maximum.` });
      }

      const [companyInfo] = await dbPool.query(
        `SELECT c.id, ct.max_members, (SELECT COUNT(*) FROM company_members WHERE company_id = c.id) AS current_members
         FROM companies c JOIN company_types ct ON ct.id = c.company_type_id WHERE c.id = ?`, [companyId]
      );
      if (companyInfo[0]?.current_members >= companyInfo[0]?.max_members) {
        return sendJson(res, 400, { ok: false, error: `Firma ist voll (${companyInfo[0].max_members} Mitglieder max.)` });
      }

      const role = body.role === 'manager' ? 'manager' : 'employee';
      await dbPool.query(
        `INSERT INTO company_members (company_id, user_id, role) VALUES (?, ?, ?)`,
        [companyId, targetUserId, role]
      );

      return sendJson(res, 200, { ok: true, data: { invited: true, user_id: targetUserId, role } });
    }

    // DELETE /api/companies/:id/members/:userId — Mitglied entfernen
    const companyMemberRemoveMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/members\/([0-9]+)$/i);
    if (companyMemberRemoveMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyMemberRemoveMatch[1]);
      const targetUserId = Number(companyMemberRemoveMatch[2]);

      const [myRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      const [targetRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, targetUserId]
      );
      if (!myRole[0]) return sendJson(res, 403, { ok: false, error: 'Keine Berechtigung' });
      if (!targetRole[0]) return sendJson(res, 404, { ok: false, error: 'Mitglied nicht gefunden' });
      if (targetRole[0].role === 'owner') return sendJson(res, 400, { ok: false, error: 'Inhaber kann nicht entfernt werden' });

      if (myRole[0].role === 'manager' && targetRole[0].role !== 'employee') {
        return sendJson(res, 403, { ok: false, error: 'Manager können nur Mitarbeiter entfernen' });
      }
      if (myRole[0].role === 'employee') {
        if (Number(authUser.id) !== targetUserId) {
          return sendJson(res, 403, { ok: false, error: 'Du kannst nur dich selbst aus der Firma entfernen' });
        }
      }

      await dbPool.query(
        `DELETE FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, targetUserId]
      );

      // Cooldown-Log: 'left' wenn selbst, 'kicked' wenn von Admin/Manager entfernt
      const isKick = Number(authUser.id) !== targetUserId;
      await dbPool.query(
        `INSERT INTO company_member_log (company_id, user_id, reason) VALUES (?, ?, ?)`,
        [companyId, targetUserId, isKick ? 'kicked' : 'left']
      ).catch(() => {});

      return sendJson(res, 200, { ok: true, data: { removed: true, user_id: targetUserId } });
    }

    // PATCH /api/companies/:id/members/:userId/role — Rolle ändern
    const companyMemberRoleMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/members\/([0-9]+)\/role$/i);
    if (companyMemberRoleMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyMemberRoleMatch[1]);
      const targetUserId = Number(companyMemberRoleMatch[2]);

      const [myRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myRole[0] || myRole[0].role !== 'owner') {
        return sendJson(res, 403, { ok: false, error: 'Nur der Inhaber kann Rollen ändern' });
      }

      const body = await readJsonBody(req);
      const newRole = body.role;
      if (!['manager', 'employee'].includes(newRole)) {
        return sendJson(res, 422, { ok: false, error: 'Rolle muss "manager" oder "employee" sein' });
      }

      const [targetMember] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, targetUserId]
      );
      if (!targetMember[0]) return sendJson(res, 404, { ok: false, error: 'Mitglied nicht gefunden' });
      if (targetMember[0].role === 'owner') return sendJson(res, 400, { ok: false, error: 'Inhaber-Rolle kann nicht geändert werden' });

      await dbPool.query(
        `UPDATE company_members SET role = ?, updated_at = NOW() WHERE company_id = ? AND user_id = ?`,
        [newRole, companyId, targetUserId]
      );

      return sendJson(res, 200, { ok: true, data: { user_id: targetUserId, new_role: newRole } });
    }

    // GET /api/companies/:id/finances — Finanz-History
    const companyFinancesMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/finances$/i);
    if (companyFinancesMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyFinancesMatch[1]);

      const [myMembership] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myMembership[0]) return sendJson(res, 403, { ok: false, error: 'Nur Firmenmitglieder sehen Finanzen' });

      const limit = Math.min(Number(requestUrl.searchParams.get('limit') || 50), 100);
      const [rows] = await dbPool.query(
        `SELECT * FROM company_finances WHERE company_id = ? ORDER BY created_at DESC LIMIT ?`,
        [companyId, limit]
      );

      return sendJson(res, 200, { ok: true, data: { finances: rows } });
    }

    // ================================================================
    // COMPANY APPLICATIONS
    // ================================================================

    // POST /api/companies/:id/apply — Sich bei Firma bewerben
    const companyApplyMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/apply$/i);
    if (companyApplyMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyApplyMatch[1]);

      const [companies] = await dbPool.query(`SELECT id, name FROM companies WHERE id = ? AND is_active = 1`, [companyId]);
      if (companies.length === 0) return sendJson(res, 404, { ok: false, error: 'Firma nicht gefunden' });

      const [existingMember] = await dbPool.query(
        `SELECT id FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (existingMember.length > 0) return sendJson(res, 400, { ok: false, error: 'Du bist bereits Mitglied' });

      const [existingApp] = await dbPool.query(
        `SELECT id, status FROM company_applications WHERE company_id = ? AND user_id = ? AND status = 'pending'`,
        [companyId, authUser.id]
      );
      if (existingApp.length > 0) return sendJson(res, 400, { ok: false, error: 'Du hast bereits eine offene Bewerbung bei dieser Firma' });

      // 5-Tage-Cooldown nach Verlassen oder Kick
      const [recentLog] = await dbPool.query(
        `SELECT reason, removed_at FROM company_member_log
         WHERE company_id = ? AND user_id = ? AND removed_at > NOW() - INTERVAL 5 DAY
         ORDER BY removed_at DESC LIMIT 1`,
        [companyId, authUser.id]
      );
      if (recentLog.length > 0) {
        const entry = recentLog[0];
        const removedAt = new Date(entry.removed_at);
        const cooldownUntil = new Date(removedAt.getTime() + 5 * 24 * 60 * 60 * 1000);
        const daysLeft = Math.ceil((cooldownUntil - new Date()) / (1000 * 60 * 60 * 24));
        const reason = entry.reason === 'kicked' ? 'gekickt wurdest' : 'die Firma verlassen hast';
        return sendJson(res, 400, {
          ok: false,
          error: `Du kannst dich erst wieder bewerben, weil du ${reason}. Noch ${daysLeft} Tag${daysLeft !== 1 ? 'e' : ''} Wartezeit.`,
        });
      }

      const body = await readJsonBody(req);
      const message = String(body.message || '').trim().substring(0, 500) || null;

      await dbPool.query(
        `INSERT INTO company_applications (company_id, user_id, message) VALUES (?, ?, ?)`,
        [companyId, authUser.id, message]
      );

      return sendJson(res, 200, { ok: true, data: { applied: true, company_name: companies[0].name } });
    }

    // POST /api/companies/:id/applications/:appId/respond — Bewerbung annehmen/ablehnen
    const companyAppRespondMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/applications\/([0-9]+)\/respond$/i);
    if (companyAppRespondMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyAppRespondMatch[1]);
      const applicationId = Number(companyAppRespondMatch[2]);

      const [myRole] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myRole[0] || !['owner', 'manager'].includes(myRole[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Keine Berechtigung' });
      }

      const body = await readJsonBody(req);
      const decision = body.decision;
      if (!['accepted', 'rejected'].includes(decision)) {
        return sendJson(res, 422, { ok: false, error: 'decision muss "accepted" oder "rejected" sein' });
      }

      const [apps] = await dbPool.query(
        `SELECT * FROM company_applications WHERE id = ? AND company_id = ? AND status = 'pending'`,
        [applicationId, companyId]
      );
      if (apps.length === 0) return sendJson(res, 404, { ok: false, error: 'Bewerbung nicht gefunden' });
      const application = apps[0];

      await dbPool.query(
        `UPDATE company_applications SET status = ?, responded_by = ?, responded_at = NOW(), updated_at = NOW() WHERE id = ?`,
        [decision, authUser.id, applicationId]
      );

      if (decision === 'accepted') {
        const [companyInfo] = await dbPool.query(
          `SELECT c.id, ct.max_members, (SELECT COUNT(*) FROM company_members WHERE company_id = c.id) AS current_members
           FROM companies c JOIN company_types ct ON ct.id = c.company_type_id WHERE c.id = ?`, [companyId]
        );
        if (companyInfo[0]?.current_members >= companyInfo[0]?.max_members) {
          return sendJson(res, 400, { ok: false, error: 'Firma ist voll — Bewerbung kann nicht angenommen werden' });
        }

        // Max 3 Mitgliedschaften als Angestellter/Manager (nicht als Inhaber)
        const [nonOwnerMemberships] = await dbPool.query(
          `SELECT COUNT(*) AS cnt FROM company_members cm
           JOIN companies c ON c.id = cm.company_id
           WHERE cm.user_id = ? AND cm.role != 'owner' AND c.is_active = 1`,
          [application.user_id]
        );
        if ((nonOwnerMemberships[0]?.cnt || 0) >= 3) {
          return sendJson(res, 400, { ok: false, error: 'Bewerber ist bereits in 3 Firmen als Mitarbeiter/Manager — Bewerbung kann nicht angenommen werden.' });
        }

        await dbPool.query(
          `INSERT IGNORE INTO company_members (company_id, user_id, role) VALUES (?, ?, 'employee')`,
          [companyId, application.user_id]
        );
      }

      return sendJson(res, 200, { ok: true, data: { application_id: applicationId, decision } });
    }

    // GET /api/companies/municipality/:slugOrId — Oeffentlich, kein Auth noetig
    const municipalityCompaniesMatch = pathname.match(/^\/api\/companies\/municipality\/([^/]+)$/);
    if (municipalityCompaniesMatch && req.method === 'GET') {
      ensureDbEnabled();
      const slugOrId = municipalityCompaniesMatch[1];
      const typeCode = requestUrl.searchParams?.get?.('type') || null;

      const [munRows] = await dbPool.query(
        `SELECT id FROM municipalities WHERE slug = ? OR id = ?`, [slugOrId, Number(slugOrId) || 0]
      );
      if (!munRows.length) return sendJson(res, 404, { ok: false, error: 'Gemeinde nicht gefunden' });
      const municipalityId = munRows[0].id;

      let sql = `
        SELECT c.id, c.name, c.level, c.reputation, ct.code AS type_code, ct.emoji,
               (SELECT COUNT(*) FROM company_members cm WHERE cm.company_id = c.id) AS member_count,
               (SELECT COUNT(*) FROM bus_lines bl WHERE bl.company_id = c.id AND bl.status = 'active') AS active_line_count,
               (SELECT COUNT(*) FROM bus_line_stops bls JOIN bus_lines bl ON bl.id = bls.bus_line_id WHERE bl.company_id = c.id AND bl.status = 'active') AS active_stop_count
        FROM companies c
        JOIN company_types ct ON ct.id = c.company_type_id
        WHERE c.municipality_id = ? AND c.is_active = 1
      `;
      const params = [municipalityId];
      if (typeCode) { sql += ` AND ct.code = ?`; params.push(typeCode); }
      sql += ` ORDER BY c.level DESC, c.name ASC`;

      const [rows] = await dbPool.query(sql, params);
      return sendJson(res, 200, { ok: true, data: { companies: rows } });
    }

  };
};
