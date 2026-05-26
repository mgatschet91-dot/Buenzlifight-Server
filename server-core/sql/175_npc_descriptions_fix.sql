-- ============================================================
-- 175_npc_descriptions_fix.sql
-- NPC-Beschreibungen an neue Effizienzwerte anpassen
-- ============================================================

UPDATE npc_bot_types SET description =
  'Günstiger Allrounder für Solo-Betrieb. Erledigt alle Aufgaben, braucht aber 3× so lange wie ein echter Mitarbeiter. Deaktiviert sich automatisch ab 3 Teammitgliedern.'
  WHERE bot_type = 'hilfsarbeiter';

UPDATE npc_bot_types SET description =
  'Spezialisiert auf den Firmenbereich. Arbeitet doppelt so langsam wie ein echter Profi, aber zuverlässig. Deaktiviert sich automatisch ab 3 Teammitgliedern.'
  WHERE bot_type = 'facharbeiter';

UPDATE npc_bot_types SET description =
  'Erfahrene Fachkraft. Arbeitet ca. 1.7× langsamer als ein echter Spieler. Max. 1 pro Firma. Deaktiviert sich automatisch ab 3 Teammitgliedern.'
  WHERE bot_type = 'manager';
