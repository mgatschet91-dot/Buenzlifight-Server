'use strict';

const { CORS_ALLOW_ALL, CORS_ALLOWED_ORIGIN_SET } = require('../config/constants');

function resolveCorsOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return null;
  if (CORS_ALLOW_ALL) return origin;
  return CORS_ALLOWED_ORIGIN_SET.has(origin) ? origin : null;
}

function applyCorsHeaders(req, res) {
  res.setHeader('Vary', 'Origin');
  const allowedOrigin = resolveCorsOrigin(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    return true;
  }
  return false;
}

module.exports = { resolveCorsOrigin, applyCorsHeaders };
