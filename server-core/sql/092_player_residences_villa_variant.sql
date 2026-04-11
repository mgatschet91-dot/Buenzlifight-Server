-- 092: Mansion-Variante pro Wohnsitz speichern
-- Wenn ein Bewohner ein Premium-Villa-Design kauft, wird hier die gewählte
-- Zeile/Spalte im mansion_alternates.png Spritesheet gespeichert.

ALTER TABLE player_residences
  ADD COLUMN mansion_variant_row TINYINT UNSIGNED NULL DEFAULT NULL
    COMMENT 'Zeile im mansion_alternates Spritesheet (0-4)',
  ADD COLUMN mansion_variant_col TINYINT UNSIGNED NULL DEFAULT NULL
    COMMENT 'Spalte im mansion_alternates Spritesheet (0-4)',
  ADD COLUMN villa_paid INT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Bezahlter Betrag für das aktuelle Villa-Design (CHF)';
