-- 173: Migrations-Log für Bürger-Umzüge zwischen Gemeinden
-- reason_code: 'crime_too_high' | 'no_job' | 'low_happiness' | 'better_job' | 'attracted'
-- Nur die letzten 3 Einträge pro Bürger werden behalten (Cleanup via citizens.js)
CREATE TABLE IF NOT EXISTS citizen_migrations (
  id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  citizen_id           INT UNSIGNED NOT NULL,
  from_municipality_id INT UNSIGNED,
  to_municipality_id   INT UNSIGNED NOT NULL,
  reason_code          VARCHAR(32) NOT NULL,
  migrated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_citizen    (citizen_id, migrated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
