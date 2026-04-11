-- Google OAuth: google_id Spalte zu users hinzufügen (IF NOT EXISTS via SET)
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'google_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE users ADD COLUMN google_id VARCHAR(128) NULL DEFAULT NULL UNIQUE AFTER email',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
