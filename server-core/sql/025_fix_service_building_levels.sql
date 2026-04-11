-- ============================================================
-- Fix: Service-Gebaeude Level zuruecksetzen
-- 
-- Bug: Der Server-Upgrade-Tick hat Service-Gebaeude (police_station,
-- fire_station, hospital, school, university, power_plant, water_tower)
-- automatisch auf Level 5 hochgesetzt — basierend auf vergangener Zeit.
-- Diese Gebaeude sollen aber NUR manuell vom Spieler upgraded werden.
--
-- Diese Migration setzt das Level aller betroffenen Gebaeude auf 1 zurueck
-- und entfernt das serverLevelAuthoritative-Flag sowie Upgrade-Reste.
-- ============================================================

UPDATE game_items
SET metadata = JSON_SET(
  JSON_REMOVE(
    COALESCE(metadata, '{}'),
    '$.serverLevelAuthoritative',
    '$.upgradeStartedAt',
    '$.upgradeTargetLevel'
  ),
  '$.level', 1
),
updated_at = CURRENT_TIMESTAMP
WHERE action_type = 'place'
  AND tool IN ('police_station', 'fire_station', 'hospital', 'school', 'university', 'power_plant', 'water_tower')
  AND JSON_EXTRACT(metadata, '$.level') > 1;
