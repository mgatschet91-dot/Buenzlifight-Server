-- =============================================
-- 020: Messenger-System (Freunde, Nachrichten, Anfragen)
-- =============================================
-- Drei Chat-Systeme:
--   1. Gemeinde-Chat   → municipality_chat_messages (existiert bereits)
--   2. Public Room Chat → WebSocket ephemeral (kein SQL nötig)
--   3. Messenger Chat   → user_messenger_messages (NEU, dieses Script)
-- =============================================

-- ─── Freundschaften ────────────────────────────────────────────
-- Bidirektionale Beziehung: user_id < friend_id (Constraint)
-- Status: 'accepted' = aktive Freundschaft
CREATE TABLE IF NOT EXISTS user_friends (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NOT NULL,
  friend_id     BIGINT UNSIGNED NOT NULL,
  status        ENUM('accepted','blocked') NOT NULL DEFAULT 'accepted',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Verhindert Duplikate (Richtung normalisiert: kleinere ID zuerst)
  UNIQUE KEY uq_user_friends_pair (user_id, friend_id),

  KEY idx_user_friends_user   (user_id, status),
  KEY idx_user_friends_friend (friend_id, status),

  CONSTRAINT fk_user_friends_user   FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_friends_friend FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─── Freundschaftsanfragen ─────────────────────────────────────
-- sender_id schickt Anfrage an receiver_id
-- Status: pending → accepted / denied
CREATE TABLE IF NOT EXISTS user_friend_requests (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sender_id     BIGINT UNSIGNED NOT NULL,
  receiver_id   BIGINT UNSIGNED NOT NULL,
  status        ENUM('pending','accepted','denied') NOT NULL DEFAULT 'pending',
  message       VARCHAR(255) NULL DEFAULT NULL COMMENT 'Optionale Nachricht bei der Anfrage',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Pro Paar nur eine aktive Anfrage (pending)
  UNIQUE KEY uq_friend_request_pair (sender_id, receiver_id),

  KEY idx_friend_requests_receiver (receiver_id, status),
  KEY idx_friend_requests_sender   (sender_id, status),

  CONSTRAINT fk_friend_request_sender   FOREIGN KEY (sender_id)   REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_friend_request_receiver FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─── Messenger-Gespräche (Konversationen) ──────────────────────
-- Ein Gespräch kann 2 oder mehr Teilnehmer haben (1:1 oder Gruppe)
CREATE TABLE IF NOT EXISTS user_messenger_conversations (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title         VARCHAR(100) NULL DEFAULT NULL COMMENT 'Optionaler Gruppenname',
  is_group      TINYINT(1) NOT NULL DEFAULT 0 COMMENT '0 = 1:1, 1 = Gruppe',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─── Gesprächs-Teilnehmer ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_messenger_participants (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  joined_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_read_at    DATETIME NULL DEFAULT NULL COMMENT 'Zeitstempel der letzten gelesenen Nachricht',
  is_muted        TINYINT(1) NOT NULL DEFAULT 0,

  UNIQUE KEY uq_conversation_user (conversation_id, user_id),

  KEY idx_messenger_participants_user (user_id),

  CONSTRAINT fk_messenger_participant_conv FOREIGN KEY (conversation_id) REFERENCES user_messenger_conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_messenger_participant_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─── Messenger-Nachrichten ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_messenger_messages (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT UNSIGNED NOT NULL,
  sender_id       BIGINT UNSIGNED NOT NULL,
  message         TEXT NOT NULL,
  type            ENUM('text','system','image') NOT NULL DEFAULT 'text',
  is_edited       TINYINT(1) NOT NULL DEFAULT 0,
  edited_at       DATETIME NULL DEFAULT NULL,
  deleted_at      DATETIME NULL DEFAULT NULL COMMENT 'Soft-Delete',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_messenger_messages_conv     (conversation_id, created_at),
  KEY idx_messenger_messages_sender   (sender_id),

  CONSTRAINT fk_messenger_message_conv   FOREIGN KEY (conversation_id) REFERENCES user_messenger_conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_messenger_message_sender FOREIGN KEY (sender_id)       REFERENCES users(id)                        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─── Online-Status Tracking ────────────────────────────────────
-- Wird vom Server aktualisiert bei WS connect/disconnect
SET @col_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'is_online');
SET @sql_add = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN is_online TINYINT(1) NOT NULL DEFAULT 0 AFTER is_email_verified', 'SELECT 1');
PREPARE stmt FROM @sql_add;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists2 = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'last_online_at');
SET @sql_add2 = IF(@col_exists2 = 0, 'ALTER TABLE users ADD COLUMN last_online_at DATETIME NULL DEFAULT NULL AFTER is_online', 'SELECT 1');
PREPARE stmt2 FROM @sql_add2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;
