-- ============================================================
-- 154: Global- und Kantonal-Chat
-- Neue Tabellen fuer chat scope='global' und scope='cantonal'
-- sowie Mute-Verwaltung fuer beide Scopes.
-- ============================================================

CREATE TABLE IF NOT EXISTS global_chat_messages (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope           ENUM('cantonal', 'global') NOT NULL DEFAULT 'global',
  canton_code     CHAR(2) NULL DEFAULT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  message         TEXT NOT NULL,
  type            ENUM('text', 'system', 'announcement') NOT NULL DEFAULT 'text',
  reply_to_id     BIGINT UNSIGNED NULL DEFAULT NULL,
  is_edited       TINYINT(1) NOT NULL DEFAULT 0,
  edited_at       TIMESTAMP NULL DEFAULT NULL,
  deleted_at      TIMESTAMP NULL DEFAULT NULL,
  deleted_by      BIGINT UNSIGNED NULL DEFAULT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_scope_canton_created (scope, canton_code, created_at),
  KEY idx_scope_created (scope, created_at),
  KEY idx_user_created (user_id, created_at),
  KEY idx_reply_to_id (reply_to_id),
  CONSTRAINT fk_global_chat_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_global_chat_deleted_by FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_global_chat_reply FOREIGN KEY (reply_to_id) REFERENCES global_chat_messages(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS global_chat_mutes (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  muted_by    BIGINT UNSIGNED NOT NULL,
  scope       ENUM('cantonal', 'global') NOT NULL DEFAULT 'global',
  canton_code CHAR(2) NULL DEFAULT NULL,
  expires_at  TIMESTAMP NULL DEFAULT NULL,
  reason      VARCHAR(255) NULL DEFAULT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_scope_canton (user_id, scope, canton_code),
  CONSTRAINT fk_gcmute_user    FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_gcmute_muted_by FOREIGN KEY (muted_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
