-- Migration 110: Shop-Items – Bar
-- item_code = ID in CATALOG_CATS['bar'] in game3d.js

INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order) VALUES
  ('barcounter',    'Bartresen',     'bar', '🍺',  380, 10),
  ('drinksshelf',   'Getränkeregal', 'bar', '🍾',  220, 20),
  ('cocktailtable', 'Cocktailtisch', 'bar', '🍹',  170, 30),
  ('fridge',        'Kühlschrank',   'bar', '🧊',  300, 40),
  ('beertap',       'Zapfhahn',      'bar', '🍻',  250, 50)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order);
