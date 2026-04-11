-- ============================================================
-- 047: Treasury als primaere Geldquelle + Schulden-System
-- ============================================================
-- treasury in municipality_stats wird zur einzigen Geldquelle
-- der Gemeinde. Vorher lag money in game_stats.stats_data (JSON).
--
-- Neue Spalten: debt, credit_limit, interest_rate, last_interest_at
-- ============================================================

-- Default von treasury auf 0 aendern (vorher 10000)
ALTER TABLE municipality_stats
  MODIFY COLUMN treasury BIGINT NOT NULL DEFAULT 0
    COMMENT 'Gemeinde-Kasse – primaere Geldquelle (vorher in JSON)';

-- Neue Spalten
ALTER TABLE municipality_stats
  ADD COLUMN debt          BIGINT        NOT NULL DEFAULT 0
    COMMENT 'Aktuelle Schulden der Gemeinde',
  ADD COLUMN credit_limit  BIGINT        NOT NULL DEFAULT 50000
    COMMENT 'Maximaler Kreditrahmen',
  ADD COLUMN interest_rate DECIMAL(6,5)  NOT NULL DEFAULT 0.00050
    COMMENT 'Taeglicher Zinssatz auf Schulden',
  ADD COLUMN last_interest_at DATE NULL DEFAULT NULL
    COMMENT 'Letzter Tag an dem Zinsen berechnet wurden';

-- ─── Daten-Migration: money aus game_stats JSON → treasury ───
-- Nimmt pro Gemeinde den hoechsten money-Wert aus allen Rooms
-- und schreibt ihn in municipality_stats.treasury.
UPDATE municipality_stats ms
  JOIN (
    SELECT municipality_id,
           MAX(
             CAST(
               COALESCE(JSON_UNQUOTE(JSON_EXTRACT(stats_data, '$.money')), '0')
               AS SIGNED
             )
           ) AS max_money
    FROM game_stats
    GROUP BY municipality_id
  ) best ON best.municipality_id = ms.municipality_id
SET ms.treasury = best.max_money
WHERE best.max_money > ms.treasury;
