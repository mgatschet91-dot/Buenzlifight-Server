-- ============================================================
-- 176_npc_max_per_company.sql
-- NPC-Limits reduzieren — max 4 NPCs pro Firma total
--   hilfsarbeiter: 5 → 2
--   facharbeiter:  3 → 1
--   manager:       1 → 1 (bleibt)
-- ============================================================

UPDATE npc_bot_types SET max_per_company = 2 WHERE bot_type = 'hilfsarbeiter';
UPDATE npc_bot_types SET max_per_company = 1 WHERE bot_type = 'facharbeiter';
