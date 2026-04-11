-- Multiplayer rooms per municipality

CREATE TABLE IF NOT EXISTS game_rooms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id BIGINT UNSIGNED NOT NULL,
  room_code VARCHAR(10) NOT NULL,
  city_name VARCHAR(191) NOT NULL,
  game_state LONGTEXT NULL,
  player_count INT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_game_rooms_municipality_room (municipality_id, room_code),
  KEY idx_game_rooms_active (is_active, updated_at),
  CONSTRAINT fk_game_rooms_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
