-- ============================================================
-- 029_events_building_snapshot.sql
-- Events an echte Gebaeude auf der Map binden
--
-- Speichert:
--   - room_code: In welchem Raum das Gebaeude steht
--   - building_snapshot: JSON-Snapshot vom Gebaeude zum Zeitpunkt
--     des Events (tool, x, y, level, metadata)
--   - building_verified_at: Wann zuletzt geprueft wurde ob das
--     Gebaeude noch existiert
--   - building_exists: Ob das Gebaeude bei letzter Pruefung noch da war
--
-- Damit kann der Server pruefen:
--   1. Steht das Gebaeude noch? (bulldozed?)
--   2. Hat sich der Zustand veraendert?
--   3. Ist das Event noch relevant?
-- ============================================================

-- room_code hinzufuegen
SET @col_room_code := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'municipality_events'
    AND COLUMN_NAME = 'room_code'
);
SET @sql_room_code := IF(@col_room_code = 0,
  'ALTER TABLE municipality_events ADD COLUMN room_code VARCHAR(10) NULL AFTER municipality_id',
  'SELECT 1');
PREPARE stmt FROM @sql_room_code;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- building_snapshot (JSON mit tool, x, y, level, metadata zum Zeitpunkt)
SET @col_snapshot := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'municipality_events'
    AND COLUMN_NAME = 'building_snapshot'
);
SET @sql_snapshot := IF(@col_snapshot = 0,
  'ALTER TABLE municipality_events ADD COLUMN building_snapshot JSON NULL COMMENT ''Snapshot vom Gebaeude bei Event-Erstellung'' AFTER affected_item_id',
  'SELECT 1');
PREPARE stmt FROM @sql_snapshot;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- building_verified_at (wann zuletzt gecheckt)
SET @col_verified := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'municipality_events'
    AND COLUMN_NAME = 'building_verified_at'
);
SET @sql_verified := IF(@col_verified = 0,
  'ALTER TABLE municipality_events ADD COLUMN building_verified_at DATETIME NULL COMMENT ''Letzter Zeitpunkt der Gebaeude-Existenz-Pruefung'' AFTER building_snapshot',
  'SELECT 1');
PREPARE stmt FROM @sql_verified;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- building_exists (Ergebnis der letzten Pruefung)
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'municipality_events'
    AND COLUMN_NAME = 'building_exists'
);
SET @sql_exists := IF(@col_exists = 0,
  'ALTER TABLE municipality_events ADD COLUMN building_exists TINYINT(1) NULL DEFAULT 1 COMMENT ''1=Gebaeude steht noch, 0=abgerissen, NULL=kein Gebaeude-Event'' AFTER building_verified_at',
  'SELECT 1');
PREPARE stmt FROM @sql_exists;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Index fuer affected_item_id (schnelle Lookups)
SET @idx_item := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'municipality_events'
    AND INDEX_NAME = 'idx_muni_events_affected_item'
);
SET @sql_idx := IF(@idx_item = 0,
  'ALTER TABLE municipality_events ADD KEY idx_muni_events_affected_item (affected_item_id)',
  'SELECT 1');
