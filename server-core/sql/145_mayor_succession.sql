-- 145: Mayor succession system
-- Tracks municipality-specific activity (not just login) and election metadata

-- Per-member activity tracking: updated when entering room, building, chatting
ALTER TABLE municipality_memberships
  ADD COLUMN last_municipality_activity_at DATETIME NULL DEFAULT NULL,
  ADD COLUMN elected_lost_at DATETIME NULL DEFAULT NULL,
  ADD COLUMN council_election_requested_at DATETIME NULL DEFAULT NULL,
  ADD COLUMN candidate_withdrawn TINYINT(1) NOT NULL DEFAULT 0;

-- Per-municipality: cooldown after last election ended
ALTER TABLE municipalities
  ADD COLUMN last_election_ended_at DATETIME NULL DEFAULT NULL;

-- Elections table
CREATE TABLE IF NOT EXISTS municipality_elections (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  municipality_id   INT UNSIGNED NOT NULL,
  status            ENUM('candidates','voting','closed','cancelled') NOT NULL DEFAULT 'candidates',
  triggered_by      ENUM('inactivity','council_vote','admin') NOT NULL DEFAULT 'inactivity',
  candidates_until  DATETIME NOT NULL,
  voting_until      DATETIME NOT NULL,
  winner_user_id    INT UNSIGNED NULL DEFAULT NULL,
  started_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at         DATETIME NULL DEFAULT NULL,
  INDEX idx_election_municipality (municipality_id),
  INDEX idx_election_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Candidates per election
CREATE TABLE IF NOT EXISTS election_candidates (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  election_id   INT UNSIGNED NOT NULL,
  user_id       INT UNSIGNED NOT NULL,
  registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  withdrawn_at  DATETIME NULL DEFAULT NULL,
  UNIQUE KEY uq_candidate (election_id, user_id),
  INDEX idx_candidate_election (election_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Votes per election (1 vote per user per election enforced by unique key)
CREATE TABLE IF NOT EXISTS election_votes (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  election_id   INT UNSIGNED NOT NULL,
  voter_id      INT UNSIGNED NOT NULL,
  candidate_id  INT UNSIGNED NOT NULL,
  voted_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vote (election_id, voter_id),
  INDEX idx_vote_election (election_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Council no-confidence vote requests (Misstrauensvotum)
CREATE TABLE IF NOT EXISTS municipality_no_confidence (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  municipality_id INT UNSIGNED NOT NULL,
  requested_by    INT UNSIGNED NOT NULL,
  status          ENUM('open','passed','rejected','expired') NOT NULL DEFAULT 'open',
  started_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      DATETIME NOT NULL,
  UNIQUE KEY uq_open_vote (municipality_id, status),
  INDEX idx_nc_municipality (municipality_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS municipality_no_confidence_votes (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  no_confidence_id  INT UNSIGNED NOT NULL,
  voter_id          INT UNSIGNED NOT NULL,
  voted_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_nc_vote (no_confidence_id, voter_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
