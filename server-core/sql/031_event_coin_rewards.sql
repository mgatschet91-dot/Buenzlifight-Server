-- ============================================================
-- 031_event_coin_rewards.sql
-- Buenzli-Coin Belohnungen fuer Events
--
-- User bekommt Coins (bobba_coins in users_data.project_data)
-- Gemeinde bekommt Coins (municipality_stats.treasury)
--
-- Report:  User meldet Event → User + Gemeinde bekommen Coins
-- Fix:     User behebt Event → User + Gemeinde bekommen Coins
-- ============================================================

-- ─── Coin-Spalten zu event_types hinzufuegen ─────────────────
SET @col1 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_types' AND COLUMN_NAME = 'coin_reward_report');
SET @sql1 := IF(@col1 = 0,
  'ALTER TABLE event_types ADD COLUMN coin_reward_report INT UNSIGNED NOT NULL DEFAULT 5 COMMENT ''Coins fuer User beim Melden'' AFTER xp_penalty_wrong',
  'SELECT 1');
PREPARE stmt FROM @sql1; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col2 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_types' AND COLUMN_NAME = 'coin_reward_fix');
SET @sql2 := IF(@col2 = 0,
  'ALTER TABLE event_types ADD COLUMN coin_reward_fix INT UNSIGNED NOT NULL DEFAULT 20 COMMENT ''Coins fuer User beim Beheben'' AFTER coin_reward_report',
  'SELECT 1');
PREPARE stmt FROM @sql2; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col3 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_types' AND COLUMN_NAME = 'coin_municipality_report');
SET @sql3 := IF(@col3 = 0,
  'ALTER TABLE event_types ADD COLUMN coin_municipality_report INT UNSIGNED NOT NULL DEFAULT 10 COMMENT ''Coins fuer Gemeinde-Kasse beim Melden'' AFTER coin_reward_fix',
  'SELECT 1');
PREPARE stmt FROM @sql3; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col4 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_types' AND COLUMN_NAME = 'coin_municipality_fix');
SET @sql4 := IF(@col4 = 0,
  'ALTER TABLE event_types ADD COLUMN coin_municipality_fix INT UNSIGNED NOT NULL DEFAULT 50 COMMENT ''Coins fuer Gemeinde-Kasse beim Beheben'' AFTER coin_municipality_report',
  'SELECT 1');
PREPARE stmt FROM @sql4; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─── Coin-Werte pro Event-Typ setzen ─────────────────────────
-- Formel: Hoehere Severity → mehr Coins
-- Report-Coins skalieren mit Severity (5/10/20/40/80)
-- Fix-Coins skalieren mit Severity (20/40/80/150/300)
-- Gemeinde bekommt ca. das Doppelte vom User-Reward

-- Severity 1 (leicht)
UPDATE event_types SET
  coin_reward_report = 5,
  coin_reward_fix = 20,
  coin_municipality_report = 10,
  coin_municipality_fix = 40
WHERE severity = 1;

-- Severity 2 (mittel)
UPDATE event_types SET
  coin_reward_report = 10,
  coin_reward_fix = 40,
  coin_municipality_report = 25,
  coin_municipality_fix = 80
WHERE severity = 2;

-- Severity 3 (schwer)
UPDATE event_types SET
  coin_reward_report = 20,
  coin_reward_fix = 80,
  coin_municipality_report = 50,
  coin_municipality_fix = 150
WHERE severity = 3;

-- Severity 4 (kritisch: Korruption etc.)
UPDATE event_types SET
  coin_reward_report = 40,
  coin_reward_fix = 150,
  coin_municipality_report = 100,
  coin_municipality_fix = 300
WHERE severity = 4;

-- Severity 5 (katastrophal)
UPDATE event_types SET
  coin_reward_report = 80,
  coin_reward_fix = 300,
  coin_municipality_report = 200,
  coin_municipality_fix = 500
WHERE severity >= 5;
