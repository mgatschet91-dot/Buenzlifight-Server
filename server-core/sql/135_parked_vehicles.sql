CREATE TABLE IF NOT EXISTS parked_vehicles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  municipality_id INT NOT NULL,
  tile_x INT NOT NULL,
  tile_y INT NOT NULL,
  slot TINYINT NOT NULL DEFAULT 0,
  color VARCHAR(16) NOT NULL DEFAULT '#cc4444',
  parked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  leave_after_seconds INT NOT NULL DEFAULT 300,
  UNIQUE KEY uq_slot (municipality_id, tile_x, tile_y, slot),
  INDEX idx_muni (municipality_id)
);
