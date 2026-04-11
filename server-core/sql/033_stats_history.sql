-- ============================================================
-- 033: Taegliche Statistik-History fuer Gemeinden
-- ============================================================
-- Ein Snapshot pro Tag pro Room. Wird beim Recompute gespeichert.
-- Ermoeglicht historische Trends im StatisticsPanel.
-- ============================================================

CREATE TABLE IF NOT EXISTS municipality_stats_history (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  municipality_id INT UNSIGNED NOT NULL,
  room_code VARCHAR(50) NOT NULL,
  snapshot_date DATE NOT NULL,
  population INT NOT NULL DEFAULT 0,
  jobs INT NOT NULL DEFAULT 0,
  money BIGINT NOT NULL DEFAULT 0,
  income INT NOT NULL DEFAULT 0,
  expenses INT NOT NULL DEFAULT 0,
  happiness INT NOT NULL DEFAULT 50,
  UNIQUE KEY uq_daily (municipality_id, room_code, snapshot_date),
  KEY idx_muni_date (municipality_id, snapshot_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
