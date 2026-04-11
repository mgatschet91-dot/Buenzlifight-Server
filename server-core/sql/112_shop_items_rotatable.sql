-- Migration 112: rotatable flag auf shop_items
-- Gibt an ob ein Möbel-Item im 3D-Raum gedreht werden kann.
-- Wird von game3d.js für das Ghost-Placement und Rotations-UI verwendet.

ALTER TABLE shop_items
  ADD COLUMN rotatable TINYINT(1) NOT NULL DEFAULT 0
  AFTER sort_order;

-- Möbel (moebel) — rotierbar außer Lampe + Pflanze
UPDATE shop_items SET rotatable = 1 WHERE item_code IN ('chair','sofa','armchair','bookshelf','tv','dresser','bed');
UPDATE shop_items SET rotatable = 0 WHERE item_code IN ('table','lamp','plant');

-- Party
UPDATE shop_items SET rotatable = 1 WHERE item_code IN ('roller','djdesk','partyflag','neon');
UPDATE shop_items SET rotatable = 0 WHERE item_code IN ('discoball','balloon');

-- Bilder (alle rotierbar — Wandausrichtung)
UPDATE shop_items SET rotatable = 1 WHERE item_code IN ('frame_blue','frame_red','frame_gold','frame_dark');

-- Hocker
UPDATE shop_items SET rotatable = 1 WHERE item_code IN ('bench');
UPDATE shop_items SET rotatable = 0 WHERE item_code IN ('barstool','ottoman','stool');

-- Treppen (alle rotierbar)
UPDATE shop_items SET rotatable = 1 WHERE item_code IN ('stair_wood','stair_stone','stair_metal','stair_open','stair_down');

-- Bar
UPDATE shop_items SET rotatable = 1 WHERE item_code IN ('barcounter','drinksshelf','fridge');
UPDATE shop_items SET rotatable = 0 WHERE item_code IN ('cocktailtable','beertap');
