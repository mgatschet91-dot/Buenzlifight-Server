'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { logError } = require('../infra/logger');

// ─── Kreditlimit dynamisch berechnen ──────────────────────────────────────

function computeCreditLimit(population) {
  return 50000 + Math.max(0, Math.round(Number(population) || 0)) * 50;
}

// ─── Zentrale Buchungsfunktion ────────────────────────────────────────────

async function applyMunicipalityTransaction(municipalityId, opts) {
  ensureDbEnabled();
  const {
    amount,
    type,
    meta = null,
    actorUserId = null,
    source = 'system',
    allowOverdraft = false,
  } = opts;

  const safeAmount = Math.round(Number(amount) || 0);
  if (safeAmount === 0) return null;

  await dbPool.query(`INSERT IGNORE INTO municipality_stats (municipality_id) VALUES (?)`, [municipalityId]);

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT treasury, debt, credit_limit, interest_rate, population
       FROM municipality_stats WHERE municipality_id = ? FOR UPDATE`,
      [municipalityId]
    );
    if (!rows[0]) {
      await conn.rollback();
      throw new Error(`municipality_stats nicht gefunden für municipality_id=${municipalityId}`);
    }

    let treasury = Number(rows[0].treasury);
    let debt = Number(rows[0].debt);
    const population = Number(rows[0].population);
    const dynamicCreditLimit = computeCreditLimit(population);

    let newTreasury = treasury + safeAmount;
    let newDebt = debt;
    const ledgerEntries = [];

    if (newTreasury < 0) {
      if (!allowOverdraft) {
        await conn.rollback();
        throw new Error(
          `Nicht genug Geld in der Gemeindekasse (${treasury}/${Math.abs(safeAmount)}) - ${type}`
        );
      }
      const overdraft = Math.abs(newTreasury);
      newDebt = debt + overdraft;
      newTreasury = 0;

      ledgerEntries.push({
        type,
        amount: safeAmount,
        balance_after: newTreasury,
        debt_after: newDebt,
      });

      if (overdraft > 0) {
        ledgerEntries.push({
          type: 'loan_take',
          amount: overdraft,
          balance_after: newTreasury,
          debt_after: newDebt,
        });
      }
    } else {
      ledgerEntries.push({
        type,
        amount: safeAmount,
        balance_after: newTreasury,
        debt_after: newDebt,
      });
    }

    await conn.query(
      `UPDATE municipality_stats SET treasury = ?, debt = ?, credit_limit = ?, updated_at = NOW()
       WHERE municipality_id = ?`,
      [newTreasury, newDebt, dynamicCreditLimit, municipalityId]
    );

    const metaStr = meta ? JSON.stringify(meta) : null;
    for (const entry of ledgerEntries) {
      await conn.query(
        `INSERT INTO municipality_ledger
           (municipality_id, type, amount, balance_after, debt_after, meta_json, actor_user_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [municipalityId, entry.type, entry.amount, entry.balance_after, entry.debt_after, metaStr, actorUserId, source]
      );
    }

    await conn.commit();

    return { treasury: newTreasury, debt: newDebt, creditLimit: dynamicCreditLimit };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─── Kredit aufnehmen ─────────────────────────────────────────────────────

