-- Migration 164: Room-Furniture + Room-NPCs auf municipality_id scopen
-- Ohne diesen Fix laden alle Häuser eines Users die gleichen Möbel/NPCs.

ALTER TABLE room_furniture
  ADD COLUMN municipality_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER user_id,
  ADD INDEX idx_rf_user_muni (user_id, municipality_id);

ALTER TABLE room_npcs
  ADD COLUMN municipality_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER user_id,
  ADD INDEX idx_rn_user_muni (user_id, municipality_id);

-- Bestehende Einträge: nur wenn User eindeutig einer Gemeinde zugeordnet werden kann
UPDATE room_furniture rf
INNER JOIN (
  SELECT user_id, MIN(municipality_id) AS municipality_id
  FROM player_residences
  GROUP BY user_id
  HAVING COUNT(*) = 1
) pr ON pr.user_id = rf.user_id
SET rf.municipality_id = pr.municipality_id
WHERE rf.municipality_id IS NULL;

UPDATE room_npcs rn
INNER JOIN (
  SELECT user_id, MIN(municipality_id) AS municipality_id
  FROM player_residences
  GROUP BY user_id
  HAVING COUNT(*) = 1
) pr ON pr.user_id = rn.user_id
SET rn.municipality_id = pr.municipality_id
WHERE rn.municipality_id IS NULL;
