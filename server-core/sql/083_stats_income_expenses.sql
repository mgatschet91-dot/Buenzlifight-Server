-- Persist income and expenses in municipality_stats for daily snapshot job
ALTER TABLE municipality_stats ADD COLUMN income INT NOT NULL DEFAULT 0;
ALTER TABLE municipality_stats ADD COLUMN expenses INT NOT NULL DEFAULT 0;
