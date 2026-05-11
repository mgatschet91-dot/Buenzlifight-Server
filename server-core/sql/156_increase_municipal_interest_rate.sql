-- Tageszins von 0.05%/Tag auf 0.1%/Tag erhoehen
ALTER TABLE municipality_stats
  ALTER COLUMN interest_rate SET DEFAULT 0.00100;

UPDATE municipality_stats
  SET interest_rate = 0.00100
  WHERE interest_rate = 0.00050;
