-- Steam Avatar URL für Profil-Anzeige (wird beim Login von Steam Web API geholt)
ALTER TABLE users
  ADD COLUMN steam_avatar_url VARCHAR(255) NULL DEFAULT NULL
  AFTER steam_id;
