'use strict';

// Fetch, Lookup, Membership-Sync, Administration

const { dbPool, ensureDbEnabled } = require('../../infra/db');
const {
  MUNICIPALITY_ROLE_OWNER,
  MUNICIPALITY_ROLE_COUNCIL,
  MUNICIPALITY_ROLE_CITIZEN,
  MUNICIPALITY_ROLE_OBSERVER,
  MUNICIPALITY_MEMBER_LIMIT,
} = require('../../config/constants');
const { normalizeMunicipalityRole } = require('../../auth/permissions');
const { toJsonValue, escapeLike } = require('../../shared/helpers');

// ── Fetch / List ──────────────────────────────────────────────────

async function fetchMunicipalities() {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT m.id, m.name, m.slug, m.canton_code, m.canton_name,
            m.updated_at, COALESCE(mc.cnt, 0) AS members_count
     FROM municipalities m
     LEFT JOIN (
       SELECT municipality_id, COUNT(*) AS cnt
       FROM users WHERE is_active = 1 GROUP BY municipality_id
     ) mc ON mc.municipality_id = m.id
     WHERE m.is_active = 1 AND (m.is_user_created = 0 OR m.is_user_created IS NULL)
     ORDER BY m.canton_code ASC, m.name ASC`
  );
  return Array.isArray(rows) ? rows : [];
}

async function fetchCantonMunicipalities(cantonCode) {
  ensureDbEnabled();
  const code = String(cantonCode || '').toUpperCase().trim();
  const [rows] = await dbPool.query(
    `SELECT id, name, slug, canton_code, canton_name
     FROM municipalities WHERE is_active = 1 AND canton_code = ? ORDER BY name ASC`,
    [code]
  );
  return Array.isArray(rows) ? rows : [];
}

async function searchMunicipalitiesForPartnerships(query = '', limit = 500) {
  ensureDbEnabled();
  const q = String(query || '').trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(2000, Math.round(Number(limit || 500))));
  const where = ['m.is_active = 1', 'ms.population >= 100', 'ms.jobs > 0'];
  const args = [];
  if (q) {
    where.push('(LOWER(m.name) LIKE ? OR LOWER(m.slug) LIKE ?)');
    const eq = escapeLike(q);
    args.push(`%${eq}%`, `%${eq}%`);
  }
  args.push(safeLimit);
  const [rows] = await dbPool.query(
    `SELECT m.id, m.name, m.slug, m.canton_code, m.canton_name,
            ms.population, ms.treasury, ms.jobs,
            COALESCE(mc.cnt, 0) AS members_count,
            owner_u.id       AS owner_id,
            owner_u.nickname AS owner_nickname
     FROM municipalities m
     LEFT JOIN municipality_stats ms ON ms.municipality_id = m.id
     LEFT JOIN (SELECT municipality_id, COUNT(*) AS cnt FROM users WHERE is_active = 1 GROUP BY municipality_id) mc ON mc.municipality_id = m.id
     LEFT JOIN municipality_memberships owner_mm ON owner_mm.municipality_id = m.id AND owner_mm.role = 'owner'
     LEFT JOIN users owner_u ON owner_u.id = owner_mm.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY ms.population DESC, m.name ASC
     LIMIT ?`,
    args
  );
  return (Array.isArray(rows) ? rows : []).map(r => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    canton_code: r.canton_code,
    canton_name: r.canton_name,
    population: r.population,
    treasury: r.treasury,
    jobs: r.jobs,
    members_count: r.members_count,
    owner: r.owner_id ? { id: Number(r.owner_id), nickname: r.owner_nickname } : null,
  }));
}

async function listPublicNavigatorMaps(query = '', limit = 60) {
  ensureDbEnabled();
  const { getRoomRuntimeEntry } = require('../rooms');
  const q = String(query || '').trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(200, Math.round(Number(limit || 60))));
  const where = ['m.is_active = 1'];
  const args = [];
  if (q) {
    where.push('(LOWER(m.name) LIKE ? OR LOWER(m.slug) LIKE ? OR LOWER(COALESCE(r.city_name, "")) LIKE ? OR LOWER(COALESCE(r.room_code, "")) LIKE ?)');
    const eq = escapeLike(q);
    args.push(`%${eq}%`, `%${eq}%`, `%${eq}%`, `%${eq}%`);
  }
  args.push(safeLimit);
  const [rows] = await dbPool.query(
    `SELECT m.id, m.name, m.slug, m.canton_code, m.canton_name,
            COALESCE(r.room_code, 'MAIN') AS room_code,
            COALESCE(r.city_name, m.name) AS room_name,
            COALESCE(r.player_count, 0) AS player_count,
            r.game_state AS room_game_state, r.updated_at AS room_updated_at,
            owner.id AS owner_id, owner.nickname AS owner_nickname
     FROM municipalities m
     INNER JOIN game_rooms r ON r.municipality_id = m.id AND r.is_active = 1 AND r.room_code LIKE 'PUB%'
     LEFT JOIN users owner ON owner.id = (SELECT MIN(u2.id) FROM users u2 WHERE u2.municipality_id = m.id AND u2.is_active = 1)
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(r.player_count, 0) DESC, m.name ASC LIMIT ?`,
    args
  );
  const list = Array.isArray(rows) ? rows : [];
  const enriched = list.map((row) => {
    const gameState = toJsonValue(row.room_game_state);
    const runtimeEntry = getRoomRuntimeEntry(Number(row.id), String(row.room_code || 'MAIN'), false);
    const livePlayerCount = runtimeEntry ? Math.max(0, Number(runtimeEntry.activePlayers || 0)) : 0;
    return {
      municipality_id: Number(row.id), municipality_name: String(row.name || ''),
      municipality_slug: String(row.slug || ''), canton_code: row.canton_code || null, canton_name: row.canton_name || null,
      room_code: String(row.room_code || 'MAIN'), room_name: String(row.room_name || row.name || 'Public Room'),
      player_count: Math.max(livePlayerCount, Number(row.player_count || 0)),
      owner: row.owner_id ? { id: Number(row.owner_id), nickname: row.owner_nickname || `User #${Number(row.owner_id)}` } : null,
      region_name: typeof gameState?.region_name === 'string' ? gameState.region_name : null,
      size_label: typeof gameState?.size_label === 'string' ? gameState.size_label : null,
      generator: typeof gameState?.generator === 'string' ? gameState.generator : null,
      updated_at: row.room_updated_at || null,
    };
  });
  enriched.sort((a, b) => Number(b.player_count || 0) - Number(a.player_count || 0));
  return enriched;
}

