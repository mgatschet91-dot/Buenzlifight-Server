-- Standalone SQL: municipalities table + seed

CREATE TABLE IF NOT EXISTS municipalities (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(191) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  canton_code CHAR(2) NOT NULL,
  canton_name VARCHAR(100) NOT NULL,
  bfs_number INT UNSIGNED NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_municipalities_slug (slug),
  UNIQUE KEY uq_municipalities_name_canton (name, canton_code),
  KEY idx_municipalities_canton_active (canton_code, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO municipalities (name, slug, canton_code, canton_name, bfs_number, is_active)
VALUES
  ('Zuerich', 'zurich', 'ZH', 'Zuerich', 261, 1),
  ('Bern', 'bern', 'BE', 'Bern', 351, 1),
  ('Luzern', 'luzern', 'LU', 'Luzern', 1061, 1),
  ('Basel', 'basel', 'BS', 'Basel-Stadt', 2701, 1),
  ('Solothurn', 'solothurn', 'SO', 'Solothurn', 2581, 1),
  ('Winterthur', 'winterthur', 'ZH', 'Zuerich', 230, 1)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  canton_code = VALUES(canton_code),
  canton_name = VALUES(canton_name),
  bfs_number = VALUES(bfs_number),
  is_active = VALUES(is_active),
  updated_at = CURRENT_TIMESTAMP;
