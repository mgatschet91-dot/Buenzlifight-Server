'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { awardXp } = require('../../../game/xp');
const { applyMunicipalityTransaction } = require('../../../game/bank');
const { creditUserBankAccount } = require('../../../game/userBanking');
const { createUserNotification } = require('../../../game/notifications');
const { resolveBuenzliEvent } = require('../../../game/buenzli');
const { calcCompanyLevel, calcWorkDuration, CONTRACT_WORKER_PAYOUT_SHARE } = require('./helpers');

module.exports = function registerContractRoutes(deps) {
  return async function handleContracts(req, res, pathname, requestUrl) {

    // GET /api/companies/:id/contracts — Aufträge
    const companyContractsMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/contracts$/i);
    if (companyContractsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyContractsMatch[1]);

      const [myMembership] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!myMembership[0]) return sendJson(res, 403, { ok: false, error: 'Nur Firmenmitglieder sehen Aufträge' });

      const statusFilter = requestUrl.searchParams.get('status') || null;
      let query = `SELECT cc.*, et.name AS event_name, et.emoji AS event_emoji,
                          me.status AS event_status, m.name AS municipality_name
                   FROM company_contracts cc
                   JOIN municipality_events me ON me.id = cc.event_id
                   JOIN event_types et ON et.id = me.event_type_id
                   JOIN municipalities m ON m.id = cc.municipality_id
                   WHERE cc.company_id = ?`;
      const queryParams = [companyId];
      if (statusFilter) {
        query += ` AND cc.status = ?`;
        queryParams.push(statusFilter);
      }
      query += ` ORDER BY cc.created_at DESC LIMIT 50`;

      const [rows] = await dbPool.query(query, queryParams);
      return sendJson(res, 200, { ok: true, data: { contracts: rows } });
    }

    // POST /api/companies/:id/contracts/:cid/accept — Auftrag annehmen
    const contractAcceptMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/contracts\/([0-9]+)\/accept$/i);
    if (contractAcceptMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(contractAcceptMatch[1]);
      const contractId = Number(contractAcceptMatch[2]);

      const [membership] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!membership[0]) return sendJson(res, 403, { ok: false, error: 'Nur Firmenmitglieder' });

      // Veraltete feststeckende Contracts automatisch abschliessen (completable_at > 24h überschritten)
      await dbPool.query(
        `UPDATE company_contracts SET status = 'completed', completed_at = NOW()
         WHERE assigned_user_id = ? AND status IN ('accepted','assigned')
           AND completable_at IS NOT NULL AND completable_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
        [authUser.id]
      );

      const [activeContracts] = await dbPool.query(
        `SELECT cc.id, et.name AS event_name FROM company_contracts cc
         JOIN municipality_events me ON me.id = cc.event_id
         JOIN event_types et ON et.id = me.event_type_id
         WHERE cc.assigned_user_id = ? AND cc.status IN ('accepted','assigned')
         LIMIT 3`,
        [authUser.id]
      );
      if (activeContracts.length >= 3) {
        return sendJson(res, 400, {
          ok: false,
          error: `Du hast bereits 3 aktive Aufträge. Schliesse zuerst einen ab.`,
          active_contract_id: activeContracts[0].id,
        });
      }

      const [contracts] = await dbPool.query(
        `SELECT * FROM company_contracts WHERE id = ? AND company_id = ? AND status = 'open'`, [contractId, companyId]
      );
      if (contracts.length === 0) return sendJson(res, 404, { ok: false, error: 'Auftrag nicht gefunden oder bereits angenommen' });

      const contract = contracts[0];

      const [companyRows] = await dbPool.query(`SELECT level FROM companies WHERE id = ?`, [companyId]);
      const companyLevel = companyRows[0]?.level || 1;

      const workDuration = calcWorkDuration(contract.difficulty, companyLevel);
      const now = new Date();
      const completableAt = new Date(now.getTime() + workDuration * 1000);

      await dbPool.query(
        `UPDATE company_contracts
         SET status = 'accepted',
             assigned_user_id = ?,
             accepted_at = ?,
             started_at = ?,
             work_duration_seconds = ?,
             completable_at = ?
         WHERE id = ?`,
        [authUser.id, now, now, workDuration, completableAt, contractId]
      );

      return sendJson(res, 200, {
        ok: true,
        data: {
          accepted: true,
          work_duration_seconds: workDuration,
          completable_at: completableAt.toISOString(),
          assigned_user_id: authUser.id,
        },
      });
    }

    // POST /api/companies/:id/contracts/:cid/complete — Auftrag abschließen
    const contractCompleteMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/contracts\/([0-9]+)\/complete$/i);
    if (contractCompleteMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(contractCompleteMatch[1]);
      const contractId = Number(contractCompleteMatch[2]);

      const [membership] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!membership[0]) return sendJson(res, 403, { ok: false, error: 'Nur Firmenmitglieder' });

      const [contracts] = await dbPool.query(
        `SELECT * FROM company_contracts WHERE id = ? AND company_id = ? AND status IN ('accepted','assigned')`, [contractId, companyId]
      );
      if (contracts.length === 0) return sendJson(res, 404, { ok: false, error: 'Kein aktiver Auftrag' });

      const contract = contracts[0];

      if (contract.assigned_user_id && contract.assigned_user_id !== authUser.id) {
        return sendJson(res, 403, { ok: false, error: 'Nur der zugewiesene Mitarbeiter kann diesen Auftrag abschließen' });
      }

      const completableAt = contract.completable_at ? new Date(contract.completable_at) : null;
      if (completableAt) {
        const now = new Date();
        if (now < completableAt) {
          const remainingSec = Math.ceil((completableAt - now) / 1000);
          const hrs = Math.floor(remainingSec / 3600);
          const mins = Math.floor((remainingSec % 3600) / 60);
          const secs = remainingSec % 60;
          let timeStr = '';
          if (hrs > 0) timeStr += `${hrs} Std. `;
          if (mins > 0) timeStr += `${mins} Min. `;
          if (hrs === 0) timeStr += `${secs} Sek.`;
          return sendJson(res, 400, {
            ok: false,
            error: `Arbeitszeit läuft noch! Noch ${timeStr.trim()} bis der Auftrag abgeschlossen werden kann.`,
            remaining_seconds: remainingSec,
            completable_at: completableAt.toISOString(),
          });
        }
      }

      await dbPool.query(
        `UPDATE company_contracts SET status = 'completed', completed_at = NOW() WHERE id = ?`, [contractId]
      );

      // Steuer-System v1: Firmensteuer nutzt den Business-Anteil der Gemeinde-TaxRate
      let taxRate = 10;
      if (contract.municipality_id) {
        const [msRows] = await dbPool.query(
          `SELECT tax_rate FROM municipality_stats WHERE municipality_id = ? LIMIT 1`, [contract.municipality_id]
        );
        if (msRows.length > 0 && msRows[0].tax_rate != null) {
          taxRate = Number(msRows[0].tax_rate) || 10;
        }
      }
      const businessTaxRate = Math.max(0, Number((taxRate * 0.32).toFixed(2)));
      const taxAmount = Math.round(contract.payment * businessTaxRate / 100);
      const baseNetPayment = contract.payment - taxAmount;

      // Satisfaction-Multiplikator: schlechte Zufriedenheit = weniger Einnahmen (min. 60%)
      let satisfaction = 50;
      if (contract.municipality_id) {
        const [satRows] = await dbPool.query(
          `SELECT citizen_satisfaction FROM municipality_stats WHERE municipality_id = ? LIMIT 1`, [contract.municipality_id]
        );
        if (satRows.length > 0 && satRows[0].citizen_satisfaction != null) {
          satisfaction = Math.max(0, Math.min(100, Number(satRows[0].citizen_satisfaction) || 50));
        }
      }
      const satisfactionMultiplier = Math.round((0.6 + satisfaction / 250) * 100) / 100;
      const netPayment = Math.round(baseNetPayment * satisfactionMultiplier);

      const reputationGain = contract.difficulty * 2;
      await dbPool.query(
        `UPDATE companies SET balance = balance + ?, total_contracts = total_contracts + 1, total_revenue = total_revenue + ?, reputation = reputation + ? WHERE id = ?`,
        [netPayment, contract.payment, reputationGain, companyId]
      );

      const [companyAfter] = await dbPool.query(`SELECT balance, reputation, level, name FROM companies WHERE id = ?`, [companyId]);
      const currentRep = companyAfter[0].reputation;
      const newLevel = calcCompanyLevel(currentRep);
      const oldLevel = companyAfter[0].level;
      let leveledUp = false;
      if (newLevel > oldLevel) {
        await dbPool.query(`UPDATE companies SET level = ? WHERE id = ?`, [newLevel, companyId]);
        leveledUp = true;
      }

      await dbPool.query(
        `INSERT INTO company_finances (company_id, amount, balance_after, reason, description, ref_type, ref_id)
         VALUES (?, ?, ?, 'contract_payment', ?, 'contract', ?)`,
        [companyId, netPayment, companyAfter[0].balance, `Auftrag #${contractId} abgeschlossen (${businessTaxRate}% Firmensteuer: ${taxAmount} CHF, Zufriedenheit ×${satisfactionMultiplier})`, contractId]
      );

      let workerPayment = Math.max(0, Math.round(netPayment * CONTRACT_WORKER_PAYOUT_SHARE));
      let workerBankBalance = null;
      let salaryError = null;
      if (workerPayment > 0) {
        const [debitResult] = await dbPool.query(
          `UPDATE companies
           SET balance = balance - ?
           WHERE id = ? AND balance >= ?`,
          [workerPayment, companyId, workerPayment]
        );
        if (Number(debitResult.affectedRows || 0) > 0) {
          try {
            const bankCredit = await creditUserBankAccount(authUser.id, {
              amount: workerPayment,
              type: 'salary',
              reference: `contract:${contractId}`,
              description: `Firmenlohn für Auftrag #${contractId}`,
              meta: {
                companyId,
                contractId,
                grossPayment: contract.payment,
                netPayment,
                taxAmount,
                taxRate,
                businessTaxRate,
                payoutShare: CONTRACT_WORKER_PAYOUT_SHARE,
              },
            });
            workerBankBalance = Number(bankCredit.balance_after || 0);

            const [companyBalanceRows] = await dbPool.query(
              `SELECT balance FROM companies WHERE id = ?`,
              [companyId]
            );
            const companyBalanceAfterSalary = Number(companyBalanceRows[0]?.balance || 0);
            companyAfter[0].balance = companyBalanceAfterSalary;

            await dbPool.query(
              `INSERT INTO company_finances (company_id, amount, balance_after, reason, description, ref_type, ref_id)
               VALUES (?, ?, ?, 'salary_paid', ?, 'contract', ?)`,
              [companyId, -workerPayment, companyBalanceAfterSalary, `Lohnzahlung an User #${authUser.id} für Auftrag #${contractId}`, contractId]
            );
          } catch (salaryErr) {
            await dbPool.query(
              `UPDATE companies SET balance = balance + ? WHERE id = ?`,
              [workerPayment, companyId]
            );
            salaryError = salaryErr.message;
            workerPayment = 0;
          }
        } else {
          workerPayment = 0;
        }
      }

      if (taxAmount > 0 && contract.municipality_id) {
        try {
          await applyMunicipalityTransaction(contract.municipality_id, {
            amount: taxAmount,
            type: 'company_tax',
            meta: { companyId, contractId, grossPayment: contract.payment, taxRate, businessTaxRate, taxAmount },
            source: 'system',
          });

          await dbPool.query(
            `INSERT INTO company_finances (company_id, amount, balance_after, reason, description, ref_type, ref_id)
             VALUES (?, ?, ?, 'tax_payment', ?, 'contract', ?)`,
            [companyId, -taxAmount, companyAfter[0].balance, `Firmensteuer ${businessTaxRate}% auf Auftrag #${contractId}`, contractId]
          );

          const companyName = companyAfter[0]?.name || `Firma #${companyId}`;
          const [admins] = await dbPool.query(
            `SELECT user_id FROM municipality_memberships WHERE municipality_id = ? AND role IN ('owner','council')`,
            [contract.municipality_id]
          );
          for (const admin of admins) {
            await createUserNotification(
              admin.user_id, 'company_tax',
              'Firmensteuer eingegangen',
              `${companyName} hat ${taxAmount.toLocaleString()} CHF Steuern (${businessTaxRate}%) auf Auftrag #${contractId} gezahlt.`,
              { companyId, contractId, taxAmount, taxRate, businessTaxRate }
            );
          }
        } catch (taxErr) {
        }
      }

      if (contract.xp_reward > 0) {
        try {
          await awardXp(authUser.id, contract.xp_reward, 'contract_complete',
            `Firmenauftrag abgeschlossen`, 'contract', contractId);
        } catch (_) {}
      }

      try {
        await resolveBuenzliEvent(contract.event_id, authUser.id, { skipTreasury: true });
      } catch (_) {}

      await dbPool.query(
        `UPDATE company_members SET contracts_done = contracts_done + 1, xp_earned = xp_earned + ? WHERE company_id = ? AND user_id = ?`,
        [contract.xp_reward || 0, companyId, authUser.id]
      );

      const responseData = {
        completed: true,
        payment: netPayment,
        gross_payment: contract.payment,
        tax_amount: taxAmount,
        tax_rate: taxRate,
        worker_payment: workerPayment,
        worker_bank_balance: workerBankBalance,
        salary_error: salaryError,
        xp: contract.xp_reward,
        reputation_gain: reputationGain,
        new_reputation: currentRep,
        new_level: leveledUp ? newLevel : oldLevel,
        leveled_up: leveledUp,
      };
      return sendJson(res, 200, { ok: true, data: responseData });
    }

    // POST /api/companies/:id/contracts/create — Neuen Auftrag erstellen (aus Event)
    const contractCreateMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/contracts\/create$/i);
    if (contractCreateMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(contractCreateMatch[1]);

      const [membership] = await dbPool.query(
        `SELECT role FROM company_members WHERE company_id = ? AND user_id = ?`, [companyId, authUser.id]
      );
      if (!membership[0] || !['owner', 'manager'].includes(membership[0].role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Owner/Manager können Aufträge erstellen' });
      }

      const body = await readJsonBody(req);
      const eventId = Number(body.event_id);
      if (!eventId) return sendJson(res, 400, { ok: false, error: 'event_id erforderlich' });

      const [events] = await dbPool.query(
        `SELECT me.*, et.category FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         WHERE me.id = ? AND me.status IN ('detected','reported')`, [eventId]
      );
      if (events.length === 0) return sendJson(res, 404, { ok: false, error: 'Event nicht gefunden oder bereits behoben' });
      const event = events[0];

      const [existingContract] = await dbPool.query(
        `SELECT id FROM company_contracts WHERE event_id = ?`, [eventId]
      );
      if (existingContract.length > 0) return sendJson(res, 400, { ok: false, error: 'Für dieses Event existiert bereits ein Auftrag' });

      const payment = event.fix_cost || event.severity * 500;
      const deadlineHours = { 1: 6, 2: 12, 3: 24, 4: 48, 5: 72 };
      const deadline = new Date(Date.now() + (deadlineHours[event.severity] || 24) * 60 * 60 * 1000);
      const xpReward = event.severity * 10;

      const [companyRows] = await dbPool.query(`SELECT level FROM companies WHERE id = ?`, [companyId]);
      const companyLevel = companyRows[0]?.level || 1;
      const workDuration = calcWorkDuration(event.severity, companyLevel);

      const [result] = await dbPool.query(
        `INSERT INTO company_contracts (company_id, event_id, municipality_id, status, payment, difficulty, xp_reward, deadline_at, work_duration_seconds)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        [companyId, eventId, event.municipality_id, payment, event.severity, xpReward, deadline, workDuration]
      );

      await dbPool.query(
        `UPDATE municipality_events SET status = 'assigned', assigned_company_id = ?, updated_at = NOW() WHERE id = ?`, [companyId, eventId]
      );

      return sendJson(res, 200, { ok: true, data: { contract_id: result.insertId, payment, xp_reward: xpReward, difficulty: event.severity, work_duration_seconds: workDuration } });
    }

    // GET /api/events/reported — Gemeldete Events die beauftragt werden können
    if (req.method === 'GET' && pathname === '/api/events/reported') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const [rows] = await dbPool.query(
        `SELECT me.id, me.severity, me.fix_cost, me.location_x, me.location_y, me.status,
                et.name, et.emoji, et.category, et.code
         FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         LEFT JOIN company_contracts cc ON cc.event_id = me.id
         WHERE me.municipality_id = ? AND me.status IN ('detected','reported') AND cc.id IS NULL
         ORDER BY me.severity DESC LIMIT 20`,
        [authUser.municipality_id]
      );
      return sendJson(res, 200, { ok: true, data: { events: rows } });
    }

  };
};
