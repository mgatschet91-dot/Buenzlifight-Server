-- Verschmutzungswerte fuer Gebaeude in der DB speichern
-- Negative Werte = reduziert Verschmutzung (Baeume, Parks)
-- Positive Werte = erzeugt Verschmutzung (Fabriken, Kraftwerke)

-- Spalte hinzufuegen
ALTER TABLE game_item_details
  ADD COLUMN pollution INT DEFAULT 0 AFTER build_cost;

-- Verschmutzungswerte aus BUILDING_STATS setzen
-- Baeume
UPDATE game_item_details SET pollution = -5 WHERE tool = 'tree';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'tree_oak';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'tree_maple';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'tree_birch';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'tree_willow';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'tree_pine';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'tree_spruce';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'tree_fir';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'tree_cedar';
UPDATE game_item_details SET pollution = -4 WHERE tool = 'tree_palm';
UPDATE game_item_details SET pollution = -4 WHERE tool = 'tree_bamboo';
UPDATE game_item_details SET pollution = -4 WHERE tool = 'tree_coconut';
UPDATE game_item_details SET pollution = -4 WHERE tool = 'tree_cherry';
UPDATE game_item_details SET pollution = -4 WHERE tool = 'tree_magnolia';
UPDATE game_item_details SET pollution = -4 WHERE tool = 'tree_jacaranda';
UPDATE game_item_details SET pollution = -4 WHERE tool = 'tree_wisteria';
-- Buesche & Formschnitt
UPDATE game_item_details SET pollution = -3 WHERE tool = 'bush_hedge';
UPDATE game_item_details SET pollution = -3 WHERE tool = 'bush_flowering';
UPDATE game_item_details SET pollution = -2 WHERE tool = 'topiary_ball';
UPDATE game_item_details SET pollution = -2 WHERE tool = 'topiary_spiral';
-- Blumen
UPDATE game_item_details SET pollution = -3 WHERE tool = 'flower_bed';
UPDATE game_item_details SET pollution = -3 WHERE tool = 'flower_planter';
-- Wohn
UPDATE game_item_details SET pollution = 0 WHERE tool = 'house_small';
UPDATE game_item_details SET pollution = 0 WHERE tool = 'house_medium';
UPDATE game_item_details SET pollution = 0 WHERE tool = 'mansion';
UPDATE game_item_details SET pollution = 2 WHERE tool = 'apartment_low';
UPDATE game_item_details SET pollution = 3 WHERE tool = 'apartment_high';
-- Gewerbe
UPDATE game_item_details SET pollution = 1 WHERE tool = 'shop_small';
UPDATE game_item_details SET pollution = 2 WHERE tool = 'shop_medium';
UPDATE game_item_details SET pollution = 2 WHERE tool = 'office_low';
UPDATE game_item_details SET pollution = 3 WHERE tool = 'office_high';
UPDATE game_item_details SET pollution = 6 WHERE tool = 'mall';
-- Industrie
UPDATE game_item_details SET pollution = 15 WHERE tool = 'factory_small';
UPDATE game_item_details SET pollution = 28 WHERE tool = 'factory_medium';
UPDATE game_item_details SET pollution = 55 WHERE tool = 'factory_large';
UPDATE game_item_details SET pollution = 18 WHERE tool = 'warehouse';
-- Services
UPDATE game_item_details SET pollution = 0 WHERE tool = 'police_station';
UPDATE game_item_details SET pollution = 0 WHERE tool = 'fire_station';
UPDATE game_item_details SET pollution = 0 WHERE tool = 'hospital';
UPDATE game_item_details SET pollution = 0 WHERE tool = 'school';
UPDATE game_item_details SET pollution = 0 WHERE tool = 'university';
-- Parks & Erholung
UPDATE game_item_details SET pollution = -10 WHERE tool = 'park';
UPDATE game_item_details SET pollution = -25 WHERE tool = 'park_large';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'tennis';
UPDATE game_item_details SET pollution = -3 WHERE tool = 'basketball_courts';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'playground_small';
UPDATE game_item_details SET pollution = -8 WHERE tool = 'playground_large';
UPDATE game_item_details SET pollution = -10 WHERE tool = 'baseball_field_small';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'soccer_field_small';
UPDATE game_item_details SET pollution = -8 WHERE tool = 'football_field';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'swimming_pool';
UPDATE game_item_details SET pollution = -3 WHERE tool = 'skate_park';
UPDATE game_item_details SET pollution = -8 WHERE tool = 'mini_golf_course';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'bleachers_field';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'amphitheater';
UPDATE game_item_details SET pollution = -15 WHERE tool = 'greenhouse_garden';
UPDATE game_item_details SET pollution = -12 WHERE tool = 'community_garden';
UPDATE game_item_details SET pollution = -15 WHERE tool = 'pond_park';
UPDATE game_item_details SET pollution = -2 WHERE tool = 'park_gate';
UPDATE game_item_details SET pollution = -8 WHERE tool = 'campground';
UPDATE game_item_details SET pollution = -3 WHERE tool = 'cabin_house';
UPDATE game_item_details SET pollution = -5 WHERE tool = 'mountain_lodge';
UPDATE game_item_details SET pollution = -10 WHERE tool = 'mountain_trailhead';
-- Infrastruktur
UPDATE game_item_details SET pollution = 30 WHERE tool = 'power_plant';
UPDATE game_item_details SET pollution = 0 WHERE tool = 'water_tower';
UPDATE game_item_details SET pollution = 2 WHERE tool = 'road';
UPDATE game_item_details SET pollution = 1 WHERE tool = 'rail';
UPDATE game_item_details SET pollution = 1 WHERE tool = 'bridge';
UPDATE game_item_details SET pollution = 0 WHERE tool = 'subway_station';
UPDATE game_item_details SET pollution = 2 WHERE tool = 'rail_station';
-- Spezial
UPDATE game_item_details SET pollution = 5 WHERE tool = 'stadium';
UPDATE game_item_details SET pollution = 0 WHERE tool = 'museum';
UPDATE game_item_details SET pollution = 20 WHERE tool = 'airport';
UPDATE game_item_details SET pollution = 5 WHERE tool = 'space_program';
UPDATE game_item_details SET pollution = 0 WHERE tool = 'city_hall';
UPDATE game_item_details SET pollution = 8 WHERE tool = 'amusement_park';
UPDATE game_item_details SET pollution = 5 WHERE tool = 'baseball_stadium';
UPDATE game_item_details SET pollution = 0 WHERE tool = 'community_center';
UPDATE game_item_details SET pollution = 1 WHERE tool = 'office_building_small';
UPDATE game_item_details SET pollution = 5 WHERE tool = 'go_kart_track';
UPDATE game_item_details SET pollution = 2 WHERE tool = 'animal_pens_farm';
UPDATE game_item_details SET pollution = 2 WHERE tool = 'marina_docks_small';
UPDATE game_item_details SET pollution = 1 WHERE tool = 'pier_large';
UPDATE game_item_details SET pollution = 3 WHERE tool = 'roller_coaster_small';
-- Militaer
UPDATE game_item_details SET pollution = 10 WHERE tool = 'military_base';
UPDATE game_item_details SET pollution = 5 WHERE tool = 'military_barracks';
