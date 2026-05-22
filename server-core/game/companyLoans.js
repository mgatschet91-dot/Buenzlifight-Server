'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { logError } = require('../infra/logger');
const { applyMunicipalityTransaction } = require('./bank');
const { createNotificationForUser } = require('./notifications');

// ─── Kredit-Antrag erstellen ──────────────────────────────────────────────

async function createLoanRequest({ municipalityId, userId, companyTypeId, companyName, message }) {
  ensureDbEnabled();

  // 1. Kein pending Request vorhanden?
  const [pendingReqs] = await dbPool.query(
    `SELECT id FROM company_loan_requests
     WHERE requesting_user_id = ? AND status = 'pending' LIMIT 1`,
    [userId]
  );
  if (pendingReqs.length > 0) {
    throw new Error('Du hast bereits einen offenen Kredit-Antrag');
  }

  // 2. Keine aktive Firma?
  const [existingCompany] = await dbPool.query(
    `SELECT c.id, c.name FROM companies c WHERE c.owner_id = ? AND c.is_active = 1`,
    [userId]
  );
  if (existingCompany.length >= 3) {
    throw new Error(`Du hast bereits 3 aktive Firmen — das ist das Maximum.`);
  }

  // 3. Firmen-Typ laden
  const [types] = await dbPool.query(
    `SELECT * FROM company_types WHERE id = ? AND is_active = 1`,
    [companyTypeId]
  );
  if (types.length === 0) {
    throw new Error('Ungültiger Firmen-Typ');
  }
  const companyType = types[0];

  // 4. User-Level prüfen
  const [xpRows] = await dbPool.query(
    `SELECT level FROM user_xp WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  const userLevel = xpRows[0]?.level || 1;
  if (userLevel < companyType.min_level) {
    throw new Error(`Level ${companyType.min_level} erforderlich (du bist Level ${userLevel})`);
  }

  // 5. Zinssatz der Gemeinde laden
  const [statsRows] = await dbPool.query(
    `SELECT company_loan_interest_rate FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
    [municipalityId]
  );
  const interestRate = Number(statsRows[0]?.company_loan_interest_rate) || 0.001;

  // 6. Berechne Kredit-Details
  const foundingCost = Number(companyType.founding_cost);
  const loanAmount = foundingCost; // Voller Betrag von der Gemeinde
  const weeklyRepayment = Math.ceil(loanAmount / 12); // ~12 Wochen Laufzeit

  // 7. Antrag speichern
  const safeName = String(companyName || '').trim();
  if (!safeName || safeName.length < 3 || safeName.length > 64) {
    throw new Error('Firmenname muss 3-64 Zeichen lang sein');
  }
  const safeMessage = message ? String(message).trim().substring(0, 500) : null;

  const [result] = await dbPool.query(
    `INSERT INTO company_loan_requests
       (municipality_id, requesting_user_id, company_type_id, company_name,
        founding_cost, loan_amount, interest_rate, weekly_repayment, status, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [municipalityId, userId, companyTypeId, safeName,
     foundingCost, loanAmount, interestRate, weeklyRepayment, safeMessage]
  );
  const requestId = result.insertId;

  // 8. Notification an Owner + Council der Gemeinde
  const [admins] = await dbPool.query(
    `SELECT user_id FROM municipality_memberships
     WHERE municipality_id = ? AND role IN ('owner', 'council')`,
    [municipalityId]
  );
  const [requester] = await dbPool.query(`SELECT nickname FROM users WHERE id = ? LIMIT 1`, [userId]);
  const nickname = requester[0]?.nickname || 'Unbekannt';

  for (const admin of admins) {
    await createNotificationForUser(admin.user_id, municipalityId, {
      type: 'company_loan_request',
      title: 'Neuer Firma-Kredit-Antrag',
      message: `${nickname} beantragt ${loanAmount.toLocaleString('de-CH')} CHF für "${safeName}" (${companyType.name})`,
      icon: '🏦',
      amount: loanAmount,
    });
  }

  return {
    id: requestId,
    municipality_id: municipalityId,
    requesting_user_id: userId,
    company_type_id: companyTypeId,
    company_name: safeName,
    founding_cost: foundingCost,
    loan_amount: loanAmount,
    interest_rate: interestRate,
    weekly_repayment: weeklyRepayment,
    status: 'pending',
    message: safeMessage,
  };
}

// ─── Kredit-Antrag genehmigen oder ablehnen ───────────────────────────────

async function respondToLoanRequest(requestId, responderId, decision, rejectReason) {
  ensureDbEnabled();

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Request laden + sperren
    const [reqs] = await conn.query(
      `SELECT clr.*, ct.code AS type_code, ct.name AS type_name, ct.emoji AS type_emoji,
              u.nickname AS requester_nickname
       FROM company_loan_requests clr
       JOIN company_types ct ON ct.id = clr.company_type_id
       JOIN users u ON u.id = clr.requesting_user_id
       WHERE clr.id = ? FOR UPDATE`,
      [requestId]
    );
    if (reqs.length === 0) {
      await conn.rollback();
      throw new Error('Kredit-Antrag nicht gefunden');
    }
    const request = reqs[0];

    if (request.status !== 'pending') {
      await conn.rollback();
      throw new Error(`Antrag wurde bereits bearbeitet (Status: ${request.status})`);
    }

    if (decision === 'approved') {
      // ── GENEHMIGUNG ──

      // a) Status sofort auf 'approved' setzen und committen, bevor der FOR UPDATE Lock freigegeben wird.
      //    Damit können keine zwei parallelen Genehmigungen dieselbe Anfrage doppelt verarbeiten.
      await conn.query(
        `UPDATE company_loan_requests SET status = 'approved', responded_by = ?, responded_at = NOW() WHERE id = ?`,
        [responderId, requestId]
      );
      await conn.commit();

      // Treasury prüfen
      const [statsCheck] = await dbPool.query(
        `SELECT treasury FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
        [request.municipality_id]
      );
      const treasury = Number(statsCheck[0]?.treasury || 0);
      if (treasury < request.founding_cost) {
        throw new Error(
          `Nicht genug CHF in der Gemeindekasse (${treasury.toLocaleString('de-CH')}/${Number(request.founding_cost).toLocaleString('de-CH')})`
        );
      }

      // b) Treasury-Transaktion
      await applyMunicipalityTransaction(request.municipality_id, {
        amount: -request.founding_cost,
        type: 'company_founding_loan',
        meta: {
          loanRequestId: requestId,
          companyName: request.company_name,
          companyTypeCode: request.type_code,
          loanAmount: request.loan_amount,
        },
        actorUserId: responderId,
        source: 'system',
      });

      // c) Firma erstellen
      const slug = request.company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 64) || 'firma';
      const [slugCheck] = await dbPool.query(`SELECT id FROM companies WHERE slug = ?`, [slug]);
      const finalSlug = slugCheck.length > 0 ? slug + '-' + Date.now() : slug;

      const [companyResult] = await dbPool.query(
        `INSERT INTO companies (company_type_id, name, slug, owner_id, municipality_id, balance, founded_at)
         VALUES (?, ?, ?, ?, ?, 0, NOW())`,
        [request.company_type_id, request.company_name, finalSlug, request.requesting_user_id, request.municipality_id]
      );
      const companyId = companyResult.insertId;

      // d) Owner-Membership
      await dbPool.query(
        `INSERT INTO company_members (company_id, user_id, role) VALUES (?, ?, 'owner')`,
        [companyId, request.requesting_user_id]
      );

      // e) Finanz-Eintrag
      await dbPool.query(
        `INSERT INTO company_finances (company_id, amount, balance_after, reason, description)
         VALUES (?, ?, 0, 'founding_cost', ?)`,
        [companyId, -request.founding_cost, `Firmengründung per Kredit: ${request.company_name}`]
      );

      // f) Kredit-Eintrag (last_payment_at = NOW() damit erste Zahlung erst nach 7 Tagen fällig)
      await dbPool.query(
        `INSERT INTO company_loans
           (company_id, municipality_id, loan_request_id, original_amount,
            remaining_amount, interest_rate, weekly_repayment, status, last_payment_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NOW())`,
        [companyId, request.municipality_id, requestId,
         request.loan_amount, request.loan_amount,
         request.interest_rate, request.weekly_repayment]
      );

      // g) Request mit company_id ergänzen (status/responded_by bereits oben gesetzt)
      await dbPool.query(
        `UPDATE company_loan_requests SET company_id = ?, updated_at = NOW() WHERE id = ?`,
        [companyId, requestId]
      );

      // h) Badge
      try {
        await dbPool.query(
          `INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, 'ACH_Company1')`,
          [request.requesting_user_id]
        );
      } catch (_) {}

      // i) Notification an Antragsteller
      await createNotificationForUser(request.requesting_user_id, request.municipality_id, {
        type: 'company_loan_approved',
        title: 'Kredit genehmigt!',
        message: `Dein Kredit über ${Number(request.loan_amount).toLocaleString('de-CH')} CHF wurde genehmigt. "${request.company_name}" wurde gegründet!`,
        icon: '✅',
        amount: request.loan_amount,
      });

      return {
        request_id: requestId,
        decision: 'approved',
        company_id: companyId,
        company_name: request.company_name,
        loan_amount: request.loan_amount,
      };

    } else if (decision === 'rejected') {
      // ── ABLEHNUNG ──
      const safeReason = rejectReason ? String(rejectReason).trim().substring(0, 500) : null;

      await conn.query(
        `UPDATE company_loan_requests
         SET status = 'rejected', responded_by = ?, responded_at = NOW(),
             reject_reason = ?, updated_at = NOW()
         WHERE id = ?`,
        [responderId, safeReason, requestId]
      );
      await conn.commit();

      // Notification an Antragsteller
      const reasonText = safeReason ? ` Grund: ${safeReason}` : '';
      await createNotificationForUser(request.requesting_user_id, request.municipality_id, {
        type: 'company_loan_rejected',
        title: 'Kredit-Antrag abgelehnt',
        message: `Dein Kredit-Antrag für "${request.company_name}" wurde abgelehnt.${reasonText}`,
        icon: '❌',
        amount: null,
      });

      return {
        request_id: requestId,
        decision: 'rejected',
        reject_reason: safeReason,
      };

    } else {
      await conn.rollback();
      throw new Error('Ungültige Entscheidung (approved oder rejected)');
    }
  } catch (err) {
    if (conn && !conn._fatalError) {
      try { await conn.rollback(); } catch (_) {}
    }
    throw err;
  } finally {
    conn.release();
  }
}

