-- Migration 123: User-spezifische Raum-Layout-Tabellen
-- Speichert Etagen, Treppen, Roller und Spawn-Punkt pro User (nicht per model_name)
-- Ermöglicht individuelles Bearbeiten des eigenen Raums ohne andere zu beeinflussen.

-- ── Etagen pro User ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_room_floors (
  id          INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED     NOT NULL,
  floor_index TINYINT UNSIGNED NOT NULL DEFAULT 0,
  name        VARCHAR(80)      NOT NULL DEFAULT 'Erdgeschoss',
  y_height    FLOAT            NOT NULL DEFAULT 0.0,
  x0          FLOAT            NOT NULL DEFAULT -10.0,
  x1          FLOAT            NOT NULL DEFAULT  10.0,
  z0          FLOAT            NOT NULL DEFAULT -10.0,
  z1          FLOAT            NOT NULL DEFAULT  10.0,
  color_a     INT UNSIGNED     NOT NULL DEFAULT 4882010,
  color_b     INT UNSIGNED     NOT NULL DEFAULT 5406051,
  wall_n      TINYINT(1)       NOT NULL DEFAULT 0,
  wall_s      TINYINT(1)       NOT NULL DEFAULT 0,
  wall_e      TINYINT(1)       NOT NULL DEFAULT 0,
  wall_w      TINYINT(1)       NOT NULL DEFAULT 0,
  door_n      TINYINT(1)       NOT NULL DEFAULT 0,
  door_s      TINYINT(1)       NOT NULL DEFAULT 0,
  door_e      TINYINT(1)       NOT NULL DEFAULT 0,
  door_w      TINYINT(1)       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_floor (user_id, floor_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Boden-Löcher (Tile-Aussparungen) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_room_floor_holes (
  id       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  floor_id INT UNSIGNED NOT NULL,
  tile_x   SMALLINT     NOT NULL,
  tile_z   SMALLINT     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hole (floor_id, tile_x, tile_z),
  CONSTRAINT fk_hole_floor FOREIGN KEY (floor_id)
    REFERENCES user_room_floors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Treppen pro User ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_room_staircases (
  id          INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED     NOT NULL,
  from_floor  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  to_floor    TINYINT UNSIGNED          DEFAULT NULL,
  anchor_x    FLOAT            NOT NULL DEFAULT 0.0,
  anchor_z    FLOAT            NOT NULL DEFAULT 0.0,
  dir         CHAR(1)          NOT NULL DEFAULT 'N',
  width_tiles FLOAT            NOT NULL DEFAULT 3.0,
  steps       SMALLINT         NOT NULL DEFAULT 14,
  height      FLOAT            NOT NULL DEFAULT 7.0,
  style       VARCHAR(16)      NOT NULL DEFAULT 'classic',
  gate_width  FLOAT                     DEFAULT NULL,
  gate_open   TINYINT(1)       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Roller (Förderband-Tiles) pro User ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_room_rollers (
  id        INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  user_id   INT UNSIGNED     NOT NULL,
  floor_idx TINYINT UNSIGNED NOT NULL DEFAULT 0,
  x         FLOAT            NOT NULL,
  z         FLOAT            NOT NULL,
  dir       CHAR(1)          NOT NULL DEFAULT 'S',
  PRIMARY KEY (id),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Spawn-Punkt pro User ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_room_spawn (
  user_id   INT UNSIGNED     NOT NULL,
  spawn_x   FLOAT            NOT NULL DEFAULT 0.0,
  spawn_z   FLOAT            NOT NULL DEFAULT 0.0,
  floor_idx TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
