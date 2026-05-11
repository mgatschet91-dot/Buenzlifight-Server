-- Kantonal Untersuchung: Eskalationsstufen + Startzeitpunkt
ALTER TABLE municipality_stats
  ADD COLUMN cantonal_investigation_since DATETIME NULL DEFAULT NULL
    AFTER cantonal_investigation_until,
  ADD COLUMN cantonal_investigation_stage TINYINT UNSIGNED NOT NULL DEFAULT 0
    AFTER cantonal_investigation_since;
-- Stage 0 = keine, 1 = aktiv, 2 = verschärft, 3 = kritisch
