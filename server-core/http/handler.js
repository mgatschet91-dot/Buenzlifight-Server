'use strict';

const fs = require('fs');
const path = require('path');
const { sendJson } = require('../infra/http');
const { applyCorsHeaders } = require('../infra/cors');
const { logError } = require('../infra/logger');

const BADGES_DIR = path.join(__dirname, '../public/badges');

const { processConstructionSyncAndBroadcast, wsPublishAuthoritativeStats } = require('./shared');

const registerGameRoutes = require('./routes/game');
const registerMunicipalityRoutes = require('./routes/municipalities');
const registerSocialRoutes = require('./routes/social');
const registerCompaniesRoutes = require('./routes/companies');
const registerBankRoutes = require('./routes/bank');
const registerUserBankingRoutes = require('./routes/userBanking');
const registerAuthRoutes = require('./routes/auth');
const registerGoogleAuthRoutes = require('./routes/auth_google');
const registerMarketplaceRoutes = require('./routes/marketplace');
const registerAdminRoutes = require('./routes/admin');
const registerReferralRoutes = require('./routes/referral');
const registerSupportRoutes = require('./routes/support');

function createRequestHandler(deps) {
  const handlers = [
    registerGameRoutes(deps),
    registerMunicipalityRoutes(deps),
    registerSocialRoutes(deps),
    registerCompaniesRoutes(deps),
    registerBankRoutes(deps),
    registerUserBankingRoutes(deps),
    registerAuthRoutes(deps),
    registerGoogleAuthRoutes(),
    registerMarketplaceRoutes(deps),
    registerAdminRoutes(deps),
    registerReferralRoutes(deps),
    registerSupportRoutes(deps),
  ];

  return async function handleRequest(req, res) {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = requestUrl.pathname;

      if (req.method === 'OPTIONS') {
        applyCorsHeaders(req, res);
        const requestHeaders = req.headers['access-control-request-headers'] || '';
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', requestHeaders || 'Content-Type,Authorization,X-Game-Token');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.writeHead(204);
        res.end();
        return;
      }

      applyCorsHeaders(req, res);

      // ── Static Badge-Bilder: /badges/CODE.gif|png ───────────────────
      if (req.method === 'GET' && pathname.startsWith('/badges/')) {
        const filename = path.basename(pathname);
        const mimeMatch = filename.match(/^([A-Za-z0-9_-]+)\.(gif|png)$/);
        if (mimeMatch) {
          const base = mimeMatch[1];
          const ext = mimeMatch[2];
          const altExt = ext === 'gif' ? 'png' : 'gif';
          const primary = path.join(BADGES_DIR, `${base}.${ext}`);
          const fallback = path.join(BADGES_DIR, `${base}.${altExt}`);
          const [filePath, mime] = fs.existsSync(primary)
            ? [primary, ext === 'png' ? 'image/png' : 'image/gif']
            : fs.existsSync(fallback)
              ? [fallback, altExt === 'png' ? 'image/png' : 'image/gif']
              : [null, null];
          if (filePath) {
            const data = fs.readFileSync(filePath);
            res.writeHead(200, {
              'Content-Type': mime,
              'Cache-Control': 'public, max-age=604800',
              'Content-Length': data.length,
            });
            res.end(data);
            return;
          }
        }
        res.writeHead(404);
        res.end();
        return;
      }

      // ── robots.txt: Block all crawlers from indexing the API domain ──
      if (pathname === '/robots.txt') {
        const robotsTxt = 'User-agent: *\nDisallow: /\n';
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': Buffer.byteLength(robotsTxt),
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(robotsTxt);
        return;
      }

      // Prevent search engines from indexing any API response
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');

      for (const handler of handlers) {
        await handler(req, res, pathname, requestUrl);
        if (res.headersSent) return;
      }

      return sendJson(res, 404, { ok: false, error: 'Route nicht gefunden' });
    } catch (err) {
      if (res.headersSent) return;
      console.error('[HTTP] Interner Serverfehler:', req.url, err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack : '');
      return sendJson(res, 500, {
        ok: false,
        error: 'Interner Serverfehler',
      });
    }
  };
}

module.exports = { createRequestHandler, processConstructionSyncAndBroadcast, wsPublishAuthoritativeStats };
