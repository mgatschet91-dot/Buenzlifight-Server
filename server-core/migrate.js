const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const cfg = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    cfg[key] = value;
  }
  return cfg;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function ensureMigrationsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(191) NOT NULL,
      checksum CHAR(64) NOT NULL,
      executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_migrations_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function listMigrationFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter(name => /^\d+.*\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
}

async function status(conn, migrationsDir) {
  await ensureMigrationsTable(conn);
  const [rows] = await conn.query('SELECT name, checksum, executed_at FROM _migrations ORDER BY id ASC');
  const executed = new Map(rows.map(r => [r.name, r]));
  const files = listMigrationFiles(migrationsDir);

  if (files.length === 0) {
    console.log('Keine numerischen SQL-Migrationsdateien gefunden.');
    return;
  }

  console.log('Migration-Status:');
  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const checksum = sha256(sql);
    const row = executed.get(file);
    if (!row) {
      console.log(`- PENDING  ${file}`);
      continue;
    }
    const changed = row.checksum !== checksum ? ' (CHECKSUM GEÄNDERT)' : '';
    console.log(`- APPLIED  ${file}${changed}`);
  }
}

async function up(conn, migrationsDir) {
  await ensureMigrationsTable(conn);
  const [rows] = await conn.query('SELECT name, checksum FROM _migrations');
  const executed = new Map(rows.map(r => [r.name, r.checksum]));
  const files = listMigrationFiles(migrationsDir);

  if (files.length === 0) {
    console.log('Keine numerischen SQL-Migrationsdateien gefunden.');
    return;
  }

  let appliedCount = 0;
  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const checksum = sha256(sql);
    const existing = executed.get(file);

    if (existing) {
      if (existing !== checksum) {
        throw new Error(`Migration ${file} wurde bereits ausgeführt, aber Dateiinhalt hat sich geändert.`);
      }
      console.log(`Skip: ${file} (bereits ausgeführt)`);
      continue;
    }

    console.log(`Apply: ${file}`);
    await conn.query(sql);
    await conn.query(
      'INSERT INTO _migrations (name, checksum) VALUES (?, ?)',
      [file, checksum]
    );
    appliedCount++;
  }

  console.log(`Fertig. Neu ausgeführt: ${appliedCount}`);
}

async function main() {
  const command = (process.argv[2] || 'up').toLowerCase();
  const configPath = path.join(__dirname, 'config.cfg');
  const cfg = loadConfig(configPath);
  const migrationsDir = path.resolve(__dirname, cfg.MIGRATIONS_DIR || './sql');

  const conn = await mysql.createConnection({
    host: cfg.DB_HOST || '127.0.0.1',
    port: Number(cfg.DB_PORT || 3306),
    user: cfg.DB_USER || 'root',
    password: cfg.DB_PASSWORD || '',
    database: cfg.DB_NAME,
    multipleStatements: true,
  });

  try {
    if (!cfg.DB_NAME) {
      throw new Error('DB_NAME fehlt in config.cfg');
    }
    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`Migrations-Ordner nicht gefunden: ${migrationsDir}`);
    }

    if (command === 'status') {
      await status(conn, migrationsDir);
    } else if (command === 'up') {
      await up(conn, migrationsDir);
    } else {
      throw new Error(`Unbekannter Befehl: ${command}. Erlaubt: up | status`);
    }
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('Migration fehlgeschlagen:', err.message);
  process.exit(1);
});