// ─── Wöchentliche Kredit-Zahlungen verarbeiten ───────────────────────────

async function processWeeklyLoanPayments() {
  ensureDbEnabled();

  // Alle aktiven Kredite deren letzte Zahlung >= 7 Tage her ist (oder nie gezahlt)
  const [loans] = await dbPool.query(
    `SELECT cl.*, c.balance AS company_balance, c.name AS company_name,
            c.owner_id, c.is_active AS company_is_active
     FROM company_loans cl
     JOIN companies c ON c.id = cl.company_id
     WHERE cl.status = 'active'
       AND (cl.last_payment_at IS NULL OR cl.last_payment_at < DATE_SUB(NOW(), INTERVAL 7 DAY))`
  );

  if (loans.length === 0) return 0;

  let processed = 0;
  for (const loan of loans) {
    try {
      await processOneLoanPayment(loan);
      processed++;
    } catch (err) {
      logError('COMPANY_LOAN', `Kredit-Zahlung fehlgeschlagen für Loan ${loan.id}: ${err.message}`, {
        loanId: loan.id, companyId: loan.company_id,
      });
    }
  }

  return processed;
}

async function processOneLoanPayment(loan) {
  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    // Aktuellen Stand mit Lock holen
    const [loanRows] = await conn.query(
      `SELECT cl.*, c.balance AS company_balance, c.name AS company_name, c.owner_id
       FROM company_loans cl
       JOIN companies c ON c.id = cl.company_id
       WHERE cl.id = ? AND cl.status = 'active' FOR UPDATE`,
      [loan.id]
    );
    if (loanRows.length === 0) {
      await conn.rollback();
      return;
    }
    const current = loanRows[0];
    const companyBalance = Number(current.company_balance);
    const remainingAmount = Number(current.remaining_amount);
    const interestRate = Number(current.interest_rate);
    const weeklyRepayment = Number(current.weekly_repayment);

    // 1. Zinsen berechnen und aufschlagen
    const interest = Math.max(1, Math.round(remainingAmount * interestRate));
    let newRemaining = remainingAmount + interest;

    // 2. Kann die Firma die Rate bezahlen?
    if (companyBalance >= weeklyRepayment) {
      // ── ZAHLUNG ERFOLGREICH ──
      const principal = weeklyRepayment - interest;
      newRemaining -= weeklyRepayment;

      // Firma-Balance abziehen
      const newCompanyBalance = companyBalance - weeklyRepayment;
      await conn.query(
        `UPDATE companies SET balance = ?, updated_at = NOW() WHERE id = ?`,
        [newCompanyBalance, current.company_id]
      );

      // Finanz-Eintrag für Firma
      await conn.query(
        `INSERT INTO company_finances (company_id, amount, balance_after, reason, description)
         VALUES (?, ?, ?, 'loan_repayment', ?)`,
        [current.company_id, -weeklyRepayment, newCompanyBalance,
         `Kredit-Rate: ${weeklyRepayment} CHF (Zinsen: ${interest}, Tilgung: ${Math.max(0, principal)})`]
      );

      // Kredit aktualisieren
      const isPaidOff = newRemaining <= 0;
      await conn.query(
        `UPDATE company_loans SET
           remaining_amount = ?,
           total_interest_paid = total_interest_paid + ?,
           total_principal_paid = total_principal_paid + ?,
           missed_payments = 0,
           last_payment_at = NOW(),
           last_interest_at = NOW(),
           status = ?,
           paid_off_at = ?
         WHERE id = ?`,
        [Math.max(0, newRemaining), interest, Math.max(0, principal),
         isPaidOff ? 'paid_off' : 'active',
         isPaidOff ? new Date() : null,
         current.id]
      );

      await conn.commit();

      // Gemeindekasse: Geld zurück (ausserhalb Transaction da eigene Connection)
      await applyMunicipalityTransaction(current.municipality_id, {
        amount: weeklyRepayment,
        type: 'company_loan_repayment',
        meta: {
          companyId: current.company_id,
          companyName: current.company_name,
          loanId: current.id,
          interest,
          principal: Math.max(0, principal),
        },
        source: 'system',
      });

      if (isPaidOff) {
        await createNotificationForUser(current.owner_id, current.municipality_id, {
          type: 'company_loan_paid_off',
          title: 'Kredit abbezahlt!',
          message: `"${current.company_name}" hat den Kredit vollständig zurückgezahlt.`,
          icon: '🎉',
          amount: null,
        });
      }

    } else {
      // ── ZAHLUNG VERPASST ──
      const newMissed = Number(current.missed_payments) + 1;

      // Zinsen trotzdem aufschlagen
      await conn.query(
        `UPDATE company_loans SET
           remaining_amount = ?,
           missed_payments = ?,
           last_interest_at = NOW()
         WHERE id = ?`,
        [newRemaining, newMissed, current.id]
      );
      await conn.commit();

      if (newMissed >= 3) {
        // 3x verpasst → Firma auflösen
        await autoDissolveCompany(current.company_id, current.id);
      } else {
        // Warnung an Owner
        await createNotificationForUser(current.owner_id, current.municipality_id, {
          type: 'company_loan_missed',
          title: 'Kredit-Rate verpasst!',
          message: `"${current.company_name}" konnte die Rate von ${weeklyRepayment} CHF nicht bezahlen (${newMissed}/3 verpasst). Bei 3 Ausfällen wird die Firma aufgelöst!`,
          icon: '⚠️',
          amount: weeklyRepayment,
        });
      }
    }
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    throw err;
  } finally {
    conn.release();
  }
}