async function listPrivateHouses(query = '', limit = 60) {
  ensureDbEnabled();
  const { getRoomRuntimeEntry } = require('../rooms');
  const q = String(query || '').trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(200, Math.round(Number(limit || 60))));
  const where = ['m.is_active = 1'];
  const args = [];
  if (q) {
    where.push('(LOWER(m.name) LIKE ? OR LOWER(m.slug) LIKE ? OR LOWER(owner.nickname) LIKE ?)');
    const eq = escapeLike(q);
    args.push(`%${eq}%`, `%${eq}%`, `%${eq}%`);
  }
  args.push(safeLimit);
  const [rows] = await dbPool.query(
    `SELECT m.id, m.name, m.slug, m.canton_code, m.canton_name,
            COALESCE(r.room_code, 'MAIN') AS room_code,
            COALESCE(r.city_name, m.name) AS room_name,
            COALESCE(r.player_count, 0) AS player_count, r.updated_at AS room_updated_at,
            owner.id AS owner_id, owner.nickname AS owner_nickname
     FROM municipalities m
     INNER JOIN game_rooms r ON r.municipality_id = m.id AND r.is_active = 1 AND r.room_code NOT LIKE 'PUB%'
     LEFT JOIN users owner ON owner.id = (SELECT MIN(u2.id) FROM users u2 WHERE u2.municipality_id = m.id AND u2.is_active = 1)
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(r.player_count, 0) DESC, m.name ASC LIMIT ?`,
    args
  );
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const runtimeEntry = getRoomRuntimeEntry(Number(row.id), String(row.room_code || 'MAIN'), false);
    const livePlayerCount = runtimeEntry ? Math.max(0, Number(runtimeEntry.activePlayers || 0)) : 0;
    return {
      municipality_id: Number(row.id), municipality_name: String(row.name || ''),
      municipality_slug: String(row.slug || ''), canton_code: row.canton_code || null, canton_name: row.canton_name || null,
      room_code: String(row.room_code || 'MAIN'), room_name: String(row.room_name || row.name || ''),
      player_count: Math.max(livePlayerCount, Number(row.player_count || 0)),
      owner: row.owner_id ? { id: Number(row.owner_id), nickname: row.owner_nickname || `User #${Number(row.owner_id)}` } : null,
      updated_at: row.room_updated_at || null,
    };
  });
}

// ── Core Lookup ───────────────────────────────────────────────────

async function getMunicipalityById(id) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(`SELECT id, name, slug, canton_code, canton_name FROM municipalities WHERE id = ? AND is_active = 1 LIMIT 1`, [id]);
  return rows[0] || null;
}

async function getMunicipalityBySlug(slug) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT id, name, slug, canton_code, canton_name, bfs_number,
            population, area_km2, elevation_m, postal_code, district
     FROM municipalities WHERE slug = ? AND is_active = 1 LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

