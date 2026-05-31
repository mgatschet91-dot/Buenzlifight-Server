'use strict';

const { dbPool, ensureDbEnabled } = require('../../infra/db');
const { normalizeMunicipalityRole } = require('../../auth/permissions');
const { MUNICIPALITY_ROLE_OWNER, MUNICIPALITY_ROLE_OBSERVER } = require('../../config/constants');
const { promoteToOwner } = require('./core.js');
const { getActiveElection, openElection } = require('./elections.js');

// ── Bürger-Petition ───────────────────────────────────────────────

async function getActivePetition(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT p.*, (SELECT COUNT(*) FROM municipality_petition_signatures s WHERE s.petition_id = p.id) AS signature_count
     FROM municipality_petitions p
     WHERE p.municipality_id = ? AND p.status = 'open' ORDER BY p.created_at DESC LIMIT 1`,
    [municipalityId]
  );
  return rows[0] || null;
}

async function openPetition(municipalityId, requestedByUserId) {
  ensureDbEnabled();
  const [memRows] = await dbPool.query(`SELECT role, petition_requested_at FROM municipality_memberships WHERE municipality_id = ? AND user_id = ? LIMIT 1`, [municipalityId, requestedByUserId]);
  if (!memRows[0]) throw new Error('NOT_A_MEMBER');
  const role = normalizeMunicipalityRole(memRows[0].role);
  if (role === MUNICIPALITY_ROLE_OBSERVER) throw new Error('NOT_A_MEMBER');
  if (role === MUNICIPALITY_ROLE_OWNER) throw new Error('OWNER_CANNOT_PETITION');

  if (memRows[0].petition_requested_at) {
    const daysSince = (Date.now() - new Date(memRows[0].petition_requested_at).getTime()) / 86400000;
    if (daysSince < 30) throw new Error('PETITION_COOLDOWN');
  }

  if (await getActivePetition(municipalityId)) throw new Error('PETITION_ALREADY_OPEN');
  if (await getActiveElection(municipalityId)) throw new Error('ELECTION_ALREADY_ACTIVE');

  const [countRows] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM municipality_memberships WHERE municipality_id = ?`, [municipalityId]);
  const signaturesNeeded = Math.max(2, Math.ceil(Number(countRows[0].cnt || 0) * 0.5));
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const [result] = await dbPool.query(`INSERT INTO municipality_petitions (municipality_id, requested_by, signatures_needed, expires_at) VALUES (?, ?, ?, ?)`, [municipalityId, requestedByUserId, signaturesNeeded, expiresAt]);
  const petitionId = result.insertId;

  await dbPool.query(`INSERT IGNORE INTO municipality_petition_signatures (petition_id, user_id) VALUES (?, ?)`, [petitionId, requestedByUserId]);
  await dbPool.query(`UPDATE municipality_memberships SET petition_requested_at = NOW() WHERE municipality_id = ? AND user_id = ?`, [municipalityId, requestedByUserId]);

  return { petition_id: petitionId, signatures_needed: signaturesNeeded };
}

