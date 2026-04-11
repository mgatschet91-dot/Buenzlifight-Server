-- ============================================================
-- 030_house_defect_events.sql
-- Hausmangel-Events: Defekte Wohngebaeude melden
--
-- Neue Event-Typen fuer Wohngebaeude:
--   - Hausmangel (Dach, Fassade, Keller etc.)
--   - Schimmelbefall
--   - Heizungsausfall
--
-- Erweitert bestehende Mappings um Wohngebaeude.
-- ============================================================

-- ─── Neue Event-Typen fuer Wohngebaeude ──────────────────────
INSERT IGNORE INTO event_types
  (code, name, description, emoji, category, severity, min_level, base_confidence,
   duration_hours_min, duration_hours_max, xp_reward_report, xp_reward_fix, xp_penalty_wrong,
   fix_cost_min, fix_cost_max, stat_impact, stat_damage, stat_fix_bonus,
   spawn_weight, company_type_required)
VALUES
('house_defect',
 'Hausmangel entdeckt',
 'An einem Wohngebaeude wurden Maengel festgestellt: Risse in der Fassade, undichtes Dach oder defekte Fenster. Ein Buenzli hat das natuerlich sofort bemerkt.',
 '🏠', 'infrastruktur', 1, 1, 1.00,
 24, 72, 15, 40, 0,
 100, 400, 'infrastructure', -2, 2,
 18, 'bau'),

('house_mold',
 'Schimmelbefall',
 'In einem Wohngebaeude wurde Schimmel entdeckt. Gesundheitsgefahr fuer die Bewohner!',
 '🦠', 'infrastruktur', 2, 3, 0.90,
 24, 48, 20, 60, 5,
 200, 600, 'infrastructure', -4, 3,
 12, 'reinigung'),

('heating_failure',
 'Heizungsausfall',
 'Die Heizung in einem Gebaeude ist ausgefallen. Im Winter besonders kritisch.',
 '🥶', 'infrastruktur', 2, 2, 1.00,
 12, 48, 15, 50, 0,
 150, 500, 'infrastructure', -3, 2,
 14, 'bau'),

('elevator_broken',
 'Lift defekt',
 'Der Aufzug in einem Mehrfamilienhaus ist kaputt. Aeltere Bewohner sind betroffen.',
 '🛗', 'infrastruktur', 1, 2, 1.00,
 24, 72, 10, 35, 0,
 200, 500, 'infrastructure', -2, 2,
 10, 'bau'),

('parking_chaos',
 'Parkplatz-Chaos',
 'Falschparkierer und chaotische Zustaende auf dem Parkplatz. Der Buenzli ist empoert.',
 '🅿', 'ordnung', 1, 1, 0.95,
 12, 36, 10, 20, 0,
 30, 100, 'attractiveness', -1, 1,
 16, NULL),

('garden_neglect',
 'Garten verwahrlost',
 'Ein Grundstueck ist voellig verwildert. Unkraut ueberall, der Nachbar-Buenzli ist entsetzt.',
 '🌿', 'ordnung', 1, 1, 1.00,
 36, 72, 10, 25, 0,
 50, 150, 'attractiveness', -1, 1,
 15, 'reinigung');

-- ─── Wohngebaeude zu NEUEN Event-Typen mappen ───────────────
INSERT IGNORE INTO event_type_building_map (event_type_id, building_tool, priority)
SELECT et.id, m.tool, m.prio
FROM event_types et
JOIN (
  -- house_defect → alle Wohngebaeude
  SELECT 'house_defect' AS ecode, 'mansion' AS tool, 15 AS prio
  UNION ALL SELECT 'house_defect', 'apartment_low', 20
  UNION ALL SELECT 'house_defect', 'apartment_high', 20
  UNION ALL SELECT 'house_defect', 'cabin_house', 10
  UNION ALL SELECT 'house_defect', 'woodcutter_house', 10
  UNION ALL SELECT 'house_defect', 'community_center', 5

  -- house_mold → Wohngebaeude
  UNION ALL SELECT 'house_mold', 'mansion', 15
  UNION ALL SELECT 'house_mold', 'apartment_low', 20
  UNION ALL SELECT 'house_mold', 'apartment_high', 20
  UNION ALL SELECT 'house_mold', 'cabin_house', 10
  UNION ALL SELECT 'house_mold', 'school', 10
  UNION ALL SELECT 'house_mold', 'hospital', 8

  -- heating_failure → alle Gebaeude mit Heizung
  UNION ALL SELECT 'heating_failure', 'mansion', 15
  UNION ALL SELECT 'heating_failure', 'apartment_low', 20
  UNION ALL SELECT 'heating_failure', 'apartment_high', 20
  UNION ALL SELECT 'heating_failure', 'cabin_house', 10
  UNION ALL SELECT 'heating_failure', 'school', 12
  UNION ALL SELECT 'heating_failure', 'hospital', 12
  UNION ALL SELECT 'heating_failure', 'office_building_small', 8
  UNION ALL SELECT 'heating_failure', 'office_low', 8
  UNION ALL SELECT 'heating_failure', 'office_high', 8

  -- elevator_broken → nur Mehrfamilienhaeuser
  UNION ALL SELECT 'elevator_broken', 'apartment_low', 20
  UNION ALL SELECT 'elevator_broken', 'apartment_high', 25
  UNION ALL SELECT 'elevator_broken', 'office_high', 15
  UNION ALL SELECT 'elevator_broken', 'hospital', 15

  -- garden_neglect → Wohngebaeude und Parks
  UNION ALL SELECT 'garden_neglect', 'mansion', 20
  UNION ALL SELECT 'garden_neglect', 'cabin_house', 15
  UNION ALL SELECT 'garden_neglect', 'woodcutter_house', 15
  UNION ALL SELECT 'garden_neglect', 'community_garden', 20
  UNION ALL SELECT 'garden_neglect', 'greenhouse_garden', 15
) m ON m.ecode = et.code;

