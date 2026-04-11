-- Stores map items per municipality + room

CREATE TABLE IF NOT EXISTS game_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id BIGINT UNSIGNED NOT NULL,
  room_code VARCHAR(10) NOT NULL,
  player_id VARCHAR(64) NOT NULL DEFAULT 'system',
  user_id BIGINT UNSIGNED NULL,
  action_type ENUM('place', 'zone', 'bulldoze', 'stats_update') NOT NULL,
  tool VARCHAR(100) NULL,
  zone_type ENUM('residential', 'commercial', 'industrial', 'none') NULL,
  x INT UNSIGNED NOT NULL,
  y INT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  client_timestamp BIGINT UNSIGNED NULL,
  applied_at DATETIME NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_game_items_room_version (municipality_id, room_code, version),
  KEY idx_game_items_room_xy (municipality_id, room_code, x, y),
  KEY idx_game_items_action (action_type),
  CONSTRAINT fk_game_items_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_game_items_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
