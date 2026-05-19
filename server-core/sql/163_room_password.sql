-- Feature: Raum-Passwort / Türschloss
-- Fügt is_locked und room_password_hash zur user_room_settings Tabelle hinzu

ALTER TABLE user_room_settings
  ADD COLUMN is_locked          TINYINT(1)    NOT NULL DEFAULT 0,
  ADD COLUMN room_password_hash VARCHAR(100)  NULL DEFAULT NULL;
