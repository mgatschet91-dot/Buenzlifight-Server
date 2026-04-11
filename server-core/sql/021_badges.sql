-- 021_badges.sql
-- Badge-System: Definition aller Badges + Zuordnung zu Usern

-- ─── Badge-Definitionen ────────────────────────────────────────────
-- Hier werden alle verfügbaren Badges definiert (z.B. "ACH_Login5", "BRA", "Z58")
CREATE TABLE IF NOT EXISTS badges (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code       VARCHAR(64)     NOT NULL COMMENT 'Eindeutiger Badge-Code z.B. ACH_Login5, BRA, HC1',
  name       VARCHAR(128)    NOT NULL DEFAULT '' COMMENT 'Anzeigename z.B. Habbo Club Badge',
  description TEXT           NULL     COMMENT 'Beschreibung was der Badge bedeutet',
  category   VARCHAR(32)     NOT NULL DEFAULT 'general' COMMENT 'Kategorie: achievement, rank, event, special, general',
  image_url  VARCHAR(512)    NULL     COMMENT 'URL zum Badge-Bild (z.B. bobba.io CDN)',
  rarity     TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0=common, 1=uncommon, 2=rare, 3=epic, 4=legendary',
  is_active  TINYINT(1)      NOT NULL DEFAULT 1 COMMENT 'Ob der Badge noch vergeben werden kann',
  sort_order INT             NOT NULL DEFAULT 0 COMMENT 'Sortierung innerhalb der Kategorie',
  created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_badge_code (code),
  KEY idx_badge_category (category),
  KEY idx_badge_active_sort (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── User-Badges (welcher User hat welchen Badge) ──────────────────
CREATE TABLE IF NOT EXISTS user_badges (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  badge_code VARCHAR(64)     NOT NULL COMMENT 'Verweist auf badges.code',
  slot       TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Anzeige-Slot 0-4 (0 = nicht angezeigt, 1-4 = Profil-Slot)',
  acquired_at TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Wann der Badge erhalten wurde',
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_badge (user_id, badge_code),
  KEY idx_user_badges_slot (user_id, slot),
  KEY idx_badge_code (badge_code),
  CONSTRAINT fk_user_badges_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Standard-Badges einfügen ──────────────────────────────────────
INSERT IGNORE INTO badges (code, name, description, category, image_url, rarity, sort_order) VALUES
  ('ACH_Login1',       'Erster Login',         'Logge dich zum ersten Mal ein',            'achievement', 'https://images.bobba.io/c_images/Badges/ACH_Login1.gif',       0, 10),
  ('ACH_Login5',       '5 Tage Online',        'Logge dich an 5 verschiedenen Tagen ein',  'achievement', 'https://images.bobba.io/c_images/Badges/ACH_Login5.gif',       0, 20),
  ('ACH_Login10',      '10 Tage Online',       'Logge dich an 10 verschiedenen Tagen ein', 'achievement', 'https://images.bobba.io/c_images/Badges/ACH_Login10.gif',      1, 30),
  ('ACH_Login25',      '25 Tage Online',       'Logge dich an 25 verschiedenen Tagen ein', 'achievement', 'https://images.bobba.io/c_images/Badges/ACH_Login25.gif',      1, 40),
  ('ACH_Login50',      '50 Tage Online',       'Logge dich an 50 verschiedenen Tagen ein', 'achievement', 'https://images.bobba.io/c_images/Badges/ACH_Login50.gif',      2, 50),
  ('ACH_Login100',     '100 Tage Online',      'Logge dich an 100 verschiedenen Tagen ein','achievement', 'https://images.bobba.io/c_images/Badges/ACH_Login100.gif',     3, 60),
  ('ACH_RoomEntry1',   'Raumbesucher',         'Betrete einen Raum',                       'achievement', 'https://images.bobba.io/c_images/Badges/ACH_RoomEntry1.gif',   0, 70),
  ('ACH_RoomEntry5',   'Stammgast',            'Betrete 5 verschiedene Räume',             'achievement', 'https://images.bobba.io/c_images/Badges/ACH_RoomEntry5.gif',   0, 80),
  ('ACH_FriendList1',  'Erster Freund',        'Füge einen Freund hinzu',                  'achievement', 'https://images.bobba.io/c_images/Badges/ACH_FriendListSize1.gif', 0, 90),
  ('ACH_FriendList5',  '5 Freunde',            'Habe 5 Freunde',                           'achievement', 'https://images.bobba.io/c_images/Badges/ACH_FriendListSize5.gif', 1, 100),
  ('ACH_Chat1',        'Chatterbox',           'Sende deine erste Nachricht',              'achievement', 'https://images.bobba.io/c_images/Badges/ACH_SelfModChatTurnOffSeen1.gif', 0, 110),
  ('ACH_Furni1',       'Möbel-Sammler',        'Kaufe dein erstes Möbelstück',             'achievement', 'https://images.bobba.io/c_images/Badges/ACH_FurniturePlaceStickie1.gif', 0, 120),
  ('HC1',              'Habbo Club',           'Habbo Club Mitglied',                       'rank',       'https://images.bobba.io/c_images/Badges/HC1.gif',              1, 200),
  ('VIP',              'VIP',                  'VIP-Mitglied',                              'rank',       'https://images.bobba.io/c_images/Badges/VIP.gif',              2, 210),
  ('ADM',              'Administrator',        'Hotel-Administrator',                       'rank',       'https://images.bobba.io/c_images/Badges/ADM.gif',              4, 220),
  ('BRA',              'Brasilien',            'Brasilien Event Badge',                     'event',      'https://images.bobba.io/c_images/Badges/BRA.gif',              1, 300),
  ('Z58',              'Snowstorm',            'Snowstorm Event Badge',                     'event',      'https://images.bobba.io/c_images/Badges/Z58.gif',              1, 310),
  ('AC1',              'Classic',              'Classic Habbo Badge',                        'special',    'https://images.bobba.io/c_images/Badges/AC1.gif',              2, 400),
  ('NWB',              'Neuling',              'Willkommen! Neuer Bewohner Badge',          'special',    'https://images.bobba.io/c_images/Badges/NWB.gif',              0, 500);
