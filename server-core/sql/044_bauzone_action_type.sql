-- Add 'bauzone' to game_items.action_type ENUM
-- Allows storing building zone markers per tile

ALTER TABLE game_items
  MODIFY COLUMN action_type ENUM('place', 'zone', 'bulldoze', 'bauzone', 'stats_update') NOT NULL;
