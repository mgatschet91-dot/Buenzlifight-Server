-- ============================================================
-- 061: evidence_score Spalte zu municipality_events hinzufuegen
-- ============================================================
-- Wird fuer das Dispute/Anfechtungs-System benoetigt (Buenzli-Meldungen).
-- Hinweis: ADD COLUMN IF NOT EXISTS ist MariaDB-Syntax, nicht MySQL.
-- Der Migration-Runner behandelt "Duplicate column"-Fehler als gutartig.
-- ============================================================

ALTER TABLE municipality_events ADD COLUMN evidence_score INT NOT NULL DEFAULT 0 AFTER dispute_until;
