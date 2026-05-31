'use strict';

// Job 9:   NPC-Bot Arbeitstick + Wochenlohn (every 60s)
// Job 15:  Werkhof Patrol Reparatur (every 10min)
// Job 16a: Parkraum Ablauf-Tick (every 60s)
// Job 16b: Parkraum Kontrolleur-Tick (every 30s)

const { logError } = require('../infra/logger.js');
const { buildBroadcastToRoom } = require('./cache.js');

module.exports = function registerNpcJobs(deps) {
  const getNpcBots       = () => require('../game/npcBots');
  const getParkingSystem = () => require('../game/parkingSystem');

  // 9) NPC-Bot Arbeitstick + Wochenlohn
  const npcBotInterval = setInterval(async () => {
    try { await getNpcBots().runNpcBotTick(); }
    catch (err) { logError('INTERVAL', 'NPC-Bot Arbeitstick Fehler', { error: err?.message }); }
    try { await getNpcBots().runNpcSalaryTick(); }
    catch (err) { logError('INTERVAL', 'NPC-Bot Lohntick Fehler', { error: err?.message }); }
  }, 60000);

  // 15) Werkhof Patrol Reparatur (alle 10min)
  const werkhofInterval = setInterval(async () => {
    try { await getNpcBots().runServerWerkhofRepairTick(deps?.io); }
    catch (err) { logError('INTERVAL', 'Werkhof Patrol Reparatur-Tick Fehler', { error: err?.message }); }
  }, 10 * 60 * 1000);

  // 16a) Parkraum Ablauf (abgelaufene Fahrzeuge rauswerfen)
  const parkingExpiryInterval = setInterval(async () => {
    try { await getParkingSystem().runParkingExpiryTick(buildBroadcastToRoom(deps?.io)); }
    catch (err) { logError('INTERVAL', 'Parkraum-Ablauf-Tick Fehler', { error: err?.message }); }
  }, 60000);

  // 16b) Parkraum Kontrolleur (Schwarzparker büssen)
  const parkingControlInterval = setInterval(async () => {
    try { await getParkingSystem().runParkingControlTick(buildBroadcastToRoom(deps?.io)); }
    catch (err) { logError('INTERVAL', 'Parkraum-Kontrolleur-Tick Fehler', { error: err?.message }); }
  }, 30000);

  return [npcBotInterval, werkhofInterval, parkingExpiryInterval, parkingControlInterval];
};
