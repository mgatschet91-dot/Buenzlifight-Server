-- Migration 109: Shop-Items – Treppen
-- item_code = ID in CATALOG_CATS['treppen'] in game3d.js

INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order) VALUES
  ('stair_wood',  'Holztreppe',   'treppen', '🪵',  200, 10),
  ('stair_stone', 'Steintreppe',  'treppen', '🧱',  180, 20),
  ('stair_metal', 'Metalltreppe', 'treppen', '⚙️',  220, 30),
  ('stair_open',  'Glastreppe',   'treppen', '✨',  280, 40),
  ('stair_down',  'Kellertreppe', 'treppen', '⬇️',  160, 50)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order);
