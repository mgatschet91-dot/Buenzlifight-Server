-- Migration 115: Shop-Kategorie Küche
INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order, rotatable, is_active) VALUES
  ('counter_kitchen', 'Küchenblock',     'kueche', '🍳', 120, 10, 0, 1),
  ('stove',           'Herd',            'kueche', '🔥', 150, 20, 1, 1),
  ('sink_kitchen',    'Spüle',           'kueche', '🚿', 110, 30, 0, 1),
  ('coffee_machine',  'Kaffeemaschine',  'kueche', '☕', 80,  40, 1, 1),
  ('microwave',       'Mikrowelle',      'kueche', '📦', 90,  50, 1, 1)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order),
  rotatable    = VALUES(rotatable),
  is_active    = VALUES(is_active);
