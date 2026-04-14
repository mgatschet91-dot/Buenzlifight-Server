INSERT INTO game_item_details (tool, display_name, category, footprint_width, footprint_height, build_cost, is_active, build_time_seconds, pollution, daily_income)
VALUES ('disco_solothurn', 'Druckerei Solothurn', 'service', 2, 2, 5000, 1, 45, 3, 350)
ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), category=VALUES(category), footprint_width=VALUES(footprint_width), footprint_height=VALUES(footprint_height), build_cost=VALUES(build_cost), is_active=VALUES(is_active), build_time_seconds=VALUES(build_time_seconds), pollution=VALUES(pollution), daily_income=VALUES(daily_income);
