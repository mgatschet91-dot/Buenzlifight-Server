-- 157: Manuelle Kontrolle — User bekommt Anteil wenn er den Schwarzparker findet

ALTER TABLE parking_violations
  ADD COLUMN found_by_user_id BIGINT UNSIGNED NULL
    COMMENT 'User der manuell kontrolliert und den Verstoss gefunden hat',
  ADD COLUMN user_payout      INT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'CHF-Anteil für den findenden User',
  ADD KEY idx_pv_found_by (found_by_user_id);
