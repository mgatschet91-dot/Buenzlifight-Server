'use strict';

const fs = require('fs');
const path = require('path');

const { dbPool, ensureDbEnabled } = require('../infra/db');
const {
  MUNICIPALITY_ROLE_OWNER,
  MUNICIPALITY_ROLE_COUNCIL,
  MUNICIPALITY_ROLE_CITIZEN,
  MUNICIPALITY_ROLE_OBSERVER,
  MUNICIPALITY_MEMBER_LIMIT,
  COAT_OF_ARMS_UPLOAD_DIR,
  MINIMAP_UPLOAD_DIR,
  MAX_COAT_OF_ARMS_PNG_BYTES,
  MAX_MINIMAP_PNG_BYTES,
} = require('../config/constants');
const { normalizeMunicipalityRole } = require('../auth/permissions');
const {
  toJsonValue,
  normalizeInventoryItemCode,
  normalizeInventoryQuantity,
  escapeLike,
} = require('../shared/helpers');

// ─── Fetch / list municipalities ─────────────────────────────────────────────

async function fetchMunicipalities() {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT m.id, m.name, m.slug, m.canton_code, m.canton_name,
            m.updated_at, COALESCE(mc.cnt, 0) AS members_count
     FROM municipalities m
     LEFT JOIN (
       SELECT municipality_id, COUNT(*) AS cnt
       FROM users
       WHERE is_active = 1
       GROUP BY municipality_id
     ) mc ON mc.municipality_id = m.id
     WHERE m.is_active = 1
       AND (m.is_user_created = 0 OR m.is_user_created IS NULL)
     ORDER BY m.canton_code ASC, m.name ASC`
  );
  return Array.isArray(rows) ? rows : [];
}

async function fetchCantonMunicipalities(cantonCode) {
  ensureDbEnabled();
  const code = String(cantonCode || '').toUpperCase().trim();
  const [rows] = await dbPool.query(
    `SELECT id, name, slug, canton_code, canton_name
     FROM municipalities
     WHERE is_active = 1 AND canton_code = ?
     ORDER BY name ASC`,
    [code]
  );
  return Array.isArray(rows) ? rows : [];
}

async function searchMunicipalitiesForPartnerships(query = '', limit = 500) {
  ensureDbEnabled();
  const q = String(query || '').trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(2000, Math.round(Number(limit || 500))));
  const where = [
    'm.is_active = 1',
    'ms.population >= 100',
    'ms.jobs > 0',
  ];
  const args = [];
  if (q) {
    where.push('(LOWER(m.name) LIKE ? OR LOWER(m.slug) LIKE ?)');
    const eq = escapeLike(q);
    args.push(`%${eq}%`, `%${eq}%`);
  }
  args.push(safeLimit);
  const [rows] = await dbPool.query(
    `SELECT
      m.id,
      m.name,
      m.slug,
      m.canton_code,
      m.canton_name,
      ms.population AS member_count,
      ms.jobs,
      owner.id AS owner_id,
      owner.nickname AS owner_nickname
     FROM municipalities m
     INNER JOIN municipality_stats ms ON ms.municipality_id = m.id
     LEFT JOIN users owner ON owner.id = (
       SELECT MIN(u2.id)
       FROM users u2
       WHERE u2.municipality_id = m.id AND u2.is_active = 1
     )
     WHERE ${where.join(' AND ')}
     ORDER BY m.canton_code ASC, m.name ASC
     LIMIT ?`,
    args
  );
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    bfs_number: '',
    is_capital: false,
    population: Number(row.member_count || 0),
    coordinates: { lat: 47.0, lng: 8.0 },
    level: 1,
    canton: row.canton_code || null,
    owner: row.owner_id
      ? { id: Number(row.owner_id), nickname: row.owner_nickname || `User #${Number(row.owner_id)}` }
      : null,
  }));
}

async function listPublicNavigatorMaps(query = '', limit = 60) {
  ensureDbEnabled();
  const { getRoomRuntimeEntry } = require('./rooms');
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
    `SELECT
      m.id,
      m.name,
      m.slug,
      m.canton_code,
      m.canton_name,
      COALESCE(r.room_code, 'MAIN') AS room_code,
      COALESCE(r.city_name, m.name) AS room_name,
      COALESCE(r.player_count, 0) AS player_count,
      r.game_state AS room_game_state,
      r.updated_at AS room_updated_at,
      owner.id AS owner_id,
      owner.nickname AS owner_nickname
     FROM municipalities m
     INNER JOIN game_rooms r
       ON r.municipality_id = m.id
      AND r.is_active = 1
      AND r.room_code LIKE 'PUB%'
     LEFT JOIN users owner ON owner.id = (
       SELECT MIN(u2.id)
       FROM users u2
       WHERE u2.municipality_id = m.id AND u2.is_active = 1
     )
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(r.player_count, 0) DESC, m.name ASC
     LIMIT ?`,
    args
  );

  const list = Array.isArray(rows) ? rows : [];
  const enriched = list.map((row) => {
    const gameState = toJsonValue(row.room_game_state);
    const runtimeEntry = getRoomRuntimeEntry(Number(row.id), String(row.room_code || 'MAIN'), false);
    const livePlayerCount = runtimeEntry ? Math.max(0, Number(runtimeEntry.activePlayers || 0)) : 0;
    const effectivePlayerCount = Math.max(livePlayerCount, Number(row.player_count || 0));
    return {
      municipality_id: Number(row.id),
      municipality_name: String(row.name || ''),
      municipality_slug: String(row.slug || ''),
      canton_code: row.canton_code || null,
      canton_name: row.canton_name || null,
      room_code: String(row.room_code || 'MAIN'),
      room_name: String(row.room_name || row.name || 'Public Room'),
      player_count: Math.max(0, effectivePlayerCount),
      owner: row.owner_id
        ? { id: Number(row.owner_id), nickname: row.owner_nickname || `User #${Number(row.owner_id)}` }
        : null,
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
  const { getRoomRuntimeEntry } = require('./rooms');
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
    `SELECT
      m.id,
      m.name,
      m.slug,
      m.canton_code,
      m.canton_name,
      COALESCE(r.room_code, 'MAIN') AS room_code,
      COALESCE(r.city_name, m.name) AS room_name,
      COALESCE(r.player_count, 0) AS player_count,
      r.updated_at AS room_updated_at,
      owner.id AS owner_id,
      owner.nickname AS owner_nickname
     FROM municipalities m
     INNER JOIN game_rooms r
       ON r.municipality_id = m.id
      AND r.is_active = 1
      AND r.room_code NOT LIKE 'PUB%'
     LEFT JOIN users owner ON owner.id = (
       SELECT MIN(u2.id)
       FROM users u2
       WHERE u2.municipality_id = m.id AND u2.is_active = 1
     )
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(r.player_count, 0) DESC, m.name ASC
     LIMIT ?`,
    args
  );

  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const runtimeEntry = getRoomRuntimeEntry(Number(row.id), 'MAIN', false);
    const livePlayerCount = runtimeEntry ? Math.max(0, Number(runtimeEntry.activePlayers || 0)) : 0;
    const effectivePlayerCount = Math.max(livePlayerCount, Number(row.player_count || 0));
    return {
      municipality_id: Number(row.id),
      municipality_name: String(row.name || ''),
      municipality_slug: String(row.slug || ''),
      canton_code: row.canton_code || null,
      canton_name: row.canton_name || null,
      room_code: String(row.room_code || ''),
      room_name: String(row.room_name || row.name || ''),
      player_count: Math.max(0, effectivePlayerCount),
      owner: row.owner_id
        ? { id: Number(row.owner_id), nickname: row.owner_nickname || `User #${Number(row.owner_id)}` }
        : null,
      updated_at: row.room_updated_at || null,
    };
  });
}

