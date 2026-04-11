-- ============================================================
-- 027_buenzli_events.sql
-- Buenzli Melde-System: Auto-generierte Mini-Events
--
-- Der Server generiert taeglich 4-10 Events pro Gemeinde.
-- Events laufen bis zu 3 Tage, dann verfallen sie.
--
-- Wichtige Mechaniken:
--   - Severity: 1 (leicht) bis 5 (kritisch)
--   - min_level: Mindest-User-Level um Event zu sehen/melden
--   - confidence: 0.0-1.0 → wie sicher das Event echt ist
--     (z.B. Korruption hat 0.4-0.7 Confidence = kann Fehlalarm sein)
--   - Events beeinflussen Gemeinde-Stats
--   - Hoehere Severity → mehr Schaden wenn ignoriert
-- ============================================================

-- ─── Event-Typ Definitionen ──────────────────────────────────
CREATE TABLE IF NOT EXISTS event_types (
  id              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  code            VARCHAR(64)      NOT NULL COMMENT 'Eindeutiger Code z.B. fire_safety, illegal_build',
  name            VARCHAR(128)     NOT NULL COMMENT 'Anzeigename z.B. Brandschutz mangelhaft',
  description     TEXT             NULL     COMMENT 'Beschreibung was passiert',
  emoji           VARCHAR(8)       NULL     COMMENT 'Emoji fuer Anzeige z.B. 🔥',
  category        VARCHAR(32)      NOT NULL COMMENT 'infrastruktur, ordnung, sicherheit, verwaltung, soziales',
  severity        TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '1=leicht, 2=mittel, 3=schwer, 4=kritisch, 5=katastrophal',
  min_level       TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Mindest-User-Level um Event zu sehen/melden',
  base_confidence DECIMAL(3,2)     NOT NULL DEFAULT 1.00 COMMENT '1.0=sicher, 0.5=unsicher (z.B. Korruption)',
  duration_hours_min INT UNSIGNED  NOT NULL DEFAULT 24 COMMENT 'Minimale Event-Dauer in Stunden',
  duration_hours_max INT UNSIGNED  NOT NULL DEFAULT 72 COMMENT 'Maximale Event-Dauer in Stunden',
  xp_reward_report INT UNSIGNED   NOT NULL DEFAULT 10 COMMENT 'XP fuer korrektes Melden',
  xp_reward_fix    INT UNSIGNED   NOT NULL DEFAULT 50 COMMENT 'XP fuer Behebung',
  xp_penalty_wrong INT UNSIGNED   NOT NULL DEFAULT 0  COMMENT 'XP-Abzug fuer Falschmeldung',
  fix_cost_min     INT UNSIGNED   NOT NULL DEFAULT 100 COMMENT 'Min Kosten zum Beheben (Gemeinde-Geld)',
  fix_cost_max     INT UNSIGNED   NOT NULL DEFAULT 500 COMMENT 'Max Kosten zum Beheben',
  stat_impact      VARCHAR(32)    NULL     COMMENT 'Welcher Gemeinde-Stat betroffen: security, attractiveness, cleanliness, infrastructure',
  stat_damage      INT            NOT NULL DEFAULT -5  COMMENT 'Stat-Aenderung wenn ignoriert (negativ)',
  stat_fix_bonus   INT            NOT NULL DEFAULT 3   COMMENT 'Stat-Bonus wenn behoben (positiv)',
  spawn_weight     INT UNSIGNED   NOT NULL DEFAULT 10  COMMENT 'Gewichtung fuer Zufallsgenerierung (hoeher = haeufiger)',
  company_type_required VARCHAR(64) NULL   COMMENT 'Welcher Firmen-Typ das beheben kann (NULL = jeder)',
  is_active        TINYINT(1)     NOT NULL DEFAULT 1,
  created_at       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_event_type_code (code),
  KEY idx_event_type_category (category),
  KEY idx_event_type_severity (severity),
  KEY idx_event_type_active_weight (is_active, spawn_weight)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Aktive Events pro Gemeinde ──────────────────────────────
CREATE TABLE IF NOT EXISTS municipality_events (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id  BIGINT UNSIGNED NOT NULL,
  event_type_id    BIGINT UNSIGNED NOT NULL,
  status           VARCHAR(24)     NOT NULL DEFAULT 'active'
    COMMENT 'active, reported, investigating, in_progress, resolved, expired, false_alarm',
  severity         TINYINT UNSIGNED NOT NULL COMMENT 'Kopie oder modifiziert vom Event-Typ',
  confidence       DECIMAL(3,2)    NOT NULL DEFAULT 1.00
    COMMENT 'Wie sicher ist das Event echt? 1.0=sicher, 0.0=definitiv falsch',
  actual_real      TINYINT(1)      NULL     COMMENT 'NULL=unbekannt, 1=echt, 0=Fehlalarm (enthuellt nach Investigation)',
  min_level        TINYINT UNSIGNED NOT NULL DEFAULT 1
    COMMENT 'Mindest-Level um dieses spezifische Event zu sehen',
  fix_cost         INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Kosten zum Beheben',
  location_x       INT             NULL     COMMENT 'X-Position auf der Karte (optional)',
  location_y       INT             NULL     COMMENT 'Y-Position auf der Karte (optional)',
  affected_item_id BIGINT UNSIGNED NULL     COMMENT 'Betroffenes game_item (optional)',
  reported_by      BIGINT UNSIGNED NULL     COMMENT 'Wer hat gemeldet (NULL = System)',
  assigned_company_id BIGINT UNSIGNED NULL  COMMENT 'Welche Firma bearbeitet (FK zu companies)',
  resolved_by      BIGINT UNSIGNED NULL     COMMENT 'Wer hat behoben',
  spawned_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Wann generiert',
  expires_at       DATETIME        NOT NULL COMMENT 'Wann verfaellt das Event',
  reported_at      DATETIME        NULL     COMMENT 'Wann gemeldet',
  resolved_at      DATETIME        NULL     COMMENT 'Wann behoben',
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_muni_events_municipality_status (municipality_id, status),
  KEY idx_muni_events_status_expires (status, expires_at),
  KEY idx_muni_events_type (event_type_id),
  KEY idx_muni_events_severity (severity DESC),
  KEY idx_muni_events_assigned_company (assigned_company_id),
  KEY idx_muni_events_reported_by (reported_by),
  CONSTRAINT fk_muni_events_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_muni_events_event_type
    FOREIGN KEY (event_type_id) REFERENCES event_types(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_muni_events_reported_by
    FOREIGN KEY (reported_by) REFERENCES users(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_muni_events_resolved_by
    FOREIGN KEY (resolved_by) REFERENCES users(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Event-Meldungen von Usern ───────────────────────────────
-- User koennen Events melden, bestätigen oder Korruption untersuchen
CREATE TABLE IF NOT EXISTS event_reports (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id     BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  report_type  VARCHAR(32)     NOT NULL DEFAULT 'confirm'
    COMMENT 'confirm=bestaetigen, deny=bezweifeln, investigate=untersuchen',
  comment      VARCHAR(500)    NULL     COMMENT 'Optionaler Kommentar',
  user_level   TINYINT UNSIGNED NOT NULL COMMENT 'Level des Users zum Zeitpunkt der Meldung',
  is_correct   TINYINT(1)      NULL     COMMENT 'NULL=noch offen, 1=richtig, 0=falsch (nach Auflosung)',
  xp_awarded   INT             NOT NULL DEFAULT 0 COMMENT 'Vergebene/abgezogene XP',
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_event_report_user (event_id, user_id),
  KEY idx_event_reports_user (user_id),
  KEY idx_event_reports_type (report_type),
  CONSTRAINT fk_event_reports_event
    FOREIGN KEY (event_id) REFERENCES municipality_events(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_event_reports_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Gemeinde-Stats ──────────────────────────────────────────
-- Werden von Events beeinflusst (Schaden wenn ignoriert, Bonus wenn behoben)
CREATE TABLE IF NOT EXISTS municipality_stats (
  municipality_id  BIGINT UNSIGNED NOT NULL,
  security         INT NOT NULL DEFAULT 50 COMMENT 'Sicherheit 0-100',
  attractiveness   INT NOT NULL DEFAULT 50 COMMENT 'Attraktivitaet 0-100',
  cleanliness      INT NOT NULL DEFAULT 50 COMMENT 'Sauberkeit 0-100',
  infrastructure   INT NOT NULL DEFAULT 50 COMMENT 'Infrastruktur-Zustand 0-100',
  transparency     INT NOT NULL DEFAULT 50 COMMENT 'Verwaltungs-Transparenz 0-100',
  citizen_satisfaction INT NOT NULL DEFAULT 50 COMMENT 'Buerger-Zufriedenheit (Durchschnitt) 0-100',
  treasury         BIGINT NOT NULL DEFAULT 10000 COMMENT 'Gemeinde-Kasse in Spielwaehrung',
  daily_income     INT NOT NULL DEFAULT 0 COMMENT 'Taegl. Einkommen (Steuern etc.)',
  population       INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Aktuelle virtuelle Einwohner',
  max_population   INT UNSIGNED NOT NULL DEFAULT 100 COMMENT 'Max. Einwohner (steigt mit Attraktivitaet)',
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (municipality_id),
  KEY idx_muni_stats_satisfaction (citizen_satisfaction DESC),
  KEY idx_muni_stats_population (population DESC),
  CONSTRAINT fk_muni_stats_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Event-Generation Log ────────────────────────────────────
-- Trackt wann fuer welche Gemeinde Events generiert wurden
CREATE TABLE IF NOT EXISTS event_generation_log (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id  BIGINT UNSIGNED NOT NULL,
  generation_date  DATE            NOT NULL,
  events_generated INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_event_gen_muni_date (municipality_id, generation_date),
  CONSTRAINT fk_event_gen_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Stat-Aenderungs-Log ─────────────────────────────────────
-- Protokolliert alle Aenderungen an Gemeinde-Stats
CREATE TABLE IF NOT EXISTS municipality_stats_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id BIGINT UNSIGNED NOT NULL,
  stat_name       VARCHAR(32)     NOT NULL COMMENT 'security, attractiveness, cleanliness, infrastructure, transparency',
  old_value       INT             NOT NULL,
  new_value       INT             NOT NULL,
  change_amount   INT             NOT NULL,
  reason          VARCHAR(64)     NOT NULL COMMENT 'event_expired, event_fixed, company_work, daily_decay, etc.',
  ref_type        VARCHAR(32)     NULL     COMMENT 'event, contract, etc.',
  ref_id          BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_stats_log_muni_created (municipality_id, created_at DESC),
  KEY idx_stats_log_stat (stat_name),
  CONSTRAINT fk_stats_log_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- SEED DATA: Event-Typen
-- ============================================================

INSERT IGNORE INTO event_types
  (code, name, description, emoji, category, severity, min_level, base_confidence,
   duration_hours_min, duration_hours_max, xp_reward_report, xp_reward_fix, xp_penalty_wrong,
   fix_cost_min, fix_cost_max, stat_impact, stat_damage, stat_fix_bonus,
   spawn_weight, company_type_required)
VALUES

-- ─── Kategorie: Ordnung & Sauberkeit ────────────────────────
('trash_lying',
 'Muell liegt rum', 'Abfall wurde an oeffentlichen Plaetzen entdeckt. Stinkt und sieht haesslich aus.',
 '🗑', 'ordnung', 1, 1, 1.00,
 24, 48, 10, 30, 0,
 50, 200, 'cleanliness', -3, 2,
 20, 'reinigung'),

('graffiti',
 'Graffiti & Vandalismus', 'Waende und Gebaeude wurden mit Graffiti beschmiert.',
 '🎨', 'ordnung', 1, 2, 1.00,
 24, 48, 10, 25, 0,
 80, 250, 'cleanliness', -2, 2,
 15, 'reinigung'),

('noise_complaint',
 'Laermbelaestigung', 'Nachbarn beschweren sich ueber anhaltenden Laerm.',
 '🔊', 'ordnung', 1, 2, 0.85,
 12, 36, 10, 20, 5,
 30, 100, 'attractiveness', -2, 1,
 18, NULL),

('illegal_dumping',
 'Illegale Entsorgung', 'Jemand hat illegal Abfall oder Sondermuell entsorgt.',
 '☢', 'ordnung', 2, 5, 0.90,
 36, 72, 25, 60, 10,
 200, 600, 'cleanliness', -5, 3,
 10, 'reinigung'),

-- ─── Kategorie: Infrastruktur ────────────────────────────────
('fire_safety',
 'Brandschutz mangelhaft', 'Ein Gebaeude hat gravierende Maengel beim Brandschutz.',
 '🔥', 'infrastruktur', 2, 5, 1.00,
 36, 72, 20, 80, 0,
 300, 800, 'infrastructure', -5, 4,
 12, 'bau'),

('illegal_build',
 'Bau ohne Bewilligung', 'Ein Bauvorhaben wurde ohne Genehmigung gestartet.',
 '🚧', 'infrastruktur', 2, 3, 0.90,
 24, 60, 20, 60, 5,
 200, 600, 'infrastructure', -4, 3,
 14, 'bau'),

('building_decay',
 'Gebaeude verfallen', 'Ein Gebaeude ist in schlechtem Zustand und droht einzustuerzen.',
 '🏚', 'infrastruktur', 3, 8, 1.00,
 48, 72, 30, 120, 0,
 500, 1500, 'infrastructure', -8, 5,
 8, 'bau'),

('road_damage',
 'Strassenschaeden', 'Schlagloecher und Risse auf Hauptstrassen gefunden.',
 '🛣', 'infrastruktur', 1, 1, 1.00,
 24, 48, 10, 40, 0,
 100, 400, 'infrastructure', -3, 2,
 16, 'bau'),

('water_pipe_broken',
 'Wasserleitung defekt', 'Eine Wasserleitung ist gebrochen, Wasser laeuft aus.',
 '💧', 'infrastruktur', 2, 4, 1.00,
 12, 36, 20, 70, 0,
 250, 700, 'infrastructure', -5, 3,
 11, 'bau'),

('power_outage',
 'Stromausfall', 'Ein Quartier hat keinen Strom. Ursache unklar.',
 '⚡', 'infrastruktur', 3, 7, 0.95,
 6, 24, 25, 100, 0,
 400, 1000, 'infrastructure', -7, 4,
 7, 'bau'),

-- ─── Kategorie: Sicherheit ──────────────────────────────────
('police_underfunded',
 'Polizei unterfinanziert', 'Die lokale Polizei hat zu wenig Budget fuer Patrouillen.',
 '🚓', 'sicherheit', 3, 10, 1.00,
 48, 72, 30, 150, 0,
 800, 2000, 'security', -8, 6,
 6, 'sicherheit'),

('burglary_wave',
 'Einbruchserie', 'Mehrere Einbrueche in kurzer Zeit gemeldet.',
 '🔓', 'sicherheit', 3, 8, 0.90,
 36, 72, 30, 120, 5,
 500, 1200, 'security', -7, 5,
 7, 'sicherheit'),

('vandalism_wave',
 'Vandalismus-Welle', 'Systematische Zerstoerung von oeffentlichem Eigentum.',
 '💥', 'sicherheit', 2, 6, 0.95,
 24, 60, 20, 80, 0,
 300, 800, 'security', -5, 3,
 9, 'sicherheit'),

('drug_problem',
 'Drogenszene', 'An bestimmten Orten hat sich eine offene Drogenszene etabliert.',
 '💊', 'sicherheit', 3, 12, 0.85,
 48, 72, 35, 150, 10,
 600, 1500, 'security', -8, 5,
 5, 'sicherheit'),

-- ─── Kategorie: Verwaltung ───────────────────────────────────
('corruption',
 'Korruption', 'Es gibt Hinweise auf Korruption in der Gemeindeverwaltung. Aber ist es wirklich wahr?',
 '💰', 'verwaltung', 4, 15, 0.50,
 48, 72, 50, 200, 30,
 1000, 3000, 'transparency', -12, 8,
 3, 'medien'),

('tax_abuse',
 'Steuermissbrauch', 'Verdacht auf Missbrauch von Steuergeldern. Schwer zu beweisen.',
 '🏦', 'verwaltung', 4, 18, 0.45,
 48, 72, 60, 250, 35,
 1500, 4000, 'transparency', -15, 10,
 2, 'medien'),

('bureaucracy_jam',
 'Buerokratie-Stau', 'Bewilligungen und Antraege werden nicht bearbeitet. Alles staut sich.',
 '📋', 'verwaltung', 2, 7, 1.00,
 36, 72, 20, 60, 0,
 200, 500, 'transparency', -4, 3,
 10, NULL),

('missing_transparency',
 'Fehlende Transparenz', 'Die Gemeinde kommuniziert schlecht. Buerger wissen nicht was passiert.',
 '🔍', 'verwaltung', 3, 12, 0.70,
 36, 72, 30, 100, 15,
 400, 1000, 'transparency', -6, 5,
 6, 'medien'),

-- ─── Kategorie: Soziales ────────────────────────────────────
('homelessness',
 'Obdachlosigkeit steigt', 'Die Zahl der Obdachlosen in der Gemeinde nimmt zu.',
 '🏕', 'soziales', 2, 6, 1.00,
 48, 72, 20, 80, 0,
 400, 1000, 'attractiveness', -5, 4,
 8, NULL),

('school_understaffed',
 'Schule unterbesetzt', 'Schulen haben zu wenig Lehrkraefte. Klassen werden zusammengelegt.',
 '🏫', 'soziales', 2, 5, 1.00,
 48, 72, 20, 70, 0,
 300, 800, 'attractiveness', -4, 3,
 9, NULL),

('youth_crime',
 'Jugendkriminalitaet', 'Vermehrte Delikte durch Jugendliche gemeldet.',
 '👤', 'soziales', 3, 9, 0.80,
 36, 72, 30, 100, 10,
 500, 1200, 'security', -6, 4,
 6, 'sicherheit'),

('hospital_overload',
 'Spital ueberlastet', 'Das lokale Spital hat zu wenig Kapazitaet.',
 '🏥', 'soziales', 3, 10, 1.00,
 36, 72, 30, 120, 0,
 600, 1500, 'attractiveness', -7, 5,
 5, NULL),

('housing_shortage',
 'Wohnungsnot', 'Es gibt zu wenig bezahlbare Wohnungen. Buerger wandern ab.',
 '🏠', 'soziales', 3, 8, 1.00,
 48, 72, 25, 100, 0,
 800, 2000, 'attractiveness', -8, 6,
 6, 'bau');

-- ─── Gemeinde-Stats fuer bestehende Gemeinden initialisieren ─
INSERT INTO municipality_stats (municipality_id, security, attractiveness, cleanliness, infrastructure, transparency, citizen_satisfaction, treasury, population)
SELECT
  m.id,
  50, 50, 50, 50, 50, 50,
  10000,
  0
FROM municipalities m
WHERE m.is_active = 1
ON DUPLICATE KEY UPDATE
  updated_at = CURRENT_TIMESTAMP;

-- ─── Buenzli-Event Badges ────────────────────────────────────
INSERT IGNORE INTO badges (code, name, description, category, rarity, sort_order) VALUES
  ('ACH_Report1',    'Erster Melder',       'Melde dein erstes Event',                       'achievement', 0, 500),
  ('ACH_Report10',   'Aufmerksamer Buerger', 'Melde 10 Events',                              'achievement', 1, 510),
  ('ACH_Report50',   'Wachsames Auge',      'Melde 50 Events',                               'achievement', 2, 520),
  ('ACH_Fix1',       'Problemloeser',       'Behebe dein erstes Event',                       'achievement', 0, 530),
  ('ACH_Fix25',      'Gemeinde-Held',       'Behebe 25 Events',                               'achievement', 2, 540),
  ('ACH_Corruption', 'Entlarver',           'Decke einen Korruptionsfall korrekt auf',         'achievement', 3, 550),
  ('ACH_FalseAlarm', 'Fehlalarm',           'Melde einen Korruptionsfall der sich als falsch herausstellt', 'event', 1, 560);
