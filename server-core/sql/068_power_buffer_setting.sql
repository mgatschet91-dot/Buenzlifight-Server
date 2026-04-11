ALTER TABLE municipality_stats
  ADD COLUMN power_buffer_pct TINYINT UNSIGNED NOT NULL DEFAULT 10
    COMMENT 'Reservepuffer in % der Produktion (5-25%), vom Spieler einstellbar';
