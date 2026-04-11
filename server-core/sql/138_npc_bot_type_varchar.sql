-- ============================================================
-- 138: npc_bot_types – bot_type ENUM → VARCHAR, company_type_code hinzu
-- ─────────────────────────────────────────────────────────────
-- bot_type war ENUM('hilfsarbeiter','facharbeiter','manager').
-- Neue Typen (z.B. kontrolleur) konnten nicht eingefügt werden.
-- Lösung: VARCHAR(32) + company_type_code (NULL = für alle Firmen).
-- ============================================================

-- 1) npc_bot_types: PRIMARY KEY (ENUM) → VARCHAR
ALTER TABLE npc_bot_types
  MODIFY COLUMN bot_type VARCHAR(32) NOT NULL;

-- 2) npc_bot_types: company_type_code hinzufügen
--    NULL = dieser Typ ist für alle Firmentypen verfügbar
ALTER TABLE npc_bot_types
  ADD COLUMN company_type_code VARCHAR(32) NULL DEFAULT NULL
    COMMENT 'Firmentyp-Code (aus company_types.code) — NULL = universal';

-- 3) npc_bots: bot_type ENUM → VARCHAR
ALTER TABLE npc_bots
  MODIFY COLUMN bot_type VARCHAR(32) NOT NULL DEFAULT 'hilfsarbeiter';

-- 4) Kontrolleur eintragen (jetzt möglich da VARCHAR)
--    Falls Migration 137 bereits ausgeführt wurde und INSERT scheiterte:
INSERT IGNORE INTO npc_bot_types
  (bot_type, display_name, emoji, hire_cost, salary_weekly, efficiency, max_per_company, description, company_type_code)
VALUES
  ('kontrolleur', 'Parkraum-Kontrolleur', '🚔', 300, 150, 0.80, 5,
   'Patrouilliert über Parkfelder und büsst Schwarzparker. Pro Busse erhält die Firma eine Provision.',
   'parkraum_security');

-- 5) Bestehende General-Typen als NULL markieren (universal)
UPDATE npc_bot_types
  SET company_type_code = NULL
  WHERE bot_type IN ('hilfsarbeiter', 'facharbeiter', 'manager');