async function getMunicipalityById(id) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT id, name, slug, canton_code, canton_name
     FROM municipalities
     WHERE id = ? AND is_active = 1
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function getMunicipalityBySlug(slug) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT id, name, slug, canton_code, canton_name, bfs_number,
            population, area_km2, elevation_m, postal_code, district
     FROM municipalities
     WHERE slug = ? AND is_active = 1
     LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

async function getMunicipalityOwner(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT id, nickname
     FROM users
     WHERE municipality_id = ? AND is_active = 1
     ORDER BY id ASC
     LIMIT 1`,
    [municipalityId]
  );
  return rows[0] || null;
}

// Schema wird über sql/043_consolidate_inline_schema.sql verwaltet
async function ensureMunicipalityIsUserCreatedColumn() {}
async function ensureMunicipalityRoleTables() {}

async function syncMunicipalityMemberships(municipalityId) {
  ensureDbEnabled();
  await ensureMunicipalityRoleTables();
  const [activeUsers] = await dbPool.query(
    `SELECT id
     FROM users
     WHERE municipality_id = ? AND is_active = 1
     ORDER BY id ASC`,
    [municipalityId]
  );
  const activeRows = Array.isArray(activeUsers) ? activeUsers : [];
  if (activeRows.length <= 0) {
    await dbPool.query(`DELETE FROM municipality_memberships WHERE municipality_id = ?`, [municipalityId]);
    return;
  }

  // Respect existing owner — only fall back to lowest-id if no owner row exists
  const [existingOwnerRows] = await dbPool.query(
    `SELECT mm.user_id FROM municipality_memberships mm
     INNER JOIN users u ON u.id = mm.user_id
     WHERE mm.municipality_id = ? AND mm.role = 'owner'
       AND u.is_active = 1 AND u.municipality_id = ?
     LIMIT 1`,
    [municipalityId, municipalityId]
  );
  const ownerUserId = existingOwnerRows.length > 0
    ? Number(existingOwnerRows[0].user_id)
    : Number(activeRows[0].id);

  const values = [];
  const params = [];
  for (const row of activeRows) {
    const userId = Number(row.id);
    if (!Number.isInteger(userId) || userId <= 0) continue;
    values.push('(?, ?, ?)');
    params.push(
      Number(municipalityId),
      userId,
      userId === ownerUserId ? MUNICIPALITY_ROLE_OWNER : MUNICIPALITY_ROLE_CITIZEN
    );
  }
  if (values.length > 0) {
    // ON DUPLICATE KEY: nur updated_at → bestehende Rollen (council etc.) bleiben erhalten
    await dbPool.query(
      `INSERT INTO municipality_memberships (municipality_id, user_id, role)
       VALUES ${values.join(', ')}
       ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
      params
    );
  }

  // Genau einen Owner sicherstellen
  await dbPool.query(
    `UPDATE municipality_memberships SET role = ?, updated_at = CURRENT_TIMESTAMP
     WHERE municipality_id = ? AND user_id = ?`,
    [MUNICIPALITY_ROLE_OWNER, municipalityId, ownerUserId]
  );
  // Weitere Owner-Einträge (sollte nicht passieren) auf citizen zurücksetzen
  await dbPool.query(
    `UPDATE municipality_memberships SET role = ?, updated_at = CURRENT_TIMESTAMP
     WHERE municipality_id = ? AND user_id <> ? AND role = ?`,
    [MUNICIPALITY_ROLE_CITIZEN, municipalityId, ownerUserId, MUNICIPALITY_ROLE_OWNER]
  );

  // Veraltete Memberships entfernen (User hat Gemeinde gewechselt oder ist deaktiviert)
  await dbPool.query(
    `DELETE mm FROM municipality_memberships mm
     LEFT JOIN users u ON u.id = mm.user_id
     WHERE mm.municipality_id = ?
       AND (u.id IS NULL OR u.is_active <> 1 OR u.municipality_id <> ?)`,
    [municipalityId, municipalityId]
  );
}

// Setzt einen User als neuen Bürgermeister (alten Owner → citizen)
async function promoteToOwner(municipalityId, userId) {
  ensureDbEnabled();
  await dbPool.query(
    `UPDATE municipality_memberships SET role = 'citizen', updated_at = CURRENT_TIMESTAMP
     WHERE municipality_id = ? AND role = 'owner'`,
    [municipalityId]
  );
  await dbPool.query(
    `UPDATE municipality_memberships SET role = 'owner', updated_at = CURRENT_TIMESTAMP
     WHERE municipality_id = ? AND user_id = ?`,
    [municipalityId, userId]
  );
}

