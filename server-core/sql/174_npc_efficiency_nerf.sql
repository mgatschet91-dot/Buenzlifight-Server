-- ============================================================
-- 174_npc_efficiency_nerf.sql
-- NPC-Effizienz reduzieren — NPCs sind Notlösung, kein Ersatz
-- für echte Spieler.
--
-- Alt → Neu:
--   hilfsarbeiter: 0.60 → 0.30  (~3.3× langsamer als Mensch)
--   facharbeiter:  0.75 → 0.45  (~2.2× langsamer)
--   manager:       0.85 → 0.60  (~1.7× langsamer)
-- ============================================================

UPDATE npc_bot_types SET efficiency = 0.30 WHERE bot_type = 'hilfsarbeiter';
UPDATE npc_bot_types SET efficiency = 0.45 WHERE bot_type = 'facharbeiter';
UPDATE npc_bot_types SET efficiency = 0.60 WHERE bot_type = 'manager';

-- Bereits eingestellte NPCs ebenfalls anpassen
UPDATE npc_bots SET efficiency = 0.30 WHERE bot_type = 'hilfsarbeiter' AND status != 'fired';
UPDATE npc_bots SET efficiency = 0.45 WHERE bot_type = 'facharbeiter'  AND status != 'fired';
UPDATE npc_bots SET efficiency = 0.60 WHERE bot_type = 'manager'       AND status != 'fired';
