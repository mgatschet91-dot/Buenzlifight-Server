-- Arbeitszeit wird serverseitig berechnet und in der DB gespeichert
-- Damit kann nicht gecheated werden und verschiedene Events haben verschiedene Zeiten

ALTER TABLE company_contracts
  ADD COLUMN work_duration_seconds INT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Berechnete Arbeitszeit in Sekunden (bei Accept gesetzt)',
  ADD COLUMN completable_at DATETIME NULL
    COMMENT 'Zeitpunkt ab dem abgeschlossen werden darf (accepted_at + work_duration)';
