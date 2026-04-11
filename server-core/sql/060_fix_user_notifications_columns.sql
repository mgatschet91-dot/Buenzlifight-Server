-- ============================================================
-- 060: Fehlende Spalten in user_notifications hinzufuegen
-- ============================================================
-- Migration 012 erstellt die Tabelle ohne icon, amount, municipality_id.
-- Migration 034 hat CREATE TABLE IF NOT EXISTS und aendert nichts.
-- Dieser Fix fuegt die fehlenden Spalten nach.
-- Hinweis: ADD COLUMN IF NOT EXISTS ist MariaDB-Syntax, nicht MySQL.
-- Der Migration-Runner behandelt "Duplicate column"-Fehler als gutartig.
-- ============================================================

ALTER TABLE user_notifications ADD COLUMN municipality_id INT UNSIGNED DEFAULT NULL AFTER user_id;
ALTER TABLE user_notifications ADD COLUMN icon VARCHAR(50) NOT NULL DEFAULT 'info' AFTER message;
ALTER TABLE user_notifications ADD COLUMN amount INT DEFAULT NULL AFTER icon;
