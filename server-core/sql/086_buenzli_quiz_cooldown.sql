-- 086_buenzli_quiz_cooldown.sql
-- Server-seitiger Quiz-Cooldown: kein localStorage-Bypass möglich
ALTER TABLE users ADD COLUMN buenzli_quiz_failed_at DATETIME NULL DEFAULT NULL;
