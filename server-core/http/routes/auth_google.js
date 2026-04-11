'use strict';

const https = require('https');
const { sendJson } = require('../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../infra/db');
const { signToken } = require('../../auth/tokens');
const { createAuthSession } = require('../../auth/middleware');
const { logInfo, logError } = require('../../infra/logger');
const { randomUUID } = require('crypto');
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, FRONTEND_URL } = require('../../config/constants');

// PKCE-losen State als einfacher CSRF-Schutz
const pendingStates = new Set();

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams(body).toString();
    const options = {
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

module.exports = function registerGoogleAuthRoutes(deps) {
  return async function handleGoogleAuth(req, res, pathname) {

    // GET /api/auth/google — Weiterleitung zu Google
    if (req.method === 'GET' && pathname === '/api/auth/google') {
      if (!GOOGLE_CLIENT_ID) return sendJson(res, 503, { ok: false, error: 'Google OAuth nicht konfiguriert' });

      const state = randomUUID().replace(/-/g, '');
      pendingStates.add(state);
      setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000); // 10 Min Ablauf

      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: GOOGLE_REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        access_type: 'online',
        prompt: 'select_account',
      });

      res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
      return res.end();
    }

    // GET /api/auth/google/callback — Google-Callback
    if (req.method === 'GET' && pathname === '/api/auth/google/callback') {
      ensureDbEnabled();
      const requestUrl = new URL(`https://dummy${req.url}`);
      const code = requestUrl.searchParams.get('code');
      const state = requestUrl.searchParams.get('state');
      const error = requestUrl.searchParams.get('error');
      const frontendUrl = FRONTEND_URL || 'https://buenzlifight.ch';

      if (error || !code) {
        res.writeHead(302, { Location: `${frontendUrl}?auth_error=abgebrochen` });
        return res.end();
      }

      if (!pendingStates.has(state)) {
        res.writeHead(302, { Location: `${frontendUrl}?auth_error=ungueltig` });
        return res.end();
      }
      pendingStates.delete(state);

      try {
        // 1. Code gegen Token tauschen
        const tokenData = await httpsPost('oauth2.googleapis.com', '/token', {
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: GOOGLE_REDIRECT_URI,
          grant_type: 'authorization_code',
        });

        if (!tokenData.access_token) {
          logError('GOOGLE_AUTH', 'Kein access_token von Google', tokenData);
          res.writeHead(302, { Location: `${frontendUrl}?auth_error=token` });
          return res.end();
        }

        // 2. User-Info von Google holen
        const userInfo = await httpsGet(
          `https://www.googleapis.com/oauth2/v3/userinfo?access_token=${tokenData.access_token}`
        );

        const googleId = userInfo.sub;
        const email = (userInfo.email || '').toLowerCase().trim();
        const displayName = userInfo.name || '';

        if (!googleId || !email) {
          res.writeHead(302, { Location: `${frontendUrl}?auth_error=daten` });
          return res.end();
        }

        // 3. Bestehenden User suchen (zuerst google_id, dann email)
        let [[user]] = await dbPool.query(
          `SELECT id, email, nickname, is_active, is_banned, municipality_id FROM users WHERE google_id = ? LIMIT 1`,
          [googleId]
        );

        if (!user) {
          [[user]] = await dbPool.query(
            `SELECT id, email, nickname, is_active, is_banned, municipality_id FROM users WHERE email = ? LIMIT 1`,
            [email]
          );
          if (user) {
            // Bestehendem User google_id verknüpfen
            await dbPool.query(`UPDATE users SET google_id = ? WHERE id = ?`, [googleId, user.id]);
            logInfo('GOOGLE_AUTH', `Google verknüpft mit bestehendem Account: ${email}`);
          }
        }

        if (!user) {
          // 4. Neuer User: temporär mit is_active=0 erstellen, User wählt Nickname+Gemeinde selbst
          const uuid = randomUUID();
          let baseNick = displayName.replace(/[^a-zA-Z0-9äöüÄÖÜ_\-]/g, '').slice(0, 20) || `user${Date.now().toString().slice(-6)}`;
          const [[existing]] = await dbPool.query(`SELECT id FROM users WHERE nickname = ? LIMIT 1`, [baseNick]);
          if (existing) baseNick = `${baseNick}${Math.floor(Math.random() * 900 + 100)}`;

          const [insertResult] = await dbPool.query(
            `INSERT INTO users (uuid, email, nickname, google_id, municipality_id, password_hash, password_salt, is_active, is_email_verified)
             VALUES (?, ?, ?, ?, NULL, '', NULL, 0, 1)`,
            [uuid, email, baseNick, googleId]
          );
          const newId = insertResult.insertId;
          [[user]] = await dbPool.query(`SELECT id, email, nickname, is_active, is_banned, municipality_id FROM users WHERE id = ?`, [newId]);
          logInfo('GOOGLE_AUTH', `Neuer Google-User angelegt (Setup ausstehend): ${email} → ${baseNick}`);

          // Setup-Token ausgeben und zu Setup-Formular weiterleiten
          const setupToken = signToken({ sub: user.id, email: user.email, nickname: user.nickname, rem: 1, google_setup: 1 }, 2);
          await createAuthSession(user.id, setupToken, req, 2);
          res.writeHead(302, { Location: `${frontendUrl}?google_token=${encodeURIComponent(setupToken)}&google_setup=1&google_nickname=${encodeURIComponent(baseNick)}` });
          return res.end();
        }

        if (user.is_banned) {
          res.writeHead(302, { Location: `${frontendUrl}?auth_error=gesperrt` });
          return res.end();
        }

        // Bestehender User noch nicht fertig eingerichtet (Gemeinde fehlt)
        if (!user.municipality_id) {
          const setupToken = signToken({ sub: user.id, email: user.email, nickname: user.nickname, rem: 1, google_setup: 1 }, 2);
          await createAuthSession(user.id, setupToken, req, 2);
          res.writeHead(302, { Location: `${frontendUrl}?google_token=${encodeURIComponent(setupToken)}&google_setup=1&google_nickname=${encodeURIComponent(user.nickname)}` });
          return res.end();
        }

        if (!user.is_active) {
          res.writeHead(302, { Location: `${frontendUrl}?auth_error=gesperrt` });
          return res.end();
        }

        // 5. JWT ausstellen und Session erstellen
        const token = signToken({ sub: user.id, email: user.email, nickname: user.nickname, rem: 1 }, 24 * 30);
        await createAuthSession(user.id, token, req, 24 * 30);

        logInfo('GOOGLE_AUTH', `Login erfolgreich: ${user.email} (ID ${user.id})`);

        // 6. Zu Frontend weiterleiten mit Token
        res.writeHead(302, { Location: `${frontendUrl}?google_token=${encodeURIComponent(token)}` });
        return res.end();

      } catch (err) {
        logError('GOOGLE_AUTH', 'Fehler beim Google-Callback', { error: err?.message });
        res.writeHead(302, { Location: `${frontendUrl}?auth_error=server` });
        return res.end();
      }
    }

    // POST /api/auth/google/complete — Nickname + Gemeinde nach Google-Login setzen
    if (req.method === 'POST' && pathname === '/api/auth/google/complete') {
      ensureDbEnabled();
      const { readJsonBody, getBearerToken } = require('../../infra/http');
      const { verifyToken } = require('../../auth/tokens');
      const { isSessionValid, getUserByIdWithMunicipality } = require('../../auth/middleware');
      // Setup-Token prüfen: JWT gültig + Session aktiv + User existiert (is_active=0 erlaubt!)
      const rawToken = getBearerToken(req);
      const payload = rawToken ? verifyToken(rawToken) : null;
      if (!payload?.sub || !payload?.google_setup) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const validSession = await isSessionValid(rawToken);
      if (!validSession) return sendJson(res, 401, { ok: false, error: 'Session abgelaufen' });
      const authUser = await getUserByIdWithMunicipality(Number(payload.sub));
      if (!authUser || authUser.is_banned) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      const body = await readJsonBody(req);
      const nickname = String(body?.nickname || '').trim();
      const municipalityId = Number(body?.municipality_id) || null;
      const createMunicipality = Boolean(body?.create_municipality);
      const newMunicipalityName = String(body?.new_municipality_name || '').trim();
      const referralCode = String(body?.referral_code || '').trim();

      if (!nickname || nickname.length < 2 || nickname.length > 30) {
        return sendJson(res, 422, { ok: false, error: 'Nickname muss 2–30 Zeichen haben' });
      }
      if (!/^[a-zA-Z0-9äöüÄÖÜ_\-]+$/.test(nickname)) {
        return sendJson(res, 422, { ok: false, error: 'Nickname enthält ungültige Zeichen' });
      }

      // Nickname-Eindeutigkeit prüfen (ausser eigener)
      const [[nicknameCheck]] = await dbPool.query(
        `SELECT id FROM users WHERE nickname = ? AND id != ? LIMIT 1`, [nickname, authUser.id]
      );
      if (nicknameCheck) return sendJson(res, 409, { ok: false, error: 'Spielername bereits vergeben' });

      let muniId = municipalityId;
      if (createMunicipality && newMunicipalityName) {
        const muniUuid = randomUUID();
        const muniSlug = newMunicipalityName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
        const [muniResult] = await dbPool.query(
          `INSERT INTO municipalities (uuid, name, slug, canton_code, canton_name, is_active, is_user_created) VALUES (?, ?, ?, '', '', 1, 1)`,
          [muniUuid, newMunicipalityName, muniSlug]
        );
        muniId = muniResult.insertId;
        await dbPool.query(
          `INSERT IGNORE INTO municipality_stats (municipality_id, shield_active_until, treasury) VALUES (?, DATE_ADD(NOW(), INTERVAL 7 DAY), 15000)`,
          [muniId]
        );
      } else if (!muniId) {
        return sendJson(res, 422, { ok: false, error: 'Bitte eine Gemeinde wählen' });
      }

      // Referral verarbeiten (gleiche Logik wie normale Registrierung)
      const { lookupUserByReferralCode, processReferral, dispatchReferrerRewards } = require('../../game/referral');
      const { creditUserBankAccount } = require('../../game/userBanking');
      let referrer = null;
      if (referralCode) {
        referrer = await lookupUserByReferralCode(referralCode);
        if (referrer && referrer.id !== authUser.id) {
          setImmediate(async () => {
            try {
              const ref = await processReferral(referrer.id, authUser.id, referralCode);
              if (ref) await dispatchReferrerRewards(ref.id, referrer.id);
            } catch (err) {
              logError('GOOGLE_AUTH', `Referral-Fehler bei Google-Setup: ${err?.message}`);
            }
          });
        }
      }

      // User aktivieren, Nickname + Gemeinde setzen
      await dbPool.query(
        `UPDATE users SET nickname = ?, municipality_id = ?, is_active = 1 WHERE id = ?`,
        [nickname, muniId, authUser.id]
      );

      // Startgeld: 800 CHF mit Referral, sonst 500 CHF (gleich wie normale Registrierung)
      const startBonus = (referrer && referrer.id !== authUser.id) ? 800 : 500;
      await creditUserBankAccount(authUser.id, {
        amount: startBonus,
        type: 'welcome_bonus',
        description: referrer ? `Startguthaben (geworben von ${referrer.nickname})` : 'Startguthaben',
      }).catch(() => {});

      // Neues langlebiges JWT ausgeben
      const token = signToken({ sub: authUser.id, email: authUser.email, nickname, rem: 1 }, 24 * 30);
      await createAuthSession(authUser.id, token, req, 24 * 30);

      logInfo('GOOGLE_AUTH', `Setup abgeschlossen: ${authUser.email} → ${nickname} (Gemeinde ${muniId})`);
      return sendJson(res, 200, { ok: true, token, nickname, municipality_id: muniId });
    }
  };
};
