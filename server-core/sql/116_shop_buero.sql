-- Migration 116: Shop-Kategorie Büro
INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order, rotatable, is_active) VALUES
  ('desk_office',     'Schreibtisch',    'buero', '💼', 140, 10, 1, 1),
  ('chair_office',    'Bürostuhl',       'buero', '🪑', 110, 20, 1, 1),
  ('computer',        'Computer',        'buero', '💻', 200, 30, 1, 1),
  ('whiteboard',      'Whiteboard',      'buero', '📋', 90,  40, 1, 1),
  ('filing_cabinet',  'Aktenschrank',    'buero', '🗄️', 100, 50, 1, 1)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order),
  rotatable    = VALUES(rotatable),
  is_active    = VALUES(is_active);
