-- Migration 150: Partnerschaft Phase 2 — Diplomatische Aktionen + Export-Kapazität

-- Diplomatische Aktionen zwischen Partnerstädten
CREATE TABLE IF NOT EXISTS game_partnership_actions (
  id                INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  from_municipality_id INT       NOT NULL,
  to_municipality_id   INT       NOT NULL,
  action_type       VARCHAR(32)  NOT NULL,  -- 'emergency_aid' | 'city_festival' | 'labor_migration'
  cost              INT          NOT NULL DEFAULT 0,
  executed_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at        DATETIME     NULL,       -- Wann läuft der Effekt ab (z.B. Zufriedenheit)
  meta              JSON         NULL,       -- Zusatzinfos (Betrag, Empfänger, etc.)
  INDEX idx_from (from_municipality_id),
  INDEX idx_to   (to_municipality_id),
  INDEX idx_type_from (action_type, from_municipality_id)
);

-- Export-Kapazität: wird serverseitig berechnet, hier gecacht damit der Client schnell lesen kann
ALTER TABLE game_partnerships
  ADD COLUMN export_slots       TINYINT  NOT NULL DEFAULT 0,
  ADD COLUMN export_multiplier  FLOAT    NOT NULL DEFAULT 1.0,
  ADD COLUMN last_action_at     JSON     NULL;  -- {action_type: ISO-Datum} für Cooldown-Tracking
