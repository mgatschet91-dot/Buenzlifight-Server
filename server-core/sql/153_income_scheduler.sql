-- Einnahmen-Scheduler: last_income_at als echte DB-Spalte
-- Damit kann der Hintergrund-Job alle Gemeinden prüfen (online & offline gleichbehandelt)
ALTER TABLE municipality_stats
  ADD COLUMN last_income_at DATETIME NULL DEFAULT NULL;

-- Bestehende Zeilen initialisieren: Akkumulation startet ab jetzt
UPDATE municipality_stats SET last_income_at = NOW() WHERE last_income_at IS NULL;
