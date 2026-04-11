-- Swiss rivers data table (sorted/filterable by canton)

CREATE TABLE IF NOT EXISTS game_data_rivers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(191) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  canton_code CHAR(2) NOT NULL,
  canton_name VARCHAR(100) NOT NULL,
  length_km DECIMAL(6,2) NULL,
  source_name VARCHAR(191) NULL,
  mouth_name VARCHAR(191) NULL,
  river_type ENUM('river', 'stream', 'canal') NOT NULL DEFAULT 'river',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_game_data_rivers_slug (slug),
  KEY idx_game_data_rivers_canton_name (canton_code, name),
  KEY idx_game_data_rivers_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO game_data_rivers (name, slug, canton_code, canton_name, length_km, source_name, mouth_name, river_type, is_active)
VALUES
  ('Aare', 'aare', 'BE', 'Bern', 295.00, 'Oberaarsee', 'Rhein', 'river', 1),
  ('Reuss', 'reuss', 'LU', 'Luzern', 164.00, 'Gotthardmassiv', 'Aare', 'river', 1),
  ('Limmat', 'limmat', 'ZH', 'Zuerich', 36.00, 'Zuerichsee', 'Aare', 'river', 1),
  ('Rhein', 'rhein', 'SH', 'Schaffhausen', 1230.00, 'Vorderrhein/Hinterrhein', 'Nordsee', 'river', 1),
  ('Rhone', 'rhone', 'VS', 'Wallis', 812.00, 'Rhonegletscher', 'Mittelmeer', 'river', 1),
  ('Thur', 'thur', 'TG', 'Thurgau', 134.00, 'Saentisgebiet', 'Rhein', 'river', 1),
  ('Linth', 'linth', 'GL', 'Glarus', 50.00, 'Tobelseegebiet', 'Walensee', 'river', 1),
  ('Sihl', 'sihl', 'ZH', 'Zuerich', 68.00, 'Drusberggebiet', 'Limmat', 'river', 1),
  ('Birs', 'birs', 'BL', 'Basel-Landschaft', 73.00, 'Jura', 'Rhein', 'river', 1),
  ('Emme', 'emme', 'BE', 'Bern', 80.00, 'Entlebuch', 'Aare', 'river', 1),
  ('Ticino', 'ticino', 'TI', 'Tessin', 248.00, 'Nufenengebiet', 'Po', 'river', 1),
  ('Inn', 'inn', 'GR', 'Graubuenden', 517.00, 'Malojagebiet', 'Donau', 'river', 1)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  canton_code = VALUES(canton_code),
  canton_name = VALUES(canton_name),
  length_km = VALUES(length_km),
  source_name = VALUES(source_name),
  mouth_name = VALUES(mouth_name),
  river_type = VALUES(river_type),
  is_active = VALUES(is_active),
  updated_at = CURRENT_TIMESTAMP;
