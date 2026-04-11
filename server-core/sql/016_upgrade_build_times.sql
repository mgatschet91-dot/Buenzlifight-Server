-- Upgrade-Bauzeiten fuer Service-Gebaeude
-- upgrade_build_time_seconds = Basis-Sekunden fuer L1->L2
-- Hoehere Levels skalieren: L2->L3 = 2x, L3->L4 = 4x, L4->L5 = 8x
-- Formel: upgrade_build_time_seconds * pow(2, targetLevel - 2)

-- Spalte hinzufuegen (bei erneutem Ausfuehren: Fehler ignorieren falls schon vorhanden)
ALTER TABLE game_item_details
  ADD COLUMN upgrade_build_time_seconds INT UNSIGNED NULL AFTER build_time_seconds;

-- Sicherstellen dass alle Service-Gebaeude existieren (auch 1x1 die evtl. fehlen)
-- Dann upgrade_build_time_seconds setzen
INSERT INTO game_item_details (tool, display_name, category, footprint_width, footprint_height, build_cost, upgrade_build_time_seconds, is_active)
VALUES
  ('police_station', 'Police Station', 'service', 1, 1, 500, 7200, 1),
  ('fire_station', 'Fire Station', 'service', 1, 1, 500, 7200, 1),
  ('hospital', 'Hospital', 'service', 2, 2, 1000, 14400, 1),
  ('school', 'School', 'service', 2, 2, 400, 10800, 1),
  ('university', 'University', 'service', 3, 3, 2000, 21600, 1),
  ('power_plant', 'Power Plant', 'infrastructure', 2, 2, 3000, 14400, 1),
  ('water_tower', 'Water Tower', 'infrastructure', 1, 1, 1000, 3600, 1)
ON DUPLICATE KEY UPDATE
  upgrade_build_time_seconds = VALUES(upgrade_build_time_seconds),
  updated_at = CURRENT_TIMESTAMP;
