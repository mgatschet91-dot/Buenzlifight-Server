CREATE TABLE IF NOT EXISTS frontend_errors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  message_hash CHAR(16) NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  component_stack TEXT,
  url VARCHAR(512),
  user_id INT DEFAULT NULL,
  municipality_slug VARCHAR(255) DEFAULT NULL,
  browser VARCHAR(512),
  count INT DEFAULT 1,
  first_seen DATETIME DEFAULT NOW(),
  last_seen DATETIME DEFAULT NOW(),
  UNIQUE KEY uniq_hash_url (message_hash, url(255)),
  KEY idx_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
