-- Migration 114: West-Wand Bilder-Frames facingIdx korrigieren
-- West-Wand = x = -9, Frames müssen facingIdx=3 ('W', rotation.y=+π/2) haben
-- damit local+Z → world+X (Ostrichtung, ins Zimmer hinein)
-- Alter Wert war facingIdx=1 ('E') → Bild zeigte in die Wand

UPDATE room_furniture
SET facing_idx = 3
WHERE item_code IN ('frame_blue', 'frame_red', 'frame_gold', 'frame_dark')
  AND x = -9
  AND facing_idx = 1;
