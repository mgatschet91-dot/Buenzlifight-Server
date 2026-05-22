-- 172: Bürger-Tabelle – Kern des Citizen-Systems
-- Jeder Bürger ist einem Wohngebäude und optional einem Arbeitsort zugewiesen.
-- name_seed + nationality_id werden client-seitig zu Name/Beruf aufgelöst (kein String gespeichert).
-- education: 0=keine, 1=Lehre, 2=FH/HF, 3=Uni
-- nationality_id: 0=CH-Deutsch, 1=CH-Französisch, 2=IT, 3=DE, 4=PT, 5=SR/HR, 6=TR, 7=ES, 8=AL, 9=FR, 10=andere
CREATE TABLE IF NOT EXISTS citizens (
  id                       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id          INT UNSIGNED NOT NULL,
  family_id                INT UNSIGNED,
  name_seed                INT UNSIGNED NOT NULL,
  age                      TINYINT UNSIGNED NOT NULL,
  gender                   TINYINT(1) NOT NULL DEFAULT 0,
  nationality_id           TINYINT UNSIGNED NOT NULL DEFAULT 0,
  education                TINYINT UNSIGNED NOT NULL DEFAULT 0,
  home_building_id         INT UNSIGNED,
  workplace_id             INT UNSIGNED,
  happiness                TINYINT UNSIGNED NOT NULL DEFAULT 70,
  has_car                  TINYINT(1) NOT NULL DEFAULT 0,
  origin_municipality_id   INT UNSIGNED,
  previous_municipality_id INT UNSIGNED,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_municipality   (municipality_id),
  INDEX idx_home           (home_building_id),
  INDEX idx_workplace      (workplace_id),
  INDEX idx_happiness      (municipality_id, happiness)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
