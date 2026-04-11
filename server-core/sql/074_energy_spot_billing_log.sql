-- ── 074: Spot-Energie Billing-Log ────────────────────────────────────────────
-- Jeder Abrechnungs-Tick wird hier protokolliert.
-- Ermöglicht vollständige Nachvollziehbarkeit: wann, wieviel MW, von wem, zu welchem Preis.

CREATE TABLE IF NOT EXISTS energy_spot_billing_log (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contract_id             BIGINT UNSIGNED NOT NULL,
  billed_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  buyer_municipality_id   BIGINT UNSIGNED NOT NULL,
  seller_municipality_id  BIGINT UNSIGNED NOT NULL,
  buyer_municipality_name VARCHAR(255) NOT NULL DEFAULT '',
  seller_municipality_name VARCHAR(255) NOT NULL DEFAULT '',
  buyer_user_id           BIGINT UNSIGNED NOT NULL,
  seller_user_id          BIGINT UNSIGNED NOT NULL,
  deficit_total_mw        INT NOT NULL DEFAULT 0
    COMMENT 'Gesamtdefizit der Käufer-Gemeinde zum Zeitpunkt der Abrechnung',
  actual_mw               INT NOT NULL DEFAULT 0
    COMMENT 'Tatsächlich abgerechnete MW aus diesem Vertrag',
  price_per_mw_hour       DECIMAL(8,4) NOT NULL,
  amount_chf              DECIMAL(10,4) NOT NULL,
  auto_subscribed         TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_esbl_contract   (contract_id),
  KEY idx_esbl_buyer_muni (buyer_municipality_id),
  KEY idx_esbl_seller_muni(seller_municipality_id),
  KEY idx_esbl_billed_at  (billed_at),
  CONSTRAINT fk_esbl_contract FOREIGN KEY (contract_id)
    REFERENCES energy_trade_contracts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
