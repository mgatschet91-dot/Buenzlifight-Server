'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { DEFAULT_ACHIEVEMENTS } = require('../config/constants');
const { normalizeRoomCode } = require('../shared/helpers');

// Schema wird über sql/043_consolidate_inline_schema.sql verwaltet
function ensureAchievementTables() {
  return Promise.resolve();
}

async function seedAchievementsCatalog() {
  ensureDbEnabled();
  for (const def of DEFAULT_ACHIEVEMENTS) {
    await dbPool.query(
      `INSERT INTO achievements
        (code, title, description, goal_type, goal_value, reward_xp, reward_money, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         description = VALUES(description),
         goal_type = VALUES(goal_type),
         goal_value = VALUES(goal_value),
         reward_xp = VALUES(reward_xp),
         reward_money = VALUES(reward_money),
         is_active = 1,
         sort_order = VALUES(sort_order),
         updated_at = CURRENT_TIMESTAMP`,
      [
        String(def.code),
        String(def.title),
        String(def.description || ''),
        String(def.goal_type),
        Number(def.goal_value || 0),
        Number(def.reward_xp || 0),
        Number(def.reward_money || 0),
        Number(def.sort_order || 0),
      ]
    );
  }
}

/**
 * Build progress snapshot for achievement checks. Uses lazy requires for rooms.recomputeAuthoritativePopulationAndJobs
 * and partnerships.listPartnershipRows; if recompute is missing, population/jobs are 0 and money from loadRoomStats.
 * @param {number} municipalityId
 * @param {string} roomCode
 * @returns {Promise<{ room_code: string, population: number, jobs: number, money: number, connected_partnerships: number, building_count: number, city_hall_count: number }>}
 */
async function getAchievementProgressSnapshot(municipalityId, roomCode) {
  ensureDbEnabled();
  const safeRoomCode = normalizeRoomCode(roomCode) || 'MAIN';
  let population = 0;
  let jobs = 0;
  let money = 0;

  try {
    const rooms = require('./rooms');
    if (typeof rooms.recomputeAuthoritativePopulationAndJobs === 'function') {
      const stats = await rooms.recomputeAuthoritativePopulationAndJobs(municipalityId, safeRoomCode);
      if (stats && typeof stats === 'object') {
        population = Number(stats.population) || 0;
        jobs = Number(stats.jobs) || 0;
        money = Number(stats.money);
        if (!Number.isFinite(money)) money = 0;
      }
    }
  } catch (_) {
    // recomputeAuthoritativePopulationAndJobs may not exist in rooms.js yet
  }

  if (!Number.isFinite(money) || money === 0) {
    try {
      const rooms = require('./rooms');
      money = await rooms.getMunicipalityMoney(municipalityId);
    } catch (_) {}
  }

  let connectedPartnerships = 0;
  try {
    const partnerships = require('./partnerships');
    const rows = await partnerships.listPartnershipRows(municipalityId);
    connectedPartnerships = rows.filter((r) => String(r.status) === 'connected').length;
  } catch (_) {}

  const [buildingRows] = await dbPool.query(
    `SELECT
       COUNT(*) AS building_count,
       SUM(
         CASE WHEN LOWER(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.buildingType')), ''), NULLIF(tool, ''), '')) = 'city_hall'
           THEN 1 ELSE 0
         END
       ) AS city_hall_count
     FROM game_items
     WHERE municipality_id = ?
       AND room_code = ?
       AND action_type IN ('place', 'zone')
       AND LOWER(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.buildingType')), ''), NULLIF(tool, ''), '')) NOT IN ('', 'empty', 'grass', 'water')`,
    [municipalityId, safeRoomCode]
  );
  const row = Array.isArray(buildingRows) && buildingRows.length > 0 ? buildingRows[0] : {};
  const buildingCount = Number(row.building_count || 0);
  const cityHallCount = Number(row.city_hall_count || 0);

  return {
    room_code: safeRoomCode,
    population,
    jobs,
    money,
    connected_partnerships: connectedPartnerships,
    building_count: buildingCount,
    city_hall_count: cityHallCount,
  };
}

