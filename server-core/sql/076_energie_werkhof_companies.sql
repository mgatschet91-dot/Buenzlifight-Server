-- ============================================================
-- 076_energie_werkhof_companies.sql
-- Zwei neue Firmentypen + passende Events
--
-- Energieunternehmen (energie):
--   Spezialisiert auf Strom- und Energieinfrastruktur.
--   Höhere Gründungskosten, gut für Gemeinden mit viel
--   Energieerzeugung (Solar, Wind, Kraftwerk).
--
-- Gemeindewerkhof (werkhof):
--   Der klassische Schweizer Werkhof. Vielseitig:
--   repariert Strassen, mäht Rasen, räumt Schnee weg.
--   Kann Infrastruktur UND Ordnungs-Events beheben.
--   Ideal für Einzelspieler oder kleine Gemeinden.
-- ============================================================

-- ─── Neue Firmentypen ────────────────────────────────────────
INSERT IGNORE INTO company_types
  (code, name, description, emoji, can_fix_categories, founding_cost, min_level, max_members)
VALUES

('energie',
 'Energieunternehmen',
 'Betreibt und wartet die Energieinfrastruktur der Gemeinde. Behebt Stromausfälle, repariert Transformatoren, kümmert sich um Solar- und Windanlagen.',
 '⚡',
 '["energie"]',
 15000, 10, 12),

('werkhof',
 'Gemeindewerkhof',
 'Der Werkhof der Gemeinde: Allrounder für Infrastruktur und Ordnung. Strassenunterhalt, Grünpflege, Schneeräumung und allgemeine Instandhaltung.',
 '🚛',
 '["infrastruktur", "ordnung"]',
 3500, 3, 25);

-- ─── Neue Event-Typen: Kategorie "energie" ───────────────────
INSERT IGNORE INTO event_types
  (code, name, description, emoji, category, severity, min_level, base_confidence,
   duration_hours_min, duration_hours_max, xp_reward_report, xp_reward_fix, xp_penalty_wrong,
   fix_cost_min, fix_cost_max, stat_impact, stat_damage, stat_fix_bonus,
   spawn_weight, company_type_required)
VALUES

('transformer_damage',
 'Transformatorschaden',
 'Ein Transformator ist überhitzt und ausgefallen. Mehrere Quartiere ohne Strom.',
 '🔌', 'energie', 3, 8, 0.95,
 6, 18, 25, 100, 0,
 600, 1400, 'infrastructure', -7, 5,
 8, 'energie'),

('grid_overload',
 'Netzüberlastung',
 'Das Stromnetz ist überlastet. Gefahr von Kurzschlüssen und Bränden.',
 '⚠️', 'energie', 3, 10, 0.90,
 8, 24, 30, 110, 5,
 700, 1600, 'infrastructure', -6, 5,
 7, 'energie'),

('solar_defect',
 'Solaranlage defekt',
 'Mehrere Solarpanels produzieren keinen Strom mehr. Techniker gefragt.',
 '☀️', 'energie', 2, 6, 1.00,
 12, 36, 20, 70, 0,
 300, 800, 'infrastructure', -4, 3,
 10, 'energie'),

('wind_turbine_defect',
 'Windturbine defekt',
 'Eine Windturbine ist ausgefallen. Muss gewartet und repariert werden.',
 '🌬️', 'energie', 2, 7, 1.00,
 12, 36, 20, 75, 0,
 350, 900, 'infrastructure', -4, 3,
 9, 'energie'),

('power_theft',
 'Stromdiebstahl',
 'Illegale Stromentnahme entdeckt. Schaden für das Netz und die Gemeindekasse.',
 '🔋', 'energie', 2, 5, 0.80,
 24, 48, 20, 80, 10,
 200, 600, 'infrastructure', -3, 2,
 8, 'energie'),