-- ─── Bestehende Event-Typen: Wohngebaeude ergaenzen ─────────
-- building_decay: + Wohngebaeude
INSERT IGNORE INTO event_type_building_map (event_type_id, building_tool, priority)
SELECT et.id, m.tool, m.prio
FROM event_types et
JOIN (
  SELECT 'building_decay' AS ecode, 'apartment_low' AS tool, 12 AS prio
  UNION ALL SELECT 'building_decay', 'apartment_high', 12
  UNION ALL SELECT 'building_decay', 'cabin_house', 8
  UNION ALL SELECT 'building_decay', 'woodcutter_house', 8
  UNION ALL SELECT 'building_decay', 'office_low', 8
  UNION ALL SELECT 'building_decay', 'office_high', 8
  UNION ALL SELECT 'building_decay', 'office_building_small', 6
  UNION ALL SELECT 'building_decay', 'mall', 6
  UNION ALL SELECT 'building_decay', 'museum', 8
  UNION ALL SELECT 'building_decay', 'stadium', 5
) m ON m.ecode = et.code;

-- fire_safety: + Wohngebaeude
INSERT IGNORE INTO event_type_building_map (event_type_id, building_tool, priority)
SELECT et.id, m.tool, m.prio
FROM event_types et
JOIN (
  SELECT 'fire_safety' AS ecode, 'mansion' AS tool, 12 AS prio
  UNION ALL SELECT 'fire_safety', 'apartment_low', 15
  UNION ALL SELECT 'fire_safety', 'apartment_high', 15
  UNION ALL SELECT 'fire_safety', 'cabin_house', 10
  UNION ALL SELECT 'fire_safety', 'woodcutter_house', 10
  UNION ALL SELECT 'fire_safety', 'mall', 8
  UNION ALL SELECT 'fire_safety', 'museum', 8
  UNION ALL SELECT 'fire_safety', 'stadium', 5
) m ON m.ecode = et.code;

-- vandalism_wave: + Wohngebaeude-Umfeld
INSERT IGNORE INTO event_type_building_map (event_type_id, building_tool, priority)
SELECT et.id, m.tool, m.prio
FROM event_types et
JOIN (
  SELECT 'vandalism_wave' AS ecode, 'basketball_courts' AS tool, 10 AS prio
  UNION ALL SELECT 'vandalism_wave', 'soccer_field_small', 10
  UNION ALL SELECT 'vandalism_wave', 'tennis', 8
  UNION ALL SELECT 'vandalism_wave', 'swimming_pool', 8
  UNION ALL SELECT 'vandalism_wave', 'community_garden', 8
  UNION ALL SELECT 'vandalism_wave', 'stadium', 5
  UNION ALL SELECT 'vandalism_wave', 'museum', 5
) m ON m.ecode = et.code;

-- burglary_wave: + mehr Wohngebaeude
INSERT IGNORE INTO event_type_building_map (event_type_id, building_tool, priority)
SELECT et.id, m.tool, m.prio
FROM event_types et
JOIN (
  SELECT 'burglary_wave' AS ecode, 'cabin_house' AS tool, 10 AS prio
  UNION ALL SELECT 'burglary_wave', 'woodcutter_house', 8
  UNION ALL SELECT 'burglary_wave', 'warehouse', 12
  UNION ALL SELECT 'burglary_wave', 'museum', 10
  UNION ALL SELECT 'burglary_wave', 'office_low', 8
  UNION ALL SELECT 'burglary_wave', 'office_high', 8
) m ON m.ecode = et.code;
