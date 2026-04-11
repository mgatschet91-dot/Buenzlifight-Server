-- ============================================================
-- 034: Persistente Benutzer-Benachrichtigungen
-- ============================================================
-- Speichert Idle-Earnings, Meilenstein-Boni und andere Events
-- damit sie nicht verloren gehen bei Page-Reload.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_notifications (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  municipality_id INT UNSIGNED DEFAULT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'info',
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  icon VARCHAR(50) NOT NULL DEFAULT 'info',
  amount INT DEFAULT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_unread (user_id, is_read, created_at),
  KEY idx_user_date (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
