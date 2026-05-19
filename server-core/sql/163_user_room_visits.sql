-- Navigator: Zuletzt besuchte Räume pro User (server-side, nicht localStorage)
CREATE TABLE IF NOT EXISTS user_room_visits (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,
  municipality_id   BIGINT UNSIGNED NOT NULL,
  municipality_slug VARCHAR(100)    NOT NULL DEFAULT '',
  municipality_name VARCHAR(120)    NOT NULL DEFAULT '',
  room_code         VARCHAR(20)     NOT NULL DEFAULT 'MAIN',
  room_name         VARCHAR(100)    NOT NULL DEFAULT '',
  visited_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                                    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_room (user_id, municipality_id, room_code),
  INDEX idx_user_visited (user_id, visited_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
