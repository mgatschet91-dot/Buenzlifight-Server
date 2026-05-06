-- Migration 152: Baukosten korrigieren & fehlende Gebäude eintragen
-- Sync zwischen SQL (Wahrheitsquelle) und Client game.ts

-- DIFF-Fixes
UPDATE game_item_details SET build_cost = 1500  WHERE tool = 'solar_panel';
UPDATE game_item_details SET build_cost = 1800  WHERE tool = 'water_reservoir';
UPDATE game_item_details SET build_cost = 220   WHERE tool = 'parking_spot';

-- Fehlende Gebäude aus Client (game.ts) in DB eintragen
INSERT INTO game_item_details (tool, display_name, category, footprint_width, footprint_height, build_cost, is_active)
VALUES
  ('woodcutter_house', 'Holzfäller-Haus', 'service',        1, 1,  500, 1),
  ('werkhof',          'Werkhof',          'service',        2, 2, 4500, 1),
  ('bank_house',       'Bank',             'commercial',     1, 1, 2000, 1)
ON DUPLICATE KEY UPDATE
  build_cost   = VALUES(build_cost),
  display_name = VALUES(display_name),
  is_active    = 1;
