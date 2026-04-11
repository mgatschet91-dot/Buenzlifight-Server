-- Add solar_production to municipality_stats for live ranking
ALTER TABLE municipality_stats ADD COLUMN solar_production INT NOT NULL DEFAULT 0;
