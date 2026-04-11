-- Migration 113: Falsch platzierte Bilder-Frames aus room_furniture entfernen
-- Frames müssen auf Außenwänden stehen: x=-9 (West) oder z=-9 (Nord)
-- Einträge die weder auf West- noch auf Nord-Wand liegen werden gelöscht

DELETE FROM room_furniture
WHERE item_code IN ('frame_blue', 'frame_red', 'frame_gold', 'frame_dark')
  AND (x <> -9 AND z <> -9);

-- Optional: wy korrigieren falls 0 oder NULL (Höhe = 1.26m über Boden)
UPDATE room_furniture
SET wy = 1.26
WHERE item_code IN ('frame_blue', 'frame_red', 'frame_gold', 'frame_dark')
  AND (wy IS NULL OR wy < 0.5);
