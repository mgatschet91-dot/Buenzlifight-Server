-- Migration 119: Shop-Kategorie Sport
INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order, rotatable, is_active) VALUES
  ('treadmill',       'Laufband',        'sport', '🏃', 400, 10, 1, 1),
  ('punching_bag',    'Boxsack',         'sport', '🥊', 150, 20, 1, 1),
  ('yoga_mat',        'Yogamatte',       'sport', '🧘', 40,  30, 1, 1),
  ('weights_rack',    'Hantelregal',     'sport', '🏋️', 220, 40, 1, 1)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order),
  rotatable    = VALUES(rotatable),
  is_active    = VALUES(is_active);
