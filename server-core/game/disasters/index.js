'use strict';

// Rückwärts-kompatibler Re-Export für require('./disasters.js') / require('./disasters')

const config            = require('./config.js');
const buildingUpgrades  = require('./building-upgrades.js');
const zoneGrowth        = require('./zone-growth.js');
const woodcutter        = require('./woodcutter.js');
const crimeSystem       = require('./crime-system.js');
const ticks             = require('./ticks.js');

module.exports = {
  // config.js
  ...config,

  // building-upgrades.js
  runServerBuildingUpgradeTick: buildingUpgrades.runServerBuildingUpgradeTick,

  // zone-growth.js
  runServerZoneGrowthTick: zoneGrowth.runServerZoneGrowthTick,

  // woodcutter.js
  runServerWoodcutterTick: woodcutter.runServerWoodcutterTick,

  // crime-system.js
  runServerCrimeTick: crimeSystem.runServerCrimeTick,
  clearCrimeState:    crimeSystem.clearCrimeState,

  // ticks.js
  runServerDisasterTick:         ticks.runServerDisasterTick,
  triggerManualDisaster:         ticks.triggerManualDisaster,
  runServerTrafficAccidentTick:  ticks.runServerTrafficAccidentTick,
  clearTrafficAccidentState:     ticks.clearTrafficAccidentState,
};
