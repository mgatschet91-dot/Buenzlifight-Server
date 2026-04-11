-- ── 071: Spot-Energie-Verträge ────────────────────────────────────────────────
-- Spot = dynamisch: Käufer zahlt nur was tatsächlich genutzt wird (Defizit-gedeckt)
-- Zahlung: persönliches Bankkonto Käufer → persönliches Bankkonto Verkäufer (CHF/MW/Min)

ALTER TABLE energy_trade_contracts
  ADD COLUMN contract_type  ENUM('fixed','spot') NOT NULL DEFAULT 'fixed'
    COMMENT 'fixed = feste MW blockiert, spot = dynamisch nach Defizit',
  ADD COLUMN spot_max_mw    INT UNSIGNED NULL DEFAULT NULL
    COMMENT 'Max abrufbare MW pro Billing-Zyklus bei Spot-Verträgen',
  ADD COLUMN seller_user_id BIGINT UNSIGNED NULL DEFAULT NULL
    COMMENT 'User-ID des Verkäufers (für persönliche Bank-Gutschrift)',
  ADD COLUMN buyer_user_id  BIGINT UNSIGNED NULL DEFAULT NULL
    COMMENT 'User-ID des Käufers (für persönliche Bank-Abbuchung)';

-- Öffentlich sichtbare Spot-Angebote (anderer Spieler kann abonnieren)
CREATE TABLE IF NOT EXISTS energy_spot_offers (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  seller_municipality_id BIGINT UNSIGNED NOT NULL,
  seller_user_id         BIGINT UNSIGNED NOT NULL,
  max_mw                 INT UNSIGNED NOT NULL DEFAULT 10
    COMMENT 'Max MW die pro Stunde zur Verfügung gestellt werden',
  price_per_mw_hour      DECIMAL(8,4) NOT NULL DEFAULT 2.00
    COMMENT 'CHF pro MW pro Stunde (÷60 pro Minute)',
  status                 ENUM('active','cancelled') NOT NULL DEFAULT 'active',
  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_eso_status     (status),
  KEY idx_eso_seller_muni(seller_municipality_id),
  CONSTRAINT fk_eso_seller_muni FOREIGN KEY (seller_municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
  CONSTRAINT fk_eso_seller_user FOREIGN KEY (seller_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
