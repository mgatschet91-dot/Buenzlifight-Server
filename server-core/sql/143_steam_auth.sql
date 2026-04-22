-- Steam-Auth: steam_id Spalte für User-Tabelle
ALTER TABLE users
  ADD COLUMN steam_id VARCHAR(32) NULL DEFAULT NULL UNIQUE
  AFTER password_salt;
