-- Partnerships and partnership requests

CREATE TABLE IF NOT EXISTS game_partnerships (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id BIGINT UNSIGNED NOT NULL,
  partner_municipality_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'discovered',
  direction VARCHAR(16) NULL,
  trade_income INT NOT NULL DEFAULT 0,
  connection_bonus_paid TINYINT(1) NOT NULL DEFAULT 0,
  discovered_at DATETIME NULL,
  connected_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_game_partnership_pair (municipality_id, partner_municipality_id),
  KEY idx_game_partnership_status (status),
  CONSTRAINT fk_game_partnership_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_game_partnership_partner
    FOREIGN KEY (partner_municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS game_partnership_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  from_municipality_id BIGINT UNSIGNED NOT NULL,
  to_municipality_id BIGINT UNSIGNED NOT NULL,
  from_user_id BIGINT UNSIGNED NULL,
  responder_user_id BIGINT UNSIGNED NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  message VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_game_partnership_requests_to_status (to_municipality_id, status),
  KEY idx_game_partnership_requests_from_status (from_municipality_id, status),
  CONSTRAINT fk_game_partnership_requests_from_municipality
    FOREIGN KEY (from_municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_game_partnership_requests_to_municipality
    FOREIGN KEY (to_municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_game_partnership_requests_from_user
    FOREIGN KEY (from_user_id) REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,
  CONSTRAINT fk_game_partnership_requests_responder_user
    FOREIGN KEY (responder_user_id) REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
