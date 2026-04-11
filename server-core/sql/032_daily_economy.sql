-- ============================================================
-- 032: Taegliches Wirtschaftssystem (Echtzeit-Economy)
-- ============================================================
-- Fuegt daily_income Spalte zu game_item_details hinzu.
-- Gebaeude generieren taegliches Einkommen fuer die Gemeindekasse.
-- ROI (Return on Investment) Zielwert: 5-10 Tage pro Gebaeude.
-- ============================================================

-- 1) daily_income Spalte hinzufuegen
ALTER TABLE game_item_details
  ADD COLUMN daily_income INT NOT NULL DEFAULT 0
  AFTER build_cost;

-- 2) Gebaeude-Einkommen setzen (Commercial)
UPDATE game_item_details SET daily_income = 120 WHERE tool = 'shop_small';
UPDATE game_item_details SET daily_income = 180 WHERE tool = 'shop_medium';
UPDATE game_item_details SET daily_income = 100 WHERE tool = 'office_building_small';
UPDATE game_item_details SET daily_income = 300 WHERE tool = 'office_low';
UPDATE game_item_details SET daily_income = 600 WHERE tool = 'office_high';
UPDATE game_item_details SET daily_income = 900 WHERE tool = 'mall';

-- 3) Gebaeude-Einkommen setzen (Industrial)
UPDATE game_item_details SET daily_income = 170 WHERE tool = 'factory_small';
UPDATE game_item_details SET daily_income = 320 WHERE tool = 'factory_medium';
UPDATE game_item_details SET daily_income = 650 WHERE tool = 'factory_large';
UPDATE game_item_details SET daily_income = 230 WHERE tool = 'warehouse';

-- 4) Gebaeude-Einkommen setzen (Unterhaltung/Tourismus)
UPDATE game_item_details SET daily_income = 400 WHERE tool = 'stadium';
UPDATE game_item_details SET daily_income = 280 WHERE tool = 'museum';
UPDATE game_item_details SET daily_income = 700 WHERE tool = 'airport';
UPDATE game_item_details SET daily_income = 800 WHERE tool = 'amusement_park';

-- 5) Kleinere Einkommen fuer weitere Gebaeude
UPDATE game_item_details SET daily_income = 50  WHERE tool = 'community_center';
UPDATE game_item_details SET daily_income = 80  WHERE tool = 'marina_docks_small';
UPDATE game_item_details SET daily_income = 60  WHERE tool = 'roller_coaster_small';
UPDATE game_item_details SET daily_income = 40  WHERE tool = 'go_kart_track';
UPDATE game_item_details SET daily_income = 30  WHERE tool = 'amphitheater';
UPDATE game_item_details SET daily_income = 25  WHERE tool = 'campground';
UPDATE game_item_details SET daily_income = 20  WHERE tool = 'swimming_pool';
UPDATE game_item_details SET daily_income = 15  WHERE tool = 'mini_golf_course';
UPDATE game_item_details SET daily_income = 35  WHERE tool = 'mountain_lodge';
UPDATE game_item_details SET daily_income = 150 WHERE tool = 'military_base';
UPDATE game_item_details SET daily_income = 50  WHERE tool = 'military_barracks';

-- ============================================================
-- 6) Meilenstein-Tabelle fuer Population-Boni
-- ============================================================
CREATE TABLE IF NOT EXISTS municipality_milestones (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  municipality_id INT UNSIGNED NOT NULL,
  milestone_code VARCHAR(50) NOT NULL,
  bonus_amount INT NOT NULL DEFAULT 0,
  reached_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_muni_milestone (municipality_id, milestone_code),
  KEY idx_muni_id (municipality_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7) Vordefinierte Meilenstein-Konfiguration als Referenz
-- (wird im Server-Code als Konstante definiert, nicht in DB)
-- POP_100:   100 Pop → 5,000 Bonus
-- POP_500:   500 Pop → 15,000 Bonus
-- POP_1000: 1000 Pop → 50,000 Bonus
-- POP_2000: 2000 Pop → 100,000 Bonus
-- POP_3000: 3000 Pop → 200,000 Bonus
