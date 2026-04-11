'use strict';

const { sendJson, readJsonBody } = require('../../infra/http');
const { ensureDbEnabled } = require('../../infra/db');
const { logError } = require('../../infra/logger');
const { getAuthenticatedUser } = require('../../auth/middleware');
const { getUserMunicipalityRole } = require('../../game/municipality');
const { getBankStatus, getLedger, takeLoan, repayLoan } = require('../../game/bank');
const { getCompanyLoanInterestRate, setCompanyLoanInterestRate } = require('../../game/companyLoans');

module.exports = function registerBankRoutes(/* deps */) {
  return async function handleBank(req, res, pathname, requestUrl) {

    if (req.method === 'GET' && pathname === '/api/game/bank/status') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      try {
        const status = await getBankStatus(authUser.municipality_id);
        return sendJson(res, 200, { ok: true, data: status });
      } catch (err) {
        logError('BANK', 'getBankStatus failed', { municipalityId: authUser.municipality_id, error: err?.message });
        return sendJson(res, 500, { ok: false, error: 'Bank-Status konnte nicht geladen werden' });
      }
    }

    if (req.method === 'GET' && pathname === '/api/game/bank/ledger') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const role = await getUserMunicipalityRole(authUser.id, authUser.municipality_id);
      if (!role || !['owner', 'council', 'admin'].includes(role)) return sendJson(res, 403, { ok: false, error: 'Nur Verwaltung darf das Ledger einsehen' });
      try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const limit = Math.min(50, Number(url.searchParams.get('limit')) || 15);
        const offset = Number(url.searchParams.get('offset')) || 0;
        const filter = url.searchParams.get('filter') || 'all';
        const result = await getLedger(authUser.municipality_id, { limit, offset, typeFilter: filter });
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        logError('BANK', 'getLedger failed', { municipalityId: authUser.municipality_id, error: err?.message });
        return sendJson(res, 500, { ok: false, error: 'Ledger konnte nicht geladen werden' });
      }
    }

    if (req.method === 'POST' && pathname === '/api/game/bank/loan') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const role = await getUserMunicipalityRole(authUser.id, authUser.municipality_id);
      if (!role || !['owner', 'council'].includes(role)) return sendJson(res, 403, { ok: false, error: 'Nur Gemeindepräsident oder Gemeinderat dürfen Kredite aufnehmen' });
      const body = await readJsonBody(req);
      const amount = Math.round(Number(body.amount) || 0);
      if (amount <= 0) return sendJson(res, 400, { ok: false, error: 'Betrag muss grösser als 0 sein' });
      try {
        const result = await takeLoan(authUser.municipality_id, amount, authUser.id);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }
    }

    if (req.method === 'POST' && pathname === '/api/game/bank/repay') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const role = await getUserMunicipalityRole(authUser.id, authUser.municipality_id);
      if (!role || !['owner', 'council'].includes(role)) return sendJson(res, 403, { ok: false, error: 'Nur Gemeindepräsident oder Gemeinderat dürfen Kredite zurückzahlen' });
      const body = await readJsonBody(req);
      const amount = body.amount === 'all' ? 'all' : Math.round(Number(body.amount) || 0);
      if (amount !== 'all' && amount <= 0) return sendJson(res, 400, { ok: false, error: 'Betrag muss grösser als 0 sein' });
      try {
        const result = await repayLoan(authUser.municipality_id, amount, authUser.id);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }
    }

    // ── GET /api/game/bank/company-loan-settings — Firma-Kredit-Zinssatz lesen ──
    if (req.method === 'GET' && pathname === '/api/game/bank/company-loan-settings') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const role = await getUserMunicipalityRole(authUser.id, authUser.municipality_id);
      if (!role || !['owner', 'council'].includes(role)) return sendJson(res, 403, { ok: false, error: 'Nur Gemeindepräsident oder Gemeinderat' });
      try {
        const rate = await getCompanyLoanInterestRate(authUser.municipality_id);
        return sendJson(res, 200, { ok: true, data: { interest_rate: rate } });
      } catch (err) {
        logError('BANK', 'getCompanyLoanInterestRate failed', { error: err?.message });
        return sendJson(res, 500, { ok: false, error: 'Fehler beim Laden der Einstellung' });
      }
    }

    // ── PATCH /api/game/bank/company-loan-settings — Firma-Kredit-Zinssatz ändern ──
    if (req.method === 'PATCH' && pathname === '/api/game/bank/company-loan-settings') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });
      const role = await getUserMunicipalityRole(authUser.id, authUser.municipality_id);
      if (!role || !['owner', 'council'].includes(role)) return sendJson(res, 403, { ok: false, error: 'Nur Gemeindepräsident oder Gemeinderat' });
      const body = await readJsonBody(req);
      const rate = Number(body.interest_rate);
      if (isNaN(rate) || rate < 0 || rate > 0.05) {
        return sendJson(res, 422, { ok: false, error: 'Zinssatz muss zwischen 0 und 5% liegen (0.0 – 0.05)' });
      }
      try {
        const newRate = await setCompanyLoanInterestRate(authUser.municipality_id, rate);
        return sendJson(res, 200, { ok: true, data: { interest_rate: newRate } });
      } catch (err) {
        logError('BANK', 'setCompanyLoanInterestRate failed', { error: err?.message });
        return sendJson(res, 500, { ok: false, error: 'Fehler beim Speichern der Einstellung' });
      }
    }
  };
};
