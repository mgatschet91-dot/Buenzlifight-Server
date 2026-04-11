-- Insert Habbo furni: Calip Cola vending machine
-- Sprites loaded from: https://images.bobba.io/dcr/hof_furni/ads_calip_cola/
-- Logic: furniture_multistate (supports double-click state toggle)
-- Dimensions from furni.json logic.dimensions: x=1, y=1
-- Catalog page: 10 = Moebel > Automaten

INSERT INTO game_item_details
  (tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, is_active)
VALUES
  ('furni_ads_calip_cola', 'Calip Cola Automat', 'moebel', 'ads_calip_cola', 'furniture_multistate', 10, 1, 1, 25, 1)
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
