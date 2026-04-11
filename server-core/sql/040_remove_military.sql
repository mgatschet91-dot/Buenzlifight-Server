-- ============================================================
-- 040_remove_military.sql
-- Militaer-System komplett entfernen
-- ============================================================

-- 1) Tabellen droppen
DROP TABLE IF EXISTS military_attacks;
DROP TABLE IF EXISTS municipality_military;

-- 2) Militaer-Gebaeude aus game_item_details entfernen
DELETE FROM game_item_details WHERE tool IN ('military_base', 'military_barracks');
