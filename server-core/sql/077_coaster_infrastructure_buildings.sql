-- Migration 077: Coaster Infrastructure Gebäude in game_item_details
-- Fügt alle 30 infra_* Gebäude des IsoCoaster Spiel-Infrastruktur-Spritesheets ein

INSERT INTO game_item_details (tool, display_name, category, footprint_width, footprint_height, build_cost, is_active)
VALUES
  -- Eingänge (Row 0)
  ('infra_main_entrance',    'Haupteingang',          'infrastructure', 3, 1, 5000,  1),
  ('infra_themed_entrance',  'Themen-Eingang',        'infrastructure', 2, 2, 8000,  1),
  ('infra_vip_entrance',     'VIP-Eingang',           'infrastructure', 2, 2, 10000, 1),
  ('infra_exit_gate',        'Ausgangstor',           'infrastructure', 2, 1, 2000,  1),
  ('infra_turnstile',        'Drehkreuz',             'infrastructure', 1, 1, 500,   1),
  -- Admin-Gebäude (Row 1)
  ('infra_office',           'Verwaltungsbüro',       'infrastructure', 2, 2, 3000,  1),
  ('infra_maintenance',      'Wartungsdepot',         'infrastructure', 2, 2, 2000,  1),
  ('infra_warehouse',        'Lagerhaus',             'infrastructure', 2, 2, 2500,  1),
  ('infra_security',         'Sicherheitsposten',     'infrastructure', 1, 1, 1500,  1),
  ('infra_break_room',       'Pausenraum',            'infrastructure', 1, 1, 1000,  1),
  -- Gästeservice (Row 2)
  ('infra_guest_relations',  'Gästeservice',          'infrastructure', 2, 2, 2000,  1),
  ('infra_lost_found',       'Fundbüro',              'infrastructure', 1, 1, 500,   1),
  ('infra_package_pickup',   'Paketausgabe',          'infrastructure', 1, 1, 500,   1),
  ('infra_ticket_booth',     'Kassenhäuschen',        'infrastructure', 1, 1, 1500,  1),
  ('infra_season_pass',      'Saisonkarten-Center',   'infrastructure', 1, 1, 2000,  1),
  -- Transport (Row 3)
  ('infra_tram_stop',        'Tramhaltestelle',       'infrastructure', 2, 1, 3000,  1),
  ('infra_bus_stop',         'Bushaltestelle',        'infrastructure', 2, 1, 1500,  1),
  ('infra_shuttle',          'Shuttle-Bay',           'infrastructure', 2, 2, 2000,  1),
  ('infra_golf_cart',        'Golfcart-Station',      'infrastructure', 1, 1, 1000,  1),
  ('infra_utility_vehicle',  'Fahrzeugdepot',         'infrastructure', 2, 1, 1500,  1),
  -- Versorgung (Row 4)
  ('infra_generator',        'Generator',             'infrastructure', 1, 1, 2000,  1),
  ('infra_dumpster',         'Müllcontainerplatz',    'infrastructure', 1, 1, 300,   1),
  ('infra_loading_dock',     'Laderampe',             'infrastructure', 2, 1, 1000,  1),
  ('infra_container',        'Lagercontainer',        'infrastructure', 1, 1, 500,   1),
  ('infra_utility_box',      'Verteilerschrank',      'infrastructure', 1, 1, 200,   1),
  -- Sicherheit (Row 5)
  ('infra_first_aid_station','Erste-Hilfe-Station',   'infrastructure', 1, 1, 1500,  1),
  ('infra_defibrillator',    'Defibrillator-Post',    'infrastructure', 1, 1, 300,   1),
  ('infra_fire_extinguisher','Feuerlöscher-Post',     'infrastructure', 1, 1, 200,   1),
  ('infra_emergency_phone',  'Notrufsäule',           'infrastructure', 1, 1, 200,   1),
  ('infra_evacuation',       'Sammelpunkt',           'infrastructure', 1, 1, 300,   1)
ON DUPLICATE KEY UPDATE
  display_name      = VALUES(display_name),
  category          = VALUES(category),
  footprint_width   = VALUES(footprint_width),
  footprint_height  = VALUES(footprint_height),
  build_cost        = VALUES(build_cost),
  is_active         = VALUES(is_active),
  updated_at        = CURRENT_TIMESTAMP;
