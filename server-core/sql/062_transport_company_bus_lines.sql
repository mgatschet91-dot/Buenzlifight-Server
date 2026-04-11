-- ============================================================
-- 062: Transport-Firmentyp + Buslinien-Tabellen
-- ============================================================

-- Neuer Firmentyp: ÖV-Firma
INSERT INTO company_types (code, name, emoji, description, can_fix_categories, founding_cost, min_level, max_members)
VALUES ('transport', 'ÖV-Firma', '🚌', 'Verwaltet Buslinien und den öffentlichen Verkehr der Gemeinde.', '[]', 5000, 3, 10)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  emoji = VALUES(emoji),
  description = VALUES(description),
  founding_cost = VALUES(founding_cost),
  min_level = VALUES(min_level),
  max_members = VALUES(max_members);

-- Buslinien einer Transport-Firma
CREATE TABLE IF NOT EXISTS bus_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  municipality_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  color VARCHAR(16) NOT NULL DEFAULT '#f59e0b',
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bus_lines_company (company_id),
  KEY idx_bus_lines_municipality (municipality_id, status),
  CONSTRAINT fk_bus_lines_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Haltestellen einer Buslinie (geordnet)
CREATE TABLE IF NOT EXISTS bus_line_stops (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bus_line_id BIGINT UNSIGNED NOT NULL,
  stop_x INT NOT NULL,
  stop_y INT NOT NULL,
  sequence_order INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_line_stop_order (bus_line_id, sequence_order),
  KEY idx_bus_line_stops_line (bus_line_id),
  CONSTRAINT fk_bus_line_stops_line FOREIGN KEY (bus_line_id) REFERENCES bus_lines(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
