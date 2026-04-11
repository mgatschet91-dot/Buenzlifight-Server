-- Bus Station (Busbahnhof) 4x4 building
INSERT INTO game_item_details (tool, display_name, category, build_cost, footprint_width, footprint_height, is_active)
VALUES ('bus_station', 'Busbahnhof', 'infrastructure', 3000, 4, 4, 1)
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), build_cost = VALUES(build_cost),
  footprint_width = VALUES(footprint_width), footprint_height = VALUES(footprint_height);
