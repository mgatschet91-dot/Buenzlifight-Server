'use strict';

// ——— Shared constants ———

const COMPANY_LEVEL_THRESHOLDS = [0, 20, 60, 120, 200, 320, 480, 700, 1000, 1400];
const CONTRACT_WORKER_PAYOUT_SHARE = 0.35;
const EXTERNAL_REPORT_PAYOUT_RATIO = 0.08;
const EXTERNAL_REPORT_PAYOUT_MIN = 250;
const EXTERNAL_REPORT_PAYOUT_MAX = 5000;

// ——— Shared helper functions ———

function calcCompanyLevel(reputation) {
  let level = 1;
  for (let i = COMPANY_LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (reputation >= COMPANY_LEVEL_THRESHOLDS[i]) { level = i + 1; break; }
  }
  return Math.min(level, 10);
}

// Basis-Zeiten pro Schwierigkeit (Sekunden):
//   1 = 5 Min, 2 = 30 Min, 3 = 1 Std, 4 = 3 Std, 5 = 6 Std
// Firma-Level reduziert die Zeit (max -50% bei Level 10)
function calcWorkDuration(difficulty, companyLevel = 1) {
  const baseDurations = { 1: 300, 2: 1800, 3: 3600, 4: 10800, 5: 21600 };
  const base = baseDurations[difficulty] || 1800;
  const levelReduction = Math.min(0.5, (companyLevel - 1) * 0.05);
  return Math.max(60, Math.round(base * (1 - levelReduction)));
}

module.exports = {
  COMPANY_LEVEL_THRESHOLDS,
  CONTRACT_WORKER_PAYOUT_SHARE,
  EXTERNAL_REPORT_PAYOUT_RATIO,
  EXTERNAL_REPORT_PAYOUT_MIN,
  EXTERNAL_REPORT_PAYOUT_MAX,
  calcCompanyLevel,
  calcWorkDuration,
};
