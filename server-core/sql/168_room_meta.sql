-- Raum-Metadaten: Anzeigename, Beschreibung, max. Besucherzahl
ALTER TABLE user_room_settings
  ADD COLUMN room_display_name VARCHAR(60)  NULL DEFAULT NULL,
  ADD COLUMN room_description  VARCHAR(200) NULL DEFAULT NULL,
  ADD COLUMN max_visitors      TINYINT UNSIGNED NOT NULL DEFAULT 25;
