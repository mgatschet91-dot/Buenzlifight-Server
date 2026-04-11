-- ============================================================
-- 085_buenzli_dispatches.sql
-- Büenzli-Inspektor Dispatches: Server-autoritativ, 1h Suche
-- Ziel-Gemeinde muss NICHT online sein.
-- ============================================================

CREATE TABLE IF NOT EXISTS buenzli_dispatches (
  id                      BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  sender_user_id          BIGINT UNSIGNED  NOT NULL,
  sender_municipality_id  BIGINT UNSIGNED  NOT NULL,
  target_municipality_id  BIGINT UNSIGNED  NOT NULL,
  quiz_score              TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0-3 richtige Antworten',
  status                  ENUM('searching','found_violation','found_nothing','cancelled') NOT NULL DEFAULT 'searching',
  dispatched_at           DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  arrives_at              DATETIME         NOT NULL COMMENT 'Zeitpunkt wenn Suche abgeschlossen',
  resolved_at             DATETIME         DEFAULT NULL,
  fine_amount             INT UNSIGNED     NOT NULL DEFAULT 0 COMMENT 'CHF Busse aus Gemeinekasse',
  event_id                BIGINT UNSIGNED  DEFAULT NULL COMMENT 'Verknuepfter municipality_events Eintrag',
  violation_type          VARCHAR(64)      DEFAULT NULL COMMENT 'event_types.code',
  notification_sent       TINYINT(1)       NOT NULL DEFAULT 0,
  sender_rewarded         TINYINT(1)       NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  INDEX idx_bd_sender   (sender_user_id),
  INDEX idx_bd_target   (target_municipality_id),
  INDEX idx_bd_status   (status, arrives_at),
  INDEX idx_bd_dispatched (dispatched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
