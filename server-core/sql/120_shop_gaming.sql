-- Migration 120: Shop-Kategorie Gaming
INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order, rotatable, is_active) VALUES
  ('arcade_machine',  'Arcade-Automat',  'gaming', '🕹️', 500, 10, 1, 1),
  ('pinball_machine', 'Flipperautomat',  'gaming', '🎰', 450, 20, 1, 1),
  ('gaming_chair',    'Gaming-Stuhl',    'gaming', '🎮', 250, 30, 1, 1),
  ('pool_table',      'Billardtisch',    'gaming', '🎱', 380, 40, 1, 1)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order),
  rotatable    = VALUES(rotatable),
  is_active    = VALUES(is_active);
