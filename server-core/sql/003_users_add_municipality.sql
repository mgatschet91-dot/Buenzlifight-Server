-- Add municipality relation to users

ALTER TABLE users
  ADD COLUMN municipality_id BIGINT UNSIGNED NULL AFTER nickname,
  ADD KEY idx_users_municipality_id (municipality_id),
  ADD CONSTRAINT fk_users_municipality
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
