-- Default build times (seconds) for larger projects and key service buildings

UPDATE game_item_details SET build_time_seconds = 25 WHERE tool IN ('hospital', 'school', 'city_hall');
UPDATE game_item_details SET build_time_seconds = 35 WHERE tool IN ('power_plant', 'rail_station', 'warehouse');
UPDATE game_item_details SET build_time_seconds = 60 WHERE tool IN ('water_tower');
UPDATE game_item_details SET build_time_seconds = 45 WHERE tool IN ('stadium', 'museum', 'university', 'military_barracks');
UPDATE game_item_details SET build_time_seconds = 60 WHERE tool IN ('airport', 'space_program', 'military_base');
UPDATE game_item_details SET build_time_seconds = 50 WHERE tool IN ('amusement_park', 'baseball_stadium', 'mountain_trailhead');
