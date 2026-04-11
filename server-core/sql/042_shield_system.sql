-- Migration 042: Schutzschild-System
-- shield_active_until: Wenn gesetzt und in der Zukunft, blockiert expired-Event Debuffs

ALTER TABLE municipality_stats
  ADD COLUMN shield_active_until DATETIME NULL DEFAULT NULL
    COMMENT 'Schutzschild aktiv bis (blockiert Debuffs von expired Events)';
