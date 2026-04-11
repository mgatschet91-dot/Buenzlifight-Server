-- Per-municipality generated map storage

CREATE TABLE IF NOT EXISTS game_data_map (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id BIGINT UNSIGNED NOT NULL,
  grid_size INT UNSIGNED NOT NULL DEFAULT 50,
  map_data JSON NOT NULL,
  water_bodies JSON NULL,
  seed VARCHAR(100) NULL,
  generator_version VARCHAR(50) NULL,
  generated_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_game_data_map_municipality (municipality_id),
  KEY idx_game_data_map_updated (updated_at),
  CONSTRAINT fk_game_data_map_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
