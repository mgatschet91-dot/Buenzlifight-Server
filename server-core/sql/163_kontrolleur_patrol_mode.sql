-- 163: Kontrolleur-NPCs auf patrol_mode=1 setzen
-- Verhindert dass bestehende Kontrolleure regulaere Firmen-Vertraege (inkl. Gebaeude-Reparaturen) annehmen.
-- Neue Kontrolleure bekommen patrol_mode=1 bereits beim Einstellen (npcBots.js).
UPDATE npc_bots
SET patrol_mode = 1
WHERE bot_type = 'kontrolleur' AND status != 'fired';
