'use strict';

const { sendJson, readJsonBody } = require('../../../infra/http');
const { dbPool, ensureDbEnabled } = require('../../../infra/db');
const { getAuthenticatedUser } = require('../../../auth/middleware');
const { normalizeDirection, oppositeDirection } = require('../../../shared/helpers');
const { GLOBAL_ROLE_ADMINISTRATOR } = require('../../../config/constants');

const {
  getMunicipalityBySlug,
  getMunicipalityById,
  getMunicipalityOwner,
} = require('../../../game/municipality');

const {
  upsertPartnership,
  getPartnershipRow,
  listPartnershipRows,
  toPartnershipDto,
  listPartnershipRequestsForMunicipality,
  getPartnershipRequestById,
  toPartnershipRequestDto,
  investInPartnership,
  executeDiplomaticAction,
  getActionCooldowns,
  computeExportCapacity,
  updateRoadConnected,
} = require('../../../game/partnerships');

const { createUserNotification } = require('../../../game/notifications');

function isGlobalAdmin(authUser) {
  return String(authUser?.global_role || '').toLowerCase() === GLOBAL_ROLE_ADMINISTRATOR;
}

module.exports = function registerPartnershipRoutes(deps) {
  return async function handlePartnerships(req, res, pathname, requestUrl) {

    // ================================================================
    // PARTNERSHIPS
    // ================================================================

    const municipalityPartnershipsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships$/i);
    if (municipalityPartnershipsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const rows = await listPartnershipRows(municipality.id);
      const partnerships = rows.map(toPartnershipDto);
      const discoveredCount = partnerships.filter((p) => p.status === 'discovered').length;
      const connectedCount = partnerships.filter((p) => p.status === 'connected').length;
      const totalTradeIncome = partnerships
        .filter((p) => p.status === 'connected')
        .reduce((sum, p) => sum + Number(p.trade_income || 0), 0);
      return sendJson(res, 200, {
        success: true,
        data: {
          partnerships,
          total_trade_income: totalTradeIncome,
          discovered_count: discoveredCount,
          connected_count: connectedCount,
        },
      });
    }

    const municipalityPartnershipsDiscoverMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/discover$/i);
    if (municipalityPartnershipsDiscoverMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipsDiscoverMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const body = await readJsonBody(req);
      const direction = normalizeDirection(body.direction) || 'north';
      const partnerSlug = String(body.partner_slug || '').trim().toLowerCase();
      let partner = partnerSlug ? await getMunicipalityBySlug(partnerSlug) : null;
      if (!partner && body.partner_name) {
        const [rows] = await dbPool.query(
          `SELECT id, name, slug, canton_code, canton_name
           FROM municipalities
           WHERE LOWER(name) = LOWER(?)
           LIMIT 1`,
          [String(body.partner_name).trim()]
        );
        partner = rows[0] || null;
      }
      if (!partner) return sendJson(res, 404, { success: false, error: 'Partner-Gemeinde nicht gefunden' });
      if (Number(partner.id) === Number(municipality.id)) {
        return sendJson(res, 422, { success: false, error: 'Partnerschaft mit sich selbst nicht moeglich' });
      }
      const existing = await getPartnershipRow(municipality.id, partner.id);
      if (!existing) {
        const now = new Date();
        await upsertPartnership({
          municipalityId: municipality.id,
          partnerMunicipalityId: partner.id,
          status: 'discovered',
          direction,
          tradeIncome: 0,
          connectionBonusPaid: false,
          discoveredAt: now,
          connectedAt: null,
        });
        await upsertPartnership({
          municipalityId: partner.id,
          partnerMunicipalityId: municipality.id,
          status: 'discovered',
          direction: oppositeDirection(direction),
          tradeIncome: 0,
          connectionBonusPaid: false,
          discoveredAt: now,
          connectedAt: null,
        });
      }
      const row = await getPartnershipRow(municipality.id, partner.id);
      const dto = toPartnershipDto({
        ...row,
        partner_id: partner.id,
        partner_name: partner.name,
        partner_slug: partner.slug,
        partner_canton: partner.canton_code,
      });
      const municipalityOwner = await getMunicipalityOwner(municipality.id);
      const partnerOwner = await getMunicipalityOwner(partner.id);
      if (municipalityOwner?.id && Number(municipalityOwner.id) !== Number(authUser.id)) {
        await createUserNotification(
          municipalityOwner.id,
          'partnership_discovered',
          'Neue Handelspartnerschaft entdeckt',
          `${partner.name} wurde als potenzieller Handelspartner entdeckt.`,
          { municipality_slug: municipality.slug, partner_slug: partner.slug, direction }
        );
      }
      if (partnerOwner?.id) {
        await createUserNotification(
          partnerOwner.id,
          'partnership_discovered_by_other',
          'Gemeinde hat dich entdeckt',
          `${municipality.name} hat deine Gemeinde als Handelspartner entdeckt.`,
          { municipality_slug: municipality.slug, partner_slug: partner.slug, direction: oppositeDirection(direction) }
        );
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          partnership: dto,
          already_discovered: Boolean(existing),
          message: existing ? 'Partnerschaft bereits entdeckt' : 'Partnerschaft entdeckt',
        },
      });
    }

    const municipalityPartnershipsConnectMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/([a-z0-9-]+)\/connect$/i);
    if (municipalityPartnershipsConnectMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipsConnectMatch[1].toLowerCase());
      const partner = await getMunicipalityBySlug(municipalityPartnershipsConnectMatch[2].toLowerCase());
      if (!municipality || !partner) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const existing = await getPartnershipRow(municipality.id, partner.id);
      const isAlreadyConnected = existing && existing.status === 'connected';
      const monthlyIncome = Number(existing?.trade_income || 200);
      const bonusPaid = isAlreadyConnected || existing?.connection_bonus_paid ? 0 : 5000;
      const now = new Date();
      const direction = normalizeDirection(existing?.direction) || 'north';

      await upsertPartnership({
        municipalityId: municipality.id,
        partnerMunicipalityId: partner.id,
        status: 'connected',
        direction,
        tradeIncome: monthlyIncome,
        connectionBonusPaid: true,
        discoveredAt: existing?.discovered_at || now,
        connectedAt: now,
      });
      await upsertPartnership({
        municipalityId: partner.id,
        partnerMunicipalityId: municipality.id,
        status: 'connected',
        direction: oppositeDirection(direction),
        tradeIncome: monthlyIncome,
        connectionBonusPaid: true,
        discoveredAt: now,
        connectedAt: now,
      });

      const row = await getPartnershipRow(municipality.id, partner.id);
      const dto = toPartnershipDto({
        ...row,
        partner_id: partner.id,
        partner_name: partner.name,
        partner_slug: partner.slug,
        partner_canton: partner.canton_code,
      });
      const municipalityOwner = await getMunicipalityOwner(municipality.id);
      const partnerOwner = await getMunicipalityOwner(partner.id);
      if (municipalityOwner?.id) {
        await createUserNotification(
          municipalityOwner.id,
          'partnership_connected',
          'Handelsroute aktiv',
          `Die Handelsroute mit ${partner.name} ist jetzt aktiv.`,
          { municipality_slug: municipality.slug, partner_slug: partner.slug, monthly_income: monthlyIncome, bonus_paid: bonusPaid }
        );
      }
      if (partnerOwner?.id) {
        await createUserNotification(
          partnerOwner.id,
          'partnership_connected',
          'Handelsroute aktiv',
          `Die Handelsroute mit ${municipality.name} ist jetzt aktiv.`,
          { municipality_slug: partner.slug, partner_slug: municipality.slug, monthly_income: monthlyIncome, bonus_paid: bonusPaid }
        );
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          partnership: dto,
          already_connected: Boolean(isAlreadyConnected),
          bonus_paid: bonusPaid,
          monthly_income: monthlyIncome,
          message: isAlreadyConnected ? 'Handelsroute bereits aktiv' : 'Handelsroute erfolgreich etabliert',
        },
      });
    }

    const municipalityPartnershipsTradeIncomeMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/trade-income$/i);
    if (municipalityPartnershipsTradeIncomeMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipsTradeIncomeMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const rows = (await listPartnershipRows(municipality.id)).filter((r) => r.status === 'connected');
      const list = rows.map((r) => ({
        partner_name: r.partner_name,
        partner_slug: r.partner_slug,
        income: Number(r.trade_income || 0),
      }));
      const totalMonthlyIncome = list.reduce((sum, p) => sum + Number(p.income), 0);
      return sendJson(res, 200, {
        success: true,
        data: {
          total_monthly_income: totalMonthlyIncome,
          partnerships: list,
          partnership_count: list.length,
        },
      });
    }

    const municipalityPartnershipRequestsMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/requests$/i);
    if (pathname === '/api/game/partnerships/requests' && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { success: false, error: 'Keine Gemeinde zugeordnet' });
      const municipality = await getMunicipalityById(Number(authUser.municipality_id));
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      const rows = await listPartnershipRequestsForMunicipality(municipality.id);
      const incoming = [];
      const outgoing = [];
      for (const row of rows) {
        const fromOwner = await getMunicipalityOwner(row.from_municipality_id);
        const dto = toPartnershipRequestDto(row, fromOwner);
        if (Number(row.to_municipality_id) === Number(municipality.id)) incoming.push(dto);
        if (Number(row.from_municipality_id) === Number(municipality.id)) outgoing.push(dto);
      }
      return sendJson(res, 200, { success: true, data: { incoming, outgoing } });
    }

    const myPartnershipRequestRespondMatch = pathname.match(/^\/api\/game\/partnerships\/requests\/([0-9]+)\/(accept|decline)$/i);
    if (myPartnershipRequestRespondMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      if (!authUser.municipality_id) return sendJson(res, 400, { success: false, error: 'Keine Gemeinde zugeordnet' });
      const municipality = await getMunicipalityById(Number(authUser.municipality_id));
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });

      const requestId = Number(myPartnershipRequestRespondMatch[1]);
      const action = myPartnershipRequestRespondMatch[2].toLowerCase();
      const requestRow = await getPartnershipRequestById(requestId);
      if (!requestRow) return sendJson(res, 404, { success: false, error: 'Anfrage nicht gefunden' });
      if (String(requestRow.status) !== 'pending') {
        return sendJson(res, 409, { success: false, error: 'Anfrage bereits bearbeitet' });
      }
      if (Number(requestRow.to_municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Anfrage gehoert nicht zu dieser Gemeinde' });
      }

      const newStatus = action === 'accept' ? 'accepted' : 'declined';
      await dbPool.query(
        `UPDATE game_partnership_requests
         SET status = ?, responder_user_id = ?, responded_at = NOW(), updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [newStatus, authUser.id, requestId]
      );

      const [requestRows] = await dbPool.query(
        `SELECT
          r.id, r.from_municipality_id, r.to_municipality_id, r.status, r.message, r.created_at, r.responded_at,
          fm.name AS from_name, fm.slug AS from_slug, fm.canton_code AS from_canton,
          tm.name AS to_name, tm.slug AS to_slug
         FROM game_partnership_requests r
         INNER JOIN municipalities fm ON fm.id = r.from_municipality_id
         INNER JOIN municipalities tm ON tm.id = r.to_municipality_id
         WHERE r.id = ?
         LIMIT 1`,
        [requestId]
      );
      const dto = toPartnershipRequestDto(requestRows[0], await getMunicipalityOwner(requestRows[0].from_municipality_id));
      let partnershipDto = null;
      if (newStatus === 'accepted') {
        const monthlyIncome = 200;
        const now = new Date();
        const fromMunicipalityId = Number(requestRows[0].from_municipality_id);
        const toMunicipalityId = Number(requestRows[0].to_municipality_id);
        const existingForward = await getPartnershipRow(fromMunicipalityId, toMunicipalityId);
        const existingReverse = await getPartnershipRow(toMunicipalityId, fromMunicipalityId);
        const inferredFromReverse = normalizeDirection(oppositeDirection(existingReverse?.direction));
        const forwardDirection = normalizeDirection(existingForward?.direction) || inferredFromReverse || 'north';
        const reverseDirection = normalizeDirection(oppositeDirection(forwardDirection))
          || normalizeDirection(existingReverse?.direction)
          || 'south';
        await upsertPartnership({
          municipalityId: fromMunicipalityId,
          partnerMunicipalityId: toMunicipalityId,
          status: 'connected',
          direction: forwardDirection,
          tradeIncome: monthlyIncome,
          connectionBonusPaid: true,
          discoveredAt: existingForward?.discovered_at || now,
          connectedAt: now,
        });
        await upsertPartnership({
          municipalityId: toMunicipalityId,
          partnerMunicipalityId: fromMunicipalityId,
          status: 'connected',
          direction: reverseDirection,
          tradeIncome: monthlyIncome,
          connectionBonusPaid: true,
          discoveredAt: existingReverse?.discovered_at || now,
          connectedAt: now,
        });
        const toMunicipality = await getMunicipalityById(toMunicipalityId);
        const row = await getPartnershipRow(fromMunicipalityId, toMunicipalityId);
        partnershipDto = toPartnershipDto({
          ...row,
          partner_id: toMunicipality.id,
          partner_name: toMunicipality.name,
          partner_slug: toMunicipality.slug,
          partner_canton: toMunicipality.canton_code,
        });
      }

      const fromOwner = await getMunicipalityOwner(requestRows[0].from_municipality_id);
      if (fromOwner?.id) {
        await createUserNotification(
          fromOwner.id,
          newStatus === 'accepted' ? 'partnership_request_accepted' : 'partnership_request_declined',
          newStatus === 'accepted' ? 'Partnerschaftsanfrage akzeptiert' : 'Partnerschaftsanfrage abgelehnt',
          `${requestRows[0].to_name} hat deine Anfrage ${newStatus === 'accepted' ? 'angenommen' : 'abgelehnt'}.`,
          { request_id: requestId, status: newStatus }
        );
      }

      return sendJson(res, 200, {
        success: true,
        data: {
          request: dto,
          partnership: partnershipDto,
          message: newStatus === 'accepted' ? 'Anfrage akzeptiert' : 'Anfrage abgelehnt',
        },
      });
    }

    if (municipalityPartnershipRequestsMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipRequestsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const rows = await listPartnershipRequestsForMunicipality(municipality.id);
      const incoming = [];
      const outgoing = [];
      for (const row of rows) {
        const fromOwner = await getMunicipalityOwner(row.from_municipality_id);
        const dto = toPartnershipRequestDto(row, fromOwner);
        if (Number(row.to_municipality_id) === Number(municipality.id)) incoming.push(dto);
        if (Number(row.from_municipality_id) === Number(municipality.id)) outgoing.push(dto);
      }
      return sendJson(res, 200, { success: true, data: { incoming, outgoing } });
    }

    if (municipalityPartnershipRequestsMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipRequestsMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const body = await readJsonBody(req);
      const targetSlug = String(body.target_slug || '').trim().toLowerCase();
      const target = await getMunicipalityBySlug(targetSlug);
      if (!target) return sendJson(res, 404, { success: false, error: 'Ziel-Gemeinde nicht gefunden' });
      const targetOwner = await getMunicipalityOwner(target.id);
      if (!targetOwner?.id) {
        return sendJson(res, 422, { success: false, error: 'Ziel-Gemeinde hat keinen aktiven Besitzer' });
      }
      if (Number(target.id) === Number(municipality.id)) {
        return sendJson(res, 422, { success: false, error: 'Anfrage an eigene Gemeinde nicht moeglich' });
      }
      const [dupRows] = await dbPool.query(
        `SELECT id
         FROM game_partnership_requests
         WHERE from_municipality_id = ? AND to_municipality_id = ? AND status = 'pending'
         LIMIT 1`,
        [municipality.id, target.id]
      );
      if (Array.isArray(dupRows) && dupRows.length > 0) {
        return sendJson(res, 409, { success: false, error: 'Anfrage bereits offen' });
      }
      const message = String(body.message || '').trim().slice(0, 500);
      const [result] = await dbPool.query(
        `INSERT INTO game_partnership_requests (from_municipality_id, to_municipality_id, from_user_id, status, message)
         VALUES (?, ?, ?, 'pending', ?)`,
        [municipality.id, target.id, authUser.id, message || null]
      );
      const [rows] = await dbPool.query(
        `SELECT
          r.id, r.from_municipality_id, r.to_municipality_id, r.status, r.message, r.created_at, r.responded_at,
          fm.name AS from_name, fm.slug AS from_slug, fm.canton_code AS from_canton,
          tm.name AS to_name, tm.slug AS to_slug
         FROM game_partnership_requests r
         INNER JOIN municipalities fm ON fm.id = r.from_municipality_id
         INNER JOIN municipalities tm ON tm.id = r.to_municipality_id
         WHERE r.id = ?
         LIMIT 1`,
        [result.insertId]
      );
      const row = rows[0];
      const fromOwner = await getMunicipalityOwner(municipality.id);
      const dto = toPartnershipRequestDto(row, fromOwner);
      if (targetOwner?.id) {
        await createUserNotification(
          targetOwner.id,
          'partnership_request_incoming',
          `Neue Partnerschaftsanfrage von ${municipality.name}`,
          message || `Die Gemeinde ${municipality.name} moechte eine Partnerschaft aufbauen.`,
          { request_id: Number(row.id), from_slug: municipality.slug, to_slug: target.slug }
        );
      }
      return sendJson(res, 200, {
        success: true,
        data: {
          request: dto,
          message: 'Partnerschaftsanfrage gesendet',
        },
      });
    }

    const municipalityPartnershipRequestRespondMatch = pathname.match(/^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/requests\/([0-9]+)\/(accept|decline)$/i);
    if (municipalityPartnershipRequestRespondMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht authentifiziert' });
      const municipality = await getMunicipalityBySlug(municipalityPartnershipRequestRespondMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });
      if (Number(authUser.municipality_id) !== Number(municipality.id) && !isGlobalAdmin(authUser)) {
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung für diese Gemeinde' });
      }
      const requestId = Number(municipalityPartnershipRequestRespondMatch[2]);
      const action = municipalityPartnershipRequestRespondMatch[3].toLowerCase();
      const requestRow = await getPartnershipRequestById(requestId);
      if (!requestRow) return sendJson(res, 404, { success: false, error: 'Anfrage nicht gefunden' });
      if (String(requestRow.status) !== 'pending') {
        return sendJson(res, 409, { success: false, error: 'Anfrage bereits bearbeitet' });
      }
      if (Number(requestRow.to_municipality_id) !== Number(municipality.id)) {
        return sendJson(res, 403, { success: false, error: 'Anfrage gehoert nicht zu dieser Gemeinde' });
      }

      const newStatus = action === 'accept' ? 'accepted' : 'declined';
      await dbPool.query(
        `UPDATE game_partnership_requests
         SET status = ?, responder_user_id = ?, responded_at = NOW(), updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [newStatus, authUser.id, requestId]
      );

      const [requestRows] = await dbPool.query(
        `SELECT
          r.id, r.from_municipality_id, r.to_municipality_id, r.status, r.message, r.created_at, r.responded_at,
          fm.name AS from_name, fm.slug AS from_slug, fm.canton_code AS from_canton,
          tm.name AS to_name, tm.slug AS to_slug
         FROM game_partnership_requests r
         INNER JOIN municipalities fm ON fm.id = r.from_municipality_id
         INNER JOIN municipalities tm ON tm.id = r.to_municipality_id
         WHERE r.id = ?
         LIMIT 1`,
        [requestId]
      );
      const dto = toPartnershipRequestDto(requestRows[0], await getMunicipalityOwner(requestRows[0].from_municipality_id));
      let partnershipDto = null;
      if (newStatus === 'accepted') {
        const monthlyIncome = 200;
        const now = new Date();
        const fromMunicipalityId = Number(requestRows[0].from_municipality_id);
        const toMunicipalityId = Number(requestRows[0].to_municipality_id);
        const existingForward = await getPartnershipRow(fromMunicipalityId, toMunicipalityId);
        const existingReverse = await getPartnershipRow(toMunicipalityId, fromMunicipalityId);
        const inferredFromReverse = normalizeDirection(oppositeDirection(existingReverse?.direction));
        const forwardDirection = normalizeDirection(existingForward?.direction) || inferredFromReverse || 'north';
        const reverseDirection = normalizeDirection(oppositeDirection(forwardDirection))
          || normalizeDirection(existingReverse?.direction)
          || 'south';
        await upsertPartnership({
          municipalityId: fromMunicipalityId,
          partnerMunicipalityId: toMunicipalityId,
          status: 'connected',
          direction: forwardDirection,
          tradeIncome: monthlyIncome,
          connectionBonusPaid: true,
          discoveredAt: existingForward?.discovered_at || now,
          connectedAt: now,
        });
        await upsertPartnership({
          municipalityId: toMunicipalityId,
          partnerMunicipalityId: fromMunicipalityId,
          status: 'connected',
          direction: reverseDirection,
          tradeIncome: monthlyIncome,
          connectionBonusPaid: true,
          discoveredAt: existingReverse?.discovered_at || now,
          connectedAt: now,
        });
        const toMunicipality = await getMunicipalityById(toMunicipalityId);
        const row = await getPartnershipRow(fromMunicipalityId, toMunicipalityId);
        partnershipDto = toPartnershipDto({
          ...row,
          partner_id: toMunicipality.id,
          partner_name: toMunicipality.name,
          partner_slug: toMunicipality.slug,
          partner_canton: toMunicipality.canton_code,
        });
      }

      const fromOwner = await getMunicipalityOwner(requestRows[0].from_municipality_id);
      if (fromOwner?.id) {
        await createUserNotification(
          fromOwner.id,
          newStatus === 'accepted' ? 'partnership_request_accepted' : 'partnership_request_declined',
          newStatus === 'accepted' ? 'Partnerschaftsanfrage akzeptiert' : 'Partnerschaftsanfrage abgelehnt',
          `${requestRows[0].to_name} hat deine Anfrage ${newStatus === 'accepted' ? 'angenommen' : 'abgelehnt'}.`,
          { request_id: requestId, status: newStatus }
        );
      }

      return sendJson(res, 200, {
        success: true,
        data: {
          request: dto,
          partnership: partnershipDto || undefined,
          message: newStatus === 'accepted' ? 'Anfrage akzeptiert' : 'Anfrage abgelehnt',
        },
      });
    }

    // ── INVEST IN PARTNERSHIP ──────────────────────────────────────────────────
    // POST /api/game/municipality/:slug/partnerships/:partnerSlug/invest
    const investMatch = pathname.match(
      /^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/([a-z0-9-]+)\/invest$/i
    );
    if (investMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht eingeloggt' });

      const municipality = await getMunicipalityBySlug(investMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });

      const owner = await getMunicipalityOwner(municipality.id);
      if (!owner || Number(owner.id) !== Number(authUser.id))
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung' });

      const partner = await getMunicipalityBySlug(investMatch[2].toLowerCase());
      if (!partner) return sendJson(res, 404, { success: false, error: 'Partner-Gemeinde nicht gefunden' });

      const body = await readJsonBody(req);
      const amount = Math.max(0, Math.round(Number(body?.amount) || 0));
      if (amount <= 0) return sendJson(res, 400, { success: false, error: 'Betrag muss grösser als 0 sein' });

      try {
        const tierProgress = await investInPartnership(municipality.id, partner.id, amount);
        return sendJson(res, 200, { success: true, data: { invested: amount, tier_progress: tierProgress } });
      } catch (err) {
        return sendJson(res, 400, { success: false, error: err.message });
      }
    }

    // ── DIPLOMATISCHE AKTIONEN ─────────────────────────────────────────────────
    // POST /api/game/municipality/:slug/partnerships/:partnerSlug/action
    const actionMatch = pathname.match(
      /^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/([a-z0-9-]+)\/action$/i
    );
    if (actionMatch && req.method === 'POST') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht eingeloggt' });

      const municipality = await getMunicipalityBySlug(actionMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });

      const owner = await getMunicipalityOwner(municipality.id);
      if (!owner || Number(owner.id) !== Number(authUser.id))
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung' });

      const partner = await getMunicipalityBySlug(actionMatch[2].toLowerCase());
      if (!partner) return sendJson(res, 404, { success: false, error: 'Partner-Gemeinde nicht gefunden' });

      const body = await readJsonBody(req);
      const actionType = String(body?.action_type || '').trim();
      if (!actionType) return sendJson(res, 400, { success: false, error: 'action_type fehlt' });

      try {
        const cooldowns = await executeDiplomaticAction(municipality.id, partner.id, actionType);
        return sendJson(res, 200, { success: true, data: { cooldowns } });
      } catch (err) {
        return sendJson(res, 400, { success: false, error: err.message });
      }
    }

    // GET /api/game/municipality/:slug/partnerships/:partnerSlug/action
    if (actionMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht eingeloggt' });

      const municipality = await getMunicipalityBySlug(actionMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });

      const partner = await getMunicipalityBySlug(actionMatch[2].toLowerCase());
      if (!partner) return sendJson(res, 404, { success: false, error: 'Partner-Gemeinde nicht gefunden' });

      try {
        const cooldowns = await getActionCooldowns(municipality.id, partner.id);
        return sendJson(res, 200, { success: true, data: { cooldowns } });
      } catch (err) {
        return sendJson(res, 400, { success: false, error: err.message });
      }
    }

    // ── EXPORT-KAPAZITÄT ───────────────────────────────────────────────────────
    // GET /api/game/municipality/:slug/partnerships/export-capacity
    const exportCapMatch = pathname.match(
      /^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/export-capacity$/i
    );
    if (exportCapMatch && req.method === 'GET') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht eingeloggt' });

      const municipality = await getMunicipalityBySlug(exportCapMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });

      try {
        const capacity = await computeExportCapacity(municipality.id);
        return sendJson(res, 200, { success: true, data: capacity });
      } catch (err) {
        return sendJson(res, 400, { success: false, error: err.message });
      }
    }

    // ── ROAD-STATUS UPDATE ─────────────────────────────────────────────────────
    // PATCH /api/game/municipality/:slug/partnerships/:partnerSlug/road-status
    const roadStatusMatch = pathname.match(
      /^\/api\/game\/municipality\/([a-z0-9-]+)\/partnerships\/([a-z0-9-]+)\/road-status$/i
    );
    if (roadStatusMatch && req.method === 'PATCH') {
      ensureDbEnabled();
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Nicht eingeloggt' });

      const municipality = await getMunicipalityBySlug(roadStatusMatch[1].toLowerCase());
      if (!municipality) return sendJson(res, 404, { success: false, error: 'Gemeinde nicht gefunden' });

      const owner = await getMunicipalityOwner(municipality.id);
      if (!owner || Number(owner.id) !== Number(authUser.id))
        return sendJson(res, 403, { success: false, error: 'Keine Berechtigung' });

      const partner = await getMunicipalityBySlug(roadStatusMatch[2].toLowerCase());
      if (!partner) return sendJson(res, 404, { success: false, error: 'Partner-Gemeinde nicht gefunden' });

      const body = await readJsonBody(req);
      const connected = body?.connected === true || body?.connected === 1;

      try {
        await updateRoadConnected(municipality.id, partner.id, connected);
        return sendJson(res, 200, { success: true, data: { road_connected: connected } });
      } catch (err) {
        return sendJson(res, 400, { success: false, error: err.message });
      }
    }

  };
};
