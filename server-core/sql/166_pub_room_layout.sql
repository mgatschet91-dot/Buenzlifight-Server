-- Migration 166: PUB-Room Layout als JSON in game_rooms speichern
-- Ermöglicht das Bearbeiten öffentlicher Räume im Room-Editor.
-- Das Layout wird als v:1 JSON-Blob gespeichert (analog user_room_floors/staircases).

ALTER TABLE game_rooms
  ADD COLUMN layout_json LONGTEXT NULL DEFAULT NULL AFTER game_state;
