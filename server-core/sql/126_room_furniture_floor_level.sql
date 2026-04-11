-- Migration 126: floor_level Spalte zu room_furniture hinzufügen
-- Ermöglicht korrektes Laden von Möbeln auf Obergeschossen (Etage 1, 2, ...)

ALTER TABLE room_furniture
  ADD COLUMN floor_level TINYINT NOT NULL DEFAULT 0
  AFTER z;
