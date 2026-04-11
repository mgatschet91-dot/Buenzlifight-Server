-- Migration 078: Water storage level tracking
ALTER TABLE municipality_stats ADD COLUMN water_storage_level FLOAT NOT NULL DEFAULT 0;
