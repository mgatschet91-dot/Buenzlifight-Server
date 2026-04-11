ALTER TABLE municipality_stats
  ADD COLUMN energy_sold_mw INT NOT NULL DEFAULT 0 COMMENT 'Aktuell verkaufte MW an andere Gemeinden';

ALTER TABLE municipality_stats
  ADD COLUMN energy_bought_mw INT NOT NULL DEFAULT 0 COMMENT 'Aktuell gekaufte MW von anderen Gemeinden';

CREATE TABLE IF NOT EXISTS energy_trade_contracts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  seller_municipality_id BIGINT UNSIGNED NOT NULL,
  buyer_municipality_id  BIGINT UNSIGNED NOT NULL,
  mw_amount              INT UNSIGNED NOT NULL DEFAULT 0,
  price_per_mw           DECIMAL(8,2) NOT NULL DEFAULT 2.00,
  status                 ENUM('active','terminated') NOT NULL DEFAULT 'active',
  marketplace_listing_id BIGINT UNSIGNED NULL,
  started_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  terminated_at          DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_etc_seller (seller_municipality_id),
  KEY idx_etc_buyer (buyer_municipality_id),
  KEY idx_etc_status (status),
  CONSTRAINT fk_etc_seller FOREIGN KEY (seller_municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
  CONSTRAINT fk_etc_buyer  FOREIGN KEY (buyer_municipality_id)  REFERENCES municipalities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
