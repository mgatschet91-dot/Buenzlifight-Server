-- Migration 084: Werkhof (Kommunaler Bauhof) Feature
-- Gebäudezustand (condition) wird in game_items.metadata JSON gespeichert (kein neues Feld nötig)
-- Dieses Script dokumentiert das Feature und fügt has_werkhof zu municipality_stats hinzu.
--
-- Werkhof-Feature-Dokumentation:
--   - Gebäudezustand: game_items.metadata->>'$.condition' (0-100, Standard: 100)
--   - Decay: 0.002 pro Server-Tick (3s) für Wohn- und Gewerbegebäude
--   - Vollständiger Verfall: ~41.7 Stunden Echtzeit
--   - Reparatur: Werkhof-LKW fährt automatisch zu Gebäuden mit Zustand < 60%
--   - Reparatur-Dauer: 60 Sekunden Echtzeit am Gebäude
--   - Müllabfuhr: Müllauto fährt alle 10 Minuten Echtzeit eine Route ab
--
-- has_werkhof: wird vom Server-Tick aktuell gehalten (1 wenn mind. 1 Werkhof existiert)

ALTER TABLE municipality_stats ADD COLUMN has_werkhof TINYINT(1) NOT NULL DEFAULT 0;
