'use strict';

const fs = require('fs');
const path = require('path');
const { dbPool } = require('./db');
const { logInfo, logWarn, logError } = require('./logger');

const SQL_DIR = path.join(__dirname, '..', 'sql');
const MIGRATION_REGEX = /^(\d{3,})_.*\.sql$/;

/**
 * Erstellt die _migrations Tabelle falls sie nicht existiert.
 */
async function ensureMigrationsTable() {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(191) NOT NULL UNIQUE,
      checksum CHAR(64) NOT NULL DEFAULT '',
      executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/**
 * Gibt alle bereits ausgefuehrten Migration-Dateinamen zurueck.
 */
async function getExecutedMigrations() {
  const [rows] = await dbPool.query('SELECT name FROM _migrations ORDER BY id');
  return new Set(rows.map(r => r.name));
}

/**
 * Liest alle nummerierten SQL-Dateien aus dem sql/ Verzeichnis,
 * sortiert nach Nummer, und fuehrt ausstehende Migrationen aus.
 */
async function runPendingMigrations() {
  if (!dbPool) {
    logWarn('MIGRATE', 'Keine DB-Verbindung – Migrationen uebersprungen');
    return { applied: 0, skipped: 0, errors: 0 };
  }

  await ensureMigrationsTable();
  const executed = await getExecutedMigrations();

  // Alle nummerierten SQL-Dateien lesen und sortieren
  const files = fs.readdirSync(SQL_DIR)
    .filter(f => MIGRATION_REGEX.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(MIGRATION_REGEX)[1], 10);
      const numB = parseInt(b.match(MIGRATION_REGEX)[1], 10);
      return numA - numB;
    });

  let applied = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    if (executed.has(file)) {
      skipped++;
      continue;
    }

    const filePath = path.join(SQL_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf8').trim();
    if (!sql) {
      logWarn('MIGRATE', `Leere Migration uebersprungen: ${file}`);
      skipped++;
      continue;
    }

    const conn = await dbPool.getConnection();
    try {
      // Jede Migration als einzelne Transaktion ausfuehren
      const statements = splitStatements(sql);
      await conn.beginTransaction();
      for (const stmt of statements) {
        if (!stmt.trim()) continue;
        try {
          await conn.query(stmt);
        } catch (stmtErr) {
          const code = stmtErr?.code || '';
          const errno = stmtErr?.errno;
          // Harmlose Fehler ignorieren (Spalte/Tabelle/Index existiert bereits)
          const benign =
            code === 'ER_DUP_FIELDNAME'      || errno === 1060 || // Duplicate column name
            code === 'ER_TABLE_EXISTS_ERROR'  || errno === 1050 || // Table already exists
            code === 'ER_DUP_KEYNAME'         || errno === 1061 || // Duplicate key name
            code === 'ER_CANT_DROP_FIELD_OR_KEY' || errno === 1091; // Cant drop non-existing
          if (!benign) throw stmtErr;
        }
      }
      await conn.query('INSERT INTO _migrations (name, checksum) VALUES (?, ?)', [file, '']);
      await conn.commit();
      applied++;
      logInfo('MIGRATE', `Ausgefuehrt: ${file}`);
    } catch (err) {
      await conn.rollback().catch(() => {});
      errors++;
      logError('MIGRATE', `Fehler bei ${file}: ${err?.message || String(err)}`);
    } finally {
      conn.release();
    }
  }

  return { applied, skipped, errors, total: files.length };
}

/**
 * Teilt SQL-Text in einzelne Statements auf (getrennt durch ;).
 * Beruecksichtigt einfache und doppelte Anfuehrungszeichen sowie Backticks.
 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let prevChar = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const nextCh = i + 1 < sql.length ? sql[i + 1] : '';

    // Zeilenkommentar-Ende
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      prevChar = ch;
      continue;
    }

    // Blockkommentar-Ende
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && nextCh === '/') {
        current += '/';
        i++;
        inBlockComment = false;
      }
      prevChar = ch;
      continue;
    }

    // String/Backtick tracking
    if (ch === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
    } else if (ch === '`' && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
    }

    // Ausserhalb von Strings
    if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
      // Kommentar-Start
      if (ch === '-' && nextCh === '-') {
        inLineComment = true;
        current += ch;
        prevChar = ch;
        continue;
      }
      if (ch === '/' && nextCh === '*') {
        inBlockComment = true;
        current += ch;
        prevChar = ch;
        continue;
      }

      // Statement-Ende
      if (ch === ';') {
        const trimmed = current.trim();
        if (trimmed) statements.push(trimmed);
        current = '';
        prevChar = ch;
        continue;
      }
    }

    current += ch;
    prevChar = ch;
  }

  // Letztes Statement (ohne abschliessendes ;)
  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);

  return statements;
}

module.exports = { runPendingMigrations };
