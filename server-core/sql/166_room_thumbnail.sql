-- Feature: Raum-Thumbnail (Kamera-Tool)
ALTER TABLE user_room_settings
  ADD COLUMN thumbnail_updated_at DATETIME NULL DEFAULT NULL;
