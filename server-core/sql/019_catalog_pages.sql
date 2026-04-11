-- ============================================================
-- Catalog Pages – serverseitig definierter Katalog-Baum
-- ============================================================

CREATE TABLE IF NOT EXISTS catalog_pages (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  parent_id     INT UNSIGNED    NULL DEFAULT NULL,
  caption       VARCHAR(120)    NOT NULL,
  slug          VARCHAR(120)    NOT NULL,
  icon_image    VARCHAR(250)    NULL DEFAULT NULL,
  sort_order    INT             NOT NULL DEFAULT 0,
  visible       TINYINT(1)      NOT NULL DEFAULT 1,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_catalog_pages_slug (slug),
  KEY idx_catalog_pages_parent (parent_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Seed: Bestehende Kategorien als Top-Level-Pages
-- -----------------------------------------------------------
INSERT INTO catalog_pages (id, parent_id, caption, slug, sort_order, visible) VALUES
  (1,  NULL, 'City Management', 'city_management', 10, 1),
  (2,  NULL, 'Commercial',      'commercial',      20, 1),
  (3,  NULL, 'Decoration',      'decoration',      30, 1),
  (4,  NULL, 'Industrial',      'industrial',      40, 1),
  (5,  NULL, 'Infrastructure',  'infrastructure',  50, 1),
  (6,  NULL, 'Residential',     'residential',     60, 1),
  (7,  NULL, 'Service',         'service',         70, 1),
  (8,  NULL, 'Terrain',         'terrain',         80, 1),

  -- Möbel (Furni fuer Public Rooms)
  (9,  NULL, 'Moebel',           'moebel',             90, 1),
  (10, 9,    'Automaten',        'moebel_automaten',    10, 1),
  (11, 9,    'Stuehle & Sitze',  'moebel_stuehle',      20, 1),
  (12, 9,    'Tische',           'moebel_tische',       30, 1),
  (13, 9,    'Dekoration',       'moebel_deko',         40, 1),
  (14, 9,    'Lampen',           'moebel_lampen',       50, 1),
  (15, 9,    'Pflanzen',         'moebel_pflanzen',     60, 1)
ON DUPLICATE KEY UPDATE
  caption    = VALUES(caption),
  sort_order = VALUES(sort_order),
  visible    = VALUES(visible);

-- -----------------------------------------------------------
-- Link: game_item_details → catalog_pages
-- -----------------------------------------------------------
ALTER TABLE game_item_details
  ADD COLUMN catalog_page_id INT UNSIGNED NULL DEFAULT NULL AFTER furni_logic,
  ADD KEY idx_game_item_details_page (catalog_page_id);

-- Map bestehende Items anhand category zu den Pages
UPDATE game_item_details SET catalog_page_id = 2 WHERE category = 'commercial'      AND catalog_page_id IS NULL;
UPDATE game_item_details SET catalog_page_id = 3 WHERE category = 'decoration'      AND catalog_page_id IS NULL;
UPDATE game_item_details SET catalog_page_id = 4 WHERE category = 'industrial'      AND catalog_page_id IS NULL;
UPDATE game_item_details SET catalog_page_id = 5 WHERE category = 'infrastructure'  AND catalog_page_id IS NULL;
UPDATE game_item_details SET catalog_page_id = 6 WHERE category = 'residential'     AND catalog_page_id IS NULL;
UPDATE game_item_details SET catalog_page_id = 7 WHERE category = 'service'         AND catalog_page_id IS NULL;
