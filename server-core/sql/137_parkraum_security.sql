-- 137: Parkraum Security Firmen-Typ + Kontrolleur NPC

INSERT IGNORE INTO company_types
  (code, name, description, emoji, can_fix_categories, founding_cost, min_level, max_members)
VALUES
  ('parkraum_security',
   'Parkraum Security',
   'Kontrolliert Parkfelder der Gemeinde auf Schwarzparker und stellt Bussen aus. Provision pro Busse geht an die Firma.',
   '🚔',
   '["sicherheit"]',
   2000,
   1,
   10);

-- Kontrolleur NPC-Typ (nur für parkraum_security Firmen verwendbar)
INSERT IGNORE INTO npc_bot_types
  (bot_type, display_name, emoji, hire_cost, salary_weekly, efficiency, max_per_company, description)
VALUES
  ('kontrolleur',
   'Parkraum-Kontrolleur',
   '🚔',
   300,
   150,
   0.80,
   5,
   'Patrouilliert über Parkfelder und büsst Schwarzparker. Pro Busse erhält die Firma eine Provision.');
