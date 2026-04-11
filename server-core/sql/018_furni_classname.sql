-- Adds furni_classname column for Habbo-style furniture items loaded from Bobba.io CDN.
-- When furni_classname is set, the client loads sprites from:
--   https://images.bobba.io/dcr/hof_furni/{furni_classname}/
-- The furni_logic field controls double-click behaviour:
--   furniture_multistate  = state toggle on double-click
--   furniture_static      = no interaction
--   furniture_animated    = auto-plays animation, no interaction

ALTER TABLE game_item_details
  ADD COLUMN furni_classname VARCHAR(120) NULL DEFAULT NULL AFTER category,
  ADD COLUMN furni_logic VARCHAR(50) NULL DEFAULT NULL AFTER furni_classname;

-- Index for quick furni lookups
ALTER TABLE game_item_details
  ADD KEY idx_game_item_details_furni (furni_classname);
