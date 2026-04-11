-- Standalone users table (MySQL 8+)

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  email VARCHAR(191) NOT NULL,
  nickname VARCHAR(64) NOT NULL,
  municipality_id BIGINT UNSIGNED NULL,
  password_hash VARCHAR(255) NOT NULL,
  password_salt VARCHAR(64) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_email_verified TINYINT(1) NOT NULL DEFAULT 0,
  last_login_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_uuid (uuid),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_nickname (nickname),
  KEY idx_users_active_created (is_active, created_at),
  KEY idx_users_municipality_id (municipality_id),
  CONSTRAINT fk_users_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
