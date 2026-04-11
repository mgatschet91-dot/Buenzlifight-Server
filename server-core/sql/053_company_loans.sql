-- ============================================================
-- 053_company_loans.sql
-- Firma-Kredit-System (Company Loan Requests + Tracking)
--
-- Ablauf:
--   1. User will Firma gruenden, aber Gemeindekasse hat nicht genug
--   2. User beantragt Kredit fuer die Differenz
--   3. Gemeindepraesident/Gemeinderat genehmigt oder lehnt ab
--   4. Bei Genehmigung: Gemeinde finanziert Gruendung, Firma wird erstellt
--   5. Firma zahlt woechentlich Raten + Zinsen aus company.balance zurueck
--   6. Bei 3x Zahlungsausfall wird Firma automatisch aufgeloest
-- ============================================================

-- ─── Gemeinde-Einstellung: Zinssatz fuer Firma-Kredite ─────
SET @s = (SELECT IF(COUNT(*)=0,
  'ALTER TABLE municipality_stats ADD COLUMN company_loan_interest_rate DECIMAL(8,6) NOT NULL DEFAULT 0.001000 COMMENT ''Woechentlicher Zinssatz fuer Firma-Kredite (0.1%% = 0.001). Einstellbar im GemeindePanel.''',
  'SELECT 1')
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA=DATABASE()
  AND TABLE_NAME='municipality_stats'
  AND COLUMN_NAME='company_loan_interest_rate');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─── Firma-Kredit-Antraege (Genehmigungs-Workflow) ─────────
CREATE TABLE IF NOT EXISTS company_loan_requests (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  municipality_id     BIGINT UNSIGNED  NOT NULL COMMENT 'Gemeinde (Kreditgeber)',
  requesting_user_id  BIGINT UNSIGNED  NOT NULL COMMENT 'User der die Firma gruenden will',
  company_type_id     BIGINT UNSIGNED  NOT NULL COMMENT 'Gewuenschter Firmen-Typ',
  company_name        VARCHAR(128)     NOT NULL COMMENT 'Gewuenschter Firmenname',
  founding_cost       INT UNSIGNED     NOT NULL COMMENT 'Gesamte Gruendungskosten',
  loan_amount         INT UNSIGNED     NOT NULL COMMENT 'Kreditbetrag',
  interest_rate       DECIMAL(8,6)     NOT NULL DEFAULT 0.001000 COMMENT 'Woechentlicher Zinssatz bei Antragstellung',
  weekly_repayment    INT UNSIGNED     NOT NULL DEFAULT 0 COMMENT 'Berechnete woechentliche Rate',
  status              VARCHAR(24)      NOT NULL DEFAULT 'pending'
    COMMENT 'pending, approved, rejected, cancelled',
  message             VARCHAR(500)     NULL     COMMENT 'Optionale Nachricht vom Antragsteller',
  reject_reason       VARCHAR(500)     NULL     COMMENT 'Optionaler Ablehnungsgrund',
  responded_by        BIGINT UNSIGNED  NULL     COMMENT 'User der genehmigt/abgelehnt hat',
  responded_at        DATETIME         NULL,
  company_id          BIGINT UNSIGNED  NULL     COMMENT 'Erstellte Firma (nach Genehmigung)',
  created_at          TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_loan_req_municipality (municipality_id, status),
  KEY idx_loan_req_user (requesting_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Aktive Firma-Kredite (Schulden-Tracking) ──────────────
CREATE TABLE IF NOT EXISTS company_loans (
  id                    BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  company_id            BIGINT UNSIGNED  NOT NULL COMMENT 'Firma die den Kredit hat',
  municipality_id       BIGINT UNSIGNED  NOT NULL COMMENT 'Gemeinde = Kreditgeber',
  loan_request_id       BIGINT UNSIGNED  NOT NULL COMMENT 'Zugehoeriger Antrag',
  original_amount       INT UNSIGNED     NOT NULL COMMENT 'Urspruenglicher Kreditbetrag',
  remaining_amount      INT              NOT NULL COMMENT 'Verbleibende Schulden (inkl. Zinsen)',
  interest_rate         DECIMAL(8,6)     NOT NULL DEFAULT 0.001000 COMMENT 'Woechentlicher Zinssatz',
  weekly_repayment      INT UNSIGNED     NOT NULL DEFAULT 0 COMMENT 'Woechentliche Rate',
  total_interest_paid   INT UNSIGNED     NOT NULL DEFAULT 0 COMMENT 'Bisher gezahlte Zinsen',
  total_principal_paid  INT UNSIGNED     NOT NULL DEFAULT 0 COMMENT 'Bisher gezahltes Kapital',
  missed_payments       TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Aufeinanderfolgende verpasste Zahlungen',
  status                VARCHAR(24)      NOT NULL DEFAULT 'active'
    COMMENT 'active, paid_off, defaulted',
  last_payment_at       DATETIME         NULL,
  last_interest_at      DATETIME         NULL     COMMENT 'Letzte Zinsberechnung',
  paid_off_at           DATETIME         NULL,
  defaulted_at          DATETIME         NULL,
  created_at            TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_loan_company (company_id),
  KEY idx_loan_municipality (municipality_id),
  KEY idx_loan_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
