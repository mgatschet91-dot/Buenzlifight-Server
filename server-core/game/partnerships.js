'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { normalizeDirection, normalizePartnershipStatus } = require('../shared/helpers');

/**
 * Insert or update a partnership row. Uses UNIQUE (municipality_id, partner_municipality_id).
 * @param {Object} opts
 * @param {number} opts.municipalityId
 * @param {number} opts.partnerMunicipalityId
 * @param {string} [opts.status]
 * @param {string} [opts.direction]
 * @param {number} [opts.tradeIncome]
 * @param {boolean} [opts.connectionBonusPaid]
 * @param {Date|string|null} [opts.discoveredAt]
 * @param {Date|string|null} [opts.connectedAt]
 */
async function upsertPartnership({
  municipalityId,
  partnerMunicipalityId,
  status,
  direction,
  tradeIncome,
  connectionBonusPaid,
  discoveredAt,
  connectedAt,
}) {
  ensureDbEnabled();
  await dbPool.query(
    `INSERT INTO game_partnerships
      (municipality_id, partner_municipality_id, status, direction, trade_income, connection_bonus_paid, discovered_at, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      direction = COALESCE(VALUES(direction), direction),
      trade_income = VALUES(trade_income),
      connection_bonus_paid = VALUES(connection_bonus_paid),
      discovered_at = COALESCE(discovered_at, VALUES(discovered_at)),
      connected_at = COALESCE(VALUES(connected_at), connected_at),
      updated_at = CURRENT_TIMESTAMP`,
    [
      municipalityId,
      partnerMunicipalityId,
      normalizePartnershipStatus(status),
      normalizeDirection(direction),
      Number(tradeIncome || 0),
      connectionBonusPaid ? 1 : 0,
      discoveredAt,
      connectedAt,
    ]
  );
}

/**
 * @param {number} municipalityId
 * @param {number} partnerMunicipalityId
 * @returns {Promise<Object|null>}
 */
async function getPartnershipRow(municipalityId, partnerMunicipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT *
     FROM game_partnerships
     WHERE municipality_id = ? AND partner_municipality_id = ?
     LIMIT 1`,
    [municipalityId, partnerMunicipalityId]
  );
  return rows[0] || null;
}

/**
 * List partnership rows for a municipality with partner info from municipalities.
 * @param {number} municipalityId
 * @returns {Promise<Array<Object>>}
 */
async function listPartnershipRows(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT
      p.id, p.status, p.direction, p.trade_income, p.connection_bonus_paid, p.discovered_at, p.connected_at,
      m.id AS partner_id, m.name AS partner_name, m.slug AS partner_slug, m.canton_code AS partner_canton
     FROM game_partnerships p
     INNER JOIN municipalities m ON m.id = p.partner_municipality_id
     WHERE p.municipality_id = ?
     ORDER BY m.name ASC`,
    [municipalityId]
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Map a partnership row (from listPartnershipRows or getPartnershipRow + join) to DTO.
 * @param {Object} row - must have id, partner_id, partner_name, partner_slug, partner_canton, status, direction, trade_income, connection_bonus_paid, discovered_at, connected_at
 * @returns {Object}
 */
function toPartnershipDto(row) {
  return {
    id: Number(row.id),
    partner: {
      id: Number(row.partner_id),
      name: row.partner_name,
      slug: row.partner_slug,
      canton: row.partner_canton || undefined,
      population: row.partner_population != null ? Number(row.partner_population) : 0,
    },
    status: row.status === 'connected' ? 'connected' : 'discovered',
    direction: normalizeDirection(row.direction) || 'north',
    trade_income: Number(row.trade_income || 0),
    connection_bonus_paid: Boolean(row.connection_bonus_paid),
    discovered_at: row.discovered_at || null,
    connected_at: row.connected_at || null,
  };
}

/**
 * List partnership requests where the municipality is sender or receiver (with JOINs for names).
 * @param {number} municipalityId
 * @returns {Promise<Array<Object>>}
 */
async function listPartnershipRequestsForMunicipality(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT
      r.id, r.from_municipality_id, r.to_municipality_id, r.status, r.message, r.created_at, r.responded_at,
      fm.name AS from_name, fm.slug AS from_slug, fm.canton_code AS from_canton,
      tm.name AS to_name, tm.slug AS to_slug
     FROM game_partnership_requests r
     INNER JOIN municipalities fm ON fm.id = r.from_municipality_id
     INNER JOIN municipalities tm ON tm.id = r.to_municipality_id
     WHERE r.from_municipality_id = ? OR r.to_municipality_id = ?
     ORDER BY r.created_at DESC`,
    [municipalityId, municipalityId]
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * @param {number} requestId
 * @returns {Promise<Object|null>}
 */
async function getPartnershipRequestById(requestId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT *
     FROM game_partnership_requests
     WHERE id = ?
     LIMIT 1`,
    [requestId]
  );
  return rows[0] || null;
}

/**
 * Map a partnership request row to DTO. Row may be from list (with from_name, to_name, etc.) or getById (raw columns only).
 * @param {Object} row
 * @param {Object|null} [fromOwner] - optional owner of from_municipality for owner info in DTO
 * @returns {Object}
 */
function toPartnershipRequestDto(row, fromOwner) {
  return {
    id: Number(row.id),
    from_municipality: {
      id: Number(row.from_municipality_id),
      name: row.from_name != null ? row.from_name : String(row.from_municipality_id || ''),
      slug: row.from_slug != null ? row.from_slug : '',
      canton: row.from_canton || undefined,
      population: 0,
      owner: fromOwner
        ? { id: Number(fromOwner.id), nickname: fromOwner.nickname }
        : null,
    },
    to_municipality: {
      id: Number(row.to_municipality_id),
      name: row.to_name != null ? row.to_name : String(row.to_municipality_id || ''),
      slug: row.to_slug != null ? row.to_slug : '',
    },
    status: ['accepted', 'declined', 'pending'].includes(String(row.status))
      ? row.status
      : 'pending',
    message: row.message || undefined,
    created_at: row.created_at,
    responded_at: row.responded_at || undefined,
  };
}

module.exports = {
  upsertPartnership,
  getPartnershipRow,
  listPartnershipRows,
  toPartnershipDto,
  listPartnershipRequestsForMunicipality,
  getPartnershipRequestById,
  toPartnershipRequestDto,
};
