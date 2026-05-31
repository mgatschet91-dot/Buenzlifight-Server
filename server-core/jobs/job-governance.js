'use strict';

// Job 13: Mansion-Mietabrechnungen (every 6h)
// Job 17: Election-Phase-Check + No-Confidence + Petitions (every 60s)
// Job 18a: War Relations Decay (every 60min)
// Job 18: Bürgermeister-Nachfolge (every 6h)
// Job 19: Firmen-Auftrags-Cleanup (every 5min)

const { logInfo, logError } = require('../infra/logger.js');

module.exports = function registerGovernanceJobs(deps) {
  const getMunicipality  = () => require('../game/municipality');
  const getWarRelations  = () => require('../game/warRelations');
  const getMansionRentals = () => require('../game/mansionRentals');

  // 13) Mansion-Mietabrechnungen (alle 6h)
  const mansionRentalsInterval = setInterval(async () => {
    try { await getMansionRentals().processMonthlyRentals(); }
    catch (err) { logError('INTERVAL', 'Mansion rentals tick error', { error: err?.message }); }
  }, 6 * 60 * 60 * 1000);

  // 17) Election + No-Confidence + Petitions (every 60s)
  const electionInterval = setInterval(async () => {
    try {
      const m = getMunicipality();
      await m.resolveElectionPhases();
      await m.resolveExpiredNoConfidenceVotes();
      await m.resolveExpiredPetitions();
    } catch (err) {
      logError('INTERVAL', 'Election phase check error', { error: err?.message });
    }
  }, 60000);

  // 18a) War Relations Decay (alle 60min)
  const warRelationsInterval = setInterval(async () => {
    try { await getWarRelations().runRelationDecayTick(); }
    catch (err) { logError('INTERVAL', 'War relations decay error', { error: err?.message }); }
  }, 60 * 60 * 1000);

  // 18) Bürgermeister-Nachfolge (alle 6h)
  const mayorSuccessionInterval = setInterval(async () => {
    try { await getMunicipality().checkAndSucceedInactiveMunicipalityOwners(); }
    catch (err) { logError('INTERVAL', 'Mayor succession tick error', { error: err?.message }); }
  }, 6 * 60 * 60 * 1000);

  // 19) Firmen-Auftrags-Cleanup (alle 5min)
  const contractCleanupInterval = setInterval(async () => {
    try {
      const { dbPool } = require('../infra/db.js');
      if (!dbPool) return;

      // a) Abgelaufene Contracts → failed
      const [expired] = await dbPool.query(
        `SELECT id, event_id FROM company_contracts WHERE status IN ('open', 'accepted', 'assigned') AND deadline_at < NOW()`
      );
      if (expired.length > 0) {
        const contractIds = expired.map(r => r.id);
        const eventIds    = [...new Set(expired.map(r => r.event_id).filter(Boolean))];
        await dbPool.query(`UPDATE company_contracts SET status = 'failed' WHERE id IN (?)`, [contractIds]);
        if (eventIds.length > 0) {
          await dbPool.query(
            `UPDATE municipality_events SET status = 'failed', resolved_at = NOW()
             WHERE id IN (?) AND status NOT IN ('resolved','expired','false_alarm','failed')`,
            [eventIds]
          );
        }
        logInfo('JOBS', `Contract-Cleanup: ${expired.length} abgelaufene Auftraege auf failed gesetzt`);
      }

      // b) Verwaiste Events (Contract abgeschlossen, Event noch aktiv)
      const [orphaned] = await dbPool.query(
        `SELECT me.id AS event_id, cc.status AS contract_status
         FROM municipality_events me
         JOIN company_contracts cc ON cc.event_id = me.id
         WHERE me.status NOT IN ('resolved','expired','false_alarm','failed')
           AND cc.status IN ('completed','failed','cancelled')`
      );
      if (orphaned.length > 0) {
        const completedEventIds = orphaned.filter(r => r.contract_status === 'completed').map(r => r.event_id);
        const failedEventIds    = orphaned.filter(r => r.contract_status !== 'completed').map(r => r.event_id);
        if (completedEventIds.length > 0) await dbPool.query(`UPDATE municipality_events SET status = 'resolved', resolved_at = NOW() WHERE id IN (?) AND status NOT IN ('resolved','expired','false_alarm','failed')`, [completedEventIds]);
        if (failedEventIds.length > 0) await dbPool.query(`UPDATE municipality_events SET status = 'failed', resolved_at = NOW() WHERE id IN (?) AND status NOT IN ('resolved','expired','false_alarm','failed')`, [failedEventIds]);
        logInfo('JOBS', `Contract-Cleanup: ${orphaned.length} verwaiste Events bereinigt`);
      }
    } catch (err) {
      logError('JOBS', 'Contract-Expiry-Tick Fehler', { error: err?.message });
    }
  }, 5 * 60 * 1000);

  return [mansionRentalsInterval, electionInterval, warRelationsInterval, mayorSuccessionInterval, contractCleanupInterval];
};
