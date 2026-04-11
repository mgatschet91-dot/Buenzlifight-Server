-- ============================================================
-- 043: Konsolidierung aller inline DDL-Statements
--
-- Verschiebt CREATE TABLE / ALTER TABLE Logik aus dem Server-Code
-- in eine einzige Migration. Alle Statements verwenden IF NOT EXISTS
-- bzw. prüfen auf bestehende Spalten, damit sie idempotent sind.
-- ============================================================

-- ── municipality_memberships ────────────────────────────────
CREATE TABLE IF NOT EXISTS municipality_memberships (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('owner', 'council', 'citizen', 'observer') NOT NULL DEFAULT 'citizen',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_municipality_user (municipality_id, user_id),
  KEY idx_user_id (user_id),
  KEY idx_municipality_role (municipality_id, role),
  CONSTRAINT fk_membership_municipality FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
  CONSTRAINT fk_membership_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── municipalities.is_user_created ──────────────────────────
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'municipalities' AND COLUMN_NAME = 'is_user_created');
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE municipalities ADD COLUMN is_user_created TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── municipality_coat_of_arms ───────────────────────────────
CREATE TABLE IF NOT EXISTS municipality_coat_of_arms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id BIGINT UNSIGNED NOT NULL,
  image_filename VARCHAR(255) NOT NULL,
  byte_size INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_municipality_id (municipality_id),
  CONSTRAINT fk_coa_municipality FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── municipality_chat_messages ──────────────────────────────
CREATE TABLE IF NOT EXISTS municipality_chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  message TEXT NOT NULL,
  type ENUM('text', 'system', 'announcement') NOT NULL DEFAULT 'text',
  metadata JSON NULL,
  reply_to_id BIGINT UNSIGNED NULL,
  is_edited TINYINT(1) NOT NULL DEFAULT 0,
  edited_at TIMESTAMP NULL DEFAULT NULL,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_municipality_created (municipality_id, created_at),
  KEY idx_user_created (user_id, created_at),
  KEY idx_reply_to_id (reply_to_id),
  CONSTRAINT fk_chat_msg_municipality FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_msg_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_msg_reply FOREIGN KEY (reply_to_id) REFERENCES municipality_chat_messages(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── municipality_chat_logs ──────────────────────────────────
CREATE TABLE IF NOT EXISTS municipality_chat_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  action ENUM('created', 'edited', 'deleted', 'restored', 'reported') NOT NULL,
  old_content TEXT NULL,
  new_content TEXT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent TEXT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_message_created (message_id, created_at),
  KEY idx_user_action (user_id, action),
  CONSTRAINT fk_chat_log_message FOREIGN KEY (message_id) REFERENCES municipality_chat_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_log_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── users_data ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users_data (
  user_id BIGINT UNSIGNED NOT NULL,
  avatar_config JSON NULL,
  project_data JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_users_data_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── user_inventory ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_inventory (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  item_code VARCHAR(64) NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 0,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_item (user_id, item_code),
  KEY idx_user_updated (user_id, updated_at),
  CONSTRAINT fk_user_inventory_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── achievements ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS achievements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT NULL,
  goal_type VARCHAR(64) NOT NULL,
  goal_value BIGINT NOT NULL DEFAULT 1,
  reward_xp INT NOT NULL DEFAULT 0,
  reward_money BIGINT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_code (code),
  KEY idx_active_order (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS achievement_user (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  municipality_id BIGINT UNSIGNED NOT NULL,
  achievement_id BIGINT UNSIGNED NOT NULL,
  progress_value BIGINT NOT NULL DEFAULT 0,
  achieved TINYINT(1) NOT NULL DEFAULT 0,
  achieved_at TIMESTAMP NULL DEFAULT NULL,
  claimed TINYINT(1) NOT NULL DEFAULT 0,
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_user_municipality_achievement (user_id, municipality_id, achievement_id),
  KEY idx_user_scope (user_id, municipality_id),
  KEY idx_achievement_scope (achievement_id, municipality_id),
  CONSTRAINT fk_achievement_user_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_achievement_user_municipality FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
  CONSTRAINT fk_achievement_user_achievement FOREIGN KEY (achievement_id) REFERENCES achievements(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Bobba-Tabellen entfernt (rooms, room_favourites, room_items, catalog_items) ──
