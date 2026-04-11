CREATE TABLE IF NOT EXISTS user_identity (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  ahv_number VARCHAR(20) NOT NULL,
  tax_number VARCHAR(24) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_identity_user_id (user_id),
  UNIQUE KEY uq_user_identity_ahv (ahv_number),
  UNIQUE KEY uq_user_identity_tax (tax_number),
  CONSTRAINT fk_user_identity_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_bank_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  account_number VARCHAR(34) NOT NULL,
  card_number_last4 CHAR(4) NOT NULL,
  card_brand ENUM('MEINORT') NOT NULL DEFAULT 'MEINORT',
  balance BIGINT NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'CHF',
  status ENUM('active','frozen','closed') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_bank_accounts_user_id (user_id),
  UNIQUE KEY uq_user_bank_accounts_account_number (account_number),
  KEY idx_user_bank_accounts_status (status),
  CONSTRAINT fk_user_bank_accounts_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bank_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  direction ENUM('credit','debit') NOT NULL,
  type VARCHAR(32) NOT NULL DEFAULT 'reward',
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  reference VARCHAR(64) NULL,
  description VARCHAR(255) NULL,
  meta_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bank_transactions_account_id (account_id),
  KEY idx_bank_transactions_created_at (created_at),
  KEY idx_bank_transactions_type (type),
  CONSTRAINT fk_bank_transactions_account
    FOREIGN KEY (account_id) REFERENCES user_bank_accounts(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
