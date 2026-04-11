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
  await conn.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(191) NOT NULL,
      checksum CHAR(64) NOT NULL,
      executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_migrations_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error('Usage: node migrate-single.js <sql-file-or-name>');
  }

  const configPath = path.join(__dirname, 'config.cfg');
  const cfg = loadConfig(configPath);
  if (!cfg.DB_NAME) {
    throw new Error('DB_NAME fehlt in config.cfg');
  }

  const migrationsDir = path.resolve(__dirname, cfg.MIGRATIONS_DIR || './sql');
  let filePath = path.isAbsolute(input) ? input : path.resolve(__dirname, input);
  if (!fs.existsSync(filePath)) {
    filePath = path.resolve(migrationsDir, input);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`SQL-Datei nicht gefunden: ${input}`);
  }

  const fileName = path.basename(filePath);
  const sql = fs.readFileSync(filePath, 'utf8');
  const checksum = sha256(sql);

  const conn = await mysql.createConnection({
    host: cfg.DB_HOST || '127.0.0.1',
    port: Number(cfg.DB_PORT || 3306),
    user: cfg.DB_USER || 'root',
    password: cfg.DB_PASSWORD || '',
    database: cfg.DB_NAME,
    multipleStatements: true,
  });

  try {
    await ensureMigrationsTable(conn);
    const [rows] = await conn.query(
      'SELECT id FROM _migrations WHERE name = ? LIMIT 1',
      [fileName]
    );
    if (Array.isArray(rows) && rows.length > 0) {
      console.log(`Skip: ${fileName} (bereits in _migrations)`);
      return;
    }

    console.log(`Apply: ${fileName}`);
    await conn.query(sql);
    await conn.query(
      'INSERT INTO _migrations (name, checksum) VALUES (?, ?)',
      [fileName, checksum]
    );
    console.log(`OK: ${fileName} ausgeführt und eingetragen.`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Migration fehlgeschlagen:', err.message || String(err));
  process.exit(1);
});
