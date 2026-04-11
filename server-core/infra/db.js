'use strict';

const mysql = require('mysql2/promise');
const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_CONNECTION_LIMIT } = require('../config/constants');

const dbPool = DB_NAME && DB_USER
  ? mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user: DB_USER,
      password: DB_PASSWORD,
      connectionLimit: DB_CONNECTION_LIMIT,
      waitForConnections: true,
      queueLimit: 0,
    })
  : null;

function ensureDbEnabled() {
  if (!dbPool) {
    throw new Error('DB-Konfiguration fehlt (DB_NAME/DB_USER).');
  }
}

module.exports = { dbPool, ensureDbEnabled };