async function takeLoan(municipalityId, amount, actorUserId) {
  ensureDbEnabled();
  const safeAmount = Math.max(0, Math.round(Number(amount) || 0));
  if (safeAmount <= 0) throw new Error('Kreditbetrag muss grösser als 0 sein');

  await dbPool.query(`INSERT IGNORE INTO municipality_stats (municipality_id) VALUES (?)`, [municipalityId]);

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT treasury, debt, population FROM municipality_stats WHERE municipality_id = ? FOR UPDATE`,
      [municipalityId]
    );
    if (!rows[0]) { await conn.rollback(); throw new Error(`municipality_stats nicht gefunden für municipality_id=${municipalityId}`); }

    const treasury = Number(rows[0].treasury);
    const debt = Number(rows[0].debt);
    const population = Number(rows[0].population);
    const creditLimit = computeCreditLimit(population);

    if (debt + safeAmount > creditLimit) {
      await conn.rollback();
      throw new Error(
        `Kreditlimit überschritten (Schulden: ${debt} + ${safeAmount} > Limit: ${creditLimit})`
      );
    }

    const newTreasury = treasury + safeAmount;
    const newDebt = debt + safeAmount;

    await conn.query(
      `UPDATE municipality_stats SET treasury = ?, debt = ?, credit_limit = ?, updated_at = NOW()
       WHERE municipality_id = ?`,
      [newTreasury, newDebt, creditLimit, municipalityId]
    );

    await conn.query(
      `INSERT INTO municipality_ledger
         (municipality_id, type, amount, balance_after, debt_after, meta_json, actor_user_id, source)
       VALUES (?, 'loan_take', ?, ?, ?, NULL, ?, 'user')`,
      [municipalityId, safeAmount, newTreasury, newDebt, actorUserId]
    );

    await conn.commit();

    return { treasury: newTreasury, debt: newDebt, creditLimit, loanAmount: safeAmount };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─── Kredit zurückzahlen ──────────────────────────────────────────────────

async function repayLoan(municipalityId, amount, actorUserId) {
  ensureDbEnabled();

  await dbPool.query(`INSERT IGNORE INTO municipality_stats (municipality_id) VALUES (?)`, [municipalityId]);

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT treasury, debt, population FROM municipality_stats WHERE municipality_id = ? FOR UPDATE`,
      [municipalityId]
    );
    if (!rows[0]) { await conn.rollback(); throw new Error(`municipality_stats nicht gefunden für municipality_id=${municipalityId}`); }

    const treasury = Number(rows[0].treasury);
    const debt = Number(rows[0].debt);
    const population = Number(rows[0].population);

    if (debt <= 0) {
      await conn.rollback();
      throw new Error('Keine Schulden vorhanden');
    }

    const requested = amount === 'all' ? debt : Math.max(0, Math.round(Number(amount) || 0));
    const pay = Math.min(requested, treasury, debt);
    if (pay <= 0) {
      await conn.rollback();
      throw new Error('Nicht genug Geld für Rückzahlung');
    }

    const newTreasury = treasury - pay;
    const newDebt = debt - pay;
    const creditLimit = computeCreditLimit(population);

    await conn.query(
      `UPDATE municipality_stats SET treasury = ?, debt = ?, credit_limit = ?, updated_at = NOW()
       WHERE municipality_id = ?`,
      [newTreasury, newDebt, creditLimit, municipalityId]
    );

    await conn.query(
      `INSERT INTO municipality_ledger
         (municipality_id, type, amount, balance_after, debt_after, meta_json, actor_user_id, source)
       VALUES (?, 'loan_repay', ?, ?, ?, NULL, ?, 'user')`,
      [municipalityId, -pay, newTreasury, newDebt, actorUserId]
    );

    await conn.commit();

    return { treasury: newTreasury, debt: newDebt, creditLimit, paid: pay };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─── Zinsen berechnen (1x pro Tag) ───────────────────────────────────────

async function processInterest(municipalityId) {
  ensureDbEnabled();

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT treasury, debt, interest_rate, population
       FROM municipality_stats WHERE municipality_id = ? FOR UPDATE`,
      [municipalityId]
    );
    if (!rows[0] || Number(rows[0].debt) <= 0) {
      await conn.rollback();
      return null;
    }

    let treasury = Number(rows[0].treasury);
    let debt = Number(rows[0].debt);
    const rate = Number(rows[0].interest_rate) || 0.0005;
    const population = Number(rows[0].population);
    const creditLimit = computeCreditLimit(population);

    const interest = Math.max(1, Math.round(debt * rate));

    if (treasury >= interest) {
      treasury -= interest;

      await conn.query(
        `INSERT INTO municipality_ledger
           (municipality_id, type, amount, balance_after, debt_after, meta_json, actor_user_id, source)
         VALUES (?, 'interest', ?, ?, ?, ?, NULL, 'system')`,
        [municipalityId, -interest, treasury, debt, JSON.stringify({ rate, calculated: interest })]
      );
    } else {
      const paid = treasury;
      const unpaid = interest - paid;
      treasury = 0;
      debt += unpaid;

      if (paid > 0) {
        await conn.query(
          `INSERT INTO municipality_ledger
             (municipality_id, type, amount, balance_after, debt_after, meta_json, actor_user_id, source)
           VALUES (?, 'interest', ?, ?, ?, ?, NULL, 'system')`,
          [municipalityId, -paid, 0, debt, JSON.stringify({ rate, calculated: interest, partial: true })]
        );
      }

      if (unpaid > 0) {
        await conn.query(
          `INSERT INTO municipality_ledger
             (municipality_id, type, amount, balance_after, debt_after, meta_json, actor_user_id, source)
           VALUES (?, 'loan_take', ?, ?, ?, ?, NULL, 'system')`,
          [municipalityId, unpaid, 0, debt, JSON.stringify({ reason: 'unpaid_interest', original_interest: interest })]
        );
      }
    }

    await conn.query(
      `UPDATE municipality_stats SET treasury = ?, debt = ?, credit_limit = ?, last_interest_at = CURDATE(), updated_at = NOW()
       WHERE municipality_id = ?`,
      [treasury, debt, creditLimit, municipalityId]
    );

    await conn.commit();

    return { treasury, debt, interest, creditLimit };
  } catch (err) {
    await conn.rollback();
    logError('BANK', `Zinsen-Fehler Gemeinde ${municipalityId}: ${err.message}`);
    throw err;
  } finally {
    conn.release();
  }
}

// ─── Alle fälligen Zinsen abarbeiten ──────────────────────────────────────

async function processAllPendingInterest() {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT municipality_id FROM municipality_stats
     WHERE debt > 0 AND (last_interest_at IS NULL OR last_interest_at < CURDATE())`
  );
  let processed = 0;
  for (const row of rows) {
    try {
      await processInterest(row.municipality_id);
      processed++;
    } catch (err) {
      logError('BANK', `Zinsen-Tick fehlgeschlagen für Gemeinde ${row.municipality_id}: ${err.message}`);
    }
  }
  return processed;
}

