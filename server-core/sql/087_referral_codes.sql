-- Migration 087: Persönliche Referral-Codes für User
ALTER TABLE users
  ADD COLUMN referral_code CHAR(8) NULL DEFAULT NULL
    COMMENT '8-char alphanumeric invite code, generated on registration',
  ADD UNIQUE KEY uq_users_referral_code (referral_code);
