-- Migration 105: Shop-Items – Möbel
-- item_code = ID in CATALOG_CATS['moebel'] in game3d.js

INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order) VALUES
  ('chair',     'Stuhl',      'moebel', '🪑',  150,  10),
  ('table',     'Tisch',      'moebel', '🪵',  200,  20),
  ('sofa',      'Sofa',       'moebel', '🛋️',  350,  30),
  ('armchair',  'Sessel',     'moebel', '🛋️',  280,  40),
  ('lamp',      'Lampe',      'moebel', '💡',  120,  50),
  ('plant',     'Pflanze',    'moebel', '🌿',   80,  60),
  ('bookshelf', 'Regal',      'moebel', '📚',  220,  70),
  ('tv',        'Fernseher',  'moebel', '📺',  400,  80),
  ('dresser',   'Kommode',    'moebel', '🗄️',  250,  90),
  ('bed',       'Bett',       'moebel', '🛏️',  500, 100)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order);
