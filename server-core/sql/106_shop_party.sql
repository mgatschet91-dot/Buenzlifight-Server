-- Migration 106: Shop-Items – Party
-- item_code = ID in CATALOG_CATS['party'] in game3d.js

INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order) VALUES
  ('discoball',  'Discokugel',   'party', '🪩',  300,  10),
  ('djdesk',     'DJ-Pult',      'party', '🎧',  450,  20),
  ('balloon',    'Ballons',      'party', '🎈',   60,  30),
  ('partyflag',  'Girlande',     'party', '🎊',   80,  40),
  ('neon',       'Neonschild',   'party', '✨',  250,  50),
  ('roller',     'Roller',       'party', '🔄',  350,  60)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order);
