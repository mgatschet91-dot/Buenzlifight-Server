'use strict';

const { sendJson, readJsonBody } = require('../../infra/http');
const { ensureDbEnabled, dbPool } = require('../../infra/db');

const supportAttempts = new Map();
const SUPPORT_RATE_LIMIT = 5;
const SUPPORT_WINDOW_MS = 15 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - SUPPORT_WINDOW_MS;
  for (const [key, entry] of supportAttempts) {
    if (entry.firstAttempt < cutoff) supportAttempts.delete(key);
  }
}, 60_000);

function checkSupportRateLimit(ip) {
  const now = Date.now();
  const entry = supportAttempts.get(ip);
  if (entry && entry.count >= SUPPORT_RATE_LIMIT && (now - entry.firstAttempt) < SUPPORT_WINDOW_MS) {
    return Math.ceil((SUPPORT_WINDOW_MS - (now - entry.firstAttempt)) / 1000);
  }
  return 0;
}

function incrementSupportRateLimit(ip) {
  const now = Date.now();
  const entry = supportAttempts.get(ip);
  if (entry) {
    entry.count++;
  } else {
    supportAttempts.set(ip, { count: 1, firstAttempt: now });
  }
}

const VALID_CATEGORIES = ['bug', 'feedback', 'account', 'dsgvo', 'other'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = function registerSupportRoutes(_deps) {
  return async function handleSupport(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/api/support/contact') {
      const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

      const retryAfter = checkSupportRateLimit(ip);
      if (retryAfter) {
        return sendJson(res, 429, { ok: false, error: `Zu viele Anfragen. Bitte warte ${retryAfter} Sekunden.` });
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Ungültige Anfrage.' });
      }

      const category = typeof body.category === 'string' ? body.category.trim() : '';
      if (!VALID_CATEGORIES.includes(category)) {
        return sendJson(res, 400, { ok: false, error: 'Ungültige Kategorie.' });
      }

      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (message.length < 10 || message.length > 2000) {
        return sendJson(res, 400, { ok: false, error: 'Nachricht muss zwischen 10 und 2000 Zeichen lang sein.' });
      }

      const username = typeof body.username === 'string' ? body.username.trim().slice(0, 32) : null;
      const usernameVal = username && username.length > 0 ? username : null;

      const email = typeof body.email === 'string' ? body.email.trim().slice(0, 255) : null;
      if (email && email.length > 0 && !EMAIL_REGEX.test(email)) {
        return sendJson(res, 400, { ok: false, error: 'Ungültige E-Mail-Adresse.' });
      }
      const emailVal = email && email.length > 0 ? email : null;

      ensureDbEnabled();
      const [result] = await dbPool.query(
        `INSERT INTO support_tickets (username, email, category, message) VALUES (?, ?, ?, ?)`,
        [usernameVal, emailVal, category, message]
      );

      incrementSupportRateLimit(ip);

      return sendJson(res, 200, { ok: true, id: result.insertId });
    }

    return null;
  };
};
