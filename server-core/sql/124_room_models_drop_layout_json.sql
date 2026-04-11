-- Migration 124: layout_json Spalte aus room_models entfernen
-- Die Spalte war redundant: Raumgeometrie wird aus room_floors + room_staircases geladen,
-- nicht aus JSON. Das JSON enthielt ausserdem falsche Daten (6x6 Raum ohne Treppe).

SET @dbname = DATABASE();
SET @tblname = 'room_models';
SET @colname = 'layout_json';
SET @sql = IF(
  EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @dbname
      AND TABLE_NAME  = @tblname
      AND COLUMN_NAME = @colname
  ),
  CONCAT('ALTER TABLE `', @tblname, '` DROP COLUMN `', @colname, '`'),
  'SELECT 1 -- column already removed'
);
PREPARE _stmt FROM @sql;
EXECUTE _stmt;
DEALLOCATE PREPARE _stmt;
