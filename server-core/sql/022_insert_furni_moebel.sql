-- ============================================================
-- 10 Habbo-Moebel fuer den Shop / Katalog
-- Sprites werden geladen von: /assets/hof_furni/{furni_classname}/
-- Alle Items sind reine Moebel (type='s'), keine Waende/Effekte/Pets.
-- Quelle: bobba.sql furniture-Tabelle
-- ============================================================

-- ── 1. Mini-Bar ── Kategorie: Automaten (catalog_page_id = 10)
-- bobba id=109, item_name=bar_polyfon, 1×1, interaction=vendingmachine
INSERT INTO game_item_details
  (tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, is_active)
VALUES
  ('furni_bar_polyfon', 'Mini-Bar', 'moebel', 'bar_polyfon', 'furniture_multistate', 10, 1, 1, 30, 1)
ON DUPLICATE KEY UPDATE
  display_name    = VALUES(display_name),
  category        = VALUES(category),
  furni_classname = VALUES(furni_classname),
  furni_logic     = VALUES(furni_logic),
  catalog_page_id = VALUES(catalog_page_id),
  footprint_width = VALUES(footprint_width),
  footprint_height= VALUES(footprint_height),
  build_cost      = VALUES(build_cost),
  is_active       = VALUES(is_active),
  updated_at      = CURRENT_TIMESTAMP;

-- ── 2. Stuhl Norja ── Kategorie: Stuehle & Sitze (catalog_page_id = 11)
-- bobba id=15, item_name=chair_norja, 1×1, interaction=default, modes=1
INSERT INTO game_item_details
  (tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, is_active)
VALUES
  ('furni_chair_norja', 'Stuhl Norja', 'moebel', 'chair_norja', 'furniture_static', 11, 1, 1, 15, 1)
ON DUPLICATE KEY UPDATE
  display_name    = VALUES(display_name),
  category        = VALUES(category),
  furni_classname = VALUES(furni_classname),
  furni_logic     = VALUES(furni_logic),
  catalog_page_id = VALUES(catalog_page_id),
  footprint_width = VALUES(footprint_width),
  footprint_height= VALUES(footprint_height),
  build_cost      = VALUES(build_cost),
  is_active       = VALUES(is_active),
  updated_at      = CURRENT_TIMESTAMP;

-- ── 3. Polster-Sofa ── Kategorie: Stuehle & Sitze (catalog_page_id = 11)
-- bobba id=13, item_name=sofa_silo, 2×1, interaction=default, modes=1
INSERT INTO game_item_details
  (tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, is_active)
VALUES
  ('furni_sofa_silo', 'Polster-Sofa', 'moebel', 'sofa_silo', 'furniture_static', 11, 2, 1, 35, 1)
ON DUPLICATE KEY UPDATE
  display_name    = VALUES(display_name),
  category        = VALUES(category),
  furni_classname = VALUES(furni_classname),
  furni_logic     = VALUES(furni_logic),
  catalog_page_id = VALUES(catalog_page_id),
  footprint_width = VALUES(footprint_width),
  footprint_height= VALUES(footprint_height),
  build_cost      = VALUES(build_cost),
  is_active       = VALUES(is_active),
  updated_at      = CURRENT_TIMESTAMP;

-- ── 4. Kaffeetisch Norja ── Kategorie: Tische (catalog_page_id = 12)
-- bobba id=6, item_name=table_norja_med, 2×2, interaction=default, modes=1
INSERT INTO game_item_details
  (tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, is_active)
VALUES
  ('furni_table_norja_med', 'Kaffeetisch Norja', 'moebel', 'table_norja_med', 'furniture_static', 12, 2, 2, 25, 1)
ON DUPLICATE KEY UPDATE
  display_name    = VALUES(display_name),
  category        = VALUES(category),
  furni_classname = VALUES(furni_classname),
  furni_logic     = VALUES(furni_logic),
  catalog_page_id = VALUES(catalog_page_id),
  footprint_width = VALUES(footprint_width),
  footprint_height= VALUES(footprint_height),
  build_cost      = VALUES(build_cost),
  is_active       = VALUES(is_active),
  updated_at      = CURRENT_TIMESTAMP;

-- ── 5. Kamin ── Kategorie: Dekoration (catalog_page_id = 13)
-- bobba id=46, item_name=fireplace_polyfon, 2×1, interaction=default, modes=2
INSERT INTO game_item_details
  (tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, is_active)
VALUES
  ('furni_fireplace_polyfon', 'Kamin', 'moebel', 'fireplace_polyfon', 'furniture_multistate', 13, 2, 1, 50, 1)
ON DUPLICATE KEY UPDATE
  display_name    = VALUES(display_name),
  category        = VALUES(category),
  furni_classname = VALUES(furni_classname),
  furni_logic     = VALUES(furni_logic),
  catalog_page_id = VALUES(catalog_page_id),
  footprint_width = VALUES(footprint_width),
  footprint_height= VALUES(footprint_height),
  build_cost      = VALUES(build_cost),
  is_active       = VALUES(is_active),
  updated_at      = CURRENT_TIMESTAMP;

