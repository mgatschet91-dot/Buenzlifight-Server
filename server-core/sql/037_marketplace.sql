-- 037_marketplace.sql
-- Marktplatz: Spieler koennen Items/Ressourcen handeln

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  seller_id       BIGINT UNSIGNED NOT NULL,
  item_code       VARCHAR(64)     NOT NULL COMMENT 'Item/Ressource die verkauft wird',
  quantity        INT UNSIGNED    NOT NULL DEFAULT 1,
  price_per_unit  INT UNSIGNED    NOT NULL COMMENT 'Preis pro Stueck in Coins',
  status          ENUM('active','sold','cancelled','expired') NOT NULL DEFAULT 'active',
  buyer_id        BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sold_at         DATETIME        NULL,
  expires_at      DATETIME        NOT NULL,
  PRIMARY KEY (id),
  KEY idx_listing_seller (seller_id),
  KEY idx_listing_status (status),
  KEY idx_listing_item (item_code, status),
  CONSTRAINT fk_listing_seller
    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS direct_trades (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sender_id       BIGINT UNSIGNED NOT NULL,
  receiver_id     BIGINT UNSIGNED NOT NULL,
  coins_offered   INT UNSIGNED    NOT NULL DEFAULT 0,
  coins_requested INT UNSIGNED    NOT NULL DEFAULT 0,
  message         VARCHAR(255)    NULL,
  status          ENUM('pending','accepted','rejected','cancelled') NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at    DATETIME        NULL,
  PRIMARY KEY (id),
  KEY idx_trade_sender (sender_id),
  KEY idx_trade_receiver (receiver_id),
  KEY idx_trade_status (status),
  CONSTRAINT fk_trade_sender
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_trade_receiver
    FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
