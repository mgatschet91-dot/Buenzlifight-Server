-- Migration 107: Shop-Items – Bilder
-- item_code = ID in CATALOG_CATS['bilder'] in game3d.js

INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order) VALUES
  ('frame_blue', 'Rahmen Blau',   'bilder', '🖼️',  100, 10),
  ('frame_red',  'Rahmen Rot',    'bilder', '🖼️',  100, 20),
  ('frame_gold', 'Rahmen Gold',   'bilder', '🖼️',  180, 30),
  ('frame_dark', 'Rahmen Dunkel', 'bilder', '🖼️',  100, 40)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order);
