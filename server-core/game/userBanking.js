'use strict';

const crypto = require('crypto');
const { dbPool, ensureDbEnabled } = require('../infra/db');

function randomDigits(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String(crypto.randomInt(0, 10));
  }
  return out;
}

function buildAhvNumber() {
  return `756.${randomDigits(4)}.${randomDigits(4)}.${randomDigits(2)}`;
}

function buildTaxNumber(userId) {
  const year = new Date().getFullYear();
  return `TAX-MEIN-${year}-${String(Number(userId) || 0).padStart(6, '0')}`;
}

function buildAccountNumber(userId) {
  const userPart = String(Number(userId) || 0).padStart(10, '0');
  const suffix = randomDigits(6);
  return `CH${randomDigits(2)}MEIN${userPart}${suffix}`;
}

function maskAccountNumber(value) {
  const raw = String(value || '');
  if (raw.length <= 8) return raw;
  return `${raw.slice(0, 6)}********${raw.slice(-4)}`;
}

function maskAhvNumber(value) {
  const raw = String(value || '');
  const parts = raw.split('.');
  if (parts.length !== 4) return raw ? `${raw.slice(0, 3)}********` : '';
  return `${parts[0]}.****.****.${parts[3]}`;
}

function maskTaxNumber(value) {
  const raw = String(value || '');
  if (raw.length <= 8) return raw;
  return `${raw.slice(0, 8)}****`;
}

function formatProfile(row, includeSensitive = false) {
  return {
    user_id: Number(row.user_id),
    account_number: includeSensitive ? String(row.account_number || '') : maskAccountNumber(row.account_number),
    card_number_masked: `**** **** **** ${String(row.card_number_last4 || '').padStart(4, '0')}`,
    card_brand: row.card_brand || 'MEINORT',
    balance: Number(row.balance || 0),
    currency: row.currency || 'CHF',
    status: row.status || 'active',
    ahv_number: includeSensitive ? String(row.ahv_number || '') : maskAhvNumber(row.ahv_number),
    tax_number: includeSensitive ? String(row.tax_number || '') : maskTaxNumber(row.tax_number),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function ensureUserIdentity(conn, userId) {
  const [existing] = await conn.query(
    `SELECT user_id FROM user_identity WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  if (existing[0]) return;

  const taxNumber = buildTaxNumber(userId);
  for (let tries = 0; tries < 5; tries++) {
    const ahvNumber = buildAhvNumber();
    try {
      await conn.query(
        `INSERT INTO user_identity (user_id, ahv_number, tax_number) VALUES (?, ?, ?)`,
        [userId, ahvNumber, taxNumber]
      );
      return;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') continue;
      throw err;
    }
  }
  throw new Error('Konnte keine eindeutige AHV-Nummer erzeugen');
}

async function ensureUserBankAccount(conn, userId) {
  const [existing] = await conn.query(
    `SELECT user_id FROM user_bank_accounts WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  if (existing[0]) return;

  for (let tries = 0; tries < 5; tries++) {
    const accountNumber = buildAccountNumber(userId);
    const cardLast4 = randomDigits(4);
    try {
      await conn.query(
        `INSERT INTO user_bank_accounts (user_id, account_number, card_number_last4) VALUES (?, ?, ?)`,
        [userId, accountNumber, cardLast4]
      );
      return;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') continue;
      throw err;
    }
  }
  throw new Error('Konnte keine eindeutige Kontonummer erzeugen');
}

async function ensureUserBankingProfile(userId) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) {
    throw new Error('Ungültige userId');
  }

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    const [users] = await conn.query(`SELECT id FROM users WHERE id = ? LIMIT 1`, [safeUserId]);
    if (!users[0]) {
      await conn.rollback();
      throw new Error('Benutzer nicht gefunden');
    }

    await ensureUserIdentity(conn, safeUserId);
    await ensureUserBankAccount(conn, safeUserId);

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return getUserBankingProfile(safeUserId, { includeSensitive: true });
}

async function getUserBankingProfile(userId, opts = {}) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return null;
  const includeSensitive = !!opts.includeSensitive;
  const [rows] = await dbPool.query(
    `SELECT
       ba.user_id,
       ba.account_number,
       ba.card_number_last4,
       ba.card_brand,
       ba.balance,
       ba.currency,
       ba.status,
       ba.created_at,
       ba.updated_at,
       ui.ahv_number,
       ui.tax_number
     FROM user_bank_accounts ba
     JOIN user_identity ui ON ui.user_id = ba.user_id
     WHERE ba.user_id = ?
     LIMIT 1`,
    [safeUserId]
  );
  if (!rows[0]) return null;
  return formatProfile(rows[0], includeSensitive);
}

