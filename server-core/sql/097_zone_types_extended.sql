-- Migration 097: Erweitere zone_type ENUM um 'nature' und 'mixed'
ALTER TABLE game_items
  MODIFY COLUMN zone_type
  ENUM('residential','commercial','industrial','nature','mixed','none') NULL;
