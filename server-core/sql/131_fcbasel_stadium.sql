-- Fügt das Stadion FC Basel als Spezialgebäude hinzu.
-- Gleiche Werte wie das normale Stadion (3x3, 5000 CHF, 45s Bauzeit, 400 Tageseinkommen).

INSERT INTO game_item_details (tool, display_name, category, footprint_width, footprint_height, build_cost, is_active, build_time_seconds, pollution, daily_income)
VALUES ('fcbasel_stadium', 'Stadion FC Basel', 'service', 3, 3, 5000, 1, 45, 5, 400)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  category = VALUES(category),
  footprint_width = VALUES(footprint_width),
  footprint_height = VALUES(footprint_height),
  build_cost = VALUES(build_cost),
  build_time_seconds = VALUES(build_time_seconds),
  pollution = VALUES(pollution),
  daily_income = VALUES(daily_income);