// ─── Bank-Status lesen ────────────────────────────────────────────────────

async function getBankStatus(municipalityId) {
  ensureDbEnabled();
  await dbPool.query(`INSERT IGNORE INTO municipality_stats (municipality_id) VALUES (?)`, [municipalityId]);
  const [rows] = await dbPool.query(
    `SELECT treasury, debt, credit_limit, interest_rate, last_interest_at,
            daily_income, daily_expenses, population, last_income_at
     FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
    [municipalityId]
  );
  if (!rows[0]) throw new Error(`municipality_stats nicht gefunden für municipality_id=${municipalityId}`);
  const r = rows[0];
  const population = Number(r.population);
  const dynamicCreditLimit = computeCreditLimit(population);
  const debt = Number(r.debt);
  const rate = Number(r.interest_rate) || 0.0005;

  return {
    treasury: Number(r.treasury),
    debt,
    creditLimit: dynamicCreditLimit,
    interestRate: rate,
    lastInterestAt: r.last_interest_at || null,
    dailyIncome: Number(r.daily_income),
    dailyExpenses: Number(r.daily_expenses),
    population,
    nextInterestEstimate: debt > 0 ? Math.max(1, Math.round(debt * rate)) : 0,
    lastIncomeAt: r.last_income_at || null,
  };
}

// ─── Ledger lesen ─────────────────────────────────────────────────────────

async function getLedger(municipalityId, opts = {}) {
  ensureDbEnabled();
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 15));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const typeFilter = opts.typeFilter || null;

  const hours = Number(opts.hours) || 0;

  let where = 'municipality_id = ?';
  const params = [municipalityId];

  if (hours > 0) {
    where += ` AND ts >= DATE_SUB(NOW(), INTERVAL ${Math.round(hours)} HOUR)`;
  }

  if (typeFilter === 'income') {
    where += ' AND amount > 0';
  } else if (typeFilter === 'expense') {
    where += ' AND amount < 0';
  } else if (typeFilter && typeFilter !== 'all') {
    where += ' AND type = ?';
    params.push(typeFilter);
  }

  const [[countRow]] = await dbPool.query(
    `SELECT COUNT(*) AS total FROM municipality_ledger WHERE ${where}`,
    params
  );

  const [entries] = await dbPool.query(
    `SELECT id, ts, type, amount, balance_after, debt_after, meta_json, actor_user_id, source
     FROM municipality_ledger
     WHERE ${where}
     ORDER BY ts DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return {
    entries: entries.map(e => ({
      id: e.id,
      ts: e.ts,
      type: e.type,
      amount: Number(e.amount),
      balanceAfter: Number(e.balance_after),
      debtAfter: Number(e.debt_after),
      meta: e.meta_json ? (typeof e.meta_json === 'string' ? JSON.parse(e.meta_json) : e.meta_json) : null,
      actorUserId: e.actor_user_id,
      source: e.source,
    })),
    total: Number(countRow.total),
    hasMore: offset + limit < Number(countRow.total),
  };
}

module.exports = {
  computeCreditLimit,
  applyMunicipalityTransaction,
  takeLoan,
  repayLoan,
  processInterest,
  processAllPendingInterest,
  getBankStatus,
  getLedger,
};
