-- Migration 069: Gebäude-Statistiken in game_item_details speichern
-- Fügt max_pop, max_jobs, power_production, power_consumption_base, land_value hinzu
-- Werte werden beim Serverstart durch seedBuildingStatsToDb() aus HARD_CODED_BUILDING_STATS befüllt

ALTER TABLE game_item_details
  ADD COLUMN max_pop INT NOT NULL DEFAULT 0 AFTER pollution,
  ADD COLUMN max_jobs INT NOT NULL DEFAULT 0 AFTER max_pop,
  ADD COLUMN power_production INT NOT NULL DEFAULT 0 AFTER max_jobs,
  ADD COLUMN power_consumption_base INT NOT NULL DEFAULT 0 AFTER power_production,
  ADD COLUMN land_value INT NOT NULL DEFAULT 0 AFTER power_consumption_base;
