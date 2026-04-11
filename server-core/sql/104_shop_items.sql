-- Migration 104: Shop items table
-- Jedes Item ist in einer eigenen Kategorie-Datei (105–110) definiert.
-- item_code muss mit den IDs in CATALOG_CATS (game3d.js) übereinstimmen.

CREATE TABLE IF NOT EXISTS shop_items (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  item_code    VARCHAR(64)  NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  category     VARCHAR(50)  NOT NULL,          -- z.B. moebel, party, bar
  icon         VARCHAR(200) NULL DEFAULT NULL, -- Emoji oder Bild-Pfad
  price        INT UNSIGNED NOT NULL DEFAULT 0,
  sort_order   INT          NOT NULL DEFAULT 0,
  is_active    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_shop_items_category (category, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
