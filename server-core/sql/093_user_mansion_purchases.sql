-- 093: User Mansion Purchase (Design kaufen vor dem Platzieren)
-- Speichert welches Villa-Design ein User pro Gemeinde gekauft hat.
-- Unabhängig vom Platzieren auf der Karte.

CREATE TABLE IF NOT EXISTS user_mansion_purchases (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  municipality_id BIGINT UNSIGNED NOT NULL,
  variant_row     TINYINT UNSIGNED NOT NULL,
  variant_col     TINYINT UNSIGNED NOT NULL,
  price_paid      INT UNSIGNED NOT NULL DEFAULT 0,
  purchased_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_muni (user_id, municipality_id),
  KEY idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
