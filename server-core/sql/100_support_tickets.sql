CREATE TABLE IF NOT EXISTS support_tickets (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  username    VARCHAR(32)  NULL,
  email       VARCHAR(255) NULL,
  category    VARCHAR(32)  NOT NULL,
  message     TEXT         NOT NULL,
  status      VARCHAR(16)  NOT NULL DEFAULT 'open',
  admin_reply TEXT         NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  replied_at  DATETIME     NULL
);
