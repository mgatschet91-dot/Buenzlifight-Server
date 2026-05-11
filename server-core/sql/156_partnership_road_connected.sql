-- Speichert ob eine Randstrasse in Richtung des Handelspartners existiert.
-- Wird vom Client beim Laden gesetzt. Kein Income wenn 0.
ALTER TABLE game_partnerships
  ADD COLUMN road_connected TINYINT(1) NOT NULL DEFAULT 1;
