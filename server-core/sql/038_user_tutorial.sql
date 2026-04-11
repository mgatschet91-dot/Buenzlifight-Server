-- 038_user_tutorial.sql
-- Tutorial/Onboarding Status wird in users_data.project_data (JSON) gespeichert.
-- Kein Schema-Change noetig — users_data + project_data existieren bereits.
--
-- Verwendete JSON-Keys in project_data:
--   $.tutorial_completed  (0 oder 1)
--   $.tutorial_step       (int, aktueller Schritt)
--
-- Diese Datei ist nur Dokumentation, kein SQL auszufuehren.
SELECT 1;
