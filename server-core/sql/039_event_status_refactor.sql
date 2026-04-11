-- ============================================================
-- 039_event_status_refactor.sql
-- Event-Status-Refactoring: 4 klare Zustände
--
-- Neuer Flow:
--   detected → reported → assigned → resolved
--   Optional: expired, failed, false_alarm
--
-- Aenderungen:
--   - 'active'      → 'detected'  (gefunden, noch nicht gemeldet)
--   - 'in_progress'  → 'assigned'  (Firma zugewiesen)
--   - 'investigating' bleibt als Unter-Status von 'reported'
--   - Neuer Status 'failed' (Frist abgelaufen waehrend assigned)
--
-- municipality_events.status COMMENT aktualisieren
-- company_contracts.status COMMENT aktualisieren
-- ============================================================

-- 1) Bestehende Events migrieren: active → detected
UPDATE municipality_events SET status = 'detected' WHERE status = 'active';

-- 2) Bestehende Events migrieren: in_progress → assigned
UPDATE municipality_events SET status = 'assigned' WHERE status = 'in_progress';

-- 3) Status-Kommentar aktualisieren
ALTER TABLE municipality_events
  MODIFY COLUMN status VARCHAR(24) NOT NULL DEFAULT 'detected'
  COMMENT 'detected, reported, investigating, assigned, resolved, expired, failed, false_alarm';

-- 4) company_contracts: in_progress → assigned
UPDATE company_contracts SET status = 'assigned' WHERE status = 'in_progress';

-- 5) company_contracts: Kommentar aktualisieren
ALTER TABLE company_contracts
  MODIFY COLUMN status VARCHAR(24) NOT NULL DEFAULT 'open'
  COMMENT 'open, accepted, assigned, completed, failed, cancelled';
