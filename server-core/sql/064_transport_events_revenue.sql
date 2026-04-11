-- Transport-Events und ÖV-Einnahmen-System
-- Event-Types für Transport-Firmen (company_type_required = 'transport')

INSERT INTO event_types (code, name, description, emoji, category, severity, min_level, base_confidence,
  duration_hours_min, duration_hours_max, xp_reward_report, xp_reward_fix, coin_reward_report, coin_reward_fix,
  coin_municipality_report, coin_municipality_fix, fix_cost_min, fix_cost_max, stat_impact, stat_damage, stat_fix_bonus,
  spawn_weight, company_type_required, is_active)
VALUES
  ('bus_stop_dirty', 'Bushaltestelle verschmutzt', 'Abfall und Schmutz an einer Bushaltestelle. Fahrgäste beschweren sich.', '🗑', 'infrastruktur', 2, 1, 0.95,
   12, 48, 8, 30, 5, 15, 8, 30, 80, 200, 'satisfaction', -3, 2, 15, 'reinigung', 1),

  ('bus_stop_vandalism', 'Bushaltestelle beschädigt', 'Vandalismus an der Bushaltestelle. Glasscheibe eingeschlagen, Fahrplan zerstört.', '💥', 'infrastruktur', 3, 2, 0.90,
   24, 72, 12, 50, 8, 25, 12, 50, 200, 500, 'satisfaction', -5, 3, 10, 'bau', 1),

  ('bus_breakdown', 'Bus-Panne', 'Ein Bus der ÖV-Firma hat eine Panne. Die Linie ist vorübergehend unterbrochen.', '🔧', 'infrastruktur', 3, 3, 1.00,
   6, 24, 10, 40, 5, 20, 10, 40, 150, 400, 'satisfaction', -4, 3, 12, 'transport', 1),

  ('bus_overcrowded', 'Überfüllter Bus', 'Fahrgäste beschweren sich über ständig überfüllte Busse auf einer Linie.', '🚌', 'ordnung', 2, 2, 0.85,
   24, 72, 8, 25, 5, 12, 8, 25, 50, 150, 'satisfaction', -3, 2, 8, 'transport', 1),

  ('bus_station_maintenance', 'Busbahnhof-Wartung fällig', 'Der Busbahnhof braucht regelmässige Wartung und Reinigung.', '🏗', 'infrastruktur', 2, 1, 1.00,
   24, 96, 10, 35, 5, 18, 10, 35, 100, 300, 'satisfaction', -2, 2, 12, 'transport', 1),

  ('bus_delay_complaints', 'Verspätungs-Beschwerden', 'Bünzlis beschweren sich über häufige Bus-Verspätungen.', '⏰', 'ordnung', 1, 1, 0.80,
   12, 48, 5, 20, 3, 10, 5, 20, 30, 100, 'satisfaction', -2, 1, 10, 'transport', 1)
ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description);

-- Passive ÖV-Einnahmen Tracking-Spalte auf companies
-- MySQL 5.7 compat: check column existence via procedure
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'last_revenue_at');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE companies ADD COLUMN last_revenue_at TIMESTAMP NULL DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