PREPARE stmt FROM @sql_idx;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ─── Event-Typ → Gebaeude Mapping ───────────────────────────
-- Tabelle die definiert welche Gebaeude-Tools fuer welchen Event-Typ
-- relevant sind (zum Generieren von Gebaeude-bezogenen Events)
CREATE TABLE IF NOT EXISTS event_type_building_map (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type_id  BIGINT UNSIGNED NOT NULL,
  building_tool  VARCHAR(100)    NOT NULL COMMENT 'game_items.tool z.B. police_station, school',
  priority       INT UNSIGNED    NOT NULL DEFAULT 10 COMMENT 'Hoeher = bevorzugt',
  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_event_building (event_type_id, building_tool),
  KEY idx_building_tool (building_tool),
  CONSTRAINT fk_event_building_type
    FOREIGN KEY (event_type_id) REFERENCES event_types(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Seed: Welche Events an welche Gebaeude gebunden werden ──
INSERT IGNORE INTO event_type_building_map (event_type_id, building_tool, priority)
SELECT et.id, m.tool, m.prio
FROM event_types et
JOIN (
  -- fire_safety → alle Gebaeude ausser Natur/Strassen
  SELECT 'fire_safety' AS ecode, 'police_station' AS tool, 10 AS prio
  UNION ALL SELECT 'fire_safety', 'fire_station', 10
  UNION ALL SELECT 'fire_safety', 'hospital', 10
  UNION ALL SELECT 'fire_safety', 'school', 10
  UNION ALL SELECT 'fire_safety', 'university', 10
  UNION ALL SELECT 'fire_safety', 'city_hall', 10
  UNION ALL SELECT 'fire_safety', 'community_center', 10
  UNION ALL SELECT 'fire_safety', 'office_building_small', 5
  UNION ALL SELECT 'fire_safety', 'warehouse', 5
  UNION ALL SELECT 'fire_safety', 'factory_medium', 5
  UNION ALL SELECT 'fire_safety', 'factory_large', 5

  -- illegal_build → Neubauten
  UNION ALL SELECT 'illegal_build', 'mansion', 10
  UNION ALL SELECT 'illegal_build', 'apartment_low', 10
  UNION ALL SELECT 'illegal_build', 'apartment_high', 10
  UNION ALL SELECT 'illegal_build', 'office_low', 10
  UNION ALL SELECT 'illegal_build', 'office_high', 10
  UNION ALL SELECT 'illegal_build', 'factory_medium', 8
  UNION ALL SELECT 'illegal_build', 'factory_large', 8
  UNION ALL SELECT 'illegal_build', 'warehouse', 5

  -- building_decay → aeltere Gebaeude
  UNION ALL SELECT 'building_decay', 'school', 10
  UNION ALL SELECT 'building_decay', 'hospital', 10
  UNION ALL SELECT 'building_decay', 'community_center', 10
  UNION ALL SELECT 'building_decay', 'city_hall', 8
  UNION ALL SELECT 'building_decay', 'mansion', 5
  UNION ALL SELECT 'building_decay', 'warehouse', 8
  UNION ALL SELECT 'building_decay', 'factory_medium', 8

  -- road_damage → Strassen
  UNION ALL SELECT 'road_damage', 'road', 20

  -- water_pipe_broken → Wasser-Infrastruktur
  UNION ALL SELECT 'water_pipe_broken', 'water_tower', 20

  -- power_outage → Strom-Infrastruktur
  UNION ALL SELECT 'power_outage', 'power_plant', 20

  -- police_underfunded → Polizei
  UNION ALL SELECT 'police_underfunded', 'police_station', 20

  -- school_understaffed → Schulen
  UNION ALL SELECT 'school_understaffed', 'school', 20
  UNION ALL SELECT 'school_understaffed', 'university', 15

  -- hospital_overload → Spital
  UNION ALL SELECT 'hospital_overload', 'hospital', 20

  -- housing_shortage → Wohngebaeude
  UNION ALL SELECT 'housing_shortage', 'mansion', 10
  UNION ALL SELECT 'housing_shortage', 'apartment_low', 15
  UNION ALL SELECT 'housing_shortage', 'apartment_high', 15

  -- burglary_wave → Wohn/Geschaefts-Gebaeude
  UNION ALL SELECT 'burglary_wave', 'mansion', 10
  UNION ALL SELECT 'burglary_wave', 'apartment_low', 10
  UNION ALL SELECT 'burglary_wave', 'apartment_high', 10
  UNION ALL SELECT 'burglary_wave', 'office_building_small', 8
  UNION ALL SELECT 'burglary_wave', 'mall', 8

  -- vandalism_wave → Oeffentliche Gebaeude und Parks
  UNION ALL SELECT 'vandalism_wave', 'park', 10
  UNION ALL SELECT 'vandalism_wave', 'park_large', 10
  UNION ALL SELECT 'vandalism_wave', 'playground_small', 10
  UNION ALL SELECT 'vandalism_wave', 'playground_large', 10
  UNION ALL SELECT 'vandalism_wave', 'skate_park', 10
  UNION ALL SELECT 'vandalism_wave', 'community_center', 8
) m ON m.ecode = et.code;
