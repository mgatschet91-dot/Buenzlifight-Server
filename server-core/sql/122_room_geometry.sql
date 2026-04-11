-- Migration 122: Raumgeometrie in SQL
-- room_models bekommt Geometrie-Spalten (Grid, Wände, Tür)
-- Neue Tabellen: room_floors (Stockwerke), room_staircases (Treppen)

-- ── Geometrie-Spalten zu room_models hinzufügen ───────────────────────────────
ALTER TABLE room_models
  ADD COLUMN grid_size    TINYINT UNSIGNED NOT NULL DEFAULT 20   AFTER display_name,
  ADD COLUMN wall_n       TINYINT(1)       NOT NULL DEFAULT 1    AFTER grid_size,
  ADD COLUMN wall_s       TINYINT(1)       NOT NULL DEFAULT 0    AFTER wall_n,
  ADD COLUMN wall_e       TINYINT(1)       NOT NULL DEFAULT 0    AFTER wall_s,
  ADD COLUMN wall_w       TINYINT(1)       NOT NULL DEFAULT 1    AFTER wall_e,
  ADD COLUMN door_wall    CHAR(1)          NOT NULL DEFAULT 'S'  AFTER wall_w,
  ADD COLUMN door_offset  FLOAT            NOT NULL DEFAULT 0.0  AFTER door_wall,
  ADD COLUMN door_width   FLOAT            NOT NULL DEFAULT 1.8  AFTER door_offset,
  ADD COLUMN door_height  FLOAT            NOT NULL DEFAULT 2.2  AFTER door_width;

-- ── Stockwerke (upper floors, Erdgeschoss y=0 ist immer implizit) ─────────────
CREATE TABLE IF NOT EXISTS room_floors (
  id           INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  model_name   VARCHAR(50)      NOT NULL,
  floor_index  TINYINT UNSIGNED NOT NULL DEFAULT 1,
  y_height     FLOAT            NOT NULL DEFAULT 7.0,
  x0           FLOAT            NOT NULL DEFAULT -7.0,
  x1           FLOAT            NOT NULL DEFAULT  8.0,
  z0           FLOAT            NOT NULL DEFAULT -9.0,
  z1           FLOAT            NOT NULL DEFAULT -3.0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_floor (model_name, floor_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Treppen (verbinden Stockwerke) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS room_staircases (
  id           INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  model_name   VARCHAR(50)      NOT NULL,
  x0           FLOAT            NOT NULL DEFAULT  5.0,
  x1           FLOAT            NOT NULL DEFAULT  8.0,
  z0           FLOAT            NOT NULL DEFAULT -3.0,
  z1           FLOAT            NOT NULL DEFAULT  7.0,
  from_floor   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  to_floor     TINYINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Seed: model_standard Geometrie ───────────────────────────────────────────
UPDATE room_models SET
  grid_size   = 20,
  wall_n      = 1,
  wall_s      = 0,
  wall_e      = 0,
  wall_w      = 1,
  door_wall   = 'S',
  door_offset = 0.0,
  door_width  = 1.8,
  door_height = 2.2
WHERE model_name = 'model_standard';

INSERT INTO room_floors (model_name, floor_index, y_height, x0, x1, z0, z1) VALUES
  ('model_standard', 1, 7.0, -7.0, 8.0, -9.0, -3.0)
ON DUPLICATE KEY UPDATE
  y_height = VALUES(y_height),
  x0 = VALUES(x0), x1 = VALUES(x1),
  z0 = VALUES(z0), z1 = VALUES(z1);

INSERT INTO room_staircases (model_name, x0, x1, z0, z1, from_floor, to_floor) VALUES
  ('model_standard', 5.0, 8.0, -3.0, 7.0, 0, 1);
