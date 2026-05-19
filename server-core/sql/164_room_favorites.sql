-- Feature: Raum-Favoriten
CREATE TABLE IF NOT EXISTS user_room_favorites (
  id                 INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  user_id            INT UNSIGNED     NOT NULL,
  municipality_slug  VARCHAR(100)     NOT NULL,
  municipality_name  VARCHAR(100)     NOT NULL DEFAULT '',
  room_code          VARCHAR(50)      NOT NULL,
  room_name          VARCHAR(80)      NOT NULL DEFAULT '',
  owner_user_id      INT UNSIGNED     NULL,
  added_at           DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fav (user_id, municipality_slug, room_code),
  KEY idx_fav_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
