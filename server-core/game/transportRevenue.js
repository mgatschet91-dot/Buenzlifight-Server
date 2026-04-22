'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { logInfo, logError } = require('../infra/logger');
const { applyMunicipalityTransaction } = require('./bank');
const { creditUserBankAccount } = require('./userBanking');

// Gleich wie bei Aufträgen: 35% vom Netto-Gewinn geht als Lohn an Mitarbeiter
const WORKER_PAYOUT_SHARE = 0.35;

// ═══════════════════════════════════════════════════════════
// ÖV-Einnahmen — Dynamisches Revenue-System (deckend/break-even)
// ═══════════════════════════════════════════════════════════
//
// Revenue = BasisProStop × sqrt(Pop/50) × Tageszeit × Zufriedenheit × Beschäftigung × Level
// Kosten  = Fix pro Linie + Stops × (Fix + PopFaktor × 0.9)  ← skaliert mit Einwohnern!
// Steuer  = taxRate × 32% auf Gewinn (gleich wie bei Aufträgen)
// Löhne   = 35% vom Netto-Gewinn → Mitarbeiter-Bankkonten
// Rest    → Firma-Balance (für Kredit-Rückzahlung etc.)
//
// Ziel: Knapp deckend bei kleinen Städten (~1000 Pop),
//       leicht profitabel bei grösseren (5k-50k).
//       Reale Schweizer ÖV-Kostendeckung: ~60% durch Tickets.
// ═══════════════════════════════════════════════════════════

const REVENUE_INTERVAL_HOURS = 1;

// Basis-Revenue pro Stop pro Stunde (wird durch Pop-Faktor skaliert)
const BASE_REVENUE_PER_STOP = 2;

// Kosten-Struktur: Skaliert mit Population (mehr Passagiere = mehr Busse/Fahrer nötig)
// Reale Schweizer ÖV-Daten: Ticket-Einnahmen decken ~60% der Kosten
// Im Game: knapp deckend bei kleinen Städten, leicht profitabel bei grösseren
const OPERATING_COST_BASE = 5;         // Fix pro Linie (Verwaltung, Depot)
const OPERATING_COST_PER_STOP = 1;     // Fix pro Stop (Haltestellen-Wartung)
const POP_COST_PER_STOP = 0.9;        // Variabel: mehr Einwohner = mehr Busse/Fahrer/Treibstoff

// Tageszeit-Multiplikatoren (Stunde 0-23)
const TIME_MULTIPLIERS = [
  0.05, 0.02, 0.02, 0.02, 0.05, 0.20, // 00-05: Nacht
  0.60, 1.40, 1.80, 1.20, 0.80, 0.70, // 06-11: Morgen Rush
  0.90, 0.80, 0.70, 0.80, 1.20, 1.60, // 12-17: Nachmittag Rush
  1.40, 1.00, 0.60, 0.30, 0.15, 0.08, // 18-23: Abend
];

// Population-Faktor: logarithmisch skaliert damit 50k nicht 500x mehr gibt als 100
// sqrt(pop / 50) → 100 Pop = 1.4, 500 = 3.2, 1000 = 4.5, 5000 = 10, 50000 = 31.6
function populationFactor(pop) {
  if (pop <= 0) return 0;
  return Math.sqrt(pop / 50);
}

// Beschäftigungs-Bonus: Pendler nutzen ÖV
// Bei 80%+ Beschäftigung: 1.2x, bei 50%: 1.0x, bei 20%: 0.7x
function employmentMultiplier(employed, population) {
  if (population <= 0) return 0.5;
  const rate = Math.min(1, employed / (population * 0.6)); // ~60% sind erwerbsfähig
  return 0.5 + rate * 0.7; // 0.5 bis 1.2
}

function satisfactionMultiplier(pct) {
  return 0.3 + (pct / 100) * 1.0;
}

function levelMultiplier(level) {
  return 1 + (level - 1) * 0.10;
}

// Tages-Durchschnitt berechnen (Summe aller Stunden-Multiplier / 24)
function calcDailyAverageMultiplier() {
  return TIME_MULTIPLIERS.reduce((a, b) => a + b, 0) / TIME_MULTIPLIERS.length;
}