// ─── Firma automatisch auflösen (3x Zahlungsausfall) ──────────────────────

async function autoDissolveCompany(companyId, loanId) {
  ensureDbEnabled();

  // 1. Firma-Daten laden
  const [companies] = await dbPool.query(
    `SELECT c.*, cl.remaining_amount, cl.municipality_id AS loan_municipality_id
     FROM companies c
     JOIN company_loans cl ON cl.company_id = c.id
     WHERE c.id = ? AND cl.id = ?`,
    [companyId, loanId]
  );
  if (companies.length === 0) return;
  const company = companies[0];
  const restBalance = Math.max(0, Number(company.balance));

  // 2. Aktive Aufträge stornieren
  await dbPool.query(
    `UPDATE company_contracts SET status = 'cancelled', updated_at = NOW()
     WHERE company_id = ? AND status IN ('open', 'accepted', 'assigned')`,
    [companyId]
  );

  // 3. Restliches Balance an Gemeindekasse zurückzahlen
  if (restBalance > 0) {
    await dbPool.query(
      `UPDATE companies SET balance = 0, updated_at = NOW() WHERE id = ?`,
      [companyId]
    );
    await applyMunicipalityTransaction(company.loan_municipality_id, {
      amount: restBalance,
      type: 'company_loan_default_refund',
      meta: {
        companyId,
        companyName: company.name,
        loanId,
        refund: restBalance,
      },
      source: 'system',
    });
  }

  // 4. Kredit als defaulted markieren
  await dbPool.query(
    `UPDATE company_loans SET status = 'defaulted', defaulted_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    [loanId]
  );

  // 5. Firma deaktivieren
  await dbPool.query(
    `UPDATE companies SET is_active = 0, updated_at = NOW() WHERE id = ?`,
    [companyId]
  );

  // 6. Mitglieder entfernen
  await dbPool.query(
    `DELETE FROM company_members WHERE company_id = ?`,
    [companyId]
  );

  // 7. Notifications
  const remainingDebt = Math.max(0, Number(company.remaining_amount) - restBalance);

  // An Firma-Owner
  await createNotificationForUser(company.owner_id, company.loan_municipality_id, {
    type: 'company_dissolved_default',
    title: 'Firma aufgelöst!',
    message: `"${company.name}" wurde wegen 3 verpassten Kredit-Raten automatisch aufgelöst.`,
    icon: '💀',
    amount: null,
  });

  // An Gemeinde-Owner/Council
  const [admins] = await dbPool.query(
    `SELECT user_id FROM municipality_memberships
     WHERE municipality_id = ? AND role IN ('owner', 'council')`,
    [company.loan_municipality_id]
  );
  for (const admin of admins) {
    if (admin.user_id === company.owner_id) continue; // Nicht doppelt benachrichtigen
    await createNotificationForUser(admin.user_id, company.loan_municipality_id, {
      type: 'company_dissolved_default',
      title: 'Firma aufgelöst (Zahlungsausfall)',
      message: `"${company.name}" wurde aufgelöst. Verlust: ${remainingDebt.toLocaleString('de-CH')} CHF. Rückerstattung: ${restBalance.toLocaleString('de-CH')} CHF.`,
      icon: '🏦',
      amount: remainingDebt > 0 ? -remainingDebt : null,
    });
  }

}

// ─── Kredit-Antrag stornieren ────────────────────────────────────────────

async function cancelLoanRequest(requestId, userId) {
  ensureDbEnabled();
  const [result] = await dbPool.query(
    `UPDATE company_loan_requests
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = ? AND requesting_user_id = ? AND status = 'pending'`,
    [requestId, userId]
  );
  if (result.affectedRows === 0) {
    throw new Error('Antrag nicht gefunden oder bereits bearbeitet');
  }
  return { cancelled: true };
}

// ─── Kredit-Antrag bei manueller Firma-Auflösung als defaulted markieren ──

async function defaultLoanOnDissolution(companyId) {
  ensureDbEnabled();
  const [loans] = await dbPool.query(
    `SELECT id, remaining_amount, municipality_id FROM company_loans
     WHERE company_id = ? AND status = 'active' LIMIT 1`,
    [companyId]
  );
  if (loans.length === 0) return null;
  const loan = loans[0];

  await dbPool.query(
    `UPDATE company_loans SET status = 'defaulted', defaulted_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    [loan.id]
  );

  return {
    loanId: loan.id,
    remainingDebt: Number(loan.remaining_amount),
    municipalityId: loan.municipality_id,
  };
}

