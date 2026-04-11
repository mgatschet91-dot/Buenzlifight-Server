CREATE TABLE player_residences (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,
  municipality_id  BIGINT UNSIGNED NOT NULL,
  room_code        VARCHAR(10) NOT NULL,
  tile_x           INT NOT NULL,
  tile_y           INT NOT NULL,
  occupied_since   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_municipality (user_id, municipality_id),
  UNIQUE KEY uq_tile (municipality_id, room_code, tile_x, tile_y),
  KEY idx_pr_muni (municipality_id, room_code),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE
) ENGINE=InnoDB;
