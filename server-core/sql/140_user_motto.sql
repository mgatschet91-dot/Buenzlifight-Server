-- Migration 140: Motto-Feld für Spieler (Habbo-Style)
ALTER TABLE users ADD COLUMN motto VARCHAR(128) NULL DEFAULT NULL;
