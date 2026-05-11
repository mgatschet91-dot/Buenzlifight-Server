-- ============================================================
-- 161_transparency_events.sql
-- Mehr Transparenz-Events damit Gemeinden Transparenz
-- aktiv zurueckgewinnen koennen.
--
-- Problem vorher: Nur 4 Transparenz-Events (Gewicht 21/653 = 3.2%)
-- → durchschnittlich nur ~2 Transparenz-Events/Woche.
-- Dabei gibt es mehrere Drains (Kantonale Untersuchung etc.)
--
-- Fix: 5 neue Transparenz-Event-Typen (Gesamtgewicht +63)
-- → neu ~11.7% aller Events betreffen Transparenz.
--
-- Bonus-Fix: stat_impact='satisfaction' in Transport-Events
-- wird von applyStatChange() ignoriert (nicht in validStats).
-- Update auf 'attractiveness' damit sie echten Effekt haben.
-- ============================================================

-- ─── 5 neue Verwaltungs-Event-Typen ─────────────────────────
INSERT IGNORE INTO event_types
  (code, name, description, emoji, category, severity, min_level, base_confidence,
   duration_hours_min, duration_hours_max, xp_reward_report, xp_reward_fix, xp_penalty_wrong,
   fix_cost_min, fix_cost_max, stat_impact, stat_damage, stat_fix_bonus,
   spawn_weight, company_type_required)
VALUES

('council_minutes_missing',
 'Protokolle fehlen',
 'Die Gemeinderatsprotokolle der letzten drei Sitzungen wurden nicht veroeffentlicht. Buerger haben kein Recht zu wissen was abgelaeuft ist?',
 '📄', 'verwaltung', 1, 1, 1.00,
 24, 48, 10, 30, 0,
 80, 200, 'transparency', -3, 3,
 18, NULL),

('budget_report_delayed',
 'Jahresbericht verzoegert',
 'Der Jahresbericht der Gemeinde ist seit Wochen ueberfaellig. Die Buerger warten auf Transparenz bei den Finanzen.',
 '📊', 'verwaltung', 2, 3, 1.00,
 36, 72, 15, 50, 0,
 150, 400, 'transparency', -5, 4,
 15, 'medien'),

('open_data_breach',
 'Datenpanne aufgedeckt',
 'Interne Gemeindedaten waren oeffentlich zugaenglich. IT-Sicherheitsluecke muss sofort geschlossen werden.',
 '🔓', 'verwaltung', 3, 5, 0.80,
 24, 60, 25, 80, 10,
 300, 800, 'transparency', -7, 6,
 12, NULL),

('audit_resistance',
 'Revision behindert',
 'Die Gemeindeverwaltung verweigert der Revisionsstelle Zugang zu Buchhaltungsunterlagen. Das stinkt.',
 '🔍', 'verwaltung', 3, 10, 0.90,
 36, 72, 30, 100, 5,
 400, 1000, 'transparency', -8, 6,
 10, 'medien'),

('lobbying_suspicion',
 'Lobbyismus-Verdacht',
 'Hinweise auf undeklarierte Lobbyisten-Kontakte in der Gemeindepolitik. Schwer zu beweisen aber der Verdacht schadet.',
 '🤝', 'verwaltung', 3, 12, 0.65,
 48, 72, 40, 150, 20,
 500, 1200, 'transparency', -9, 7,
 8, 'medien');

-- ─── Fix: Transport-Events stat_impact 'satisfaction' → 'attractiveness' ──
-- 'satisfaction' ist kein gueltiger Stat in applyStatChange() und wird
-- ignoriert. 'attractiveness' passt inhaltlich (schlechter OeV = weniger
-- Attraktivitaet der Gemeinde).
UPDATE event_types
SET stat_impact = 'attractiveness'
WHERE code IN ('bus_stop_dirty', 'bus_stop_vandalism', 'bus_breakdown',
               'bus_overcrowded', 'bus_station_maintenance', 'bus_delay_complaints')
  AND stat_impact = 'satisfaction';
