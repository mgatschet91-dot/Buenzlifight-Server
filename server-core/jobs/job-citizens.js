'use strict';

// Job 4a: Citizen Happiness + Migration Tick (every 5min)

const { logError } = require('../infra/logger.js');

module.exports = function registerCitizenJobs(deps) {
  const getRooms    = () => require('../game/rooms');
  const getCitizens = () => require('../game/citizens');

  // Backfill beim Start für alle aktiven Gemeinden (5s Verzögerung damit DB bereit ist)
  const _backfilledMunicipalities = new Set();
  setTimeout(async () => {
    try {
      const { dbPool } = require('../infra/db.js');
      const citizens   = getCitizens();
      const [munis]    = await dbPool.query(`SELECT id FROM municipalities WHERE is_active = 1 LIMIT 50`);
      for (const m of munis) {
        if (_backfilledMunicipalities.has(m.id)) continue;
        _backfilledMunicipalities.add(m.id);
        citizens.backfillCitizensForAllBuildings(m.id).catch(() => {});
      }
    } catch (_) {}
  }, 5000);

  const citizenInterval = setInterval(async () => {
    try {
      const rooms    = getRooms();
      const citizens = getCitizens();
      for (const [, entry] of rooms.roomRuntimeCache.entries()) {
        if (entry.activePlayers <= 0) continue;
        const { municipalityId } = entry;

        if (!_backfilledMunicipalities.has(municipalityId)) {
          _backfilledMunicipalities.add(municipalityId);
          citizens.backfillCitizensForAllBuildings(municipalityId).catch(() => {});
        }

        const crimeRate = Math.min(1, (entry._lastCrimeCount || 0) / 10);
        await citizens.runCitizenHappinessTick(municipalityId, crimeRate).catch(() => {});
        await citizens.runCitizenMigrationCheck(municipalityId).catch(() => {});
      }
    } catch (err) {
      logError('INTERVAL', 'Citizen happiness tick error', { error: err?.message });
    }
  }, 5 * 60 * 1000);

  return [citizenInterval];
};
