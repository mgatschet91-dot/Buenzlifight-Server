-- Landmark-Gebäude: Preise erhöht (einmalige Spezialgebäude pro Stadt)
UPDATE game_item_details SET build_cost = 50000, daily_income = 1500 WHERE tool = 'fcbasel_stadium';
UPDATE game_item_details SET build_cost = 30000, daily_income = 800  WHERE tool = 'st_ursen_kathedrale';
UPDATE game_item_details SET build_cost = 75000, daily_income = 2500 WHERE tool = 'primetower';