('energy_audit_fail',
 'Energieprüfung fehlgeschlagen',
 'Die kantonale Energiebehörde hat Mängel festgestellt. Sofortmassnahmen nötig.',
 '📋', 'energie', 3, 12, 1.00,
 36, 72, 35, 130, 0,
 800, 2000, 'infrastructure', -8, 6,
 5, 'energie'),

-- ─── Neue Event-Typen: Kategorie "infrastruktur" (Werkhof) ───

('pothole_cluster',
 'Schlagloch-Cluster',
 'Viele Schlaglöcher auf Nebenstrassen. Gemeinde-Werkhof muss ran.',
 '🕳️', 'infrastruktur', 1, 2, 1.00,
 24, 48, 10, 35, 0,
 80, 250, 'infrastructure', -2, 2,
 18, 'werkhof'),

('snow_removal_needed',
 'Schneeräumung nötig',
 'Starker Schneefall. Strassen und Wege müssen geräumt werden.',
 '❄️', 'infrastruktur', 1, 1, 1.00,
 4, 12, 10, 30, 0,
 60, 180, 'infrastructure', -2, 1,
 15, 'werkhof'),

('fallen_tree',
 'Baum auf Strasse',
 'Ein umgefallener Baum blockiert eine Hauptstrasse.',
 '🌲', 'infrastruktur', 2, 3, 1.00,
 4, 16, 15, 50, 0,
 150, 400, 'infrastructure', -3, 2,
 14, 'werkhof'),

('bridge_maintenance',
 'Brücke wartungsbedürftig',
 'Eine Fussgängerbrücke hat Rostschäden und muss saniert werden.',
 '🌉', 'infrastruktur', 2, 5, 1.00,
 24, 60, 20, 65, 0,
 300, 700, 'infrastructure', -4, 3,
 10, 'werkhof'),

('streetlight_out',
 'Strassenbeleuchtung defekt',
 'Mehrere Strassenlaternen ausgefallen. Sicherheitsrisiko bei Dunkelheit.',
 '💡', 'infrastruktur', 1, 2, 1.00,
 8, 24, 10, 35, 0,
 100, 300, 'infrastructure', -2, 2,
 16, 'werkhof'),

-- ─── Neue Event-Typen: Kategorie "ordnung" (Werkhof) ─────────

('park_neglected',
 'Park verwahrlost',
 'Der Gemeindepark wurde zu lange nicht gepflegt. Unkraut, Müll, kaputte Bänke.',
 '🌿', 'ordnung', 1, 2, 1.00,
 24, 48, 10, 30, 0,
 70, 200, 'cleanliness', -3, 2,
 18, 'werkhof'),

('public_toilet_dirty',
 'Öffentliche WC verschmutzt',
 'Die öffentlichen Toilettenanlagen sind in einem unhaltbaren Zustand.',
 '🚽', 'ordnung', 1, 1, 1.00,
 12, 36, 8, 25, 0,
 50, 150, 'cleanliness', -2, 1,
 20, 'werkhof'),

('signage_damaged',
 'Beschädigte Beschilderung',
 'Verkehrsschilder und Strassenschilder wurden beschädigt oder gestohlen.',
 '🚧', 'ordnung', 1, 3, 1.00,
 24, 48, 10, 30, 0,
 80, 220, 'infrastructure', -2, 2,
 14, 'werkhof');

-- ─── Badges für neue Firmentypen ─────────────────────────────
INSERT IGNORE INTO badges (code, name, description, category, rarity, sort_order) VALUES
  ('ACH_EnergieFirma1',  'Stromguru',       'Gründe ein Energieunternehmen',              'achievement', 2, 641),
  ('ACH_WerkhofFirma1',  'Werkhöfler',      'Gründe einen Gemeindewerkhof',               'achievement', 0, 642),
  ('ACH_EnergieContr5',  'Netz-Retter',     'Schliesse 5 Energie-Verträge ab',            'achievement', 1, 643),
  ('ACH_WerkhofContr10', 'Allrounder',      'Schliesse 10 Werkhof-Verträge ab',           'achievement', 1, 644);
