-- Gesperrte User pro Gemeinde (nach Kick)
CREATE TABLE IF NOT EXISTS municipality_kick_bans (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  banned_by     BIGINT UNSIGNED NOT NULL,
  banned_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ban (municipality_id, user_id),
  CONSTRAINT fk_kickban_muni FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
  CONSTRAINT fk_kickban_user FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,
  CONSTRAINT fk_kickban_by   FOREIGN KEY (banned_by)       REFERENCES users(id)         ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