-- ── 6. Buecherregal Norja ── Kategorie: Dekoration (catalog_page_id = 13)
-- bobba id=1, item_name=shelves_norja, 1×1, interaction=default, modes=1
INSERT INTO game_item_details
  (tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, is_active)
VALUES
  ('furni_shelves_norja', 'Buecherregal Norja', 'moebel', 'shelves_norja', 'furniture_static', 13, 1, 1, 20, 1)
ON DUPLICATE KEY UPDATE
  display_name    = VALUES(display_name),
  category        = VALUES(category),
  furni_classname = VALUES(furni_classname),
  furni_logic     = VALUES(furni_logic),
  catalog_page_id = VALUES(catalog_page_id),
  footprint_width = VALUES(footprint_width),
  footprint_height= VALUES(footprint_height),
  build_cost      = VALUES(build_cost),
  is_active       = VALUES(is_active),
  updated_at      = CURRENT_TIMESTAMP;

-- ── 7. Tischlampe ── Kategorie: Lampen (catalog_page_id = 14)
-- bobba id=41, item_name=lamp_armas, 1×1, interaction=default, modes=2
INSERT INTO game_item_details
  (tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, is_active)
VALUES
  ('furni_lamp_armas', 'Tischlampe', 'moebel', 'lamp_armas', 'furniture_multistate', 14, 1, 1, 20, 1)
ON DUPLICATE KEY UPDATE
  display_name    = VALUES(display_name),
  category        = VALUES(category),
  furni_classname = VALUES(furni_classname),
  furni_logic     = VALUES(furni_logic),
  catalog_page_id = VALUES(catalog_page_id),
  footprint_width = VALUES(footprint_width),
  footprint_height= VALUES(footprint_height),
  build_cost      = VALUES(build_cost),
  is_active       = VALUES(is_active),
  updated_at      = CURRENT_TIMESTAMP;

-- ── 8. Pura Lampe ── Kategorie: Lampen (catalog_page_id = 14)
-- bobba id=175, item_name=lamp_basic, 1×1, interaction=default, modes=2
INSERT INTO game_item_details
  (tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, is_active)
VALUES
  ('furni_lamp_basic', 'Pura Lampe', 'moebel', 'lamp_basic', 'furniture_multistate', 14, 1, 1, 18, 1)
ON DUPLICATE KEY UPDATE
  display_name    = VALUES(display_name),
  category        = VALUES(category),
  furni_classname = VALUES(furni_classname),
  furni_logic     = VALUES(furni_logic),
  catalog_page_id = VALUES(catalog_page_id),
  footprint_width = VALUES(footprint_width),
  footprint_height= VALUES(footprint_height),
  build_cost      = VALUES(build_cost),
  is_active       = VALUES(is_active),
  updated_at      = CURRENT_TIMESTAMP;

-- ── 9. Bonsai-Baum ── Kategorie: Pflanzen (catalog_page_id = 15)
-- bobba id=144, item_name=plant_bonsai, 1×1, interaction=default, modes=1
INSERT INTO game_item_details
  (tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, is_active)
VALUES
  ('furni_plant_bonsai', 'Bonsai-Baum', 'moebel', 'plant_bonsai', 'furniture_static', 15, 1, 1, 15, 1)
ON DUPLICATE KEY UPDATE
  display_name    = VALUES(display_name),
  category        = VALUES(category),
  furni_classname = VALUES(furni_classname),
  furni_logic     = VALUES(furni_logic),
  catalog_page_id = VALUES(catalog_page_id),
  footprint_width = VALUES(footprint_width),
  footprint_height= VALUES(footprint_height),
  build_cost      = VALUES(build_cost),
  is_active       = VALUES(is_active),
  updated_at      = CURRENT_TIMESTAMP;

-- ── 10. Sonnenblume ── Kategorie: Pflanzen (catalog_page_id = 15)
-- bobba id=152, item_name=plant_sunflower, 1×1, interaction=default, modes=1
INSERT INTO game_item_details
  (tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, is_active)
VALUES
  ('furni_plant_sunflower', 'Sonnenblume', 'moebel', 'plant_sunflower', 'furniture_static', 15, 1, 1, 12, 1)
ON DUPLICATE KEY UPDATE
  display_name    = VALUES(display_name),
  category        = VALUES(category),
  furni_classname = VALUES(furni_classname),
  furni_logic     = VALUES(furni_logic),
  catalog_page_id = VALUES(catalog_page_id),
  footprint_width = VALUES(footprint_width),
  footprint_height= VALUES(footprint_height),
  build_cost      = VALUES(build_cost),
  is_active       = VALUES(is_active),
  updated_at      = CURRENT_TIMESTAMP;
