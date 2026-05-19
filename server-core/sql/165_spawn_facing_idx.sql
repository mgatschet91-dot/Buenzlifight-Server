-- Migration 165: facing_idx für Spawn-Punkt
ALTER TABLE user_room_spawn
  ADD COLUMN facing_idx TINYINT UNSIGNED NOT NULL DEFAULT 0
  COMMENT '0=N 1=E 2=S 3=W';
