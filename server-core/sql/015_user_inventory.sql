-- 015_user_inventory.sql
-- Globales User-Inventar (nicht an municipality_id gebunden)

CREATE TABLE IF NOT EXISTS user_inventory (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  item_code VARCHAR(64) NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 0,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_item (user_id, item_code),
  KEY idx_user_updated (user_id, updated_at),
  CONSTRAINT fk_user_inventory_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