async function processTransportRevenue() {
  ensureDbEnabled();

  const [companies] = await dbPool.query(
    `SELECT c.id, c.name, c.level, c.balance, c.municipality_id, c.last_revenue_at,
            ct.code AS type_code
     FROM companies c
     JOIN company_types ct ON ct.id = c.company_type_id
     WHERE ct.code = 'transport' AND c.is_active = 1`
  );

  if (companies.length === 0) return 0;

  let processed = 0;
  const now = new Date();
  const currentHour = now.getHours();
  const timeMult = TIME_MULTIPLIERS[currentHour] || 0.5;

  for (const company of companies) {
    try {
      // Stündliches Intervall prüfen
      if (company.last_revenue_at) {
        const lastRevenue = new Date(company.last_revenue_at);
        const hoursSince = (now - lastRevenue) / (1000 * 60 * 60);
        if (hoursSince < REVENUE_INTERVAL_HOURS) continue;
      }

      // Gemeinde-Daten: Population, Beschäftigung, Zufriedenheit, Steuersatz
      const [muniStats] = await dbPool.query(
        `SELECT ms.population, ms.citizen_satisfaction AS satisfaction, ms.tax_rate
         FROM municipality_stats ms
         WHERE ms.municipality_id = ?
         LIMIT 1`,
        [company.municipality_id]
      );

      const population = muniStats[0]?.population || 0;
      const employed = Math.floor(population * 0.6);
      const satisfaction = muniStats[0]?.satisfaction || 50;
      const taxRate = Number(muniStats[0]?.tax_rate || 10);
      const businessTaxRate = Math.max(0, Number((taxRate * 0.32).toFixed(2)));

      // Aktive Linien mit Stop-Counts
      const [lines] = await dbPool.query(
        `SELECT bl.id, bl.name,
                (SELECT COUNT(*) FROM bus_line_stops WHERE bus_line_id = bl.id) AS stop_count
         FROM bus_lines bl
         WHERE bl.company_id = ? AND bl.status = 'active'`,
        [company.id]
      );

      if (lines.length === 0) {
        await dbPool.query(
          `UPDATE companies SET last_revenue_at = NOW() WHERE id = ?`, [company.id]
        );
        continue;
      }

      // Multiplikatoren
      const level = company.level || 1;
      const lvlMult = levelMultiplier(level);
      const satMult = satisfactionMultiplier(satisfaction);
      const popFact = populationFactor(population);
      const empMult = employmentMultiplier(employed, population);

      let totalRevenue = 0;
      let totalCosts = 0;
      const lineDetails = [];

      for (const line of lines) {
        const stopCount = Number(line.stop_count) || 0;
        // Revenue = Basis × sqrt(Pop) × Stops × Tageszeit × Zufriedenheit × Beschäftigung × Level
        const rawRevenue = BASE_REVENUE_PER_STOP * popFact * stopCount * timeMult * satMult * empMult * lvlMult;
        const lineRevenue = Math.round(rawRevenue);
        // Kosten skalieren mit Population (mehr Passagiere = mehr Busse/Fahrer)
        const lineCost = Math.round(OPERATING_COST_BASE + stopCount * (OPERATING_COST_PER_STOP + POP_COST_PER_STOP * popFact));
        totalRevenue += lineRevenue;
        totalCosts += lineCost;
        lineDetails.push({ name: line.name, stops: stopCount, revenue: lineRevenue, cost: lineCost });
      }

      const grossProfit = totalRevenue - totalCosts;

      // Steuern nur auf Gewinn (nicht auf Verlust)
      const taxAmount = grossProfit > 0 ? Math.round(grossProfit * businessTaxRate / 100) : 0;
      const netIncome = grossProfit - taxAmount;

      // Firma-Balance aktualisieren
      await dbPool.query(
        `UPDATE companies SET
           balance = balance + ?,
           last_revenue_at = NOW(),
           total_revenue = total_revenue + GREATEST(0, ?)
         WHERE id = ?`,
        [netIncome, totalRevenue, company.id]
      );

      // Finanz-Eintrag Firma
      const [balanceRow] = await dbPool.query(
        `SELECT balance FROM companies WHERE id = ?`, [company.id]
      );
      const newBalance = balanceRow[0]?.balance || 0;

      const timeLabel = `${String(currentHour).padStart(2, '0')}:00`;
      const detailStr = lineDetails.map(l => `${l.name}: +${l.revenue}/-${l.cost}`).join(', ');

      if (netIncome !== 0) {
        const reason = netIncome >= 0 ? 'transport_revenue' : 'transport_costs';
        const desc = `ÖV ${timeLabel} | ${detailStr} | Brutto: ${grossProfit} | Steuer: ${taxAmount} (${businessTaxRate}%) | Netto: ${netIncome >= 0 ? '+' : ''}${netIncome} CHF`;
        await dbPool.query(
          `INSERT INTO company_finances (company_id, amount, balance_after, reason, description)
           VALUES (?, ?, ?, ?, ?)`,
          [company.id, netIncome, newBalance, reason, desc]
        );
      }

      // Steuer an Gemeinde-Kasse
      if (taxAmount > 0 && company.municipality_id) {
        try {
          await applyMunicipalityTransaction(company.municipality_id, {
            amount: taxAmount,
            type: 'company_tax',
            meta: { companyId: company.id, source: 'transport_revenue', grossProfit, taxRate, businessTaxRate, taxAmount },
            source: 'system',
          });

          // Steuer-Buchung in Firma-Finanzen
          await dbPool.query(
            `INSERT INTO company_finances (company_id, amount, balance_after, reason, description)
             VALUES (?, ?, ?, 'tax_payment', ?)`,
            [company.id, -taxAmount, newBalance, `Firmensteuer ${businessTaxRate}% auf ÖV-Einnahmen (${timeLabel}): ${taxAmount} CHF`]
          );

          logInfo('TRANSPORT', `Steuer ${company.name}: ${taxAmount} CHF (${businessTaxRate}%) → Gemeinde #${company.municipality_id}`);
        } catch (taxErr) {
          logError('TRANSPORT', `Steuer-Buchung Fehler: ${taxErr.message}`);
        }
      }

      // Mitarbeiter-Löhne: 35% vom Netto-Gewinn gleichmässig verteilt
      if (netIncome > 0) {
        try {
          const totalSalary = Math.round(netIncome * WORKER_PAYOUT_SHARE);
          const [members] = await dbPool.query(
            `SELECT cm.user_id FROM company_members cm WHERE cm.company_id = ?`,
            [company.id]
          );
          if (members.length > 0 && totalSalary > 0) {
            const perMember = Math.max(1, Math.round(totalSalary / members.length));
            for (const member of members) {
              try {
                await creditUserBankAccount(member.user_id, {
                  amount: perMember,
                  type: 'salary',
                  description: `ÖV-Lohn ${timeLabel} (${company.name})`,
                });
              } catch (_) { /* User hat evtl. kein Bankkonto */ }
            }
            // Firma zahlt Löhne aus Balance
            await dbPool.query(
              `UPDATE companies SET balance = balance - ? WHERE id = ?`,
              [totalSalary, company.id]
            );
            const [afterSalary] = await dbPool.query(`SELECT balance FROM companies WHERE id = ?`, [company.id]);
            await dbPool.query(
              `INSERT INTO company_finances (company_id, amount, balance_after, reason, description)
               VALUES (?, ?, ?, 'salary_payout', ?)`,
              [company.id, -totalSalary, afterSalary[0]?.balance || 0,
               `Löhne ${timeLabel}: ${totalSalary} CHF (${perMember}/Person × ${members.length} MA)`]
            );
            logInfo('TRANSPORT', `Löhne ${company.name}: ${totalSalary} CHF (${perMember}/MA × ${members.length})`);
          }
        } catch (salaryErr) {
          logError('TRANSPORT', `Lohn-Zahlung Fehler: ${salaryErr.message}`);
        }
      }

      // Reputation
      if (grossProfit > 0) {
        await dbPool.query(
          `UPDATE companies SET reputation = reputation + ? WHERE id = ?`,
          [lines.length, company.id]
        );
      } else if (grossProfit < -50) {
        await dbPool.query(
          `UPDATE companies SET reputation = GREATEST(0, reputation - 1) WHERE id = ?`,
          [company.id]
        );
      }

      processed++;
      logInfo('TRANSPORT', `"${company.name}" ${timeLabel}: Rev ${totalRevenue}, Kosten ${totalCosts}, Steuer ${taxAmount}, Netto ${netIncome} (Pop:${population}, Emp:${employed}, Sat:${satisfaction}%, Lvl:${level}, PopF:${popFact.toFixed(1)})`);

    } catch (err) {
      logError('TRANSPORT', `Revenue-Tick Fehler für Firma ${company.id}: ${err.message}`);
    }
  }

  return processed;
}

module.exports = { processTransportRevenue };
