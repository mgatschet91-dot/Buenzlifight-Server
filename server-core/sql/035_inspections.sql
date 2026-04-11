-- ============================================================
-- 035_inspections.sql
-- Server-seitige Inspektion: verhindert Client-seitiges Cheaten
--
-- Jede Inspektion wird serverseitig gestartet und erst nach
-- Ablauf der Wartezeit koennen Ergebnisse abgerufen werden.
-- ============================================================

CREATE TABLE IF NOT EXISTS inspections (
  id              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED  NOT NULL,
  municipality_id BIGINT UNSIGNED  NOT NULL,
  tile_x          INT              NOT NULL,
  tile_y          INT              NOT NULL,
  radius          INT              NOT NULL DEFAULT 5,
  status          ENUM('searching','completed','cancelled') NOT NULL DEFAULT 'searching',
  started_at      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completes_at    DATETIME         NOT NULL COMMENT 'Zeitpunkt ab dem Ergebnisse abrufbar sind',
  completed_at    DATETIME         DEFAULT NULL,
  cancelled_at    DATETIME         DEFAULT NULL,
  created_at      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_insp_user (user_id),
  INDEX idx_insp_status (user_id, status),
  INDEX idx_insp_municipality (municipality_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
