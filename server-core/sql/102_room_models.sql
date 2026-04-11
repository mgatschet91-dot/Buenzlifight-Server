-- Migration 102: Room model registry
-- Stores only the name + label for each room model.
-- The actual room geometry (grid size, walls, stairs) is defined as
-- code constants in game3d.js / ROOM_TEMPLATES — nothing is stored as JSON.

CREATE TABLE IF NOT EXISTS room_models (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  model_name   VARCHAR(50)  NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  is_default   TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order   INT          NOT NULL DEFAULT 0,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed: Standard-Raum
INSERT INTO room_models (model_name, display_name, is_default, sort_order) VALUES
  ('model_standard', 'Standard',      1, 10)
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), is_default = VALUES(is_default);
