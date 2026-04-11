-- Persisted stats per room

CREATE TABLE IF NOT EXISTS game_stats (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id BIGINT UNSIGNED NOT NULL,
  room_code VARCHAR(10) NOT NULL,
  stats_data JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_game_stats_room (municipality_id, room_code),
  CONSTRAINT fk_game_stats_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
