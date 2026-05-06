CREATE TABLE IF NOT EXISTS room_bans (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  owner_user_id  BIGINT NOT NULL,
  banned_user_id BIGINT NOT NULL,
  reason         VARCHAR(255) NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_room_ban (owner_user_id, banned_user_id),
  INDEX idx_rb_owner (owner_user_id),
  INDEX idx_rb_banned (banned_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
