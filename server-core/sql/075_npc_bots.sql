-- ============================================================
-- 075_npc_bots.sql
-- NPC-Mitarbeiter System fuer Firmen
--
-- Erlaubt Firmenbesitzern NPC-Bots einzustellen, die automatisch
-- Vertraege abarbeiten wenn zu wenig echte Spieler aktiv sind.
--
-- NPC-Typen:
--   hilfsarbeiter  → billig, 60% Effizienz, alle Tasks
--   facharbeiter   → mittel,  75% Effizienz, besser in Firmen-Kategorie
--   manager        → teuer,   85% Effizienz, max 1 pro Firma
--
-- Ablauf:
--   1. Firmenbesitzer stellt NPC ein (Einstellkosten + Wochenlohn)
--   2. NPC-Tick (alle 60s) weist idle NPCs offene Vertraege zu
--   3. NPC arbeitet (Vertragsdauer / Effizienz = echte Arbeitszeit)
--   4. Vertrag fertig → Zahlung geht an Firmenkasse (kein Arbeitnehmerlohn)
--   5. Wochenlohn wird automatisch von Firmenkasse abgezogen
--   6. Kann nicht zahlen → NPC kuendigt automatisch
-- ============================================================

CREATE TABLE IF NOT EXISTS npc_bots (
  id                    BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  company_id            BIGINT UNSIGNED  NOT NULL,
  municipality_id       BIGINT UNSIGNED  NOT NULL,
  name                  VARCHAR(64)      NOT NULL COMMENT 'Auto-generierter Schweizer Name',
  bot_type              ENUM('hilfsarbeiter','facharbeiter','manager') NOT NULL DEFAULT 'hilfsarbeiter',
  skill_level           TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '1-5, steigt mit abgeschlossenen Vertraegen',
  salary_weekly         INT UNSIGNED     NOT NULL DEFAULT 200 COMMENT 'Wochenlohn in CHF aus Firmenkasse',
  efficiency            DECIMAL(3,2)     NOT NULL DEFAULT 0.60 COMMENT 'Arbeitseffizienz 0.40-0.85',
  status                ENUM('idle','working','fired') NOT NULL DEFAULT 'idle',
  current_contract_id   BIGINT UNSIGNED  NULL DEFAULT NULL COMMENT 'Aktuell bearbeiteter Vertrag',
  contract_started_at   DATETIME         NULL DEFAULT NULL COMMENT 'Zeitpunkt Arbeitsbeginn fuer aktuellen Vertrag',
  hired_at              DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fired_at              DATETIME         NULL DEFAULT NULL,
  last_salary_paid_at   DATETIME         NULL DEFAULT NULL COMMENT 'Letzter Lohnauszahlungszeitpunkt',
  contracts_completed   INT UNSIGNED     NOT NULL DEFAULT 0,
  xp_earned             INT UNSIGNED     NOT NULL DEFAULT 0 COMMENT 'Fuer kuenftige Skill-Upgrades',
  created_at            DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_company      (company_id),
  KEY idx_municipality (municipality_id),
  KEY idx_status       (status),
  KEY idx_contract     (current_contract_id),

  CONSTRAINT fk_npcbot_company  FOREIGN KEY (company_id)  REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_npcbot_contract FOREIGN KEY (current_contract_id) REFERENCES company_contracts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='NPC-Mitarbeiter fuer Firmen (Einzelspieler/Unterbesetzung)';

-- ─── NPC-Typ Konfiguration ────────────────────────────────────
CREATE TABLE IF NOT EXISTS npc_bot_types (
  bot_type        ENUM('hilfsarbeiter','facharbeiter','manager') NOT NULL,
  display_name    VARCHAR(64)  NOT NULL,
  emoji           VARCHAR(8)   NOT NULL DEFAULT '🤖',
  hire_cost       INT UNSIGNED NOT NULL COMMENT 'Einmalige Einstellkosten aus Firmenkasse',
  salary_weekly   INT UNSIGNED NOT NULL COMMENT 'Wochenlohn aus Firmenkasse',
  efficiency      DECIMAL(3,2) NOT NULL COMMENT 'Effizienz-Multiplikator (hoeher = schneller)',
  max_per_company TINYINT      NOT NULL COMMENT 'Max. dieser Sorte pro Firma',
  description     TEXT         NULL,

  PRIMARY KEY (bot_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Konfiguration der NPC-Typen';

INSERT INTO npc_bot_types (bot_type, display_name, emoji, hire_cost, salary_weekly, efficiency, max_per_company, description) VALUES
('hilfsarbeiter', 'Hilfsarbeiter', '👷', 500,  200,  0.60, 5, 'Günstiger Allrounder. Erledigt alle Aufgaben, aber braucht 67% mehr Zeit als ein echter Mitarbeiter.'),
('facharbeiter',  'Facharbeiter',  '🔧', 1500, 500,  0.75, 3, 'Spezialisiert auf den Firmenbereich. Arbeitet 33% länger als ein Profi, aber zuverlässig.'),
('manager',       'Manager',       '💼', 5000, 1200, 0.85, 1, 'Hochqualifiziert. Kaum langsamer als ein echter Spieler. Max. 1 pro Firma.');

-- ─── Lohnbuchhaltung für NPC-Bots ────────────────────────────
CREATE TABLE IF NOT EXISTS npc_bot_salary_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  npc_bot_id  BIGINT UNSIGNED NOT NULL,
  company_id  BIGINT UNSIGNED NOT NULL,
  amount      INT             NOT NULL COMMENT 'Negativ = Lohnabzug, positiv = Rueckerstattung',
  reason      VARCHAR(64)     NOT NULL DEFAULT 'weekly_salary',
  paid_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_npc    (npc_bot_id),
  KEY idx_company (company_id),

  CONSTRAINT fk_salarylog_npc     FOREIGN KEY (npc_bot_id) REFERENCES npc_bots(id) ON DELETE CASCADE,
  CONSTRAINT fk_salarylog_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Lohnbuchhaltung fuer NPC-Mitarbeiter';