// Aktualisiert den Aktivitäts-Timestamp eines Members (beim Room-Betreten, Bauen, Chatten)
async function touchMunicipalityActivity(municipalityId, userId) {
  if (!municipalityId || !userId) return;
  try {
    await dbPool.query(
      `UPDATE municipality_memberships
       SET last_municipality_activity_at = NOW()
       WHERE municipality_id = ? AND user_id = ?`,
      [municipalityId, userId]
    );
  } catch (_) {}
}

const OWNER_INACTIVITY_DAYS = 14;

// Wird vom 6h-Job aufgerufen: prüft alle Gemeinden auf inaktive Bürgermeister
async function checkAndSucceedInactiveMunicipalityOwners() {
  ensureDbEnabled();
  const [inactiveMunis] = await dbPool.query(
    `SELECT mm.municipality_id, mm.user_id AS owner_id
     FROM municipality_memberships mm
     WHERE mm.role = 'owner'
       AND (
         mm.last_municipality_activity_at IS NULL
         OR mm.last_municipality_activity_at < DATE_SUB(NOW(), INTERVAL ? DAY)
       )`,
    [OWNER_INACTIVITY_DAYS]
  );

  for (const { municipality_id, owner_id } of inactiveMunis) {
    // Gibt es eine laufende Wahl? → nicht nochmal Nachfolge auslösen
    const [activeElections] = await dbPool.query(
      `SELECT id FROM municipality_elections
       WHERE municipality_id = ? AND status IN ('candidates','voting')
       LIMIT 1`,
      [municipality_id]
    );
    if (activeElections.length > 0) continue;

    // Nächsten aktiven Member suchen: Rat zuerst, dann Bürger, älteste Mitgliedschaft zuerst
    const [candidates] = await dbPool.query(
      `SELECT mm.user_id, mm.role
       FROM municipality_memberships mm
       WHERE mm.municipality_id = ?
         AND mm.user_id <> ?
         AND mm.role IN ('council','citizen')
         AND mm.last_municipality_activity_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       ORDER BY
         CASE mm.role WHEN 'council' THEN 0 ELSE 1 END ASC,
         mm.created_at ASC
       LIMIT 1`,
      [municipality_id, owner_id, OWNER_INACTIVITY_DAYS]
    );

    if (candidates.length > 0) {
      await promoteToOwner(municipality_id, candidates[0].user_id);
    }
    // Keine aktiven Members → nichts tun; nächster Beitretende wird Owner via Invite-Route
  }
}

// ─── Election System ──────────────────────────────────────────────────────────

async function getActiveElection(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT e.*,
       (SELECT COUNT(*) FROM election_candidates c WHERE c.election_id = e.id AND c.withdrawn_at IS NULL) AS candidate_count,
       (SELECT COUNT(*) FROM election_votes v WHERE v.election_id = e.id) AS vote_count
     FROM municipality_elections e
     WHERE e.municipality_id = ? AND e.status IN ('candidates','voting')
     ORDER BY e.started_at DESC
     LIMIT 1`,
    [municipalityId]
  );
  return rows[0] || null;
}

async function getElectionDetails(electionId, municipalityId) {
  ensureDbEnabled();
  const [elRows] = await dbPool.query(
    `SELECT * FROM municipality_elections WHERE id = ? AND municipality_id = ? LIMIT 1`,
    [electionId, municipalityId]
  );
  if (!elRows[0]) return null;
  const election = elRows[0];

  const [candidates] = await dbPool.query(
    `SELECT ec.user_id, ec.registered_at, ec.withdrawn_at, u.nickname,
       (SELECT COUNT(*) FROM election_votes ev WHERE ev.election_id = ? AND ev.candidate_id = ec.user_id) AS votes
     FROM election_candidates ec
     JOIN users u ON u.id = ec.user_id
     WHERE ec.election_id = ?
     ORDER BY ec.registered_at ASC`,
    [electionId, electionId]
  );

  return { election, candidates: Array.isArray(candidates) ? candidates : [] };
}

// Öffnet eine neue Wahl für eine Gemeinde
async function openElection(municipalityId, triggeredBy = 'inactivity') {
  ensureDbEnabled();

  // Cooldown: 14 Tage nach letzter Wahl
  const [muni] = await dbPool.query(
    `SELECT last_election_ended_at FROM municipalities WHERE id = ? LIMIT 1`,
    [municipalityId]
  );
  if (muni[0]?.last_election_ended_at) {
    const daysSince = (Date.now() - new Date(muni[0].last_election_ended_at).getTime()) / 86400000;
    if (daysSince < 14 && triggeredBy !== 'admin') {
      throw new Error('ELECTION_COOLDOWN');
    }
  }

  // Bereits laufende Wahl?
  const existing = await getActiveElection(municipalityId);
  if (existing) throw new Error('ELECTION_ALREADY_ACTIVE');

  const candidatesUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // +3 Tage
  const votingUntil    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // +7 Tage

  const [result] = await dbPool.query(
    `INSERT INTO municipality_elections
       (municipality_id, status, triggered_by, candidates_until, voting_until)
     VALUES (?, 'candidates', ?, ?, ?)`,
    [municipalityId, triggeredBy, candidatesUntil, votingUntil]
  );
  return result.insertId;
}

// User kandidiert für die laufende Wahl
async function registerCandidate(electionId, userId, municipalityId) {
  ensureDbEnabled();

  // Mindest-Mitgliedschaft: 7 Tage
  const [memRows] = await dbPool.query(
    `SELECT created_at, candidate_withdrawn FROM municipality_memberships
     WHERE municipality_id = ? AND user_id = ? LIMIT 1`,
    [municipalityId, userId]
  );
  if (!memRows[0]) throw new Error('NOT_A_MEMBER');
  const joinedDaysAgo = (Date.now() - new Date(memRows[0].created_at).getTime()) / 86400000;
  if (joinedDaysAgo < 7) throw new Error('TOO_NEW'); // mind. 7 Tage Mitglied

  // Bereits zurückgezogen in dieser Wahl?
  const [existing] = await dbPool.query(
    `SELECT id, withdrawn_at FROM election_candidates WHERE election_id = ? AND user_id = ? LIMIT 1`,
    [electionId, userId]
  );
  if (existing[0]) {
    if (existing[0].withdrawn_at) throw new Error('ALREADY_WITHDRAWN');
    throw new Error('ALREADY_CANDIDATE');
  }

  // Max 10 Kandidaten
  const [countRows] = await dbPool.query(
    `SELECT COUNT(*) AS cnt FROM election_candidates WHERE election_id = ? AND withdrawn_at IS NULL`,
    [electionId]
  );
  if (Number(countRows[0].cnt) >= 10) throw new Error('MAX_CANDIDATES');

  await dbPool.query(
    `INSERT INTO election_candidates (election_id, user_id) VALUES (?, ?)`,
    [electionId, userId]
  );
}

// Kandidatur zurückziehen (nur 1x möglich)
async function withdrawCandidacy(electionId, userId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT id, withdrawn_at FROM election_candidates WHERE election_id = ? AND user_id = ? LIMIT 1`,
    [electionId, userId]
  );
  if (!rows[0]) throw new Error('NOT_A_CANDIDATE');
  if (rows[0].withdrawn_at) throw new Error('ALREADY_WITHDRAWN');

  await dbPool.query(
    `UPDATE election_candidates SET withdrawn_at = NOW() WHERE id = ?`,
    [rows[0].id]
  );
}

