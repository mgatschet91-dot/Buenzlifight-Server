-- Global user rank + role mapping for server-core.
-- Rule: rank >= 7 => administrator, rank >= 6 => moderator, else user.

SET @users_rank_col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'rank'
);

SET @users_rank_col_sql := IF(
  @users_rank_col_exists = 0,
  'ALTER TABLE users ADD COLUMN `rank` TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER nickname',
  'SELECT 1'
);
PREPARE stmt_users_rank_col FROM @users_rank_col_sql;
EXECUTE stmt_users_rank_col;
DEALLOCATE PREPARE stmt_users_rank_col;

SET @users_rank_idx_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'idx_users_rank'
);

SET @users_rank_idx_sql := IF(
  @users_rank_idx_exists = 0,
  'ALTER TABLE users ADD INDEX idx_users_rank (`rank`)',
  'SELECT 1'
);
PREPARE stmt_users_rank_idx FROM @users_rank_idx_sql;
EXECUTE stmt_users_rank_idx;
DEALLOCATE PREPARE stmt_users_rank_idx;

CREATE TABLE IF NOT EXISTS user_global_roles (
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('user', 'moderator', 'administrator') NOT NULL DEFAULT 'user',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  KEY idx_global_role (role),
  CONSTRAINT fk_user_global_roles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO user_global_roles (user_id, role)
SELECT
  u.id,
  CASE
    WHEN COALESCE(u.`rank`, 0) >= 7 THEN 'administrator'
    WHEN COALESCE(u.`rank`, 0) >= 6 THEN 'moderator'
    ELSE 'user'
  END AS role
FROM users u
WHERE u.is_active = 1
ON DUPLICATE KEY UPDATE
  role = VALUES(role),
  updated_at = CURRENT_TIMESTAMP;
