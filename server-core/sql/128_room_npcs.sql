-- Migration 128: Room NPCs — platzierbare NPCs im Isometric-Raum
-- Eigene Tabelle (nicht room_furniture), weil NPCs Name + Style haben

CREATE TABLE IF NOT EXISTS room_npcs (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  npc_name     VARCHAR(32)  NOT NULL DEFAULT 'NPC',
  npc_style    TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '1=Arbeiter, 2=Butler, 3=Haustier',
  x            FLOAT        NOT NULL DEFAULT 0,
  z            FLOAT        NOT NULL DEFAULT 0,
  facing_idx   TINYINT      NOT NULL DEFAULT 0 COMMENT '0=N,1=E,2=S,3=W',
  floor_level  TINYINT      NOT NULL DEFAULT 0,
  placed_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_room_npcs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_room_npcs_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Shop-Eintrag: NPC als Spezial-Item
INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order, rotatable, is_active) VALUES
  ('room_npc', 'Bewohner NPC', 'spezial', '🧑', 350, 10, 1, 1)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order),
  rotatable    = VALUES(rotatable),
  is_active    = VALUES(is_active);