// Stimme abgeben
async function castVote(electionId, voterId, candidateUserId, municipalityId) {
  ensureDbEnabled();

  // Mindest-Mitgliedschaft zum Wählen: 3 Tage
  const [memRows] = await dbPool.query(
    `SELECT created_at FROM municipality_memberships
     WHERE municipality_id = ? AND user_id = ? LIMIT 1`,
    [municipalityId, voterId]
  );
  if (!memRows[0]) throw new Error('NOT_A_MEMBER');
  const joinedDaysAgo = (Date.now() - new Date(memRows[0].created_at).getTime()) / 86400000;
  if (joinedDaysAgo < 3) throw new Error('TOO_NEW');

  // Kandidat muss aktiv und nicht zurückgezogen sein
  const [candRows] = await dbPool.query(
    `SELECT id FROM election_candidates
     WHERE election_id = ? AND user_id = ? AND withdrawn_at IS NULL LIMIT 1`,
    [electionId, candidateUserId]
  );
  if (!candRows[0]) throw new Error('INVALID_CANDIDATE');

  // 1 Stimme pro User (UNIQUE constraint wirft Fehler bei Duplikat)
  try {
    await dbPool.query(
      `INSERT INTO election_votes (election_id, voter_id, candidate_id) VALUES (?, ?, ?)`,
      [electionId, voterId, candidateUserId]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new Error('ALREADY_VOTED');
    throw err;
  }
}

// Prüft Phasen aller laufenden Wahlen und wertet aus (vom 60s-Job aufgerufen)
async function resolveElectionPhases() {
  ensureDbEnabled();

  // candidates → voting (Kandidaturphase abgelaufen)
  await dbPool.query(
    `UPDATE municipality_elections
     SET status = 'voting'
     WHERE status = 'candidates' AND candidates_until <= NOW()`
  );

  // voting → auswerten (Abstimmungsphase abgelaufen)
  const [toClose] = await dbPool.query(
    `SELECT * FROM municipality_elections WHERE status = 'voting' AND voting_until <= NOW()`
  );

  for (const election of toClose) {
    // Kandidat mit den meisten Stimmen; Gleichstand → ältestes Mitglied
    const [winners] = await dbPool.query(
      `SELECT ec.user_id, COUNT(ev.id) AS votes, mm.created_at AS joined_at
       FROM election_candidates ec
       LEFT JOIN election_votes ev ON ev.election_id = ec.election_id AND ev.candidate_id = ec.user_id
       LEFT JOIN municipality_memberships mm ON mm.municipality_id = ? AND mm.user_id = ec.user_id
       WHERE ec.election_id = ? AND ec.withdrawn_at IS NULL
       GROUP BY ec.user_id
       ORDER BY votes DESC, joined_at ASC
       LIMIT 1`,
      [election.municipality_id, election.id]
    );

    if (winners.length > 0) {
      const winner = winners[0];
      await promoteToOwner(election.municipality_id, winner.user_id);
      await dbPool.query(
        `UPDATE municipality_elections
         SET status = 'closed', winner_user_id = ?, closed_at = NOW()
         WHERE id = ?`,
        [winner.user_id, election.id]
      );
    } else {
      // Keine Kandidaten → Wahl abbrechen
      await dbPool.query(
        `UPDATE municipality_elections SET status = 'cancelled', closed_at = NOW() WHERE id = ?`,
        [election.id]
      );
    }

    // Cooldown-Timestamp in der Gemeinde setzen
    await dbPool.query(
      `UPDATE municipalities SET last_election_ended_at = NOW() WHERE id = ?`,
      [election.municipality_id]
    );
  }
}

// Misstrauensvotum: Rat ruft Abstimmung gegen BM aus
async function openNoConfidenceVote(municipalityId, requestedByUserId) {
  ensureDbEnabled();

  // Anti-Spam: derselbe Rat max 1x pro 30 Tage
  const [memRows] = await dbPool.query(
    `SELECT council_election_requested_at FROM municipality_memberships
     WHERE municipality_id = ? AND user_id = ? LIMIT 1`,
    [municipalityId, requestedByUserId]
  );
  if (memRows[0]?.council_election_requested_at) {
    const daysSince = (Date.now() - new Date(memRows[0].council_election_requested_at).getTime()) / 86400000;
    if (daysSince < 30) throw new Error('REQUEST_COOLDOWN');
  }

  // Bereits offenes Misstrauensvotum?
  const [existing] = await dbPool.query(
    `SELECT id FROM municipality_no_confidence WHERE municipality_id = ? AND status = 'open' LIMIT 1`,
    [municipalityId]
  );
  if (existing.length > 0) throw new Error('ALREADY_OPEN');

  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h
  const [result] = await dbPool.query(
    `INSERT INTO municipality_no_confidence (municipality_id, requested_by, expires_at)
     VALUES (?, ?, ?)`,
    [municipalityId, requestedByUserId, expiresAt]
  );

  await dbPool.query(
    `UPDATE municipality_memberships SET council_election_requested_at = NOW()
     WHERE municipality_id = ? AND user_id = ?`,
    [municipalityId, requestedByUserId]
  );

  return result.insertId;
}

// Rat stimmt beim Misstrauensvotum zu
async function voteNoConfidence(noConfidenceId, voterUserId, municipalityId) {
  ensureDbEnabled();
  try {
    await dbPool.query(
      `INSERT INTO municipality_no_confidence_votes (no_confidence_id, voter_id) VALUES (?, ?)`,
      [noConfidenceId, voterUserId]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new Error('ALREADY_VOTED');
    throw err;
  }

  // Prüfen ob 2/3 Mehrheit der aktiven Räte erreicht
  const [councilRows] = await dbPool.query(
    `SELECT COUNT(*) AS cnt FROM municipality_memberships
     WHERE municipality_id = ? AND role = 'council'
       AND last_municipality_activity_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)`,
    [municipalityId]
  );
  const totalCouncil = Number(councilRows[0].cnt);
  const [voteRows] = await dbPool.query(
    `SELECT COUNT(*) AS cnt FROM municipality_no_confidence_votes WHERE no_confidence_id = ?`,
    [noConfidenceId]
  );
  const totalVotes = Number(voteRows[0].cnt);

  if (totalCouncil >= 2 && totalVotes >= Math.ceil((totalCouncil * 2) / 3)) {
    // Misstrauensvotum bestanden → BM absetzen, ältesten aktiven Rat befördern oder Wahl starten
    await dbPool.query(
      `UPDATE municipality_no_confidence SET status = 'passed' WHERE id = ?`,
      [noConfidenceId]
    );
    const [nextOwner] = await dbPool.query(
      `SELECT user_id FROM municipality_memberships
       WHERE municipality_id = ? AND role = 'council'
         AND last_municipality_activity_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
       ORDER BY created_at ASC LIMIT 1`,
      [municipalityId]
    );
    if (nextOwner.length > 0) {
      await promoteToOwner(municipalityId, nextOwner[0].user_id);
    } else {
      await openElection(municipalityId, 'council_vote').catch(() => {});
    }
    return 'passed';
  }
  return 'pending';
}

// Ablauf prüfen für Misstrauensvoten (vom 60s-Job)
async function resolveExpiredNoConfidenceVotes() {
  ensureDbEnabled();
  await dbPool.query(
    `UPDATE municipality_no_confidence SET status = 'expired'
     WHERE status = 'open' AND expires_at <= NOW()`
  );
}

async function getMunicipalityAdministration(municipalityId) {
  ensureDbEnabled();
  await syncMunicipalityMemberships(municipalityId);
  const [rows] = await dbPool.query(
    `SELECT mm.user_id, mm.role, u.nickname
     FROM municipality_memberships mm
     INNER JOIN users u ON u.id = mm.user_id
     WHERE mm.municipality_id = ?
       AND u.is_active = 1
       AND u.municipality_id = ?
     ORDER BY
       CASE mm.role
         WHEN 'owner' THEN 0
         WHEN 'council' THEN 1
         WHEN 'citizen' THEN 2
         WHEN 'observer' THEN 3
         ELSE 4
       END,
       u.id ASC`,
    [municipalityId, municipalityId]
  );
  const list = Array.isArray(rows) ? rows : [];
  const owner = list.find((r) => normalizeMunicipalityRole(r.role) === MUNICIPALITY_ROLE_OWNER) || null;
  const administrators = list
    .filter((r) => normalizeMunicipalityRole(r.role) === MUNICIPALITY_ROLE_COUNCIL)
    .map((r) => ({ id: Number(r.user_id), nickname: r.nickname, role: MUNICIPALITY_ROLE_COUNCIL }));
  const citizens = list
    .filter((r) => normalizeMunicipalityRole(r.role) === MUNICIPALITY_ROLE_CITIZEN)
    .map((r) => ({ id: Number(r.user_id), nickname: r.nickname, role: MUNICIPALITY_ROLE_CITIZEN }));
  const observers = list
    .filter((r) => normalizeMunicipalityRole(r.role) === MUNICIPALITY_ROLE_OBSERVER)
    .map((r) => ({ id: Number(r.user_id), nickname: r.nickname, role: MUNICIPALITY_ROLE_OBSERVER }));

  return {
    owner: owner ? { id: Number(owner.user_id), nickname: owner.nickname, role: MUNICIPALITY_ROLE_OWNER } : null,
    administrators,
    citizens,
    observers,
    member_count: list.length,
    administrator_count: administrators.length,
    member_limit: MUNICIPALITY_MEMBER_LIMIT,
    slots_remaining: Math.max(0, MUNICIPALITY_MEMBER_LIMIT - list.length),
  };
}

async function getUserMunicipalityRole(userId, municipalityId) {
  ensureDbEnabled();
  if (!Number.isInteger(Number(userId)) || !Number.isInteger(Number(municipalityId))) return MUNICIPALITY_ROLE_OBSERVER;
  try {
    await syncMunicipalityMemberships(Number(municipalityId));
    const [rows] = await dbPool.query(
      `SELECT role
       FROM municipality_memberships
       WHERE municipality_id = ? AND user_id = ?
       LIMIT 1`,
      [Number(municipalityId), Number(userId)]
    );
    if (!Array.isArray(rows) || rows.length <= 0) return MUNICIPALITY_ROLE_OBSERVER;
    return normalizeMunicipalityRole(rows[0].role);
  } catch (err) {
    return MUNICIPALITY_ROLE_OBSERVER;
  }
}

async function getMunicipalityRoleMap(municipalityId) {
  ensureDbEnabled();
  try {
    await syncMunicipalityMemberships(municipalityId);
    const [rows] = await dbPool.query(
      `SELECT user_id, role
       FROM municipality_memberships
       WHERE municipality_id = ?`,
      [municipalityId]
    );
    const roleByUserId = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const userId = Number(row.user_id);
      if (!Number.isInteger(userId) || userId <= 0) continue;
      roleByUserId.set(userId, normalizeMunicipalityRole(row.role));
    }
    return roleByUserId;
  } catch (err) {
    return new Map();
  }
}

// ─── Upload dirs, minimap, coat of arms ─────────────────────────────────────

function ensureCoatOfArmsUploadDir() {
  if (!fs.existsSync(COAT_OF_ARMS_UPLOAD_DIR)) {
    fs.mkdirSync(COAT_OF_ARMS_UPLOAD_DIR, { recursive: true });
  }
}

function ensureMinimapUploadDir() {
  if (!fs.existsSync(MINIMAP_UPLOAD_DIR)) {
    fs.mkdirSync(MINIMAP_UPLOAD_DIR, { recursive: true });
  }
}

async function saveMinimapPng(municipality, pngBuffer) {
  ensureMinimapUploadDir();
  if (!pngBuffer || pngBuffer.length < 8) {
    throw new Error('PNG-Daten fehlen');
  }
  if (pngBuffer.length > MAX_MINIMAP_PNG_BYTES) {
    throw new Error('Minimap-PNG ist zu gross (max 256KB)');
  }
  if (pngBuffer.readUInt32BE(0) !== 0x89504e47 || pngBuffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('Nur gültige PNG-Dateien sind erlaubt');
  }
  const slug = String(municipality.slug || municipality.id).toLowerCase();
  const fileName = `${slug}-minimap.png`;
  const filePath = path.join(MINIMAP_UPLOAD_DIR, fileName);
  fs.writeFileSync(filePath, pngBuffer);
  return { fileName, byteSize: pngBuffer.length };
}

async function ensureMunicipalityCoatOfArmsTable() {}

function buildCoatOfArmsImageUrl(municipalitySlug, updatedAt, requestUrl) {
  const safeSlug = String(municipalitySlug || '').toLowerCase();
  if (!safeSlug) return null;
  const stamp = updatedAt ? new Date(updatedAt).getTime() : Date.now();
  const relative = `/api/game/municipality/${safeSlug}/coat-of-arms/image?v=${Number.isFinite(stamp) ? stamp : Date.now()}`;
  if (requestUrl && requestUrl.origin) return `${requestUrl.origin}${relative}`;
  return relative;
}

async function getMunicipalityCoatOfArmsRecord(municipalityId) {
  ensureDbEnabled();
  await ensureMunicipalityCoatOfArmsTable();
  const [rows] = await dbPool.query(
    `SELECT municipality_id, image_filename, byte_size, created_at, updated_at
     FROM municipality_coat_of_arms
     WHERE municipality_id = ?
     LIMIT 1`,
    [municipalityId]
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function deleteMunicipalityCoatOfArms(municipalityId) {
  ensureDbEnabled();
  await ensureMunicipalityCoatOfArmsTable();
  ensureCoatOfArmsUploadDir();
  const existing = await getMunicipalityCoatOfArmsRecord(municipalityId);
  if (existing?.image_filename) {
    const oldPath = path.join(COAT_OF_ARMS_UPLOAD_DIR, String(existing.image_filename));
    if (fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch {
        // ignore
      }
    }
  }
  await dbPool.query(
    `DELETE FROM municipality_coat_of_arms
     WHERE municipality_id = ?`,
    [municipalityId]
  );
}

async function saveMunicipalityCoatOfArmsPng(municipality, pngBuffer) {
  ensureDbEnabled();
  await ensureMunicipalityCoatOfArmsTable();
  ensureCoatOfArmsUploadDir();
  const municipalityId = Number(municipality?.id || 0);
  if (!Number.isInteger(municipalityId) || municipalityId <= 0) {
    throw new Error('Ungültige municipality_id für Wappen');
  }
  if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length <= 0) {
    throw new Error('PNG-Daten fehlen');
  }
  if (pngBuffer.length > MAX_COAT_OF_ARMS_PNG_BYTES) {
    throw new Error('PNG-Datei ist zu gross (max 512KB)');
  }
  if (pngBuffer.length < 8 || pngBuffer.readUInt32BE(0) !== 0x89504e47 || pngBuffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('Nur gültige PNG-Dateien sind erlaubt');
  }

  const existing = await getMunicipalityCoatOfArmsRecord(municipalityId);
  const fileName = `${String(municipality.slug || municipalityId).toLowerCase()}-${Date.now()}.png`;
  const filePath = path.join(COAT_OF_ARMS_UPLOAD_DIR, fileName);
  fs.writeFileSync(filePath, pngBuffer);

  await dbPool.query(
    `INSERT INTO municipality_coat_of_arms (municipality_id, image_filename, byte_size)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       image_filename = VALUES(image_filename),
       byte_size = VALUES(byte_size),
       updated_at = CURRENT_TIMESTAMP`,
    [municipalityId, fileName, pngBuffer.length]
  );

  if (existing?.image_filename && String(existing.image_filename) !== fileName) {
    const oldPath = path.join(COAT_OF_ARMS_UPLOAD_DIR, String(existing.image_filename));
    if (fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch {
        // ignore
      }
    }
  }

  return getMunicipalityCoatOfArmsRecord(municipalityId);
}

async function resolveMunicipalityCoatOfArmsDto(municipality, requestUrl) {
  const record = await getMunicipalityCoatOfArmsRecord(municipality.id);
  if (!record?.image_filename) {
    return { svg: null, image_url: null };
  }
  return {
    svg: null,
    image_url: buildCoatOfArmsImageUrl(municipality.slug, record.updated_at, requestUrl),
  };
}

// ─── Chat DTO mapper ─────────────────────────────────────────────────────────

function mapChatMessageRowToDto(row, ownerUserId, roleByUserId = null) {
  const userId = Number(row.user_id);
  const mappedRole = roleByUserId instanceof Map ? normalizeMunicipalityRole(roleByUserId.get(userId)) : null;
  const userRole = userId === Number(ownerUserId)
    ? 'owner'
    : mappedRole === MUNICIPALITY_ROLE_COUNCIL
      ? 'admin'
      : 'member';
  return {
    id: Number(row.id),
    user: {
      id: userId,
      name: row.user_name || `User #${userId}`,
      avatar_config: null,
      role: userRole,
      is_municipality_owner: userId === Number(ownerUserId),
    },
    message: String(row.message || ''),
    type: ['text', 'system', 'announcement'].includes(String(row.type || 'text')) ? String(row.type || 'text') : 'text',
    reply_to: row.reply_to_id
      ? {
          id: Number(row.reply_to_id),
          message: String(row.reply_to_message || ''),
        }
      : null,
    is_edited: Boolean(row.is_edited),
    created_at: row.created_at,
    edited_at: row.edited_at || null,
  };
}

// ─── Chat tables, users_data, user_inventory ──────────────────────────────────

async function ensureMunicipalityChatTables() {}

async function ensureUsersDataTable() {}

async function getUserAvatarConfig(userId) {
  ensureDbEnabled();
  const { wsSanitizeAvatarConfig } = require('../ws/socketio/helpers');
  const [rows] = await dbPool.query(
    `SELECT avatar_config
     FROM users_data
     WHERE user_id = ?
     LIMIT 1`,
    [Number(userId)]
  );
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  return wsSanitizeAvatarConfig(toJsonValue(row?.avatar_config || null) || {});
}

async function upsertUserAvatarConfig(userId, avatarConfig) {
  ensureDbEnabled();
  const { wsSanitizeAvatarConfig } = require('../ws/socketio/helpers');
  const existing = await getUserAvatarConfig(userId);
  const incoming = avatarConfig && typeof avatarConfig === 'object' ? avatarConfig : {};
  const merged = {
    ...existing,
    ...incoming,
  };
  if (incoming.figure == null || String(incoming.figure || '').trim() === '') {
    merged.figure = existing.figure;
  }
  const sanitized = wsSanitizeAvatarConfig(merged);
  await dbPool.query(
    `INSERT INTO users_data (user_id, avatar_config, project_data)
     VALUES (?, ?, NULL)
     ON DUPLICATE KEY UPDATE
      avatar_config = VALUES(avatar_config),
      updated_at = CURRENT_TIMESTAMP`,
    [Number(userId), JSON.stringify(sanitized)]
  );
  return sanitized;
}

async function ensureUserInventoryTable() {}

async function upsertUserInventoryItem(userId, itemCode, quantity, metadata = null) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  const normalizedCode = normalizeInventoryItemCode(itemCode);
  const normalizedQty = normalizeInventoryQuantity(quantity);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0 || !normalizedCode) return null;

  if (normalizedQty <= 0) {
    await dbPool.query(
      `DELETE FROM user_inventory
       WHERE user_id = ? AND item_code = ?`,
      [safeUserId, normalizedCode]
    );
    return {
      item_code: normalizedCode,
      quantity: 0,
      metadata: null,
      removed: true,
    };
  }

  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : null;
  await dbPool.query(
    `INSERT INTO user_inventory (user_id, item_code, quantity, metadata)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      quantity = VALUES(quantity),
      metadata = VALUES(metadata),
      updated_at = CURRENT_TIMESTAMP`,
    [safeUserId, normalizedCode, normalizedQty, safeMetadata ? JSON.stringify(safeMetadata) : null]
  );
  return {
    item_code: normalizedCode,
    quantity: normalizedQty,
    metadata: safeMetadata,
    removed: false,
  };
}

