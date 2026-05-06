-- Migration 151: Trade Income Payout Tracking
-- Damit der Server weiss wann zuletzt Handelseinnahmen gutgeschrieben wurden

ALTER TABLE game_partnerships
  ADD COLUMN last_trade_payout_at DATETIME NULL;