// ─── Getter-Funktionen ───────────────────────────────────────────────────

async function getLoanRequestsByUser(userId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT clr.*, ct.name AS type_name, ct.emoji AS type_emoji, ct.code AS type_code
     FROM company_loan_requests clr
     JOIN company_types ct ON ct.id = clr.company_type_id
     WHERE clr.requesting_user_id = ?
     ORDER BY clr.created_at DESC LIMIT 20`,
    [userId]
  );
  return rows;
}

async function getPendingLoanRequests(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT clr.*, ct.name AS type_name, ct.emoji AS type_emoji, ct.code AS type_code,
            u.nickname AS requester_nickname
     FROM company_loan_requests clr
     JOIN company_types ct ON ct.id = clr.company_type_id
     JOIN users u ON u.id = clr.requesting_user_id
     WHERE clr.municipality_id = ? AND clr.status = 'pending'
     ORDER BY clr.created_at ASC`,
    [municipalityId]
  );
  return rows;
}

async function getCompanyLoan(companyId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT * FROM company_loans WHERE company_id = ? ORDER BY created_at DESC LIMIT 1`,
    [companyId]
  );
  return rows[0] || null;
}

async function getCompanyLoanInterestRate(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT company_loan_interest_rate FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
    [municipalityId]
  );
  return Number(rows[0]?.company_loan_interest_rate) || 0.001;
}

async function setCompanyLoanInterestRate(municipalityId, rate) {
  ensureDbEnabled();
  const safeRate = Math.max(0, Math.min(0.05, Number(rate) || 0));
  await dbPool.query(
    `UPDATE municipality_stats SET company_loan_interest_rate = ?, updated_at = NOW()
     WHERE municipality_id = ?`,
    [safeRate, municipalityId]
  );
  return safeRate;
}

module.exports = {
  createLoanRequest,
  respondToLoanRequest,
  processWeeklyLoanPayments,
  autoDissolveCompany,
  cancelLoanRequest,
  defaultLoanOnDissolution,
  getLoanRequestsByUser,
  getPendingLoanRequests,
  getCompanyLoan,
  getCompanyLoanInterestRate,
  setCompanyLoanInterestRate,
};