/**
 * Seed catalog, load achievements, compute progress, upsert achievement_user rows. Returns room_code and achievements list.
 * @param {number} userId
 * @param {number} municipalityId
 * @param {string} [roomCode]
 * @returns {Promise<{ room_code: string, achievements: Array<Object> }>}
 */
async function syncUserAchievements(userId, municipalityId, roomCode = 'MAIN') {
  ensureDbEnabled();
  await seedAchievementsCatalog();
  const [achievementRows] = await dbPool.query(
    `SELECT id, code, title, description, goal_type, goal_value, reward_xp, reward_money, is_active, sort_order
     FROM achievements
     WHERE is_active = 1
     ORDER BY sort_order ASC, id ASC`
  );
  const achievements = Array.isArray(achievementRows) ? achievementRows : [];
  if (achievements.length <= 0) {
    return { room_code: normalizeRoomCode(roomCode) || 'MAIN', achievements: [] };
  }

  const progress = await getAchievementProgressSnapshot(municipalityId, roomCode);
  const values = [];
  const params = [];
  for (const ach of achievements) {
    const goalType = String(ach.goal_type || '').trim();
    const goalValue = Math.max(1, Number(ach.goal_value || 1));
    const currentValue = Math.max(0, Number(progress[goalType] || 0));
    const achieved = currentValue >= goalValue ? 1 : 0;
    values.push('(?, ?, ?, ?, ?)');
    params.push(Number(userId), Number(municipalityId), Number(ach.id), currentValue, achieved);
  }
  if (values.length > 0) {
    await dbPool.query(
      `INSERT INTO achievement_user (user_id, municipality_id, achievement_id, progress_value, achieved)
       VALUES ${values.join(', ')}
       ON DUPLICATE KEY UPDATE
         progress_value = VALUES(progress_value),
         achieved = GREATEST(achievement_user.achieved, VALUES(achieved)),
         achieved_at = CASE
           WHEN achievement_user.achieved_at IS NULL AND VALUES(achieved) = 1 THEN CURRENT_TIMESTAMP
           ELSE achievement_user.achieved_at
         END,
         updated_at = CURRENT_TIMESTAMP`,
      params
    );
  }

  const [userRows] = await dbPool.query(
    `SELECT achievement_id, progress_value, achieved, achieved_at, claimed, claimed_at
     FROM achievement_user
     WHERE user_id = ? AND municipality_id = ?`,
    [Number(userId), Number(municipalityId)]
  );
  const byAchievementId = new Map();
  for (const r of Array.isArray(userRows) ? userRows : []) {
    byAchievementId.set(Number(r.achievement_id), r);
  }

  const result = achievements.map((ach) => {
    const userRow = byAchievementId.get(Number(ach.id)) || null;
    const goalValue = Math.max(1, Number(ach.goal_value || 1));
    const currentValue = Math.max(0, Number(userRow?.progress_value || 0));
    const achieved = Boolean(userRow?.achieved);
    const claimed = Boolean(userRow?.claimed);
    return {
      id: Number(ach.id),
      code: String(ach.code || ''),
      title: String(ach.title || ''),
      description: String(ach.description || ''),
      goal_type: String(ach.goal_type || ''),
      goal_value: goalValue,
      progress_value: currentValue,
      progress_percent: Math.min(100, Math.round((currentValue / goalValue) * 100)),
      reward_xp: Number(ach.reward_xp || 0),
      reward_money: Number(ach.reward_money || 0),
      achieved,
      achieved_at: userRow?.achieved_at || null,
      claimed,
      claimed_at: userRow?.claimed_at || null,
    };
  });

  return {
    room_code: progress.room_code,
    achievements: result,
  };
}

