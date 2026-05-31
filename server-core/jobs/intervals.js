'use strict';

const { logInfo } = require('../infra/logger.js');
const { invalidateRoomItemsCache } = require('./cache.js');

const registerRoomJobs       = require('./job-room.js');
const registerMainTickJob    = require('./job-main-tick.js');
const registerCitizenJobs    = require('./job-citizens.js');
const registerBuenzliJobs    = require('./job-buenzli.js');
const registerFinanceJobs    = require('./job-finance.js');
const registerInfraJobs      = require('./job-infra.js');
const registerNpcJobs        = require('./job-npc.js');
const registerGovernanceJobs = require('./job-governance.js');

function registerIntervals(deps) {
  const intervals = [
    ...registerRoomJobs(deps),        // Job 1+2:  Room-Cache, Stale-Player
    ...registerMainTickJob(deps),     // Job 3:    3s Haupt-Tick
    ...registerCitizenJobs(deps),     // Job 4a:   Citizens
    ...registerBuenzliJobs(deps),     // Job 4+14: Büenzli
    ...registerFinanceJobs(deps),     // Job 5-8+N: Finanzen
    ...registerInfraJobs(deps),       // Job 10-12: Infra
    ...registerNpcJobs(deps),         // Job 9+15+16: NPC, Parking
    ...registerGovernanceJobs(deps),  // Job 13+17+18+19: Governance
  ];

  logInfo('JOBS', `${intervals.length} Intervalle registriert`);
  return intervals;
}

module.exports = { registerIntervals, invalidateRoomItemsCache };
