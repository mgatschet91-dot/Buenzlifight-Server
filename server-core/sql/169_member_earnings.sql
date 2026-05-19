-- 169: Mitarbeiter-Statistiken — total_earnings pro Member
-- Trackt die gesamten CHF-Auszahlungen, die ein Mitglied
-- von dieser Firma als Lohn erhalten hat (wird bei Auftragsabschluss gesetzt).
ALTER TABLE company_members
  ADD COLUMN total_earnings BIGINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Summe aller CHF-Auszahlungen an diesen User von dieser Firma'
    AFTER xp_earned;
