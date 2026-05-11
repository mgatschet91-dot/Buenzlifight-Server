-- Fix missing footprintWidth/footprintHeight in multi-tile building metadata.
-- All buildings that evolved via server consolidation lack these fields, causing
-- the client to render them as 1x1 (no secondary blocking tiles on reload).

-- 2x2 buildings
UPDATE game_items
SET metadata = JSON_SET(
  COALESCE(metadata, '{}'),
  '$.footprintWidth',  2,
  '$.footprintHeight', 2
)
WHERE action_type IN ('place', 'zone')
  AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.buildingType')) IN
      ('mansion', 'apartment_low', 'apartment_high',
       'office_low', 'office_high',
       'factory_medium', 'warehouse')
  AND (JSON_EXTRACT(metadata, '$.footprintWidth') IS NULL
    OR JSON_EXTRACT(metadata, '$.footprintWidth') < 2);

-- 3x3 buildings
UPDATE game_items
SET metadata = JSON_SET(
  COALESCE(metadata, '{}'),
  '$.footprintWidth',  3,
  '$.footprintHeight', 3
)
WHERE action_type IN ('place', 'zone')
  AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.buildingType')) IN
      ('mall', 'factory_large')
  AND (JSON_EXTRACT(metadata, '$.footprintWidth') IS NULL
    OR JSON_EXTRACT(metadata, '$.footprintWidth') < 3);
