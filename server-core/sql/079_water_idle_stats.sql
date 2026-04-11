-- Water production/consumption/capacity stored in municipality_stats for idle background fill
ALTER TABLE municipality_stats ADD COLUMN water_production INT NOT NULL DEFAULT 0;
ALTER TABLE municipality_stats ADD COLUMN water_consumption INT NOT NULL DEFAULT 0;
ALTER TABLE municipality_stats ADD COLUMN water_storage_capacity INT NOT NULL DEFAULT 0;
