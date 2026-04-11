'use strict';

const crypto = require('crypto');
const { sendJson, readJsonBody, getBearerToken } = require('../../infra/http');
const { logInfo } = require('../../infra/logger');
const { dbPool, ensureDbEnabled } = require('../../infra/db');
const {
  getAuthenticatedUser, getUserByEmailWithMunicipality, getUserByEmailForLogin,
  getUserByIdWithMunicipality, createAuthSession, isSessionValid, revokeSession, revokeAllUserSessions,
  getUserRankValue, syncUserGlobalRoleFromRank, getUserGlobalRole, ensureAtLeastOneGlobalAdministrator,
} = require('../../auth/middleware');
const { wsEmitToUser } = require('../../ws/socketio/helpers');
const { wsUserSockets } = require('../../ws/socketio/index');
const { signToken, hashPassword, createPasswordData, verifyToken } = require('../../auth/tokens');
const { normalizeGlobalRole } = require('../../auth/permissions');
const {
  GLOBAL_ROLE_USER, GLOBAL_ROLE_ADMINISTRATOR,
  TOKEN_TTL_HOURS, TOKEN_TTL_HOURS_REMEMBER,
  MUNICIPALITY_MEMBER_LIMIT, MUNICIPALITY_ROLE_OWNER, MUNICIPALITY_ROLE_CITIZEN, XP_LEVEL_CAP,
} = require('../../config/constants');
const { validateEmail } = require('../../shared/helpers');
const {
  getMunicipalityById, getUserMunicipalityRole,
  ensureMunicipalityRoleTables, syncMunicipalityMemberships,
} = require('../../game/municipality');
const { processDailyLogin, getUserXp, xpForLevel } = require('../../game/xp');
const { ensureReferralCode, lookupUserByReferralCode, processReferral, dispatchReferrerRewards } = require('../../game/referral');
const {
  loginAttempts, registerAttempts,
  RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS,
  checkRateLimit, incrementRateLimit,
} = require('../shared');

