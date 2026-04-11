-- Migration 117: Shop-Kategorie Schlafzimmer
INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order, rotatable, is_active) VALUES
  ('nightstand',      'Nachttisch',       'schlafzimmer', '🌙', 70,  10, 1, 1),
  ('wardrobe_big',    'Kleiderschrank',   'schlafzimmer', '👗', 220, 20, 1, 1),
  ('mirror_stand',    'Standspiegel',     'schlafzimmer', '🪞', 90,  30, 1, 1),
  ('vanity_table',    'Schminktisch',     'schlafzimmer', '💄', 180, 40, 1, 1)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order),
  rotatable    = VALUES(rotatable),
  is_active    = VALUES(is_active);
