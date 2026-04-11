-- ============================================================
-- 026_user_xp_levels.sql
-- XP & Level-System fuer User und Gemeinden
--
-- Level-Formel: Level = FLOOR(SQRT(total_xp / 100)) + 1
-- Max Level 25 => benoetigt 57'600 XP
--
-- XP-Quellen:
--   - Taegl. Login:        50 XP (+ Streak-Bonus)
--   - Event melden:        10-100 XP (je nach Severity)
--   - Korruption korrekt:  200 XP Bonus
--   - Problem beheben:     50-300 XP
--   - Gebaeude bauen:      20-80 XP
-- ============================================================

-- ─── User XP Tracking ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_xp (
  user_id       BIGINT UNSIGNED NOT NULL,
  total_xp      INT UNSIGNED    NOT NULL DEFAULT 0,
  level         TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Berechnetes Level 1-25',
  login_streak  INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Aktuelle Login-Streak in Tagen',
  best_streak   INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Laengste Login-Streak aller Zeiten',
  last_login_date DATE          NULL     COMMENT 'Letzter Login-Tag (fuer Streak)',
  last_xp_at    DATETIME        NULL     COMMENT 'Letzter XP-Gewinn',
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  KEY idx_user_xp_level (level),
  KEY idx_user_xp_total (total_xp DESC),
  KEY idx_user_xp_streak (login_streak DESC),
  CONSTRAINT fk_user_xp_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── XP Event Log ────────────────────────────────────────────
-- Jeder XP-Gewinn/Verlust wird geloggt
CREATE TABLE IF NOT EXISTS user_xp_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  xp_amount   INT             NOT NULL COMMENT 'Positiv = Gewinn, Negativ = Verlust',
  reason      VARCHAR(64)     NOT NULL COMMENT 'z.B. daily_login, event_report, event_fix, build, corruption_correct, corruption_wrong',
  description VARCHAR(255)    NULL     COMMENT 'Lesbare Beschreibung',
  ref_type    VARCHAR(32)     NULL     COMMENT 'Referenz-Typ: event, company_contract, building, etc.',
  ref_id      BIGINT UNSIGNED NULL     COMMENT 'Referenz-ID (z.B. event_id, contract_id)',
  total_after INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Total XP nach dieser Aenderung',
  level_after TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Level nach dieser Aenderung',
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_xp_log_user_created (user_id, created_at DESC),
  KEY idx_xp_log_reason (reason),
  KEY idx_xp_log_ref (ref_type, ref_id),
  CONSTRAINT fk_xp_log_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Gemeinde XP ─────────────────────────────────────────────
-- Gemeinden haben eigenes Level-System
-- Formel: Level = FLOOR(SQRT(total_xp / 200))
-- Daily Limit: 500 + (Mitglieder * 10), max 2000 XP/Tag
CREATE TABLE IF NOT EXISTS municipality_xp (
  municipality_id  BIGINT UNSIGNED NOT NULL,
  total_xp         INT UNSIGNED    NOT NULL DEFAULT 0,
  level            TINYINT UNSIGNED NOT NULL DEFAULT 0,
  daily_xp_earned  INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Heute bereits verdiente XP',
  daily_xp_date    DATE            NULL     COMMENT 'Datum des daily Counters',
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (municipality_id),
  KEY idx_municipality_xp_level (level),
  KEY idx_municipality_xp_total (total_xp DESC),
  CONSTRAINT fk_municipality_xp_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Level-Uebersicht (Referenz) ────────────────────────────
-- Level = FLOOR(SQRT(total_xp / 100)) + 1
--
--  Level |  XP benoetigt
--  ------|--------------
--    1   |        0
--    2   |      100
--    3   |      400
--    4   |      900
--    5   |    1'600
--    6   |    2'500
--    7   |    3'600
--    8   |    4'900
--    9   |    6'400
--   10   |    8'100
--   11   |   10'000
--   12   |   12'100
--   13   |   14'400
--   14   |   16'900
--   15   |   19'600
--   16   |   22'500
--   17   |   25'600
--   18   |   28'900
--   19   |   32'400
--   20   |   36'100
--   21   |   40'000
--   22   |   44'100
--   23   |   48'400
--   24   |   52'900
--   25   |   57'600
-- ─────────────────────────────────────────────────────────────

-- ─── Login-Streak XP Bonus Tabelle ──────────────────────────
-- Konfigurierbare Streak-Meilensteine
CREATE TABLE IF NOT EXISTS xp_streak_bonuses (
  id             BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  streak_days    INT UNSIGNED     NOT NULL COMMENT 'Ab wie vielen Tagen Streak',
  bonus_xp       INT UNSIGNED     NOT NULL COMMENT 'Zusaetzliche XP zum Daily Login',
  badge_code     VARCHAR(64)      NULL     COMMENT 'Optionaler Badge bei Erreichen',
  description    VARCHAR(255)     NULL,
  created_at     TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_streak_days (streak_days)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Standard Streak-Boni ────────────────────────────────────
INSERT IGNORE INTO xp_streak_bonuses (streak_days, bonus_xp, badge_code, description) VALUES
  (3,   25,  NULL,              '3-Tage-Streak: +25 XP'),
  (7,   50,  'ACH_Streak7',    '7-Tage-Streak: +50 XP'),
  (14,  75,  'ACH_Streak14',   '14-Tage-Streak: +75 XP'),
  (30,  100, 'ACH_Streak30',   '30-Tage-Streak: +100 XP'),
  (60,  150, 'ACH_Streak60',   '60-Tage-Streak: +150 XP'),
  (100, 250, 'ACH_Streak100',  '100-Tage-Streak: +250 XP'),
  (365, 500, 'ACH_Streak365',  '365-Tage-Streak: +500 XP');

-- ─── Level-Up Badges ─────────────────────────────────────────
INSERT IGNORE INTO badges (code, name, description, category, rarity, sort_order) VALUES
  ('LVL_5',   'Level 5',   'Erreiche Level 5',   'achievement', 0, 130),
  ('LVL_10',  'Level 10',  'Erreiche Level 10',  'achievement', 1, 140),
  ('LVL_15',  'Level 15',  'Erreiche Level 15',  'achievement', 2, 150),
  ('LVL_20',  'Level 20',  'Erreiche Level 20',  'achievement', 3, 160),
  ('LVL_25',  'Level 25',  'Erreiche Level 25 - Maximalstufe!', 'achievement', 4, 170),
  ('ACH_Streak7',   '7-Tage-Streak',   'Logge dich 7 Tage hintereinander ein',    'achievement', 0, 180),
  ('ACH_Streak14',  '14-Tage-Streak',  'Logge dich 14 Tage hintereinander ein',   'achievement', 1, 190),
  ('ACH_Streak30',  '30-Tage-Streak',  'Logge dich 30 Tage hintereinander ein',   'achievement', 1, 195),
  ('ACH_Streak60',  '60-Tage-Streak',  'Logge dich 60 Tage hintereinander ein',   'achievement', 2, 196),
  ('ACH_Streak100', '100-Tage-Streak', 'Logge dich 100 Tage hintereinander ein',  'achievement', 3, 197),
  ('ACH_Streak365', '365-Tage-Streak', 'Logge dich 365 Tage hintereinander ein!', 'achievement', 4, 198);

-- ─── XP fuer bestehende User initialisieren ──────────────────
INSERT INTO user_xp (user_id, total_xp, level, login_streak, last_login_date)
SELECT
  u.id,
  0,
  1,
  0,
  NULL
FROM users u
WHERE u.is_active = 1
ON DUPLICATE KEY UPDATE
  updated_at = CURRENT_TIMESTAMP;
