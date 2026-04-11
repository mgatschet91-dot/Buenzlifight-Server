-- Migration 129: Shop-Kategorie Teppiche
INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order, rotatable, is_active) VALUES
  ('carpet_rectangle', 'Rechteckiger Teppich', 'teppich', '🟥', 90,  10, 1, 1),
  ('carpet_square',    'Quadratischer Teppich','teppich', '🟦', 80,  20, 1, 1),
  ('carpet_doormat',   'Fußmatte',             'teppich', '🟫', 50,  30, 1, 1),
  ('carpet_rounded',   'Abgerundeter Teppich', 'teppich', '🟩', 85,  40, 1, 1),
  ('carpet_bath',      'Badematte',            'teppich', '🛁', 60,  50, 1, 1),
  ('carpet_runner',    'Flurläufer',           'teppich', '🟪', 110, 60, 1, 1)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order),
  rotatable    = VALUES(rotatable),
  is_active    = VALUES(is_active);
