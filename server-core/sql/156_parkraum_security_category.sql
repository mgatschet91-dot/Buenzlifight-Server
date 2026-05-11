-- 156: Parkraum Security nur für Parkierungs-Events
-- Neue Kategorie "parkierung" damit illegal_parking nicht von Sicherheitsfirma behoben werden kann

UPDATE event_types
SET category = 'parkierung'
WHERE code = 'illegal_parking';

UPDATE company_types
SET can_fix_categories = '["parkierung"]'
WHERE code = 'parkraum_security';
