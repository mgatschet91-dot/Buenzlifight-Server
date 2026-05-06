-- ============================================================
-- 155: User-Block-System
-- Erlaubt es Spielern, andere Spieler zu blockieren.
-- Blockierte User koennen keine PNs senden und keine
-- neuen Konversationen starten.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_blocks (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  blocker_id  BIGINT UNSIGNED NOT NULL COMMENT 'Wer hat blockiert',
  blocked_id  BIGINT UNSIGNED NOT NULL COMMENT 'Wer wurde blockiert',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_block_pair (blocker_id, blocked_id),
  KEY idx_blocker (blocker_id),
  KEY idx_blocked (blocked_id),
  CONSTRAINT fk_block_blocker FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_block_blocked FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
