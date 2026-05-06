-- Teleporter-Paare: jeder Kauf = 1 Eintrag mit 2 Stücken
CREATE TABLE IF NOT EXISTS teleporter_pairs (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT NOT NULL,
  pieces_left  TINYINT NOT NULL DEFAULT 2,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tp_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- pair_id in room_furniture: verknüpft platzierte Teleporter-Hälften
ALTER TABLE room_furniture ADD COLUMN pair_id INT NULL;
ALTER TABLE room_furniture ADD INDEX idx_rf_pair_id (pair_id);
