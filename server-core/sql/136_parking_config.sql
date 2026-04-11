-- 136: Parking config per tile + violations table

CREATE TABLE IF NOT EXISTS parking_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  municipality_id INT NOT NULL,
  tile_x INT NOT NULL,
  tile_y INT NOT NULL,
  is_free TINYINT(1) NOT NULL DEFAULT 0,
  fee_rate DECIMAL(6,2) NOT NULL DEFAULT 3.00,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tile (municipality_id, tile_x, tile_y)
);

CREATE TABLE IF NOT EXISTS parking_violations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  municipality_id INT NOT NULL,
  tile_x INT NOT NULL,
  tile_y INT NOT NULL,
  slot TINYINT NOT NULL DEFAULT 0,
  fine_amount DECIMAL(8,2) NOT NULL DEFAULT 80.00,
  status ENUM('unpaid','fined','paid') NOT NULL DEFAULT 'unpaid',
  security_company_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fined_at TIMESTAMP NULL,
  INDEX idx_municipality (municipality_id),
  INDEX idx_status (status),
  INDEX idx_tile (municipality_id, tile_x, tile_y)
);