async function getMunicipalityOwner(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(`SELECT id, nickname FROM users WHERE municipality_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`, [municipalityId]);
  return rows[0] || null;
}

// Schema wird über sql/043_consolidate_inline_schema.sql verwaltet
async function ensureMunicipalityIsUserCreatedColumn() {}
async function ensureMunicipalityRoleTables() {}

// ── Membership Sync ───────────────────────────────────────────────

async function syncMunicipalityMemberships(municipalityId) {
  ensureDbEnabled();
  await ensureMunicipalityRoleTables();
  const [activeUsers] = await dbPool.query(`SELECT id FROM users WHERE municipality_id = ? AND is_active = 1 ORDER BY id ASC`, [municipalityId]);
  const activeRows = Array.isArray(activeUsers) ? activeUsers : [];
  if (activeRows.length <= 0) {
    await dbPool.query(`DELETE FROM municipality_memberships WHERE municipality_id = ?`, [municipalityId]);
    return;
  }

  const [existingOwnerRows] = await dbPool.query(
    `SELECT mm.user_id FROM municipality_memberships mm
     INNER JOIN users u ON u.id = mm.user_id
     WHERE mm.municipality_id = ? AND mm.role = 'owner' AND u.is_active = 1 AND u.municipality_id = ? LIMIT 1`,
    [municipalityId, municipalityId]
  );
  const ownerUserId = existingOwnerRows.length > 0 ? Number(existingOwnerRows[0].user_id) : Number(activeRows[0].id);

  const values = [], params = [];
  for (const row of activeRows) {
    const userId = Number(row.id);
    if (!Number.isInteger(userId) || userId <= 0) continue;
    values.push('(?, ?, ?)');
    params.push(Number(municipalityId), userId, userId === ownerUserId ? MUNICIPALITY_ROLE_OWNER : MUNICIPALITY_ROLE_CITIZEN);
  }
  if (values.length > 0) {
    await dbPool.query(`INSERT INTO municipality_memberships (municipality_id, user_id, role) VALUES ${values.join(', ')} ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`, params);
  }

  await dbPool.query(`UPDATE municipality_memberships SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE municipality_id = ? AND user_id = ?`, [MUNICIPALITY_ROLE_OWNER, municipalityId, ownerUserId]);
  await dbPool.query(`UPDATE municipality_memberships SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE municipality_id = ? AND user_id <> ? AND role = ?`, [MUNICIPALITY_ROLE_CITIZEN, municipalityId, ownerUserId, MUNICIPALITY_ROLE_OWNER]);
  await dbPool.query(
    `DELETE mm FROM municipality_memberships mm LEFT JOIN users u ON u.id = mm.user_id
     WHERE mm.municipality_id = ? AND (u.id IS NULL OR u.is_active <> 1 OR u.municipality_id <> ?)`,
    [municipalityId, municipalityId]
  );
}

async function promoteToOwner(municipalityId, userId) {
  ensureDbEnabled();
  await dbPool.query(`UPDATE municipality_memberships SET role = 'citizen', updated_at = CURRENT_TIMESTAMP WHERE municipality_id = ? AND role = 'owner'`, [municipalityId]);
  await dbPool.query(`UPDATE municipality_memberships SET role = 'owner', updated_at = CURRENT_TIMESTAMP WHERE municipality_id = ? AND user_id = ?`, [municipalityId, userId]);
}

async function touchMunicipalityActivity(municipalityId, userId) {
  if (!municipalityId || !userId) return;
  try {
    await dbPool.query(`UPDATE municipality_memberships SET last_municipality_activity_at = NOW() WHERE municipality_id = ? AND user_id = ?`, [municipalityId, userId]);
  } catch (_) {}
}

const OWNER_INACTIVITY_DAYS = 14;

async function checkAndSucceedInactiveMunicipalityOwners() {
  ensureDbEnabled();
  const [inactiveMunis] = await dbPool.query(
    `SELECT mm.municipality_id, mm.user_id AS owner_id FROM municipality_memberships mm
     WHERE mm.role = 'owner' AND (mm.last_municipality_activity_at IS NULL OR mm.last_municipality_activity_at < DATE_SUB(NOW(), INTERVAL ? DAY))`,
    [OWNER_INACTIVITY_DAYS]
  );

  for (const { municipality_id, owner_id } of inactiveMunis) {
    const [activeElections] = await dbPool.query(
      `SELECT id FROM municipality_elections WHERE municipality_id = ? AND status IN ('candidates','voting') LIMIT 1`,
      [municipality_id]
    );
    if (activeElections.length > 0) continue;

    const [candidates] = await dbPool.query(
      `SELECT mm.user_id, mm.role FROM municipality_memberships mm
       WHERE mm.municipality_id = ? AND mm.user_id <> ? AND mm.role IN ('council','citizen')
         AND mm.last_municipality_activity_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       ORDER BY CASE mm.role WHEN 'council' THEN 0 ELSE 1 END ASC, mm.created_at ASC LIMIT 1`,
      [municipality_id, owner_id, OWNER_INACTIVITY_DAYS]
    );
    if (candidates.length > 0) await promoteToOwner(municipality_id, candidates[0].user_id);
  }
}

