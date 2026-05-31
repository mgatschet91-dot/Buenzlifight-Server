-- 177: Bürger-Petition — Normale Mitglieder können Neuwahl fordern

CREATE TABLE IF NOT EXISTS municipality_petitions (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  municipality_id     INT NOT NULL,
  requested_by        INT NOT NULL,
  status              ENUM('open','passed','expired','cancelled') NOT NULL DEFAULT 'open',
  signatures_needed   INT NOT NULL DEFAULT 1,
  expires_at          DATETIME NOT NULL,
  triggered_election_id INT UNSIGNED NULL DEFAULT NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_muni_status (municipality_id, status),
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS municipality_petition_signatures (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  petition_id INT UNSIGNED NOT NULL,
  user_id     INT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_petition_user (petition_id, user_id),
  INDEX idx_petition (petition_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cooldown-Tracking: User kann max 1x pro 30 Tage eine Petition starten
ALTER TABLE municipality_memberships
  ADD COLUMN petition_requested_at DATETIME NULL DEFAULT NULL;