async function signPetition(petitionId, userId, municipalityId) {
  ensureDbEnabled();
  const [petRows] = await dbPool.query(`SELECT * FROM municipality_petitions WHERE id = ? AND municipality_id = ? AND status = 'open' LIMIT 1`, [petitionId, municipalityId]);
  if (!petRows[0]) throw new Error('PETITION_NOT_FOUND');

  const [memRows] = await dbPool.query(`SELECT role FROM municipality_memberships WHERE municipality_id = ? AND user_id = ? LIMIT 1`, [municipalityId, userId]);
  if (!memRows[0] || normalizeMunicipalityRole(memRows[0].role) === MUNICIPALITY_ROLE_OBSERVER) throw new Error('NOT_A_MEMBER');

  try {
    await dbPool.query(`INSERT INTO municipality_petition_signatures (petition_id, user_id) VALUES (?, ?)`, [petitionId, userId]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new Error('ALREADY_SIGNED');
    throw err;
  }

  const [sigRows] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM municipality_petition_signatures WHERE petition_id = ?`, [petitionId]);
  const totalSigs = Number(sigRows[0].cnt || 0);
  const needed = Number(petRows[0].signatures_needed || 2);

  if (totalSigs >= needed) {
    let electionId = null;
    try { electionId = await openElection(municipalityId, 'citizen_petition'); } catch (_) {}
    await dbPool.query(`UPDATE municipality_petitions SET status = 'passed', triggered_election_id = ? WHERE id = ?`, [electionId, petitionId]);
    return { passed: true, election_triggered: electionId !== null };
  }

  return { passed: false, signatures: totalSigs, signatures_needed: needed };
}

async function resolveExpiredPetitions() {
  ensureDbEnabled();
  await dbPool.query(`UPDATE municipality_petitions SET status = 'expired' WHERE status = 'open' AND expires_at <= NOW()`);
}

// ── Misstrauensvotum ──────────────────────────────────────────────

async function openNoConfidenceVote(municipalityId, requestedByUserId) {
  ensureDbEnabled();
  const [memRows] = await dbPool.query(`SELECT council_election_requested_at FROM municipality_memberships WHERE municipality_id = ? AND user_id = ? LIMIT 1`, [municipalityId, requestedByUserId]);
  if (memRows[0]?.council_election_requested_at) {
    const daysSince = (Date.now() - new Date(memRows[0].council_election_requested_at).getTime()) / 86400000;
    if (daysSince < 30) throw new Error('REQUEST_COOLDOWN');
  }

  const [existing] = await dbPool.query(`SELECT id FROM municipality_no_confidence WHERE municipality_id = ? AND status = 'open' LIMIT 1`, [municipalityId]);
  if (existing.length > 0) throw new Error('ALREADY_OPEN');

  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const [result] = await dbPool.query(`INSERT INTO municipality_no_confidence (municipality_id, requested_by, expires_at) VALUES (?, ?, ?)`, [municipalityId, requestedByUserId, expiresAt]);
  await dbPool.query(`UPDATE municipality_memberships SET council_election_requested_at = NOW() WHERE municipality_id = ? AND user_id = ?`, [municipalityId, requestedByUserId]);
  return result.insertId;
}

async function voteNoConfidence(noConfidenceId, voterUserId, municipalityId) {
  ensureDbEnabled();
  try {
    await dbPool.query(`INSERT INTO municipality_no_confidence_votes (no_confidence_id, voter_id) VALUES (?, ?)`, [noConfidenceId, voterUserId]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new Error('ALREADY_VOTED');
    throw err;
  }

  const [councilRows] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM municipality_memberships WHERE municipality_id = ? AND role = 'council' AND last_municipality_activity_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)`, [municipalityId]);
  const [voteRows] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM municipality_no_confidence_votes WHERE no_confidence_id = ?`, [noConfidenceId]);
  const totalCouncil = Number(councilRows[0].cnt);
  const totalVotes = Number(voteRows[0].cnt);

  if (totalCouncil >= 2 && totalVotes >= Math.ceil((totalCouncil * 2) / 3)) {
    await dbPool.query(`UPDATE municipality_no_confidence SET status = 'passed' WHERE id = ?`, [noConfidenceId]);
    const [nextOwner] = await dbPool.query(`SELECT user_id FROM municipality_memberships WHERE municipality_id = ? AND role = 'council' AND last_municipality_activity_at >= DATE_SUB(NOW(), INTERVAL 14 DAY) ORDER BY created_at ASC LIMIT 1`, [municipalityId]);
    if (nextOwner.length > 0) {
      await promoteToOwner(municipalityId, nextOwner[0].user_id);
    } else {
      await openElection(municipalityId, 'council_vote').catch(() => {});
    }
    return 'passed';
  }
  return 'pending';
}

async function resolveExpiredNoConfidenceVotes() {
  ensureDbEnabled();
  await dbPool.query(`UPDATE municipality_no_confidence SET status = 'expired' WHERE status = 'open' AND expires_at <= NOW()`);
}

module.exports = {
  getActivePetition, openPetition, signPetition, resolveExpiredPetitions,
  openNoConfidenceVote, voteNoConfidence, resolveExpiredNoConfidenceVotes,
};