// ── Administration ────────────────────────────────────────────────

async function getMunicipalityAdministration(municipalityId) {
  ensureDbEnabled();
  await syncMunicipalityMemberships(municipalityId);
  const [rows] = await dbPool.query(
    `SELECT mm.user_id, mm.role, u.nickname
     FROM municipality_memberships mm
     INNER JOIN users u ON u.id = mm.user_id
     WHERE mm.municipality_id = ? AND u.is_active = 1 AND u.municipality_id = ?
     ORDER BY CASE mm.role WHEN 'owner' THEN 0 WHEN 'council' THEN 1 WHEN 'citizen' THEN 2 WHEN 'observer' THEN 3 ELSE 4 END, u.id ASC`,
    [municipalityId, municipalityId]
  );
  const list = Array.isArray(rows) ? rows : [];
  const owner = list.find(r => normalizeMunicipalityRole(r.role) === MUNICIPALITY_ROLE_OWNER) || null;
  const administrators = list.filter(r => normalizeMunicipalityRole(r.role) === MUNICIPALITY_ROLE_COUNCIL).map(r => ({ id: Number(r.user_id), nickname: r.nickname, role: MUNICIPALITY_ROLE_COUNCIL }));
  const citizens = list.filter(r => normalizeMunicipalityRole(r.role) === MUNICIPALITY_ROLE_CITIZEN).map(r => ({ id: Number(r.user_id), nickname: r.nickname, role: MUNICIPALITY_ROLE_CITIZEN }));
  const observers = list.filter(r => normalizeMunicipalityRole(r.role) === MUNICIPALITY_ROLE_OBSERVER).map(r => ({ id: Number(r.user_id), nickname: r.nickname, role: MUNICIPALITY_ROLE_OBSERVER }));
  return { owner: owner ? { id: Number(owner.user_id), nickname: owner.nickname, role: MUNICIPALITY_ROLE_OWNER } : null, administrators, citizens, observers, member_count: list.length, administrator_count: administrators.length, member_limit: MUNICIPALITY_MEMBER_LIMIT, slots_remaining: Math.max(0, MUNICIPALITY_MEMBER_LIMIT - list.length) };
}

async function getUserMunicipalityRole(userId, municipalityId) {
  ensureDbEnabled();
  if (!Number.isInteger(Number(userId)) || !Number.isInteger(Number(municipalityId))) return MUNICIPALITY_ROLE_OBSERVER;
  try {
    await syncMunicipalityMemberships(Number(municipalityId));
    const [rows] = await dbPool.query(`SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ? LIMIT 1`, [Number(municipalityId), Number(userId)]);
    if (!Array.isArray(rows) || rows.length <= 0) return MUNICIPALITY_ROLE_OBSERVER;
    return normalizeMunicipalityRole(rows[0].role);
  } catch (_) {
    return MUNICIPALITY_ROLE_OBSERVER;
  }
}

async function getMunicipalityRoleMap(municipalityId) {
  ensureDbEnabled();
  try {
    await syncMunicipalityMemberships(municipalityId);
    const [rows] = await dbPool.query(`SELECT user_id, role FROM municipality_memberships WHERE municipality_id = ?`, [municipalityId]);
    const roleByUserId = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const userId = Number(row.user_id);
      if (!Number.isInteger(userId) || userId <= 0) continue;
      roleByUserId.set(userId, normalizeMunicipalityRole(row.role));
    }
    return roleByUserId;
  } catch (_) {
    return new Map();
  }
}

module.exports = {
  fetchMunicipalities, fetchCantonMunicipalities, searchMunicipalitiesForPartnerships,
  listPublicNavigatorMaps, listPrivateHouses,
  getMunicipalityById, getMunicipalityBySlug, getMunicipalityOwner,
  ensureMunicipalityIsUserCreatedColumn, ensureMunicipalityRoleTables,
  syncMunicipalityMemberships, promoteToOwner, touchMunicipalityActivity,
  checkAndSucceedInactiveMunicipalityOwners,
  getMunicipalityAdministration, getUserMunicipalityRole, getMunicipalityRoleMap,
};
