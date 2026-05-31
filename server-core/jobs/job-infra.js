'use strict';

// Job 10: Idle Water Storage Fill (every 60s)
// Job 11: Idle Infra-Recompute (every 10min)
// Job 12: Daily Snapshot (every 1h)

const { logError } = require('../infra/logger.js');

module.exports = function registerInfraJobs(deps) {
  const getRooms = () => require('../game/rooms');

  // 10) Idle Water Fill (für Gemeinden ohne aktive Spieler)
  const waterInterval = setInterval(async () => {
    try {
      const { dbPool } = require('../infra/db.js');
      const rooms      = getRooms();
      const activeIds  = new Set();
      for (const [, entry] of rooms.roomRuntimeCache.entries()) {
        if (Number(entry.activePlayers || 0) > 0 && entry.municipalityId) activeIds.add(Number(entry.municipalityId));
      }

      const tickHours = 60 / 3600;
      let sql = `UPDATE municipality_stats SET water_storage_level = GREATEST(0, LEAST(water_storage_capacity, water_storage_level + (water_production - water_consumption) * ?)) WHERE water_storage_capacity > 0`;
      const params = [tickHours];

      if (activeIds.size > 0) {
        sql += ` AND municipality_id NOT IN (${[...activeIds].map(() => '?').join(',')})`;
        params.push(...activeIds);
      }
      await dbPool.query(sql, params);
    } catch (err) {
      logError('INTERVAL', 'Idle water fill tick error', { error: err?.message });
    }
  }, 60000);

  // 11) Idle Infra-Recompute (alle 10min)
  const infraInterval = setInterval(async () => {
    try {
      const { dbPool }  = require('../infra/db.js');
      const { recomputeIdleInfraStats } = require('../game/stats.js');
      const rooms       = getRooms();
      const activeIds   = new Set();
      for (const [, entry] of rooms.roomRuntimeCache.entries()) {
        if (Number(entry.activePlayers || 0) > 0 && entry.municipalityId) activeIds.add(Number(entry.municipalityId));
      }
      const [idleRows] = await dbPool.query(
        `SELECT ms.municipality_id, gr.room_code FROM municipality_stats ms
         LEFT JOIN game_rooms gr ON gr.municipality_id = ms.municipality_id AND gr.is_active = 1
         WHERE ms.population > 0 GROUP BY ms.municipality_id, gr.room_code`
      );
      for (const row of idleRows) {
        const mid = Number(row.municipality_id);
        if (activeIds.has(mid)) continue;
        const rc = row.room_code || 'MAIN';
        try { await recomputeIdleInfraStats(mid, rc); }
        catch (e) { logError('INTERVAL', `Idle infra recompute Fehler (mid=${mid})`, { error: e?.message }); }
      }
    } catch (err) {
      logError('INTERVAL', 'Idle infra recompute Fehler', { error: err?.message });
    }
  }, 600000);

  // 12) Daily Snapshot (stündlich prüfen, einmal pro Tag schreiben)
  const snapshotInterval = setInterval(async () => {
    try {
      const { dbPool } = require('../infra/db.js');
      await dbPool.query(`
        INSERT IGNORE INTO municipality_stats_history
          (municipality_id, room_code, snapshot_date, population, jobs, money, income, expenses, happiness,
           power_production, power_consumption, water_production, water_consumption, solar_production)
        SELECT ms.municipality_id, 'default', CURDATE(),
               ms.population, ms.jobs, ms.treasury, ms.income, ms.expenses, 50,
               ms.power_production, ms.power_consumption, ms.water_production, ms.water_consumption, ms.solar_production
        FROM municipality_stats ms WHERE ms.population > 0
      `);
    } catch (err) {
      logError('INTERVAL', 'Daily snapshot job error', { error: err?.message });
    }
  }, 3600000);

  return [waterInterval, infraInterval, snapshotInterval];
};
