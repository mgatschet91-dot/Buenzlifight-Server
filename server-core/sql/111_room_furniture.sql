-- Migration 111: Placed furniture per user room
CREATE TABLE IF NOT EXISTS room_furniture (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  item_code   VARCHAR(64)  NOT NULL,
  x           FLOAT        NOT NULL,
  z           FLOAT        NOT NULL,
  facing_idx  TINYINT      NOT NULL DEFAULT 0,
  wy          FLOAT        NULL DEFAULT NULL,   -- saved Y position (wall frames etc.)
  placed_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_room_furniture_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
