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
    // Welcher User hat welche Gemeinde?
    console.log('\n=== USERS + GEMEINDEN ===');
    const [users] = await conn.query(
      `SELECT u.id, u.nickname, u.municipality_id, m.name AS muni_name,
              mm.role
       FROM users u
       LEFT JOIN municipalities m ON m.id = u.municipality_id
       LEFT JOIN municipality_memberships mm ON mm.user_id = u.id AND mm.municipality_id = u.municipality_id
       ORDER BY u.id LIMIT 20`
    );
    users.forEach(u => {
      console.log(`  User #${u.id} "${u.nickname}" -> Gemeinde: ${u.muni_name || 'KEINE'} (ID=${u.municipality_id || '-'}, Rolle=${u.role || '-'})`);
    });

    // Alle Gemeinden mit Stats
    console.log('\n=== ALLE GEMEINDEN + STATS ===');
    const [allMunis] = await conn.query(
      `SELECT m.id, m.name, ms.treasury, ms.debt
       FROM municipalities m
       LEFT JOIN municipality_stats ms ON ms.municipality_id = m.id
       ORDER BY m.id`
    );
    allMunis.forEach(m => {
      console.log(`  Gemeinde #${m.id} "${m.name}" -> Treasury=${m.treasury ?? 'N/A'}, Debt=${m.debt ?? 'N/A'}`);
    });

    // Demo-Eintraege fuer ALLE Gemeinden mit Stats
    console.log('\n=== DEMO-EINTRAEGE FUER ALLE GEMEINDEN ===');
    for (const muni of allMunis) {
      if (muni.treasury === null) {
        console.log(`  Skip ${muni.name} (keine Stats)`);
        continue;
      }

      // Pruefen ob schon Demo-Eintraege vorhanden
      const [[existing]] = await conn.query(
        `SELECT COUNT(*) AS cnt FROM municipality_ledger WHERE municipality_id = ?`, [muni.id]
      );
      if (existing.cnt > 0) {
        console.log(`  ${muni.name}: Bereits ${existing.cnt} Eintraege vorhanden, ueberspringe`);
        continue;
      }

      const treasury = Number(muni.treasury);
      const debt = Number(muni.debt || 0);

      const entries = [
        { type: 'idle_earnings', amount: 2500 },
        { type: 'building_cost', amount: -600 },
        { type: 'event_fix', amount: -150 },
      ];

      let balance = treasury;
      for (const e of entries) {
        balance += e.amount;
        await conn.query(
          `INSERT INTO municipality_ledger
             (municipality_id, type, amount, balance_after, debt_after, meta_json, source)
           VALUES (?, ?, ?, ?, ?, '{"demo":true}', 'system')`,
          [muni.id, e.type, e.amount, balance, debt]
        );
      }
      console.log(`  ${muni.name} (ID=${muni.id}): 3 Demo-Eintraege eingefuegt`);
    }

    // Zaehlung pro Gemeinde
    console.log('\n=== EINTRAEGE PRO GEMEINDE ===');
    const [counts] = await conn.query(
      `SELECT ml.municipality_id, m.name, COUNT(*) AS cnt
       FROM municipality_ledger ml
       JOIN municipalities m ON m.id = ml.municipality_id
       GROUP BY ml.municipality_id, m.name`
    );
    counts.forEach(c => {
      console.log(`  ${c.name} (ID=${c.municipality_id}): ${c.cnt} Eintraege`);
    });

    console.log('\n=== FERTIG - Jetzt im Browser Finanzen-Tab oeffnen ===');

  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('Fehler:', err.message);
  process.exit(1);
});
