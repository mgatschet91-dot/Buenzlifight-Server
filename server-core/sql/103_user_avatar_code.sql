-- Migration 103: Avatar code column on users
-- Stores avatar appearance as a compact pipe-separated string (~65 chars).
-- Format: skinHex|hairHex|hairStyle|shirtHex|shirtStyle|pantsHex|pantsStyle|shoeHex|shoeStyle|hat
-- Example: ffd7aa|444444|short|5596aa|tshirt|334455|jeans|333333|basic|none

ALTER TABLE users
  ADD COLUMN avatar_code VARCHAR(150) NULL DEFAULT NULL;
