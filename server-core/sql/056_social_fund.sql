-- ============================================================
-- 056: Sozialkasse (Social Fund) System
-- ============================================================
-- Separate Kasse fuer Arbeitslosenversicherung (ALV-Style).
-- Einzahlungen: % von Arbeitnehmer/Firmen-Einkommen
-- Auszahlungen: Sozialhilfe an Arbeitslose
-- ============================================================

-- social_fund: Aktueller Kassenstand der Sozialkasse
SET @s = (SELECT IF(COUNT(*)=0, 'ALTER TABLE municipality_stats ADD COLUMN social_fund DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT ''Sozialkasse Kontostand''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='social_fund');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

-- social_contribution_rate: Sozialabgabe-Satz in % (Spieler-Einstellung, 0-15%)
SET @s = (SELECT IF(COUNT(*)=0, 'ALTER TABLE municipality_stats ADD COLUMN social_contribution_rate TINYINT UNSIGNED NOT NULL DEFAULT 5 COMMENT ''Sozialabgabe-Satz in Prozent (0-15)''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='social_contribution_rate');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;

-- welfare_per_unemployed: Sozialhilfe pro Arbeitslosem pro Tag (CHF)
SET @s = (SELECT IF(COUNT(*)=0, 'ALTER TABLE municipality_stats ADD COLUMN welfare_per_unemployed INT UNSIGNED NOT NULL DEFAULT 8 COMMENT ''Sozialhilfe pro Arbeitslosem pro Tag (CHF)''', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='municipality_stats' AND COLUMN_NAME='welfare_per_unemployed');
PREPARE _s FROM @s; EXECUTE _s; DEALLOCATE PREPARE _s;
