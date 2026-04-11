-- Bus Stop Gebäude (ÖV-System Phase 1)
INSERT INTO game_item_details (tool, display_name, category, build_cost, footprint_width, footprint_height, is_active)
VALUES ('bus_stop', 'Bushaltestelle', 'infrastructure', 120, 1, 1, 1)
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), category = VALUES(category), build_cost = VALUES(build_cost);
