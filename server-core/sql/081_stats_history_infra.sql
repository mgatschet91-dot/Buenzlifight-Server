-- Add infrastructure columns to municipality_stats_history for daily snapshots
ALTER TABLE municipality_stats_history ADD COLUMN power_production INT NOT NULL DEFAULT 0;
ALTER TABLE municipality_stats_history ADD COLUMN power_consumption INT NOT NULL DEFAULT 0;
ALTER TABLE municipality_stats_history ADD COLUMN water_production INT NOT NULL DEFAULT 0;
ALTER TABLE municipality_stats_history ADD COLUMN water_consumption INT NOT NULL DEFAULT 0;
ALTER TABLE municipality_stats_history ADD COLUMN solar_production INT NOT NULL DEFAULT 0;
