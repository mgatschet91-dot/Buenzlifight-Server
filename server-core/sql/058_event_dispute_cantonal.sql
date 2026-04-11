-- Dispute column for municipality_events + cantonal investigation for municipality_stats
ALTER TABLE municipality_events
  ADD COLUMN dispute_until DATETIME NULL DEFAULT NULL;

ALTER TABLE municipality_stats
  ADD COLUMN cantonal_investigation_until DATETIME NULL DEFAULT NULL;
