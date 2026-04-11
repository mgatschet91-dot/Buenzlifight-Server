-- ============================================================
-- 028_companies.sql
-- Unternehmen-System (nur SQL Schema)
--
-- User koennen Firmen gruenden:
--   - Bauunternehmen      → behebt Infrastruktur-Events
--   - Sicherheitsfirma    → behebt Sicherheits-Events
--   - Reinigungsfirma     → behebt Ordnung-Events
--   - Medienhaus          → untersucht Verwaltung-Events (Korruption etc.)
--
-- Ablauf:
--   1. User tritt Gemeinde bei / arbeitet im Bauamt
--   2. User/Fremder entdeckt Mangel (Event aus 027)
--   3. Meldung/Anzeige geht ein
--   4. Gemeinderat muss reagieren
--   5. Gemeinde investiert Geld → beauftragt Firma
--   6. Firma behebt Problem → verdient Geld
--   7. Sicherheit/Attraktivitaet steigt
--   8. Neue Buerger ziehen ein → Loop
-- ============================================================

-- ─── Firmen-Typen ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_types (
  id              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  code            VARCHAR(32)      NOT NULL COMMENT 'bau, sicherheit, reinigung, medien',
  name            VARCHAR(128)     NOT NULL COMMENT 'Anzeigename',
  description     TEXT             NULL,
  emoji           VARCHAR(8)       NULL,
  can_fix_categories JSON          NOT NULL COMMENT 'Welche Event-Kategorien behoben werden: ["infrastruktur"]',
  founding_cost   INT UNSIGNED     NOT NULL DEFAULT 5000 COMMENT 'Kosten zum Gruenden',
  min_level       TINYINT UNSIGNED NOT NULL DEFAULT 5 COMMENT 'Mindest-Level des Gruenders',
  max_members     INT UNSIGNED     NOT NULL DEFAULT 10 COMMENT 'Max Mitglieder',
  is_active       TINYINT(1)       NOT NULL DEFAULT 1,
  created_at      TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_company_type_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Firmen ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_type_id  BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(128)    NOT NULL COMMENT 'Firmenname (vom Gruender gewaehlt)',
  slug             VARCHAR(128)    NOT NULL,
  owner_id         BIGINT UNSIGNED NOT NULL COMMENT 'Gruender/Inhaber',
  municipality_id  BIGINT UNSIGNED NOT NULL COMMENT 'Sitz der Firma',
  balance          BIGINT          NOT NULL DEFAULT 0 COMMENT 'Firmenkonto in Spielwaehrung',
  reputation       INT             NOT NULL DEFAULT 0 COMMENT 'Ruf der Firma (steigt mit erfolgreichen Auftraegen)',
  level            TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Firmen-Level (1-10)',
  total_contracts  INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Gesamtzahl abgeschlossener Auftraege',
  total_revenue    BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Gesamtumsatz',
  is_active        TINYINT(1)      NOT NULL DEFAULT 1,
  founded_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_company_slug (slug),
  KEY idx_company_type (company_type_id),
  KEY idx_company_owner (owner_id),
  KEY idx_company_municipality (municipality_id),
  KEY idx_company_reputation (reputation DESC),
  KEY idx_company_active (is_active),
  CONSTRAINT fk_company_type
    FOREIGN KEY (company_type_id) REFERENCES company_types(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_company_owner
    FOREIGN KEY (owner_id) REFERENCES users(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_company_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Firmen-Mitglieder ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_members (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id   BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  role         VARCHAR(24)     NOT NULL DEFAULT 'employee'
    COMMENT 'owner, manager, employee',
  salary       INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Taegl. Gehalt aus Firmenkonto',
  xp_earned    INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Gesamte XP in dieser Firma verdient',
  contracts_done INT UNSIGNED  NOT NULL DEFAULT 0 COMMENT 'Persoenlich abgeschlossene Auftraege',
  joined_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_company_member (company_id, user_id),
  KEY idx_member_user (user_id),
  KEY idx_member_role (company_id, role),
  CONSTRAINT fk_member_company
    FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_member_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Auftraege (Contracts) ───────────────────────────────────
-- Verknuepft Events mit Firmen
CREATE TABLE IF NOT EXISTS company_contracts (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL COMMENT 'Welche Firma den Auftrag hat',
  event_id         BIGINT UNSIGNED NOT NULL COMMENT 'Welches Event behoben werden soll',
  municipality_id  BIGINT UNSIGNED NOT NULL COMMENT 'Auftraggebende Gemeinde',
  assigned_user_id BIGINT UNSIGNED NULL     COMMENT 'Welches Firmenmitglied arbeitet daran',
  status           VARCHAR(24)     NOT NULL DEFAULT 'open'
    COMMENT 'open, accepted, in_progress, completed, failed, cancelled',
  payment          INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Vereinbarte Bezahlung',
  bonus            INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Bonus bei schneller Erledigung',
  penalty          INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Strafe bei Nicht-Erledigung',
  deadline_at      DATETIME        NOT NULL COMMENT 'Deadline fuer Erledigung',
  difficulty       TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '1-5 Schwierigkeit',
  xp_reward        INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'XP fuer User bei Abschluss',
  accepted_at      DATETIME        NULL,
  started_at       DATETIME        NULL     COMMENT 'Wann Arbeit begonnen',
  completed_at     DATETIME        NULL,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_event (event_id),
  KEY idx_contract_company_status (company_id, status),
  KEY idx_contract_municipality (municipality_id),
  KEY idx_contract_assigned_user (assigned_user_id),
  KEY idx_contract_status_deadline (status, deadline_at),
  CONSTRAINT fk_contract_company
    FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_contract_event
    FOREIGN KEY (event_id) REFERENCES municipality_events(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_contract_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_contract_user
    FOREIGN KEY (assigned_user_id) REFERENCES users(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Firmen-Finanzen Log ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_finances (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id   BIGINT UNSIGNED NOT NULL,
  amount       BIGINT          NOT NULL COMMENT 'Positiv = Einnahme, Negativ = Ausgabe',
  balance_after BIGINT         NOT NULL COMMENT 'Kontostand danach',
  reason       VARCHAR(64)     NOT NULL
    COMMENT 'contract_payment, salary_paid, founding_cost, bonus, penalty, tax, etc.',
  description  VARCHAR(255)    NULL,
  ref_type     VARCHAR(32)     NULL     COMMENT 'contract, salary, etc.',
  ref_id       BIGINT UNSIGNED NULL,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_finance_company_created (company_id, created_at DESC),
  KEY idx_finance_reason (reason),
  CONSTRAINT fk_finance_company
    FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Firmen-Bewerbungen ──────────────────────────────────────
-- User koennen sich bei Firmen bewerben
CREATE TABLE IF NOT EXISTS company_applications (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id   BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  message      VARCHAR(500)    NULL     COMMENT 'Bewerbungstext',
  status       VARCHAR(24)     NOT NULL DEFAULT 'pending'
    COMMENT 'pending, accepted, rejected, withdrawn',
  responded_by BIGINT UNSIGNED NULL     COMMENT 'Wer hat entschieden (owner/manager)',
  responded_at DATETIME        NULL,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_application_company_user (company_id, user_id),
  KEY idx_application_user (user_id),
  KEY idx_application_status (status),
  CONSTRAINT fk_application_company
    FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_application_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_application_responder
    FOREIGN KEY (responded_by) REFERENCES users(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- SEED DATA: Firmen-Typen
-- ============================================================

INSERT IGNORE INTO company_types (code, name, description, emoji, can_fix_categories, founding_cost, min_level, max_members) VALUES
('bau',
 'Bauunternehmen',
 'Baut, repariert und renoviert Gebaeude und Infrastruktur. Kann Strassenschaeden, Wasserleitung, Brandschutz und verfallene Gebaeude beheben.',
 '🏗',
 '["infrastruktur"]',
 5000, 5, 15),

('sicherheit',
 'Sicherheitsfirma',
 'Sorgt fuer Ordnung und Sicherheit. Bekaempft Einbrueche, Vandalismus und Drogenprobleme. Unterstuetzt die Polizei.',
 '🛡',
 '["sicherheit"]',
 7500, 8, 12),

('reinigung',
 'Reinigungsfirma',
 'Haelt die Gemeinde sauber. Rauemt Muell weg, entfernt Graffiti und beseitigt illegale Entsorgung.',
 '🧹',
 '["ordnung"]',
 3000, 3, 10),

('medien',
 'Medienhaus',
 'Investigativer Journalismus. Untersucht Korruption, Steuermissbrauch und mangelnde Transparenz in der Verwaltung.',
 '📰',
 '["verwaltung"]',
 10000, 12, 8);

-- ─── Unternehmen-Badges ──────────────────────────────────────
INSERT IGNORE INTO badges (code, name, description, category, rarity, sort_order) VALUES
  ('ACH_Company1',     'Unternehmer',          'Gruende deine erste Firma',                     'achievement', 1, 600),
  ('ACH_Contract1',    'Erster Auftrag',       'Schliesse deinen ersten Vertrag ab',             'achievement', 0, 610),
  ('ACH_Contract25',   'Auftragskoenig',       'Schliesse 25 Vertraege ab',                      'achievement', 2, 620),
  ('ACH_Contract100',  'Wirtschaftsmacht',     'Schliesse 100 Vertraege ab',                     'achievement', 3, 630),
  ('ACH_Revenue10k',   'Erste 10k',            'Verdiene 10.000 Spielwaehrung mit deiner Firma',  'achievement', 1, 640),
  ('ACH_Revenue100k',  'Grossunternehmer',     'Verdiene 100.000 Spielwaehrung mit deiner Firma', 'achievement', 3, 650),
  ('ACH_Reputation50', 'Guter Ruf',            'Erreiche 50 Firmen-Reputation',                   'achievement', 1, 660),
  ('ACH_MediaExpose',  'Enthuellung',          'Decke als Medienhaus einen Skandal auf',           'achievement', 3, 670);

-- ─── FK zu municipality_events nachtragen ────────────────────
-- Die assigned_company_id in municipality_events kann jetzt auf companies verweisen
-- (wurde in 027 ohne FK erstellt, da companies noch nicht existierte)
SET @fk_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'municipality_events'
    AND CONSTRAINT_NAME = 'fk_muni_events_assigned_company'
);

SET @fk_sql := IF(
  @fk_exists = 0,
  'ALTER TABLE municipality_events ADD CONSTRAINT fk_muni_events_assigned_company FOREIGN KEY (assigned_company_id) REFERENCES companies(id) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt_fk FROM @fk_sql;
EXECUTE stmt_fk;
DEALLOCATE PREPARE stmt_fk;
