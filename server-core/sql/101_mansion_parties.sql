CREATE TABLE IF NOT EXISTS mansion_parties (
  id INT AUTO_INCREMENT PRIMARY KEY,
  municipality_id INT NOT NULL,
  owner_id INT NOT NULL,
  tile_x INT NOT NULL,
  tile_y INT NOT NULL,
  room_code VARCHAR(64) NOT NULL,
  status ENUM('active','warning_1','warning_2','warning_3','shutdown','ended') NOT NULL DEFAULT 'active',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_warning_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  police_visits INT NOT NULL DEFAULT 0,
  total_fines INT NOT NULL DEFAULT 0,
  INDEX idx_room_code (room_code),
  INDEX idx_owner (owner_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
