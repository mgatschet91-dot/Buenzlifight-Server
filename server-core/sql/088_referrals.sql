-- Migration 088: Referrals-Tabelle (wer hat wen geworben)
CREATE TABLE IF NOT EXISTS referrals (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  referrer_id          BIGINT UNSIGNED NOT NULL COMMENT 'User der den Code geteilt hat',
  referred_id          BIGINT UNSIGNED NOT NULL COMMENT 'Neu registrierter User',
  referral_code        CHAR(8)         NOT NULL COMMENT 'Verwendeter Code (Snapshot)',
  referrer_reward_paid TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1 = 200 CHF + 100 XP bereits gutgeschrieben',
  created_at           TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_referrals_referred_id (referred_id),
  KEY idx_referrals_referrer_id (referrer_id),
  CONSTRAINT fk_referrals_referrer FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_referrals_referred FOREIGN KEY (referred_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
