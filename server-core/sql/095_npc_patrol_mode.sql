-- Migration 095: Patrol-Modus fuer Werkhof NPCs
-- Erlaubt einem NPC, als Reparateur eingesetzt zu werden.
-- Patrol-NPCs arbeiten keine Vertraege ab, sondern fahren automatisch
-- zu Gebaeuden mit niedrigem Zustand (condition < 60) und reparieren sie.
-- Pro Firma kann max. 1 NPC im Patrol-Modus sein.

ALTER TABLE npc_bots ADD COLUMN patrol_mode TINYINT(1) NOT NULL DEFAULT 0
  COMMENT 'Wenn 1: NPC ist Reparatur-Patrouille, nimmt keine Vertraege an';

ALTER TABLE npc_bots ADD COLUMN patrol_repairs INT UNSIGNED NOT NULL DEFAULT 0
  COMMENT 'Anzahl abgeschlossener Gebaeudereparaturen';