async function adjustUserInventoryItem(userId, itemCode, delta, metadata = null) {
  ensureDbEnabled();
  const safeUserId = Number(userId);
  const normalizedCode = normalizeInventoryItemCode(itemCode);
  const normalizedDelta = Math.round(Number(delta || 0));
  if (!Number.isInteger(safeUserId) || safeUserId <= 0 || !normalizedCode || !Number.isFinite(normalizedDelta)) return null;

  const [rows] = await dbPool.query(
    `SELECT quantity, metadata
     FROM user_inventory
     WHERE user_id = ? AND item_code = ?
     LIMIT 1`,
    [safeUserId, normalizedCode]
  );
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  const currentQty = normalizeInventoryQuantity(row?.quantity || 0);
  const nextQty = Math.max(0, currentQty + normalizedDelta);

  let nextMetadata = toJsonValue(row?.metadata);
  if (metadata && typeof metadata === 'object') {
    nextMetadata = {
      ...(nextMetadata && typeof nextMetadata === 'object' ? nextMetadata : {}),
      ...metadata,
    };
  }

  return upsertUserInventoryItem(safeUserId, normalizedCode, nextQty, nextMetadata);
}

// ─── Chat messages CRUD ─────────────────────────────────────────────────────

async function getMunicipalityChatMessageRowById(municipalityId, messageId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT
      m.id, m.municipality_id, m.user_id, m.message, m.type, m.reply_to_id, m.is_edited, m.created_at, m.edited_at,
      u.nickname AS user_name,
      r.message AS reply_to_message
     FROM municipality_chat_messages m
     INNER JOIN users u ON u.id = m.user_id
     LEFT JOIN municipality_chat_messages r ON r.id = m.reply_to_id
     WHERE m.municipality_id = ? AND m.id = ?
     LIMIT 1`,
    [municipalityId, messageId]
  );
  return rows[0] || null;
}

async function listMunicipalityChatMessages(municipalityId, { limit = 10, before = null, after = null } = {}) {
  ensureDbEnabled();
  const safeLimit = Math.max(1, Math.min(10, Math.round(Number(limit || 10))));
  const where = [
    'm.municipality_id = ?',
    'm.created_at >= DATE_SUB(NOW(), INTERVAL 2 DAY)',
    'm.deleted_at IS NULL',
  ];
  const args = [municipalityId];
  let orderBy = 'm.id DESC';
  if (Number.isFinite(Number(before)) && Number(before) > 0) {
    where.push('m.id < ?');
    args.push(Number(before));
  }
  if (Number.isFinite(Number(after)) && Number(after) > 0) {
    where.push('m.id > ?');
    args.push(Number(after));
    orderBy = 'm.id ASC';
  }
  args.push(safeLimit + 1);
  const [rows] = await dbPool.query(
    `SELECT
      m.id, m.user_id, m.message, m.type, m.reply_to_id, m.is_edited, m.created_at, m.edited_at,
      u.nickname AS user_name,
      r.message AS reply_to_message
     FROM municipality_chat_messages m
     INNER JOIN users u ON u.id = m.user_id
     LEFT JOIN municipality_chat_messages r ON r.id = m.reply_to_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT ?`,
    args
  );
  const list = Array.isArray(rows) ? rows : [];
  const hasMore = list.length > safeLimit;
  const trimmed = hasMore ? list.slice(0, safeLimit) : list;
  return { rows: trimmed, hasMore };
}

async function createMunicipalityChatMessage({ municipalityId, userId, message, replyToId = null, ipAddress = null, userAgent = null }) {
  ensureDbEnabled();
  let resolvedReplyTo = null;
  if (Number.isFinite(Number(replyToId)) && Number(replyToId) > 0) {
    const [replyRows] = await dbPool.query(
      `SELECT id
       FROM municipality_chat_messages
       WHERE municipality_id = ? AND id = ?
       LIMIT 1`,
      [municipalityId, Number(replyToId)]
    );
    if (Array.isArray(replyRows) && replyRows.length > 0) {
      resolvedReplyTo = Number(replyToId);
    }
  }
  const [result] = await dbPool.query(
    `INSERT INTO municipality_chat_messages
     (municipality_id, user_id, message, type, reply_to_id, is_edited, edited_at)
     VALUES (?, ?, ?, 'text', ?, 0, NULL)`,
    [municipalityId, userId, String(message || '').slice(0, 4000), resolvedReplyTo]
  );
  const messageId = Number(result.insertId || 0);
  if (messageId > 0) {
    await dbPool.query(
      `INSERT INTO municipality_chat_logs
       (message_id, user_id, action, old_content, new_content, ip_address, user_agent, metadata)
       VALUES (?, ?, 'created', NULL, ?, ?, ?, NULL)`,
      [messageId, userId, String(message || '').slice(0, 4000), ipAddress, userAgent ? String(userAgent).slice(0, 1000) : null]
    );
  }
  return messageId;
}

async function updateMunicipalityChatMessage({ municipalityId, messageId, userId, newMessage, ipAddress = null, userAgent = null }) {
  ensureDbEnabled();
  const prev = await getMunicipalityChatMessageRowById(municipalityId, messageId);
  if (!prev) return { updated: 0, previous: null };
  await dbPool.query(
    `UPDATE municipality_chat_messages
     SET message = ?, is_edited = 1, edited_at = NOW(), updated_at = CURRENT_TIMESTAMP
     WHERE municipality_id = ? AND id = ? AND deleted_at IS NULL`,
    [String(newMessage || '').slice(0, 4000), municipalityId, messageId]
  );
  await dbPool.query(
    `INSERT INTO municipality_chat_logs
     (message_id, user_id, action, old_content, new_content, ip_address, user_agent, metadata)
     VALUES (?, ?, 'edited', ?, ?, ?, ?, NULL)`,
    [messageId, userId, String(prev.message || ''), String(newMessage || '').slice(0, 4000), ipAddress, userAgent ? String(userAgent).slice(0, 1000) : null]
  );
  return { updated: 1, previous: prev };
}

async function softDeleteMunicipalityChatMessage({ municipalityId, messageId, userId, ipAddress = null, userAgent = null }) {
  ensureDbEnabled();
  const prev = await getMunicipalityChatMessageRowById(municipalityId, messageId);
  if (!prev) return { deleted: 0, previous: null };
  await dbPool.query(
    `INSERT INTO municipality_chat_logs
     (message_id, user_id, action, old_content, new_content, ip_address, user_agent, metadata)
     VALUES (?, ?, 'deleted', ?, NULL, ?, ?, NULL)`,
    [messageId, userId, String(prev.message || ''), ipAddress, userAgent ? String(userAgent).slice(0, 1000) : null]
  );
  await dbPool.query(
    `DELETE FROM municipality_chat_messages
     WHERE municipality_id = ? AND id = ?`,
    [municipalityId, messageId]
  );
  return { deleted: 1, previous: prev };
}

async function listMunicipalityChatLogs(municipalityId, limit = 100) {
  ensureDbEnabled();
  const safeLimit = Math.max(1, Math.min(500, Math.round(Number(limit || 100))));
  const [rows] = await dbPool.query(
    `SELECT
      l.id, l.message_id, l.user_id, l.action, l.old_content, l.new_content, l.ip_address, l.created_at,
      u.nickname AS user_name
     FROM municipality_chat_logs l
     INNER JOIN municipality_chat_messages m ON m.id = l.message_id
     INNER JOIN users u ON u.id = l.user_id
     WHERE m.municipality_id = ?
     ORDER BY l.id DESC
     LIMIT ?`,
    [municipalityId, safeLimit]
  );
  return Array.isArray(rows) ? rows : [];
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  fetchMunicipalities,
  fetchCantonMunicipalities,
  searchMunicipalitiesForPartnerships,
  listPublicNavigatorMaps,
  listPrivateHouses,
  getMunicipalityById,
  getMunicipalityBySlug,
  getMunicipalityOwner,
  ensureMunicipalityIsUserCreatedColumn,
  ensureMunicipalityRoleTables,
  syncMunicipalityMemberships,
  promoteToOwner,
  touchMunicipalityActivity,
  checkAndSucceedInactiveMunicipalityOwners,
  getActiveElection,
  getElectionDetails,
  openElection,
  registerCandidate,
  withdrawCandidacy,
  castVote,
  resolveElectionPhases,
  openNoConfidenceVote,
  voteNoConfidence,
  resolveExpiredNoConfidenceVotes,
  getMunicipalityAdministration,
  getUserMunicipalityRole,
  getMunicipalityRoleMap,
  ensureCoatOfArmsUploadDir,
  ensureMinimapUploadDir,
  saveMinimapPng,
  ensureMunicipalityCoatOfArmsTable,
  buildCoatOfArmsImageUrl,
  getMunicipalityCoatOfArmsRecord,
  deleteMunicipalityCoatOfArms,
  saveMunicipalityCoatOfArmsPng,
  resolveMunicipalityCoatOfArmsDto,
  mapChatMessageRowToDto,
  ensureMunicipalityChatTables,
  ensureUsersDataTable,
  getUserAvatarConfig,
  upsertUserAvatarConfig,
  ensureUserInventoryTable,
  upsertUserInventoryItem,
  adjustUserInventoryItem,
  getMunicipalityChatMessageRowById,
  listMunicipalityChatMessages,
  createMunicipalityChatMessage,
  updateMunicipalityChatMessage,
  softDeleteMunicipalityChatMessage,
  listMunicipalityChatLogs,
};
