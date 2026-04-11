-- External reporting & escalation columns for municipality_events
ALTER TABLE municipality_events
  ADD COLUMN external_reporter_id INT UNSIGNED NULL DEFAULT NULL,
  ADD COLUMN external_deadline DATETIME NULL DEFAULT NULL,
  ADD COLUMN escalation_level TINYINT UNSIGNED NOT NULL DEFAULT 0;
