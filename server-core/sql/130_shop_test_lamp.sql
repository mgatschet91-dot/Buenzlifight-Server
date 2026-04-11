-- Migration 130: Test Licht (GLB-Modell)
INSERT INTO shop_items (item_code, display_name, category, icon, price, sort_order, rotatable, is_active) VALUES
  ('test_lamp', 'Test Licht', 'spezial', '💡', 1, 999, 1, 1)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category     = VALUES(category),
  icon         = VALUES(icon),
  price        = VALUES(price),
  sort_order   = VALUES(sort_order),
  rotatable    = VALUES(rotatable),
  is_active    = VALUES(is_active);