module.exports = function registerAuthRoutes(deps) {
  const io = deps?.io;
  return async function handleAuth(req, res, pathname /*, requestUrl */) {

    if (req.method === 'POST' && pathname === '/api/auth/register') {
      ensureDbEnabled();
      const clientIp = String(req.socket?.remoteAddress || 'unknown').trim();
      const retryReg = checkRateLimit(registerAttempts, clientIp, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS);
      if (retryReg > 0) return sendJson(res, 429, { ok: false, error: `Zu viele Anfragen. Bitte warte ${retryReg} Sekunden.` });
      incrementRateLimit(registerAttempts, clientIp);
      const body = await readJsonBody(req);
      const email = (body.email || '').toString().trim().toLowerCase();
      const password = (body.password || '').toString();
      const nickname = (body.nickname || '').toString().trim();
      const municipalityId = Number(body.municipality_id) || 0;
      const newMunicipalityName = (body.new_municipality_name || '').toString().trim();
      const isCreatingMunicipality = !!body.create_municipality && newMunicipalityName.length > 0;
      const incomingReferralCode = (body.referral_code || '').toString().toUpperCase().trim().slice(0, 8);

      if (!validateEmail(email)) return sendJson(res, 422, { ok: false, error: 'Ungültige E-Mail' });
      if (password.length < 8) return sendJson(res, 422, { ok: false, error: 'Passwort muss mindestens 8 Zeichen haben' });
      if (nickname.length < 2 || nickname.length > 32) return sendJson(res, 422, { ok: false, error: 'Nickname muss 2-32 Zeichen haben' });

      let municipality = null;
      let municipalityMemberCount = 0;

      if (isCreatingMunicipality) {
        if (newMunicipalityName.length < 2 || newMunicipalityName.length > 100) return sendJson(res, 422, { ok: false, error: 'Gemeindename muss 2-100 Zeichen haben' });
        const slug = newMunicipalityName
          .toLowerCase()
          .replace(/[äàâ]/g, 'ae').replace(/[öòô]/g, 'oe').replace(/[üùû]/g, 'ue')
          .replace(/[éèêë]/g, 'e').replace(/[íìîï]/g, 'i').replace(/[ß]/g, 'ss')
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const [existingSlug] = await dbPool.query('SELECT id FROM municipalities WHERE slug = ? LIMIT 1', [slug]);
        if (Array.isArray(existingSlug) && existingSlug.length > 0) return sendJson(res, 409, { ok: false, error: 'Eine Gemeinde mit diesem Namen existiert bereits' });
        const [insertMun] = await dbPool.query(
          `INSERT INTO municipalities (name, slug, canton_code, canton_name, is_active, is_user_created) VALUES (?, ?, '', '', 1, 1)`,
          [newMunicipalityName, slug]
        );
        municipality = { id: insertMun.insertId, name: newMunicipalityName, slug, canton_code: '', canton_name: '' };
        await dbPool.query(`INSERT IGNORE INTO municipality_stats (municipality_id, shield_active_until, treasury) VALUES (?, DATE_ADD(NOW(), INTERVAL 7 DAY), 15000)`, [municipality.id]);
        municipalityMemberCount = 0;
      } else {
        if (!Number.isInteger(municipalityId) || municipalityId <= 0) return sendJson(res, 422, { ok: false, error: 'Bitte wähle eine Gemeinde oder erstelle eine neue' });
        municipality = await getMunicipalityById(municipalityId);
        if (!municipality) return sendJson(res, 422, { ok: false, error: 'Gemeinde nicht gefunden oder inaktiv' });
        const [memberLimitRows] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM users WHERE municipality_id = ? AND is_active = 1`, [municipality.id]);
        municipalityMemberCount = Number(memberLimitRows?.[0]?.cnt || 0);
        if (municipalityMemberCount >= MUNICIPALITY_MEMBER_LIMIT) return sendJson(res, 409, { ok: false, error: `Gemeinde ist voll (maximal ${MUNICIPALITY_MEMBER_LIMIT} Mitbürger)` });
      }

      const existingUser = await getUserByEmailWithMunicipality(email);
      if (existingUser) return sendJson(res, 409, { ok: false, error: 'E-Mail bereits registriert' });
      const [nicknameRows] = await dbPool.query('SELECT id FROM users WHERE nickname = ? LIMIT 1', [nickname]);
      if (Array.isArray(nicknameRows) && nicknameRows.length > 0) return sendJson(res, 409, { ok: false, error: 'Nickname bereits vergeben' });

      // Referral-Code validieren (vor dem INSERT)
      let referrer = null;
      if (incomingReferralCode && /^[A-Z0-9]{8}$/.test(incomingReferralCode)) {
        try { referrer = await lookupUserByReferralCode(incomingReferralCode); } catch (_) {}
      }

      const { salt, passwordHash } = createPasswordData(password);
      const uuid = crypto.randomUUID();
      const [insertResult] = await dbPool.query(
        `INSERT INTO users (uuid, email, nickname, municipality_id, password_hash, password_salt, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [uuid, email, nickname, municipality.id, passwordHash, salt]
      );
      const userId = insertResult.insertId;

      // Self-Referral verhindern
      if (referrer && referrer.id === userId) referrer = null;

      // Referral-Code für neuen User generieren
      let newUserReferralCode = null;
      try { newUserReferralCode = await ensureReferralCode(userId); } catch (_) {}

      // Startgeld: 800 CHF mit Referral, sonst 500 CHF
      const startBonus = referrer ? 800 : 500;
      const startDesc = referrer
        ? `Startguthaben (geworben von ${referrer.nickname})`
        : 'Startguthaben';
      try {
        const { creditUserBankAccount } = require('../../game/userBanking');
        await creditUserBankAccount(userId, {
          amount: startBonus,
          type: 'welcome_bonus',
          description: startDesc,
          reference: referrer ? `ref:${incomingReferralCode}` : null,
        });
      } catch (startMoneyErr) {
        logInfo('AUTH', `Startgeld fehlgeschlagen fuer User ${userId}: ${startMoneyErr?.message || startMoneyErr}`);
        // Retry: Konto direkt anlegen
        try {
          await dbPool.query(
            `INSERT IGNORE INTO user_bank_accounts (user_id, account_number, card_number_last4, balance)
             VALUES (?, CONCAT('CH00MEIN', LPAD(?, 16, '0')), '0000', ?)`,
            [userId, userId, startBonus]
          );
        } catch (_retryErr) { /* Letzter Versuch fehlgeschlagen */ }
      }

      // Referral eintragen + Werbenden async belohnen
      let referralProcessed = false;
      let referralId = null;
      if (referrer) {
        try {
          const ref = await processReferral(referrer.id, userId, incomingReferralCode);
          if (ref) { referralId = ref.id; referralProcessed = true; }
        } catch (refErr) {
          logInfo('AUTH', `Referral-Verarbeitung fehlgeschlagen: ${refErr?.message}`);
        }
        if (referralProcessed && referralId) {
          const _refId = referralId;
          const _referrerId = referrer.id;
          setImmediate(() => {
            dispatchReferrerRewards(_refId, _referrerId).catch(err =>
              logInfo('AUTH', `Referrer-Rewards fehlgeschlagen: ${err?.message}`)
            );
          });
        }
      }

      const rankRoleSync = await syncUserGlobalRoleFromRank(userId, GLOBAL_ROLE_USER);
      const globalRole = normalizeGlobalRole(rankRoleSync.role);
      await ensureAtLeastOneGlobalAdministrator();
      await ensureMunicipalityRoleTables();
      const initialRole = municipalityMemberCount === 0 ? MUNICIPALITY_ROLE_OWNER : MUNICIPALITY_ROLE_CITIZEN;
      await dbPool.query(
        `INSERT INTO municipality_memberships (municipality_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = CURRENT_TIMESTAMP`,
        [municipality.id, userId, initialRole]
      );
      await syncMunicipalityMemberships(municipality.id);

      // Stats auf Defaults zurücksetzen wenn User eine leere Gemeinde übernimmt
      if (initialRole === MUNICIPALITY_ROLE_OWNER && !isCreatingMunicipality) {
        try {
          await dbPool.query(
            `UPDATE municipality_stats
             SET security = 50, attractiveness = 50, cleanliness = 50, infrastructure = 50,
                 transparency = 50, citizen_satisfaction = 50, updated_at = NOW()
             WHERE municipality_id = ?
               AND (security < 50 OR attractiveness < 50 OR cleanliness < 50 OR infrastructure < 50 OR transparency < 50)`,
            [municipality.id]
          );
        } catch (_) {}
      }

      const token = signToken({ sub: userId, email, nickname, rem: 1 }, TOKEN_TTL_HOURS_REMEMBER);
      await createAuthSession(userId, token, req, TOKEN_TTL_HOURS_REMEMBER);

      const registerResponse = {
        ok: true, token, municipality_created: isCreatingMunicipality,
        user: {
          id: userId, email, nickname, name: nickname,
          municipality_id: municipality.id, municipality_slug: municipality.slug, municipality_name: municipality.name,
          role: initialRole, global_role: globalRole, user_rank: Number(rankRoleSync.rank || 0),
          referral_code: newUserReferralCode || null,
        },
      };
      if (referralProcessed && referrer) {
        registerResponse.referral = { referred_by: referrer.nickname, bonus_amount: startBonus };
      }
      return sendJson(res, 201, registerResponse);
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      ensureDbEnabled();
      const clientIp = String(req.socket?.remoteAddress || 'unknown').trim();
      const retryLogin = checkRateLimit(loginAttempts, clientIp, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS);
      if (retryLogin > 0) {
        logInfo('AUTH', `Login rate-limited für IP ${clientIp}`);
        return sendJson(res, 429, { ok: false, error: `Zu viele Login-Versuche. Bitte warte ${retryLogin} Sekunden.` });
      }
      const body = await readJsonBody(req);
      const email = (body.email || '').toString().trim().toLowerCase();
      const password = (body.password || '').toString();
      const rememberMe = !!body.remember_me;
      if (!validateEmail(email) || !password) return sendJson(res, 422, { ok: false, error: 'E-Mail oder Passwort fehlt' });

      const loginFailGeneric = 'E-Mail oder Passwort falsch';
      const user = await getUserByEmailForLogin(email);
      if (!user) { logInfo('AUTH', `Login fehlgeschlagen: E-Mail nicht gefunden: ${email}`); incrementRateLimit(loginAttempts, clientIp); return sendJson(res, 401, { ok: false, error: loginFailGeneric }); }
      if (!user.is_active) { logInfo('AUTH', `Login fehlgeschlagen: User deaktiviert: ${email} (ID ${user.id})`); return sendJson(res, 401, { ok: false, error: loginFailGeneric }); }
      if (user.is_banned) { logInfo('AUTH', `Login fehlgeschlagen: User gebannt: ${email} (ID ${user.id})`); return sendJson(res, 403, { ok: false, error: 'Dein Account wurde gesperrt.' }); }

      const inputHash = hashPassword(password, user.password_salt);
      if (inputHash !== user.password_hash) { logInfo('AUTH', `Login fehlgeschlagen: Falsches Passwort für ${email} (ID ${user.id})`); incrementRateLimit(loginAttempts, clientIp); return sendJson(res, 401, { ok: false, error: loginFailGeneric }); }
      loginAttempts.delete(clientIp);

      const ttl = rememberMe ? TOKEN_TTL_HOURS_REMEMBER : TOKEN_TTL_HOURS;
      const token = signToken({ sub: user.id, email: user.email, nickname: user.nickname, rem: rememberMe ? 1 : 0 }, ttl);
      // Alte Sessions revoken + verbundene Sockets ausloggen (Single-Session-Erzwingung)
      await revokeAllUserSessions(user.id);
      if (io) wsEmitToUser(io, user.id, 'force-logout', { reason: 'new_login_elsewhere' }, wsUserSockets);
      await createAuthSession(user.id, token, req, ttl);
      await dbPool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
      const userRole = await getUserMunicipalityRole(user.id, user.municipality_id);
      const globalRole = await getUserGlobalRole(user.id);
      const userRank = await getUserRankValue(user.id);
      let dailyLoginResult = null;
      try { dailyLoginResult = await processDailyLogin(user.id); } catch (_) {}
      const userXpData = await getUserXp(user.id);

      const loginResponse = {
        ok: true, token,
        user: {
          id: user.id, email: user.email, nickname: user.nickname, name: user.nickname,
          municipality_id: user.municipality_id, municipality_slug: user.municipality_slug || null, municipality_name: user.municipality_name || null,
          role: userRole, global_role: globalRole, user_rank: Number(userRank || 0),
          xp: { total_xp: userXpData.total_xp, level: userXpData.level, max_level: XP_LEVEL_CAP, next_level_xp: userXpData.level < XP_LEVEL_CAP ? xpForLevel(userXpData.level + 1) : null, login_streak: userXpData.login_streak },
        },
      };
      if (dailyLoginResult) loginResponse.daily_login = dailyLoginResult;
      return sendJson(res, 200, loginResponse);
    }

    if (req.method === 'GET' && pathname === '/api/auth/me') {
      ensureDbEnabled();
      const token = getBearerToken(req);
      if (!token) return sendJson(res, 401, { ok: false, error: 'Kein Token' });
      const payload = verifyToken(token);
      if (!payload) return sendJson(res, 401, { ok: false, error: 'Token ungültig/abgelaufen' });
      const validSession = await isSessionValid(token);
      if (!validSession) return sendJson(res, 401, { ok: false, error: 'Session ungültig oder abgelaufen' });
      const userId = Number(payload.sub);
      if (!Number.isInteger(userId) || userId <= 0) return sendJson(res, 401, { ok: false, error: 'Token ungültig' });
      const user = await getUserByIdWithMunicipality(userId);
      if (!user || !user.is_active) return sendJson(res, 401, { ok: false, error: 'Benutzer nicht gefunden oder deaktiviert' });
      const userRole = await getUserMunicipalityRole(user.id, user.municipality_id);
      const globalRole = await getUserGlobalRole(user.id);
      const userRank = await getUserRankValue(user.id);
      let dailyLoginResult = null;
      try { dailyLoginResult = await processDailyLogin(user.id); } catch (_) {}
      const userXpData = await getUserXp(user.id);

      const isRemember = payload.rem === 1;
      let refreshedToken = undefined;
      if (isRemember && typeof payload.exp === 'number') {
        const now = Math.floor(Date.now() / 1000);
        const remaining = payload.exp - now;
        if (remaining < 7 * 24 * 3600 && remaining > 0) {
          refreshedToken = signToken({ sub: user.id, email: user.email, nickname: user.nickname, rem: 1 }, TOKEN_TTL_HOURS_REMEMBER);
          await revokeSession(token);
          await createAuthSession(user.id, refreshedToken, req, TOKEN_TTL_HOURS_REMEMBER);
        }
      }

      // Referral-Code lazy generieren für bestehende User
      let meReferralCode = user.referral_code || null;
      if (!meReferralCode) {
        try { meReferralCode = await ensureReferralCode(userId); } catch (_) {}
      }

      // Google-Verknüpfung + Wer hat mich geworben?
      const [[meExtra]] = await dbPool.query(
        `SELECT u.google_id, ref_user.nickname AS referred_by_nickname
         FROM users u
         LEFT JOIN referrals r ON r.referred_id = u.id
         LEFT JOIN users ref_user ON ref_user.id = r.referrer_id
         WHERE u.id = ? LIMIT 1`,
        [userId]
      );

      const responseBody = {
        ok: true,
        user: {
          id: user.id, email: user.email, nickname: user.nickname, name: user.nickname,
          municipality_id: user.municipality_id, municipality_slug: user.municipality_slug || null, municipality_name: user.municipality_name || null,
          role: userRole, global_role: globalRole, user_rank: Number(userRank || 0),
          referral_code: meReferralCode,
          has_google: meExtra?.google_id ? true : false,
          referred_by_nickname: meExtra?.referred_by_nickname || null,
          xp: { total_xp: userXpData.total_xp, level: userXpData.level, max_level: XP_LEVEL_CAP, next_level_xp: userXpData.level < XP_LEVEL_CAP ? xpForLevel(userXpData.level + 1) : null, login_streak: userXpData.login_streak },
        },
      };
      if (dailyLoginResult) responseBody.daily_login = dailyLoginResult;
      if (refreshedToken) responseBody.token = refreshedToken;
      return sendJson(res, 200, responseBody);
    }

    const globalRolePatchMatch = pathname.match(/^\/api\/auth\/users\/([0-9]+)\/global-role$/i);
    if (globalRolePatchMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const token = getBearerToken(req);
      if (!token) return sendJson(res, 401, { ok: false, error: 'Kein Token' });
      const payload = verifyToken(token);
      if (!payload) return sendJson(res, 401, { ok: false, error: 'Token ungültig/abgelaufen' });
      const validSession = await isSessionValid(token);
      if (!validSession) return sendJson(res, 401, { ok: false, error: 'Session ungültig oder abgelaufen' });
      const requesterId = Number(payload.sub);
      if (!Number.isInteger(requesterId) || requesterId <= 0) return sendJson(res, 401, { ok: false, error: 'Token ungültig' });
      const requester = await getUserByIdWithMunicipality(requesterId);
      if (!requester || !requester.is_active) return sendJson(res, 401, { ok: false, error: 'Benutzer nicht gefunden oder deaktiviert' });
      const requesterGlobalRole = await getUserGlobalRole(requesterId);
      if (requesterGlobalRole !== GLOBAL_ROLE_ADMINISTRATOR) return sendJson(res, 403, { ok: false, error: 'Nur globale Administratoren dürfen globale Rollen ändern' });
      const targetUserId = Number(globalRolePatchMatch[1]);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) return sendJson(res, 422, { ok: false, error: 'user_id ist ungültig' });
      const targetUser = await getUserByIdWithMunicipality(targetUserId);
      if (!targetUser || !targetUser.is_active) return sendJson(res, 404, { ok: false, error: 'Zielbenutzer nicht gefunden oder deaktiviert' });
      const rankRoleSync = await syncUserGlobalRoleFromRank(targetUserId, GLOBAL_ROLE_USER);
      const resolvedGlobalRole = normalizeGlobalRole(rankRoleSync.role);
      return sendJson(res, 200, { ok: true, data: { user_id: targetUserId, global_role: resolvedGlobalRole, rank: Number(rankRoleSync.rank || 0) } });
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      ensureDbEnabled();
      const token = getBearerToken(req);
      if (!token) return sendJson(res, 401, { ok: false, error: 'Kein Token' });
      const revoked = await revokeSession(token);
      return sendJson(res, 200, { ok: true, revoked_sessions: revoked });
    }

    if (req.method === 'POST' && pathname === '/api/auth/change-nickname') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const body = await readBody(req);
      const newNickname = (body.nickname || '').toString().trim();
      if (newNickname.length < 2 || newNickname.length > 32) return sendJson(res, 422, { ok: false, error: 'Nickname muss 2-32 Zeichen haben' });
      if (!/^[a-zA-Z0-9_\-. äöüÄÖÜ]+$/.test(newNickname)) return sendJson(res, 422, { ok: false, error: 'Ungültige Zeichen im Nickname' });
      // 30-day cooldown check
      const [cooldownRows] = await dbPool.query('SELECT nickname, nickname_changed_at FROM users WHERE id = ? LIMIT 1', [user.id]);
      const currentRow = cooldownRows[0];
      if (currentRow?.nickname_changed_at) {
        const lastChanged = new Date(currentRow.nickname_changed_at);
        const diffDays = (Date.now() - lastChanged.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays < 30) {
          const daysLeft = Math.ceil(30 - diffDays);
          return sendJson(res, 429, { ok: false, error: `Nickname kann erst in ${daysLeft} Tag${daysLeft === 1 ? '' : 'en'} wieder geändert werden`, days_left: daysLeft });
        }
      }
      const [existing] = await dbPool.query('SELECT id FROM users WHERE nickname = ? AND id != ? LIMIT 1', [newNickname, user.id]);
      if (Array.isArray(existing) && existing.length > 0) return sendJson(res, 409, { ok: false, error: 'Nickname bereits vergeben' });
      const oldNickname = currentRow?.nickname || user.nickname;
      await dbPool.query('UPDATE users SET nickname = ?, nickname_changed_at = NOW() WHERE id = ?', [newNickname, user.id]);
      await dbPool.query('INSERT INTO nickname_history (user_id, old_nickname) VALUES (?, ?)', [user.id, oldNickname]);
      return sendJson(res, 200, { ok: true, nickname: newNickname });
    }

    if (req.method === 'GET' && pathname === '/api/auth/nickname-history') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const [rows] = await dbPool.query(
        'SELECT old_nickname, changed_at FROM nickname_history WHERE user_id = ? ORDER BY changed_at DESC LIMIT 20',
        [user.id]
      );
      return sendJson(res, 200, { ok: true, history: rows });
    }

    if (req.method === 'POST' && pathname === '/api/auth/change-password') {
      ensureDbEnabled();
      const user = await getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
      const body = await readBody(req);
      const oldPassword = (body.old_password || '').toString();
      const newPassword = (body.new_password || '').toString();
      if (!oldPassword || !newPassword) return sendJson(res, 422, { ok: false, error: 'Altes und neues Passwort erforderlich' });
      if (newPassword.length < 8) return sendJson(res, 422, { ok: false, error: 'Neues Passwort muss mindestens 8 Zeichen haben' });
      const [rows] = await dbPool.query('SELECT password_hash, password_salt FROM users WHERE id = ? LIMIT 1', [user.id]);
      const userRow = rows[0];
      if (!userRow) return sendJson(res, 404, { ok: false, error: 'User nicht gefunden' });
      const inputHash = hashPassword(oldPassword, userRow.password_salt);
      if (inputHash !== userRow.password_hash) return sendJson(res, 401, { ok: false, error: 'Aktuelles Passwort ist falsch' });
      const { salt: newSalt, passwordHash: newHash } = createPasswordData(newPassword);
      await dbPool.query('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', [newHash, newSalt, user.id]);
      return sendJson(res, 200, { ok: true });
    }
  };
};
