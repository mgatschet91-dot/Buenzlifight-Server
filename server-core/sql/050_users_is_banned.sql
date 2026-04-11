-- Add is_banned column to users table for admin ban functionality
ALTER TABLE users ADD COLUMN is_banned TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active;
ALTER TABLE users ADD KEY idx_users_is_banned (is_banned);
