-- Migration 121: Shop-Updates
-- 1) Treppen deaktivieren (werden durch Teleporter ersetzt)
UPDATE shop_items SET is_active = 0
  WHERE item_code IN ('stair_wood','stair_stone','stair_metal','stair_open','stair_down');

-- 2) Kühlschrank von bar → kueche verschieben
UPDATE shop_items SET category = 'kueche', sort_order = 60 WHERE item_code = 'fridge';

-- 3) Roller von party → sport verschieben
UPDATE shop_items SET category = 'sport', sort_order = 50 WHERE item_code = 'roller';

-- 4) Teleporter hinzufügen (1 kaufen = 2 Stück im Inventar, gehandhabt vom Backend)
INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order, rotatable, is_active) VALUES
  ('teleporter', 'Teleporter', 'spezial', '🌀', 800, 10, 0, 1)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order),
  rotatable    = VALUES(rotatable),
  is_active    = VALUES(is_active);
