-- ============================================================
-- 049: Municipality Ledger (Audit-Trail fuer Gemeindekasse)
-- ============================================================
-- Jede Geldbewegung der Gemeinde wird hier protokolliert.
-- Keine Transaktion ohne Ledger-Eintrag.
-- ============================================================

CREATE TABLE IF NOT EXISTS municipality_ledger (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id  BIGINT UNSIGNED NOT NULL,
  ts               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  type             VARCHAR(32) NOT NULL
    COMMENT 'building_cost, bulldoze_cost, upgrade_cost, upkeep,
             income_tax, building_income, idle_earnings,
             company_founding, company_dissolve, contract_payment,
             loan_take, loan_repay, interest,
             marketplace_buy, marketplace_sell, trade_send, trade_receive,
             event_fix, event_penalty, emergency_repair,
             shield, milestone, refund, correction',
  amount           BIGINT NOT NULL COMMENT 'Signed: +Einnahme / -Ausgabe',
  balance_after    BIGINT NOT NULL COMMENT 'Treasury danach',
  debt_after       BIGINT NOT NULL DEFAULT 0 COMMENT 'Schulden danach',
  meta_json        JSON NULL COMMENT '{buildingId, eventId, companyId, tool, listingId, tradeId, ...}',
  actor_user_id    BIGINT UNSIGNED NULL COMMENT 'NULL = System/Tick',
  source           VARCHAR(16) NOT NULL DEFAULT 'system'
    COMMENT 'system, user, admin',
  PRIMARY KEY (id),
  KEY idx_ledger_muni_ts (municipality_id, ts DESC),
  KEY idx_ledger_muni_type (municipality_id, type),
  CONSTRAINT fk_ledger_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
