-- Migration 118: Shop-Kategorie Deko
INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order, rotatable, is_active) VALUES
  ('fireplace',       'Kamin',           'deko', '🔥', 350, 10, 1, 1),
  ('aquarium',        'Aquarium',        'deko', '🐠', 280, 20, 1, 1),
  ('vase_tall',       'Große Vase',      'deko', '🌸', 60,  30, 1, 1),
  ('candles',         'Kerzenständer',   'deko', '🕯️', 50,  40, 1, 1),
  ('carpet_round',    'Runder Teppich',  'deko', '🟣', 80,  50, 1, 1)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order),
  rotatable    = VALUES(rotatable),
  is_active    = VALUES(is_active);
