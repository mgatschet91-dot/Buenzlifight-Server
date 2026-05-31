'use strict';

const { dbPool, ensureDbEnabled } = require('../../infra/db');
const { promoteToOwner } = require('./core.js');

async function getActiveElection(municipalityId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT e.*,
       (SELECT COUNT(*) FROM election_candidates c WHERE c.election_id = e.id AND c.withdrawn_at IS NULL) AS candidate_count,
       (SELECT COUNT(*) FROM election_votes v WHERE v.election_id = e.id) AS vote_count
     FROM municipality_elections e
     WHERE e.municipality_id = ? AND e.status IN ('candidates','voting')
     ORDER BY e.started_at DESC LIMIT 1`,
    [municipalityId]
  );
  return rows[0] || null;
}

async function getElectionDetails(electionId, municipalityId) {
  ensureDbEnabled();
  const [elRows] = await dbPool.query(`SELECT * FROM municipality_elections WHERE id = ? AND municipality_id = ? LIMIT 1`, [electionId, municipalityId]);
  if (!elRows[0]) return null;
  const [candidates] = await dbPool.query(
    `SELECT ec.user_id, ec.registered_at, ec.withdrawn_at, u.nickname,
       (SELECT COUNT(*) FROM election_votes ev WHERE ev.election_id = ? AND ev.candidate_id = ec.user_id) AS votes
     FROM election_candidates ec
     JOIN users u ON u.id = ec.user_id
     WHERE ec.election_id = ? ORDER BY ec.registered_at ASC`,
    [electionId, electionId]
  );
  return { election: elRows[0], candidates: Array.isArray(candidates) ? candidates : [] };
}

async function openElection(municipalityId, triggeredBy = 'inactivity') {
  ensureDbEnabled();
  const [muni] = await dbPool.query(`SELECT last_election_ended_at FROM municipalities WHERE id = ? LIMIT 1`, [municipalityId]);
  if (muni[0]?.last_election_ended_at) {
    const daysSince = (Date.now() - new Date(muni[0].last_election_ended_at).getTime()) / 86400000;
    if (daysSince < 14 && triggeredBy !== 'admin') throw new Error('ELECTION_COOLDOWN');
  }
  const existing = await getActiveElection(municipalityId);
  if (existing) throw new Error('ELECTION_ALREADY_ACTIVE');

  const candidatesUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const votingUntil    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [result] = await dbPool.query(
    `INSERT INTO municipality_elections (municipality_id, status, triggered_by, candidates_until, voting_until) VALUES (?, 'candidates', ?, ?, ?)`,
    [municipalityId, triggeredBy, candidatesUntil, votingUntil]
  );
  return result.insertId;
}

async function registerCandidate(electionId, userId, municipalityId) {
  ensureDbEnabled();
  const [memRows] = await dbPool.query(`SELECT created_at FROM municipality_memberships WHERE municipality_id = ? AND user_id = ? LIMIT 1`, [municipalityId, userId]);
  if (!memRows[0]) throw new Error('NOT_A_MEMBER');
  if ((Date.now() - new Date(memRows[0].created_at).getTime()) / 86400000 < 7) throw new Error('TOO_NEW');

  const [existing] = await dbPool.query(`SELECT id, withdrawn_at FROM election_candidates WHERE election_id = ? AND user_id = ? LIMIT 1`, [electionId, userId]);
  if (existing[0]) throw new Error(existing[0].withdrawn_at ? 'ALREADY_WITHDRAWN' : 'ALREADY_CANDIDATE');

  const [countRows] = await dbPool.query(`SELECT COUNT(*) AS cnt FROM election_candidates WHERE election_id = ? AND withdrawn_at IS NULL`, [electionId]);
  if (Number(countRows[0].cnt) >= 10) throw new Error('MAX_CANDIDATES');

  await dbPool.query(`INSERT INTO election_candidates (election_id, user_id) VALUES (?, ?)`, [electionId, userId]);
}

async function withdrawCandidacy(electionId, userId) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(`SELECT id, withdrawn_at FROM election_candidates WHERE election_id = ? AND user_id = ? LIMIT 1`, [electionId, userId]);
  if (!rows[0]) throw new Error('NOT_A_CANDIDATE');
  if (rows[0].withdrawn_at) throw new Error('ALREADY_WITHDRAWN');
  await dbPool.query(`UPDATE election_candidates SET withdrawn_at = NOW() WHERE id = ?`, [rows[0].id]);
}

async function castVote(electionId, voterId, candidateUserId, municipalityId) {
  ensureDbEnabled();
  const [memRows] = await dbPool.query(`SELECT created_at FROM municipality_memberships WHERE municipality_id = ? AND user_id = ? LIMIT 1`, [municipalityId, voterId]);
  if (!memRows[0]) throw new Error('NOT_A_MEMBER');
  if ((Date.now() - new Date(memRows[0].created_at).getTime()) / 86400000 < 3) throw new Error('TOO_NEW');

  const [candRows] = await dbPool.query(`SELECT id FROM election_candidates WHERE election_id = ? AND user_id = ? AND withdrawn_at IS NULL LIMIT 1`, [electionId, candidateUserId]);
  if (!candRows[0]) throw new Error('INVALID_CANDIDATE');

  try {
    await dbPool.query(`INSERT INTO election_votes (election_id, voter_id, candidate_id) VALUES (?, ?, ?)`, [electionId, voterId, candidateUserId]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new Error('ALREADY_VOTED');
    throw err;
  }
}

async function resolveElectionPhases() {
  ensureDbEnabled();
  await dbPool.query(`UPDATE municipality_elections SET status = 'voting' WHERE status = 'candidates' AND candidates_until <= NOW()`);

  const [toClose] = await dbPool.query(`SELECT * FROM municipality_elections WHERE status = 'voting' AND voting_until <= NOW()`);
  for (const election of toClose) {
    const [winners] = await dbPool.query(
      `SELECT ec.user_id, COUNT(ev.id) AS votes, mm.created_at AS joined_at
       FROM election_candidates ec
       LEFT JOIN election_votes ev ON ev.election_id = ec.election_id AND ev.candidate_id = ec.user_id
       LEFT JOIN municipality_memberships mm ON mm.municipality_id = ? AND mm.user_id = ec.user_id
       WHERE ec.election_id = ? AND ec.withdrawn_at IS NULL
       GROUP BY ec.user_id ORDER BY votes DESC, joined_at ASC LIMIT 1`,
      [election.municipality_id, election.id]
    );
    if (winners.length > 0) {
      await promoteToOwner(election.municipality_id, winners[0].user_id);
      await dbPool.query(`UPDATE municipality_elections SET status = 'closed', winner_user_id = ?, closed_at = NOW() WHERE id = ?`, [winners[0].user_id, election.id]);
    } else {
      await dbPool.query(`UPDATE municipality_elections SET status = 'cancelled', closed_at = NOW() WHERE id = ?`, [election.id]);
    }
    await dbPool.query(`UPDATE municipalities SET last_election_ended_at = NOW() WHERE id = ?`, [election.municipality_id]);
  }
}

module.exports = { getActiveElection, getElectionDetails, openElection, registerCandidate, withdrawCandidacy, castVote, resolveElectionPhases };