async function listUserBankTransactions(userId, opts = {}) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) {
    return { entries: [], total: 0, hasMore: false };
  }
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 20));
  const offset = Math.max(0, Number(opts.offset) || 0);

  const [accountRows] = await dbPool.query(
    `SELECT id FROM user_bank_accounts WHERE user_id = ? LIMIT 1`,
    [safeUserId]
  );
  if (!accountRows[0]) {
    return { entries: [], total: 0, hasMore: false };
  }
  const accountId = Number(accountRows[0].id);

  const [[countRow]] = await dbPool.query(
    `SELECT COUNT(*) AS total FROM bank_transactions WHERE account_id = ?`,
    [accountId]
  );
  const [entries] = await dbPool.query(
    `SELECT id, direction, type, amount, balance_after, reference, description, meta_json, created_at
     FROM bank_transactions
     WHERE account_id = ?
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [accountId, limit, offset]
  );

  return {
    entries: entries.map((row) => ({
      id: Number(row.id),
      direction: row.direction,
      type: row.type,
      amount: Number(row.amount || 0),
      balance_after: Number(row.balance_after || 0),
      reference: row.reference || null,
      description: row.description || null,
      meta: row.meta_json
        ? (typeof row.meta_json === 'string' ? JSON.parse(row.meta_json) : row.meta_json)
        : null,
      created_at: row.created_at || null,
    })),
    total: Number(countRow.total || 0),
    hasMore: offset + limit < Number(countRow.total || 0),
  };
}

async function creditUserBankAccount(userId, opts = {}) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  const amount = Math.max(0, Math.round(Number(opts.amount || 0)));
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) {
    throw new Error('Ungültige userId');
  }
  if (amount <= 0) {
    throw new Error('Ungültiger Betrag');
  }

  const type = String(opts.type || 'reward');
  const reference = opts.reference ? String(opts.reference).slice(0, 64) : null;
  const description = opts.description ? String(opts.description).slice(0, 255) : null;
  const meta = opts.meta && typeof opts.meta === 'object' ? opts.meta : null;

  await ensureUserBankingProfile(safeUserId);

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    const [accountRows] = await conn.query(
      `SELECT id, balance, status FROM user_bank_accounts WHERE user_id = ? LIMIT 1 FOR UPDATE`,
      [safeUserId]
    );
    if (!accountRows[0]) {
      await conn.rollback();
      throw new Error('Bankkonto nicht gefunden');
    }
    if (String(accountRows[0].status || 'active') !== 'active') {
      await conn.rollback();
      throw new Error('Bankkonto ist nicht aktiv');
    }

    const accountId = Number(accountRows[0].id);
    const currentBalance = Number(accountRows[0].balance || 0);
    const nextBalance = currentBalance + amount;

    await conn.query(
      `UPDATE user_bank_accounts SET balance = ?, updated_at = NOW() WHERE id = ?`,
      [nextBalance, accountId]
    );

    const [txResult] = await conn.query(
      `INSERT INTO bank_transactions
       (account_id, direction, type, amount, balance_after, reference, description, meta_json)
       VALUES (?, 'credit', ?, ?, ?, ?, ?, ?)`,
      [
        accountId,
        type,
        amount,
        nextBalance,
        reference,
        description,
        meta ? JSON.stringify(meta) : null,
      ]
    );

    await conn.commit();

    // Sofort per Socket an den User pushen
    try {
      const { wsUserSockets } = require('../ws/socketio/index');
      const { wsEmitToUser } = require('../ws/socketio/helpers');
      const { io: wsIo } = require('../ws/socketio/index');
      if (wsIo && wsUserSockets) {
        wsEmitToUser(wsIo, safeUserId, 'balance-update', { balance: nextBalance }, wsUserSockets);
      }
    } catch (_e) { /* non-critical */ }

    return {
      user_id: safeUserId,
      account_id: accountId,
      transaction_id: Number(txResult.insertId || 0),
      amount,
      balance_after: nextBalance,
      type,
      reference,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function debitUserBankAccount(userId, opts = {}) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  const amount = Math.max(0, Math.round(Number(opts.amount || 0)));
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) {
    throw new Error('Ungültige userId');
  }
  if (amount <= 0) {
    throw new Error('Ungültiger Betrag');
  }

  const type = String(opts.type || 'expense');
  const reference = opts.reference ? String(opts.reference).slice(0, 64) : null;
  const description = opts.description ? String(opts.description).slice(0, 255) : null;
  const meta = opts.meta && typeof opts.meta === 'object' ? opts.meta : null;

  await ensureUserBankingProfile(safeUserId);

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    const [accountRows] = await conn.query(
      `SELECT id, balance, status FROM user_bank_accounts WHERE user_id = ? LIMIT 1 FOR UPDATE`,
      [safeUserId]
    );
    if (!accountRows[0]) {
      await conn.rollback();
      throw new Error('Bankkonto nicht gefunden');
    }
    if (String(accountRows[0].status || 'active') !== 'active') {
      await conn.rollback();
      throw new Error('Bankkonto ist nicht aktiv');
    }

    const accountId = Number(accountRows[0].id);
    const currentBalance = Number(accountRows[0].balance || 0);
    if (currentBalance < amount) {
      await conn.rollback();
      throw Object.assign(
        new Error('Nicht genug Guthaben auf deinem Konto'),
        { code: 'INSUFFICIENT_BALANCE', currentBalance, requiredAmount: amount }
      );
    }

    const nextBalance = currentBalance - amount;

    await conn.query(
      `UPDATE user_bank_accounts SET balance = ?, updated_at = NOW() WHERE id = ?`,
      [nextBalance, accountId]
    );

    const [txResult] = await conn.query(
      `INSERT INTO bank_transactions
       (account_id, direction, type, amount, balance_after, reference, description, meta_json)
       VALUES (?, 'debit', ?, ?, ?, ?, ?, ?)`,
      [
        accountId,
        type,
        amount,
        nextBalance,
        reference,
        description,
        meta ? JSON.stringify(meta) : null,
      ]
    );

    await conn.commit();

    // Sofort per Socket an den User pushen — kein Extra-HTTP-Fetch nötig
    try {
      const { wsUserSockets } = require('../ws/socketio/index');
      const { wsEmitToUser } = require('../ws/socketio/helpers');
      const { io: wsIo } = require('../ws/socketio/index');
      if (wsIo && wsUserSockets) {
        wsEmitToUser(wsIo, safeUserId, 'balance-update', { balance: nextBalance }, wsUserSockets);
      }
    } catch (_e) { /* non-critical — WS nicht verfügbar */ }

    return {
      user_id: safeUserId,
      account_id: accountId,
      transaction_id: Number(txResult.insertId || 0),
      amount,
      balance_after: nextBalance,
      type,
      reference,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getUserBalance(userId) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return 0;
  const [rows] = await dbPool.query(
    `SELECT balance FROM user_bank_accounts WHERE user_id = ? LIMIT 1`,
    [safeUserId]
  );
  return Number(rows[0]?.balance || 0);
}

module.exports = {
  ensureUserBankingProfile,
  getUserBankingProfile,
  listUserBankTransactions,
  creditUserBankAccount,
  debitUserBankAccount,
  getUserBalance,
};
