-- uuid Spalte zu users hinzufügen (IF NOT EXISTS)
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'uuid'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE users ADD COLUMN uuid VARCHAR(36) NULL DEFAULT NULL AFTER id',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- uuid Spalte zu municipalities hinzufügen (IF NOT EXISTS)
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'municipalities' AND COLUMN_NAME = 'uuid'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE municipalities ADD COLUMN uuid VARCHAR(36) NULL DEFAULT NULL AFTER id',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
