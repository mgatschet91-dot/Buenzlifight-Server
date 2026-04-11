-- Migration 108: Shop-Items – Hocker & Sitze
-- item_code = ID in CATALOG_CATS['hocker'] in game3d.js

INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order) VALUES
  ('barstool', 'Barhocker',   'hocker', '🪑',  120, 10),
  ('ottoman',  'Sitzkissen',  'hocker', '🟫',   90, 20),
  ('bench',    'Bank',        'hocker', '🪵',  160, 30),
  ('stool',    'Hocker',      'hocker', '🪑',   80, 40)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order);
