'use strict';

const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, 'config.cfg'), 'utf8');
  const cfg = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return cfg;
}

async function main() {
  const cfg = loadConfig();
  const conn = await mysql.createConnection({
    host: cfg.DB_HOST || '127.0.0.1',
    port: Number(cfg.DB_PORT || 3306),
    user: cfg.DB_USER || 'root',
    password: cfg.DB_PASSWORD || '',
    database: cfg.DB_NAME,
  });

  try {
    // 1) Tabelle vorhanden?
    console.log('\n=== CHECK 1: municipality_ledger Tabelle ===');
    try {
      const [cols] = await conn.query(`SHOW COLUMNS FROM municipality_ledger`);
      console.log(`OK - Tabelle existiert mit ${cols.length} Spalten:`);
      cols.forEach(c => console.log(`  - ${c.Field} (${c.Type})`));
    } catch (err) {
      console.error(`FEHLER - Tabelle existiert NICHT: ${err.message}`);
      console.log('\n>>> Migration 049 wurde noch nicht ausgefuehrt!');
      console.log('>>> Fuehre aus: node migrate.js up\n');
      return;
    }

    // 2) Aktuelle Eintraege zaehlen
    console.log('\n=== CHECK 2: Vorhandene Eintraege ===');
    const [[countRow]] = await conn.query(`SELECT COUNT(*) AS cnt FROM municipality_ledger`);
    console.log(`Eintraege gesamt: ${countRow.cnt}`);

    // 3) Erste Gemeinde finden
    console.log('\n=== CHECK 3: Gemeinden ===');
    const [munis] = await conn.query(`SELECT id, name FROM municipalities LIMIT 5`);
    if (munis.length === 0) {
      console.log('FEHLER - Keine Gemeinden in der DB!');
      return;
    }
    console.log('Gemeinden:');
    munis.forEach(m => console.log(`  - ID ${m.id}: ${m.name}`));

    const testMuniId = munis[0].id;
    console.log(`\nVerwende Gemeinde ID=${testMuniId} (${munis[0].name}) fuer Demo-Eintraege`);

    // 4) municipality_stats pruefen
    console.log('\n=== CHECK 4: municipality_stats ===');
    const [statsRows] = await conn.query(
      `SELECT municipality_id, treasury, debt, daily_income, daily_expenses
       FROM municipality_stats WHERE municipality_id = ?`, [testMuniId]
    );
    if (statsRows.length === 0) {
      console.log(`FEHLER - Keine municipality_stats fuer Gemeinde ${testMuniId}!`);
      return;
    }
    const stats = statsRows[0];
    console.log(`Treasury: ${stats.treasury}, Debt: ${stats.debt}, Income: ${stats.daily_income}, Expenses: ${stats.daily_expenses}`);

    // 5) Demo-Eintraege einfuegen
    console.log('\n=== CHECK 5: Demo-Eintraege einfuegen ===');
    const treasury = Number(stats.treasury);
    const debt = Number(stats.debt);

    const demoEntries = [
      { type: 'idle_earnings', amount: 1500, desc: 'Demo Idle-Einnahmen' },
      { type: 'building_cost', amount: -800, desc: 'Demo Baukosten' },
      { type: 'event_fix', amount: -200, desc: 'Demo Event behoben' },
    ];

    let runningBalance = treasury;
    for (const entry of demoEntries) {
      runningBalance += entry.amount;
      await conn.query(
        `INSERT INTO municipality_ledger
           (municipality_id, type, amount, balance_after, debt_after, meta_json, actor_user_id, source)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'system')`,
        [testMuniId, entry.type, entry.amount, runningBalance, debt,
         JSON.stringify({ demo: true, description: entry.desc })]
      );
      console.log(`  Eingefuegt: ${entry.type} ${entry.amount > 0 ? '+' : ''}${entry.amount} (${entry.desc})`);
    }

    // 6) Eintraege zuruecklesen (wie getLedger es tut)
    console.log('\n=== CHECK 6: Eintraege zuruecklesen ===');
    const [entries] = await conn.query(
      `SELECT id, ts, type, amount, balance_after, debt_after, meta_json, actor_user_id, source
       FROM municipality_ledger
       WHERE municipality_id = ?
       ORDER BY ts DESC, id DESC
       LIMIT 10`,
      [testMuniId]
    );
    console.log(`Gelesene Eintraege: ${entries.length}`);
    entries.forEach(e => {
      console.log(`  #${e.id} | ${e.type} | ${e.amount > 0 ? '+' : ''}${e.amount} | balance=${e.balance_after} | ${e.ts}`);
    });

    // 7) Filter-Test (wie Frontend 'income'/'expense' filter)
    console.log('\n=== CHECK 7: Filter-Test ===');
    const [[incomeCount]] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM municipality_ledger WHERE municipality_id = ? AND amount > 0`, [testMuniId]
    );
    const [[expenseCount]] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM municipality_ledger WHERE municipality_id = ? AND amount < 0`, [testMuniId]
    );
    console.log(`Einnahmen (amount > 0): ${incomeCount.cnt}`);
    console.log(`Ausgaben (amount < 0): ${expenseCount.cnt}`);

    console.log('\n=== FERTIG ===');
    console.log('Wenn Eintraege hier sichtbar sind aber im Frontend nicht:');
    console.log('  -> Problem liegt in der API oder im Frontend');
    console.log('Wenn die Tabelle nicht existiert:');
    console.log('  -> node migrate.js up ausfuehren');

  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('Test fehlgeschlagen:', err.message);
  process.exit(1);
});
