'use strict';

// Job 5:   Bank Interest Tick (every 60s)
// Job 5b:  Partnership Tier Upgrade (every 6h)
// Job 5c:  Partnership Trade Income (every 60s)
// Job 6:   Company Loan Repayment (every 60s)
// Job 7:   Transport Revenue (every 60s)
// Job 8:   Spot-Energie Auto-Subscribe + Billing (every 60s)
// Job N:   Einnahmen-Scheduler (every 5min, pays hourly)

const { logInfo, logError } = require('../infra/logger.js');

module.exports = function registerFinanceJobs(deps) {
  const getBank          = () => require('../game/bank');
  const getCompanyLoans  = () => require('../game/companyLoans');
  const getTransportRevenue = () => require('../game/transportRevenue');
  const getEnergySpot    = () => require('../game/energySpot');

  // 5) Bank Interest
  const bankInterestInterval = setInterval(async () => {
    try { await getBank().processAllPendingInterest(); }
    catch (err) { logError('INTERVAL', 'Bank interest tick error', { error: err?.message }); }
  }, 60000);

  // 5b) Partnership Tier Upgrade (alle 6h)
  const partnershipTierInterval = setInterval(async () => {
    try {
      const { processTierUpgrades } = require('../game/partnerships');
      const result = await processTierUpgrades();
      if (result.upgraded > 0) logInfo('PARTNERSHIP', `Tier-Upgrades verarbeitet: ${result.upgraded} Partnerschaften aufgestuft`);
    } catch (err) { logError('INTERVAL', 'Partnership tier tick error', { error: err?.message }); }
  }, 6 * 60 * 60 * 1000);

  // 5c) Partnership Trade Income (every 60s, pays only if 24h elapsed)
  const partnershipTradeInterval = setInterval(async () => {
    try {
      const { processTradeIncomePayouts } = require('../game/partnerships');
      const result = await processTradeIncomePayouts();
      if (result.paid > 0) logInfo('PARTNERSHIP', `Handelseinnahmen ausgezahlt: ${result.paid} Partnerschaften, ${result.totalAmount} CHF total`);
    } catch (err) { logError('INTERVAL', 'Partnership trade payout error', { error: err?.message }); }
  }, 60000);

  // 6) Company Loan Repayment (every 60s, pays only if 7 days elapsed)
  const loanInterval = setInterval(async () => {
    try { await getCompanyLoans().processWeeklyLoanPayments(); }
    catch (err) { logError('INTERVAL', 'Company loan tick error', { error: err?.message }); }
  }, 60000);

  // 7) Transport Revenue (every 60s, pays hourly)
  const transportInterval = setInterval(async () => {
    try { await getTransportRevenue().processTransportRevenue(); }
    catch (err) { logError('INTERVAL', 'Transport revenue tick error', { error: err?.message }); }
  }, 60000);

  // 8) Spot-Energie Auto-Subscribe + Billing (every 60s)
  const energyInterval = setInterval(async () => {
    try { await getEnergySpot().autoSubscribeSpotEnergy(); }
    catch (err) { logError('INTERVAL', 'Spot-Energie auto-subscribe Fehler', { error: err?.message }); }
    try { await getEnergySpot().processSpotEnergyBilling(); }
    catch (err) { logError('INTERVAL', 'Spot-Energie billing Fehler', { error: err?.message }); }
  }, 60000);

  // N) Einnahmen-Scheduler (alle 5min prüfen, zahlt wenn 60min rum)
  const incomeInterval = setInterval(async () => {
    try {
      const { dbPool } = require('../infra/db.js');
      const { applyMunicipalityTransaction } = require('../game/bank.js');
      const { createNotificationForAllMembers } = require('../game/notifications.js');
      if (!dbPool) return;

      const INCOME_INTERVAL_MS = 60 * 60 * 1000;
      const MAX_CATCHUP_DAYS   = 7;

      const [rows] = await dbPool.query(
        `SELECT municipality_id, daily_income, daily_expenses, last_income_at
         FROM municipality_stats
         WHERE last_income_at IS NULL OR last_income_at <= DATE_SUB(NOW(), INTERVAL 60 MINUTE)`
      );

      for (const row of rows) {
        try {
          const dailyNet    = (Number(row.daily_income) || 0) - (Number(row.daily_expenses) || 0);
          const lastAt      = row.last_income_at ? new Date(row.last_income_at).getTime() : null;
          const nowMs       = Date.now();
          const elapsedMs   = lastAt ? (nowMs - lastAt) : INCOME_INTERVAL_MS;
          const elapsedDays = Math.min(elapsedMs / (1000 * 60 * 60 * 24), MAX_CATCHUP_DAYS);
          const elapsedHours = Math.round(elapsedMs / (1000 * 60 * 60) * 10) / 10;
          const earnings    = Math.floor(dailyNet * elapsedDays);

          logInfo('INCOME', `Gemeinde ${row.municipality_id}: Einnahmen-Tick`, { lastIncomeAt: row.last_income_at || 'nie', elapsedHours, dailyNet, earnings });

          await dbPool.query(`UPDATE municipality_stats SET last_income_at = NOW() WHERE municipality_id = ?`, [row.municipality_id]);
          if (earnings === 0) { logInfo('INCOME', `Gemeinde ${row.municipality_id}: earnings=0`, { dailyNet }); continue; }

          await applyMunicipalityTransaction(row.municipality_id, {
            amount: earnings, type: 'income', allowOverdraft: true,
            meta: { days: Math.round(elapsedDays * 100) / 100, hours: elapsedHours, dailyIncome: row.daily_income, dailyExpenses: row.daily_expenses, dailyNet },
            source: 'system',
          });

          logInfo('INCOME', `Gemeinde ${row.municipality_id}: +${earnings} CHF gutgeschrieben`, { hours: elapsedHours, dailyNet });

          if (elapsedDays > 30 / (60 * 24)) {
            const timeText    = elapsedDays >= 1 ? `${Math.round(elapsedDays)} Tag${Math.round(elapsedDays) !== 1 ? 'e' : ''}` : `${Math.round(elapsedDays * 24)} Stunde${Math.round(elapsedDays * 24) !== 1 ? 'n' : ''}`;
            const earningsText = earnings >= 0 ? `+${earnings.toLocaleString()} CHF` : `-${Math.abs(earnings).toLocaleString()} CHF`;
            await createNotificationForAllMembers(row.municipality_id, {
              type: 'idle_earnings', title: earnings >= 0 ? 'Einnahmen gutgeschrieben' : 'Defizit abgebucht',
              message: `Deine Stadt hat in ${timeText} ${earningsText} verdient`,
              icon: earnings >= 0 ? 'money' : 'warning', amount: earnings,
            });
          }
        } catch (innerErr) {
          logError('INCOME', `Einnahmen-Tick fehlgeschlagen für municipality ${row.municipality_id}`, { error: innerErr?.message });
        }
      }
    } catch (err) {
      logError('INCOME', 'Einnahmen-Scheduler Fehler', { error: err?.message });
    }
  }, 5 * 60 * 1000);

  return [bankInterestInterval, partnershipTierInterval, partnershipTradeInterval, loanInterval, transportInterval, energyInterval, incomeInterval];
};
