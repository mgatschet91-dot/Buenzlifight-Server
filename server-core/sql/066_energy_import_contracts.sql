-- Strom-Import-Verträge zwischen Gemeinden
CREATE TABLE IF NOT EXISTS energy_import_contracts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  buyer_municipality_id BIGINT UNSIGNED NOT NULL,
  seller_municipality_id BIGINT UNSIGNED NOT NULL,
  price_per_unit DECIMAL(6,2) NOT NULL DEFAULT 1.60,
  max_units INT UNSIGNED NOT NULL DEFAULT 500,
  status ENUM('active','paused','terminated') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_energy_contract_pair (buyer_municipality_id, seller_municipality_id),
  CONSTRAINT fk_energy_contract_buyer
    FOREIGN KEY (buyer_municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
  CONSTRAINT fk_energy_contract_seller
    FOREIGN KEY (seller_municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
