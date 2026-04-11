const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, 'config.cfg'), 'utf8');
  const cfg = {};
  raw.split(/\r?\n/).forEach(l => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return;
    const i = t.indexOf('=');
    if (i > 0) cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  });
  return cfg;
}

(async () => {
  const cfg = loadConfig();
  const conn = await mysql.createConnection({
    host: cfg.DB_HOST || '127.0.0.1',
    port: Number(cfg.DB_PORT || 3306),
    user: cfg.DB_USER || 'root',
    password: cfg.DB_PASSWORD || '',
    database: cfg.DB_NAME,
  });

  console.log('=== 1. municipality_ledger table exists? ===');
  const [tables] = await conn.query('SHOW TABLES LIKE "municipality_ledger"');
  console.log(tables.length > 0 ? 'YES' : 'NO - TABLE MISSING!');

  console.log('\n=== 2. municipality_stats rows ===');
  const [statsCount] = await conn.query('SELECT COUNT(*) as cnt FROM municipality_stats');
  console.log('Total rows:', statsCount[0].cnt);

  console.log('\n=== 3. municipality_stats sample data ===');
  const [rows] = await conn.query(
    'SELECT municipality_id, treasury, debt, credit_limit, interest_rate, population, daily_income, daily_expenses FROM municipality_stats LIMIT 5'
  );
  rows.forEach(r => console.log(JSON.stringify(r)));

  if (rows.length === 0) {
    console.log('\n!!! KEINE municipality_stats DATEN - Das ist das Problem!');
    console.log('Checking if municipalities exist...');
    const [munis] = await conn.query('SELECT id, name FROM municipalities LIMIT 5');
    console.log('Municipalities:', munis.length);
    munis.forEach(m => console.log(JSON.stringify(m)));
  }

  console.log('\n=== 4. municipality_ledger entries ===');
  try {
    const [ledgerCount] = await conn.query('SELECT COUNT(*) as cnt FROM municipality_ledger');
    console.log('Ledger entries:', ledgerCount[0].cnt);
  } catch (err) {
    console.log('ERROR reading ledger:', err.message);
  }

  console.log('\n=== 5. Test getBankStatus query for first municipality ===');
  if (rows.length > 0) {
    const muniId = rows[0].municipality_id;
    console.log('Testing with municipality_id:', muniId);
    const [bankRows] = await conn.query(
      `SELECT treasury, debt, credit_limit, interest_rate, last_interest_at,
              daily_income, daily_expenses, population
       FROM municipality_stats WHERE municipality_id = ? LIMIT 1`,
      [muniId]
    );
    if (bankRows[0]) {
      console.log('getBankStatus would return:', JSON.stringify(bankRows[0]));
    } else {
      console.log('NO DATA for municipality', muniId);
    }
  }

  await conn.end();
  console.log('\n=== DONE ===');
})().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
