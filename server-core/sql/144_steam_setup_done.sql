ALTER TABLE users
  ADD COLUMN steam_setup_done TINYINT(1) NOT NULL DEFAULT 0 AFTER steam_id;
