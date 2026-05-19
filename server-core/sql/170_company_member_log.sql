-- 170: Mitglieder-Abgangs-Log für Bewerbungs-Cooldown
-- Trackt wann ein User eine Firma verlassen oder gekickt wurde.
-- Wird genutzt um eine 5-Tage-Bewerbungssperre nach Abgang/Kick durchzusetzen.
CREATE TABLE IF NOT EXISTS company_member_log (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id  INT UNSIGNED NOT NULL,
  user_id     INT UNSIGNED NOT NULL,
  reason      ENUM('left', 'kicked') NOT NULL,
  removed_at  DATETIME NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  INDEX idx_cooldown (company_id, user_id, removed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
