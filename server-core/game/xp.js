'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { XP_LEVEL_CAP, XP_DAILY_LOGIN } = require('../config/constants');
const { pushDiscordEvent } = require('../shared/discord');

function calculateLevel(totalXp) {
  const level = Math.floor(Math.sqrt(totalXp / 100)) + 1;
  return Math.min(level, XP_LEVEL_CAP);
}

function xpForLevel(level) {
  return Math.pow(level - 1, 2) * 100;
}

async function getUserXp(userId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT user_id, total_xp, level, login_streak, best_streak, last_login_date, last_xp_at
     FROM user_xp WHERE user_id = ?`,
    [userId]
  );
  if (rows.length > 0) return rows[0];
  await dbPool.query(
    `INSERT IGNORE INTO user_xp (user_id, total_xp, level) VALUES (?, 0, 1)`,
    [userId]
  );
  return {
    user_id: userId,
    total_xp: 0,
    level: 1,
    login_streak: 0,
    best_streak: 0,
    last_login_date: null,
    last_xp_at: null,
  };
}

async function awardXp(userId, amount, reason, description, refType, refId) {
  ensureDbEnabled();
  if (!userId || amount === 0) return null;

  // Mieter-Bonus: aktiver Mietvertrag → +10% XP
  try {
    const [tenantRows] = await dbPool.query(
      `SELECT 1 FROM mansion_rental_agreements WHERE tenant_id = ? AND status = 'active' LIMIT 1`,
      [userId]
    );
    if (tenantRows.length > 0) {
      amount = Math.round(amount * 1.10);
    }
  } catch (_) {}
  const createUserNotification = require('./notifications').createUserNotification;

  const conn = await dbPool.getConnection();
  let newTotal, newLevel, oldLevel;
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT total_xp, level FROM user_xp WHERE user_id = ? FOR UPDATE`,
      [userId]
    );
    if (rows.length === 0) {
      await conn.query(
        `INSERT IGNORE INTO user_xp (user_id, total_xp, level) VALUES (?, 0, 1)`,
        [userId]
      );
      rows[0] = { total_xp: 0, level: 1 };
    }

    oldLevel = rows[0].level;
    newTotal = Math.max(0, rows[0].total_xp + amount);
    newLevel = calculateLevel(newTotal);

    await conn.query(
      `UPDATE user_xp SET total_xp = ?, level = ?, last_xp_at = NOW(), updated_at = NOW() WHERE user_id = ?`,
      [newTotal, newLevel, userId]
    );
    await conn.query(
      `INSERT INTO user_xp_log (user_id, xp_amount, reason, description, ref_type, ref_id, total_after, level_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, amount, reason, description, refType, refId, newTotal, newLevel]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const levelBadges = { 5: 'LVL_5', 10: 'LVL_10', 15: 'LVL_15', 20: 'LVL_20', 25: 'LVL_25' };
  if (newLevel > oldLevel) {
    if (levelBadges[newLevel]) {
      try {
        await dbPool.query(
          `INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, ?)`,
          [userId, levelBadges[newLevel]]
        );
      } catch (_) {}
    }
    await createUserNotification(
      userId,
      'level_up',
      `Level ${newLevel} erreicht!`,
      `Glückwunsch! Du bist jetzt Level ${newLevel}.`,
      { old_level: oldLevel, new_level: newLevel, total_xp: newTotal }
    );
  }

  return { total_xp: newTotal, level: newLevel, old_level: oldLevel, xp_change: amount };
}

async function processDailyLogin(userId) {
  ensureDbEnabled();
  await getUserXp(userId);

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // Atomares UPDATE: best_streak VOR login_streak (MySQL evaluiert SET links→rechts)
  const [updateResult] = await dbPool.query(
    `UPDATE user_xp
     SET best_streak   = GREATEST(best_streak, IF(last_login_date = ?, login_streak + 1, 1)),
         login_streak  = IF(last_login_date = ?, login_streak + 1, 1),
         last_login_date = ?,
         updated_at = NOW()
     WHERE user_id = ? AND (last_login_date IS NULL OR last_login_date < ?)`,
    [yesterday, yesterday, today, userId, today]
  );

  if (updateResult.affectedRows === 0) return null;

  const xpData = await getUserXp(userId);
  const newStreak = xpData.login_streak;
  const bestStreak = xpData.best_streak;

  let totalBonus = 0;
  const [bonuses] = await dbPool.query(
    `SELECT streak_days, bonus_xp, badge_code FROM xp_streak_bonuses WHERE streak_days <= ? ORDER BY streak_days DESC`,
    [newStreak]
  );
  if (bonuses.length > 0) {
    totalBonus = bonuses[0].bonus_xp;
    for (const bonus of bonuses) {
      if (bonus.badge_code && bonus.streak_days === newStreak) {
        try {
          await dbPool.query(
            `INSERT IGNORE INTO user_badges (user_id, badge_code) VALUES (?, ?)`,
            [userId, bonus.badge_code]
          );
        } catch (_) {}
      }
    }
  }

  const totalXpGain = XP_DAILY_LOGIN + totalBonus;
  const result = await awardXp(
    userId,
    totalXpGain,
    'daily_login',
    `Tägl. Login (+${XP_DAILY_LOGIN}) + Streak ${newStreak} Tage (+${totalBonus})`,
    null,
    null
  );

  return { ...result, login_streak: newStreak, best_streak: bestStreak, bonus_xp: totalBonus };
}

module.exports = {
  calculateLevel,
  xpForLevel,
  getUserXp,
  awardXp,
  processDailyLogin,
};
