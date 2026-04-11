-- Power production/consumption stored in municipality_stats for regional aggregation
ALTER TABLE municipality_stats ADD COLUMN power_production INT NOT NULL DEFAULT 0;
ALTER TABLE municipality_stats ADD COLUMN power_consumption INT NOT NULL DEFAULT 0;
