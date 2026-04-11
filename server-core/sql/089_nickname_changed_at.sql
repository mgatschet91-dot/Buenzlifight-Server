ALTER TABLE users
  ADD COLUMN nickname_changed_at DATETIME NULL DEFAULT NULL
    COMMENT 'Timestamp of last nickname change (for 30-day cooldown)';
