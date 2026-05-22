'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { logError } = require('../../../infra/logger');
const { ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { getUserMunicipalityRole } = require('../../../game/municipality');
const {
  createLoanRequest,
  respondToLoanRequest,
  cancelLoanRequest,
  getLoanRequestsByUser,
  getPendingLoanRequests,
  getCompanyLoan,
} = require('../../../game/companyLoans');

module.exports = function registerLoanRoutes(/* deps */) {
  return async function handleLoans(req, res, pathname, requestUrl) {

    // ── POST /api/companies/loan-request — Kredit beantragen ──────────
    if (req.method === 'POST' && pathname === '/api/companies/loan-request') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Du musst einer Gemeinde angehören' });

      const body = await readJsonBody(req);
      const companyName = String(body.name || '').trim();
      const companyTypeId = Number(body.company_type_id || 0);
      const message = body.message || null;

      if (!companyName || companyName.length < 3) {
        return sendJson(res, 422, { ok: false, error: 'Firmenname muss mindestens 3 Zeichen lang sein' });
      }
      if (!companyTypeId) {
        return sendJson(res, 422, { ok: false, error: 'Firmen-Typ ist erforderlich' });
      }

      try {
        const result = await createLoanRequest({
          municipalityId: authUser.municipality_id,
          userId: authUser.id,
          companyTypeId,
          companyName,
          message,
        });
        return sendJson(res, 201, { ok: true, data: result });
      } catch (err) {
        logError('LOAN_API', 'createLoanRequest failed', { userId: authUser.id, error: err?.message });
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // ── GET /api/companies/loan-requests/my — Eigene Anträge ─────────
    if (req.method === 'GET' && pathname === '/api/companies/loan-requests/my') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });

      try {
        const requests = await getLoanRequestsByUser(authUser.id);
        return sendJson(res, 200, { ok: true, data: { requests } });
      } catch (err) {
        logError('LOAN_API', 'getLoanRequestsByUser failed', { userId: authUser.id, error: err?.message });
        return sendJson(res, 500, { ok: false, error: 'Fehler beim Laden der Anträge' });
      }
    }

    // ── GET /api/companies/loan-requests/pending — Offene Anträge (Admin) ──
    if (req.method === 'GET' && pathname === '/api/companies/loan-requests/pending') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const role = await getUserMunicipalityRole(authUser.id, authUser.municipality_id);
      if (!role || !['owner', 'council'].includes(role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Gemeindepräsident oder Gemeinderat' });
      }

      try {
        const requests = await getPendingLoanRequests(authUser.municipality_id);
        return sendJson(res, 200, { ok: true, data: { requests } });
      } catch (err) {
        logError('LOAN_API', 'getPendingLoanRequests failed', { error: err?.message });
        return sendJson(res, 500, { ok: false, error: 'Fehler beim Laden der Anträge' });
      }
    }

    // ── DELETE /api/companies/loan-requests/:id — Antrag stornieren ───
    const cancelMatch = pathname.match(/^\/api\/companies\/loan-requests\/([0-9]+)$/);
    if (cancelMatch && req.method === 'DELETE') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const requestId = Number(cancelMatch[1]);

      try {
        const result = await cancelLoanRequest(requestId, authUser.id);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // ── POST /api/companies/loan-requests/:id/approve — Genehmigen ───
    const approveMatch = pathname.match(/^\/api\/companies\/loan-requests\/([0-9]+)\/approve$/);
    if (approveMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const role = await getUserMunicipalityRole(authUser.id, authUser.municipality_id);
      if (!role || !['owner', 'council'].includes(role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Gemeindepräsident oder Gemeinderat' });
      }

      const requestId = Number(approveMatch[1]);
      try {
        const result = await respondToLoanRequest(requestId, authUser.id, 'approved', null);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        logError('LOAN_API', 'approve failed', { requestId, error: err?.message });
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // ── POST /api/companies/loan-requests/:id/reject — Ablehnen ──────
    const rejectMatch = pathname.match(/^\/api\/companies\/loan-requests\/([0-9]+)\/reject$/);
    if (rejectMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { ok: false, error: 'Keine Gemeinde' });

      const role = await getUserMunicipalityRole(authUser.id, authUser.municipality_id);
      if (!role || !['owner', 'council'].includes(role)) {
        return sendJson(res, 403, { ok: false, error: 'Nur Gemeindepräsident oder Gemeinderat' });
      }

      const requestId = Number(rejectMatch[1]);
      const body = await readJsonBody(req);
      const reason = body.reason || null;

      try {
        const result = await respondToLoanRequest(requestId, authUser.id, 'rejected', reason);
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        logError('LOAN_API', 'reject failed', { requestId, error: err?.message });
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // ── GET /api/companies/:id/loan — Kredit-Status der Firma ────────
    const companyLoanMatch = pathname.match(/^\/api\/companies\/([0-9]+)\/loan$/);
    if (companyLoanMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Nicht authentifiziert' });
      const companyId = Number(companyLoanMatch[1]);

      try {
        const [membership] = await dbPool.query(
          `SELECT role FROM company_members WHERE company_id = ? AND user_id = ? LIMIT 1`,
          [companyId, authUser.id]
        );
        if (!membership.length) return sendJson(res, 403, { ok: false, error: 'Kein Zugriff auf diese Firma' });

        const loan = await getCompanyLoan(companyId);
        return sendJson(res, 200, { ok: true, data: { loan } });
      } catch (err) {
        logError('LOAN_API', 'getCompanyLoan failed', { companyId, error: err?.message });
        return sendJson(res, 500, { ok: false, error: 'Fehler beim Laden des Kredit-Status' });
      }
    }

  };
};