/**
 * Claim an achievement for a user: mark claimed and add reward_money to room stats.
 * @param {Object} opts
 * @param {number} opts.userId
 * @param {number} opts.municipalityId
 * @param {string} opts.achievementCode
 * @param {string} [opts.roomCode]
 * @returns {Promise<Object>}
 */
async function claimAchievementForUser({ userId, municipalityId, achievementCode, roomCode = 'MAIN' }) {
  ensureDbEnabled();
  const synced = await syncUserAchievements(userId, municipalityId, roomCode);
  const targetCode = String(achievementCode || '').trim().toLowerCase();
  const target = synced.achievements.find((entry) => String(entry.code || '').toLowerCase() === targetCode);
  if (!target) {
    return { ok: false, already_claimed: false, room_code: synced.room_code, error: 'Achievement nicht gefunden' };
  }
  if (!target.achieved) {
    return {
      ok: false,
      already_claimed: false,
      room_code: synced.room_code,
      achievement: target,
      reward_money_applied: 0,
      updated_stats: null,
      error: 'Achievement noch nicht erreicht',
    };
  }
  if (target.claimed) {
    return {
      ok: true,
      already_claimed: true,
      room_code: synced.room_code,
      achievement: target,
      reward_money_applied: 0,
      updated_stats: null,
    };
  }

  await dbPool.query(
    `UPDATE achievement_user
     SET claimed = 1,
         claimed_at = COALESCE(claimed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND municipality_id = ? AND achievement_id = ?`,
    [Number(userId), Number(municipalityId), Number(target.id)]
  );

  let updatedStats = null;
  const rewardMoney = Math.max(0, Number(target.reward_money || 0));
  if (rewardMoney > 0) {
    // Achievement-Reward über applyMunicipalityTransaction gutschreiben
    // (transaktional mit FOR UPDATE Lock, verhindert Race Conditions)
    const { applyMunicipalityTransaction } = require('./bank.js');
    await applyMunicipalityTransaction(municipalityId, {
      amount: rewardMoney,
      type: 'achievement_reward',
      meta: { achievementCode: target.code, achievementTitle: target.title },
      actorUserId: userId,
      source: 'system',
    });

    // achievement_rewards_total in Room-Stats tracken (nur Statistik, kein Geld)
    const rooms = require('./rooms');
    const rawStats = (await rooms.loadRoomStats(municipalityId, synced.room_code)) || {};
    const nextStats = { ...rawStats };
    nextStats.achievement_rewards_total = Math.max(0, Number(nextStats.achievement_rewards_total || 0) + rewardMoney);
    await rooms.saveRoomStats(municipalityId, synced.room_code, nextStats);

    try {
      const { recomputeAuthoritativePopulationAndJobs } = require('./stats');
      updatedStats = await recomputeAuthoritativePopulationAndJobs(municipalityId, synced.room_code);
    } catch (_) {}
  }

  let xpResult = null;
  const rewardXp = Math.max(0, Number(target.reward_xp || 0));
  if (rewardXp > 0) {
    const { awardXp } = require('./xp');
    xpResult = await awardXp(
      userId, rewardXp, 'achievement_claim',
      `Achievement: ${target.title}`, 'achievement', target.id
    );
  }

  const refreshed = await syncUserAchievements(userId, municipalityId, synced.room_code);
  const refreshedTarget = refreshed.achievements.find((entry) => Number(entry.id) === Number(target.id)) || target;
  return {
    ok: true,
    already_claimed: false,
    room_code: synced.room_code,
    achievement: refreshedTarget,
    reward_money_applied: rewardMoney,
    reward_xp_applied: rewardXp,
    xp: xpResult,
    updated_stats: updatedStats,
  };
}

module.exports = {
  ensureAchievementTables,
  seedAchievementsCatalog,
  getAchievementProgressSnapshot,
  syncUserAchievements,
  claimAchievementForUser,
};
