'use strict';

/**
 * cleanup-stuck-contracts.js
 *
 * Schliesst alte Firmenauftraege die durch einen Bug nie abgeschlossen wurden.
 * Contracts mit Status 'open', 'accepted' oder 'assigned' und abgelaufener Deadline
 * werden auf 'failed' gesetzt. Die verknuepften municipality_events ebenfalls.
 *
 * Usage:
 *   node cleanup-stuck-contracts.js          -- Preview (kein Schreiben)
 *   node cleanup-stuck-contracts.js --commit -- Schreibt wirklich in die DB
 */

const fs   = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function loadConfig() {
  const cfgPath = path.join(__dirname, 'config.cfg');
  const raw = fs.readFileSync(cfgPath, 'utf8');
  const cfg = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx <= 0) continue;
    cfg[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return cfg;
}

async function main() {
  const isDryRun = !process.argv.includes('--commit');

  const cfg = loadConfig();
  const db = await mysql.createConnection({
    host:     cfg.DB_HOST     || '127.0.0.1',
    port:     Number(cfg.DB_PORT || 3306),
    user:     cfg.DB_USER     || 'root',
    password: cfg.DB_PASSWORD || '',
    database: cfg.DB_NAME,
    multipleStatements: false,
  });

  console.log(`\n=== Cleanup stuck contracts ${isDryRun ? '[DRY RUN – kein Schreiben]' : '[COMMIT MODE]'} ===\n`);

  // ── 1. Stuck contracts finden ─────────────────────────────────────────────
  const [stuck] = await db.query(`
    SELECT
      cc.id              AS contract_id,
      cc.company_id,
      cc.event_id,
      cc.status          AS contract_status,
      cc.payment,
      cc.deadline_at,
      cc.municipality_id,
      me.status          AS event_status,
      c.name             AS company_name
    FROM company_contracts cc
    LEFT JOIN municipality_events me ON me.id = cc.event_id
    LEFT JOIN companies c            ON c.id  = cc.company_id
    WHERE cc.status IN ('open', 'accepted', 'assigned')
      AND cc.deadline_at < NOW()
    ORDER BY cc.deadline_at ASC
  `);

  if (stuck.length === 0) {
    console.log('✓ Keine steckgebliebenen Auftraege gefunden.');
    await db.end();
    return;
  }

  console.log(`Gefunden: ${stuck.length} steckgebliebene Auftraege\n`);
  console.log('  ID       | Firma                     | Status    | Deadline            | Zahlung | Event-Status');
  console.log('  ---------+---------------------------+-----------+---------------------+---------+-------------');
  for (const r of stuck) {
    const deadline = r.deadline_at ? new Date(r.deadline_at).toISOString().slice(0, 16) : '—';
    const co = String(r.company_name || `#${r.company_id}`).padEnd(25);
    const cs = String(r.contract_status).padEnd(9);
    const es = r.event_status || '—';
    console.log(`  ${String(r.contract_id).padEnd(8)} | ${co} | ${cs} | ${deadline} | ${String(r.payment || 0).padEnd(7)} | ${es}`);
  }

  // Aufschlüsselung nach Status
  const byStatus = {};
  for (const r of stuck) {
    byStatus[r.contract_status] = (byStatus[r.contract_status] || 0) + 1;
  }
  console.log('\n  Aufschluesselung nach Status:');
  for (const [s, n] of Object.entries(byStatus)) {
    console.log(`    ${s}: ${n}`);
  }

  if (isDryRun) {
    console.log('\n→ Dry run. Nichts wurde geaendert.');
    console.log('  Starte mit --commit um die Aenderungen zu schreiben.\n');
    await db.end();
    return;
  }

  // ── 2. Contracts auf 'failed' setzen ─────────────────────────────────────
  const contractIds = stuck.map(r => r.contract_id);
  const [cResult] = await db.query(
    `UPDATE company_contracts SET status = 'failed' WHERE id IN (?) AND status IN ('open','accepted','assigned')`,
    [contractIds]
  );
  console.log(`\n✓ ${cResult.affectedRows} Contracts auf 'failed' gesetzt`);

  // ── 3. Verknüpfte Events auf 'failed' setzen ─────────────────────────────
  const eventIds = [...new Set(stuck.map(r => r.event_id).filter(Boolean))];
  let evResult = { affectedRows: 0 };
  if (eventIds.length > 0) {
    [evResult] = await db.query(
      `UPDATE municipality_events
       SET status = 'failed', resolved_at = NOW()
       WHERE id IN (?)
         AND status NOT IN ('resolved','expired','false_alarm','failed')`,
      [eventIds]
    );
    console.log(`✓ ${evResult.affectedRows} Events (aus abgelaufenen Contracts) auf 'failed' gesetzt`);
  }

  // ── 4. Verwaiste Events: Contract completed/failed aber Event noch aktiv ─
  const [orphaned] = await db.query(
    `SELECT me.id AS event_id, cc.status AS contract_status
     FROM municipality_events me
     JOIN company_contracts cc ON cc.event_id = me.id
     WHERE me.status NOT IN ('resolved','expired','false_alarm','failed')
       AND cc.status IN ('completed','failed','cancelled')`
  );
  let orphanResolved = 0, orphanFailed = 0;
  if (orphaned.length > 0) {
    console.log(`\n  Verwaiste Events gefunden: ${orphaned.length}`);
    const completedIds = orphaned.filter(r => r.contract_status === 'completed').map(r => r.event_id);
    const failedIds    = orphaned.filter(r => r.contract_status !== 'completed').map(r => r.event_id);
    if (completedIds.length > 0) {
      const [r] = await db.query(
        `UPDATE municipality_events SET status = 'resolved', resolved_at = NOW()
         WHERE id IN (?) AND status NOT IN ('resolved','expired','false_alarm','failed')`,
        [completedIds]
      );
      orphanResolved = r.affectedRows;
    }
    if (failedIds.length > 0) {
      const [r] = await db.query(
        `UPDATE municipality_events SET status = 'failed', resolved_at = NOW()
         WHERE id IN (?) AND status NOT IN ('resolved','expired','false_alarm','failed')`,
        [failedIds]
      );
      orphanFailed = r.affectedRows;
    }
    console.log(`✓ ${orphanResolved} verwaiste Events auf 'resolved' gesetzt (Contract war completed)`);
    console.log(`✓ ${orphanFailed} verwaiste Events auf 'failed' gesetzt (Contract war failed/cancelled)`);
  }

  console.log(`\nFertig. ${cResult.affectedRows} Contracts + ${evResult.affectedRows + orphanResolved + orphanFailed} Events bereinigt.\n`);
  await db.end();
}

main().catch(err => {
  console.error('\nFehler:', err.message || err);
  process.exit(1);
});
