-- ============================================================
-- 048: Finanz- & Bevölkerungs-Spalten in municipality_stats
-- ============================================================
-- Nur sicherheitsrelevante / berechnungsrelevante Werte als
-- echte DB-Spalten. Alles andere bleibt in game_stats JSON.
--
-- daily_income existiert bereits aus 027_buenzli_events.sql
-- population, max_population existieren bereits aus 027
-- treasury, debt, credit_limit, interest_rate, last_interest_at aus 047
-- ============================================================

-- ─── Aufraeumen: Spalten aus fehlgeschlagenem vorherigen Lauf (048 alt) ───
-- Jede Spalte nur droppen wenn sie existiert (idempotent)

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN income', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='income');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN expenses', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='expenses');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN tax_income', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='tax_income');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN building_income', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='building_income');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN maintenance_expenses', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='maintenance_expenses');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN population_growth', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='population_growth');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN homeless', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='homeless');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN employed', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='employed');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN unemployed', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='unemployed');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN unemployment_rate', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='unemployment_rate');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN happiness', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='happiness');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN happiness_residential', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='happiness_residential');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN happiness_commercial', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='happiness_commercial');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN happiness_industrial', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='happiness_industrial');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN power_production', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='power_production');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN power_consumption', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='power_consumption');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN water_production', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='water_production');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN water_consumption', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='water_consumption');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN buildings_total', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='buildings_total');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN buildings_residential', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='buildings_residential');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN buildings_commercial', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='buildings_commercial');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN buildings_industrial', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='buildings_industrial');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN buildings_infrastructure', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='buildings_infrastructure');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN buildings_decoration', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='buildings_decoration');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN zones_residential', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='zones_residential');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN zones_commercial', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='zones_commercial');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN zones_industrial', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='zones_industrial');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN tick', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='tick');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN game_speed', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='game_speed');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)>0, 'ALTER TABLE municipality_stats DROP COLUMN play_time_seconds', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='play_time_seconds');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

-- ─── Neue Spalten (nur wenn noch nicht vorhanden) ─────────────
-- daily_income existiert bereits aus 027, population + max_population auch
-- treasury, debt, credit_limit, interest_rate, last_interest_at aus 047

SET @s = (SELECT IF(COUNT(*)=0, 'ALTER TABLE municipality_stats ADD COLUMN daily_expenses INT NOT NULL DEFAULT 0 COMMENT ''Taegl. Ausgaben (letzter Recompute)''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='daily_expenses');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)=0, 'ALTER TABLE municipality_stats ADD COLUMN last_finance_day DATE NULL DEFAULT NULL COMMENT ''Tag des letzten Finanz-Recompute''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='last_finance_day');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)=0, 'ALTER TABLE municipality_stats ADD COLUMN tax_rate INT NOT NULL DEFAULT 10 COMMENT ''Steuersatz (Spieler-Einstellung)''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='tax_rate');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)=0, 'ALTER TABLE municipality_stats ADD COLUMN jobs INT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''Arbeitsplaetze (berechnet)''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='jobs');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)=0, 'ALTER TABLE municipality_stats ADD COLUMN total_tax_collected BIGINT NOT NULL DEFAULT 0 COMMENT ''Kumuliert: Steuern gesamt''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='total_tax_collected');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @s = (SELECT IF(COUNT(*)=0, 'ALTER TABLE municipality_stats ADD COLUMN total_spent BIGINT NOT NULL DEFAULT 0 COMMENT ''Kumuliert: Ausgaben gesamt''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='total_spent');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

-- ─── Daten-Migration: JSON → neue Spalten ────────────────────

UPDATE municipality_stats ms
  JOIN (
    SELECT
      gs.municipality_id,
      ROUND(MAX(CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(gs.stats_data, '$.income')),      '0') AS DECIMAL(20,2)))) AS _income,
      ROUND(MAX(CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(gs.stats_data, '$.expenses')),    '0') AS DECIMAL(20,2)))) AS _expenses,
      ROUND(MAX(CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(gs.stats_data, '$.tax_rate')),   '10') AS DECIMAL(20,2)))) AS _tax_rate,
      ROUND(MAX(CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(gs.stats_data, '$.jobs')),        '0') AS DECIMAL(20,2)))) AS _jobs,
      ROUND(MAX(CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(gs.stats_data, '$.total_tax_collected')),'0') AS DECIMAL(20,2)))) AS _total_tax_collected,
      ROUND(MAX(CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(gs.stats_data, '$.total_spent')), '0') AS DECIMAL(20,2)))) AS _total_spent
    FROM game_stats gs
    GROUP BY gs.municipality_id
  ) src ON src.municipality_id = ms.municipality_id
SET
  ms.daily_income        = src._income,
  ms.daily_expenses      = src._expenses,
  ms.last_finance_day    = CURDATE(),
  ms.tax_rate            = src._tax_rate,
  ms.jobs                = src._jobs,
  ms.total_tax_collected = src._total_tax_collected,
  ms.total_spent         = src._total_spent;
