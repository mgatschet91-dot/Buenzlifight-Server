-- Migration 149: Partnerschafts-Stufen (Tier-System)
-- Tier 1 = Bekannt (+100/Tag), Tier 2 = Freundschaftlich (+250/Tag, 30d),
-- Tier 3 = Strategisch (+500/Tag, 90d + 10k), Tier 4 = Alliiert (+1000/Tag, 365d + 50k)

ALTER TABLE game_partnerships
  ADD COLUMN tier           TINYINT  NOT NULL DEFAULT 1,
  ADD COLUMN tier_upgraded_at DATETIME NULL,
  ADD COLUMN tier_invested  INT      NOT NULL DEFAULT 0;

-- Alle bestehenden connected-Partnerschaften starten auf Tier 1
UPDATE game_partnerships
SET tier = 1
WHERE status = 'connected' AND tier = 0;
