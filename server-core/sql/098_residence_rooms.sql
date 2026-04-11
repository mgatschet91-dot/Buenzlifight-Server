-- Migration 098: Habbo-style residence rooms
-- Speichert das gewählte Raum-Modell pro Spieler pro Gemeinde

CREATE TABLE IF NOT EXISTS residence_rooms (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT UNSIGNED NOT NULL,
  municipality_id BIGINT UNSIGNED NOT NULL,
  model_name      VARCHAR(50) NOT NULL DEFAULT 'model_basic',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_residence_rooms_user (user_id, municipality_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
