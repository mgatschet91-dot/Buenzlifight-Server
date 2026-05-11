ALTER TABLE game_item_details
  ADD COLUMN canton_code CHAR(2) NULL DEFAULT NULL
    AFTER is_active;
