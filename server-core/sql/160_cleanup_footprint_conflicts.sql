-- Fix buildings that exist inside another multi-tile building's footprint.
-- Caused by zone consolidation running twice on tiles that were already secondary positions.

-- Step 1: DELETE placed buildings (action_type='place') sitting inside a multi-tile footprint
DELETE b FROM game_items b
INNER JOIN game_items a ON (
  a.municipality_id = b.municipality_id
  AND a.room_code = b.room_code
  AND a.id != b.id
  AND a.action_type IN ('place', 'zone')
  AND JSON_EXTRACT(a.metadata, '$.footprintWidth') >= 2
  AND b.x >= a.x
  AND b.x < a.x + JSON_EXTRACT(a.metadata, '$.footprintWidth')
  AND b.y >= a.y
  AND b.y < a.y + JSON_EXTRACT(a.metadata, '$.footprintHeight')
  AND NOT (b.x = a.x AND b.y = a.y)
)
WHERE b.action_type = 'place';

-- Step 2: DELETE zone-evolved buildings (with real buildingType) inside a multi-tile footprint
DELETE b FROM game_items b
INNER JOIN game_items a ON (
  a.municipality_id = b.municipality_id
  AND a.room_code = b.room_code
  AND a.id != b.id
  AND a.action_type IN ('place', 'zone')
  AND JSON_EXTRACT(a.metadata, '$.footprintWidth') >= 2
  AND b.x >= a.x
  AND b.x < a.x + JSON_EXTRACT(a.metadata, '$.footprintWidth')
  AND b.y >= a.y
  AND b.y < a.y + JSON_EXTRACT(a.metadata, '$.footprintHeight')
  AND NOT (b.x = a.x AND b.y = a.y)
)
WHERE b.action_type = 'zone'
  AND JSON_EXTRACT(b.metadata, '$.buildingType') IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(b.metadata, '$.buildingType')) NOT IN ('empty', '');

-- Step 3: UPDATE remaining plain zone tiles inside a footprint → mark as 'empty' with origin
UPDATE game_items b
INNER JOIN (
  SELECT a.x AS ox, a.y AS oy, b2.id AS bid, a.municipality_id AS mid, a.room_code AS rc
  FROM game_items a
  JOIN game_items b2 ON (
    a.municipality_id = b2.municipality_id
    AND a.room_code = b2.room_code
    AND a.id != b2.id
    AND a.action_type IN ('place', 'zone')
    AND JSON_EXTRACT(a.metadata, '$.footprintWidth') >= 2
    AND b2.x >= a.x
    AND b2.x < a.x + JSON_EXTRACT(a.metadata, '$.footprintWidth')
    AND b2.y >= a.y
    AND b2.y < a.y + JSON_EXTRACT(a.metadata, '$.footprintHeight')
    AND NOT (b2.x = a.x AND b2.y = a.y)
    AND b2.action_type = 'zone'
    AND (JSON_EXTRACT(b2.metadata, '$.buildingType') IS NULL
         OR JSON_UNQUOTE(JSON_EXTRACT(b2.metadata, '$.buildingType')) = 'empty')
  )
) AS src ON b.id = src.bid
SET b.metadata = JSON_OBJECT('buildingType', 'empty', 'originX', src.ox, 'originY', src.oy);
