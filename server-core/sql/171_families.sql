-- 171: Familien-Tabelle für das Bürger-System
-- Gruppiert Bürger zu Familien mit gemeinsamem Nachnamen.
-- surname_seed wird client-seitig deterministisch zum Namen aufgelöst.
CREATE TABLE IF NOT EXISTS families (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id  INT UNSIGNED NOT NULL,
  surname_seed     INT UNSIGNED NOT NULL,
  size             TINYINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  INDEX idx_municipality (municipality_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
