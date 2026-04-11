'use strict';

const crypto = require('crypto');
const { dbPool, ensureDbEnabled } = require('../infra/db');
const { logInfo } = require('../infra/logger');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateReferralCode() {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes).map(b => ALPHABET[b % 36]).join('');
}

/**
 * Stellt sicher dass der User einen Referral-Code hat.
 * Generiert einen neuen falls keiner vorhanden. Retry bei Duplikat.
 * @returns {Promise<string>} Der Referral-Code
 */
async function ensureReferralCode(userId) {
  ensureDbEnabled();
  const safeId = Number(userId);

  // Schon vorhanden?
  const [rows] = await dbPool.query(
    'SELECT referral_code FROM users WHERE id = ? LIMIT 1',
    [safeId]
  );
  if (rows[0]?.referral_code) return rows[0].referral_code;

  // Generieren mit Retry bei Duplikat
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateReferralCode();
    try {
      await dbPool.query(
        'UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL',
        [code, safeId]
      );
      // Nochmal lesen (anderer Prozess könnte zuerst gewesen sein)
      const [check] = await dbPool.query(
        'SELECT referral_code FROM users WHERE id = ? LIMIT 1',
        [safeId]
      );
      if (check[0]?.referral_code) return check[0].referral_code;
    } catch (err) {
      if (err?.code !== 'ER_DUP_ENTRY') throw err;
      // Duplikat → neuen Code probieren
    }
  }
  throw new Error('Referral-Code konnte nicht generiert werden');
}

/**
 * Findet den User anhand seines Referral-Codes.
 * @returns {Promise<{id: number, nickname: string}|null>}
 */
async function lookupUserByReferralCode(code) {
  ensureDbEnabled();
  const clean = (code || '').toString().toUpperCase().trim().slice(0, 8);
  if (!/^[A-Z0-9]{8}$/.test(clean)) return null;

  const [rows] = await dbPool.query(
    'SELECT id, nickname FROM users WHERE referral_code = ? AND is_active = 1 LIMIT 1',
    [clean]
  );
  return rows[0] ? { id: Number(rows[0].id), nickname: String(rows[0].nickname) } : null;
}

/**
 * Trägt den Referral in die Tabelle ein (INSERT IGNORE → idempotent).
 * @returns {Promise<{id: number}|null>} Die referral-Zeile oder null falls schon vorhanden
 */
async function processReferral(referrerId, referredId, referralCode) {
  ensureDbEnabled();
  const [result] = await dbPool.query(
    `INSERT IGNORE INTO referrals (referrer_id, referred_id, referral_code)
     VALUES (?, ?, ?)`,
    [Number(referrerId), Number(referredId), String(referralCode)]
  );
  if (result.affectedRows === 0) return null;
  return { id: Number(result.insertId) };
}

/**
 * Schreibt dem Werbenden die Belohnung gut: 200 CHF + 100 XP.
 * Sicher gegen doppelte Ausführung via referrer_reward_paid Flag.
 */
async function dispatchReferrerRewards(referralId, referrerId) {
  ensureDbEnabled();
  const { creditUserBankAccount } = require('./userBanking');
  const { awardXp } = require('./xp');
  const { createNotificationForUser } = require('./notifications');

  // Atomisch prüfen + sperren
  const [rows] = await dbPool.query(
    'SELECT r.id, r.referrer_reward_paid, u.nickname AS referred_nickname FROM referrals r JOIN users u ON u.id = r.referred_id WHERE r.id = ? LIMIT 1',
    [Number(referralId)]
  );
  if (!rows[0] || rows[0].referrer_reward_paid) return; // bereits bezahlt

  const referredNickname = rows[0].referred_nickname || 'Jemand';

  try {
    await creditUserBankAccount(Number(referrerId), {
      amount: 200,
      type: 'referral_reward',
      description: 'Werbeprämie: Freund erfolgreich geworben',
      reference: `referral:${referralId}`,
    });
    await awardXp(
      Number(referrerId),
      100,
      'referral_reward',
      'Freund erfolgreich geworben',
      'referral',
      String(referralId)
    );
    await dbPool.query(
      'UPDATE referrals SET referrer_reward_paid = 1 WHERE id = ?',
      [Number(referralId)]
    );
    await createNotificationForUser(Number(referrerId), null, {
      type: 'referral_reward',
      title: 'Werbeprämie erhalten!',
      message: `${referredNickname} hat sich mit deinem Einladungslink registriert. Du erhältst +200 CHF und +100 XP als Dankeschön!`,
      icon: 'gift',
      amount: 200,
    });
    logInfo('REFERRAL', `Belohnung für Werbenden ${referrerId} ausgezahlt (referral ${referralId})`);
  } catch (err) {
    logInfo('REFERRAL', `Belohnungs-Fehler für Werbenden ${referrerId}: ${err?.message}`);
  }
}

module.exports = {
  ensureReferralCode,
  lookupUserByReferralCode,
  processReferral,
  dispatchReferrerRewards,
};
