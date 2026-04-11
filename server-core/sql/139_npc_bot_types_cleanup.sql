-- ============================================================
-- 139: Duplikate in npc_bot_types bereinigen
-- kontrolleur company_type_code korrekt setzen
-- ============================================================

-- Doppelten Eintrag entfernen (falls Migration 137 + 138 beide liefen)
DELETE FROM npc_bot_types
  WHERE bot_type = 'kontrolleur' AND company_type_code IS NULL;

-- Sicherstellen dass der verbleibende Eintrag korrekt ist
INSERT INTO npc_bot_types
  (bot_type, display_name, emoji, hire_cost, salary_weekly, efficiency, max_per_company, description, company_type_code)
VALUES
  ('kontrolleur', 'Parkraum-Kontrolleur', '🚔', 300, 150, 0.80, 5,
   'Patrouilliert über Parkfelder und büsst Schwarzparker. Pro Busse erhält die Firma eine Provision.',
   'parkraum_security')
ON DUPLICATE KEY UPDATE company_type_code = 'parkraum_security';
