-- Municipality zone settings: controls who must follow bauzone restrictions
-- bauzone_mode: 'disabled' (no restriction), 'members' (citizens only), 'all' (everyone except owner)

CREATE TABLE IF NOT EXISTS municipality_zone_settings (
  municipality_id BIGINT UNSIGNED NOT NULL,
  room_code VARCHAR(10) NOT NULL DEFAULT 'main',
  bauzone_mode ENUM('disabled', 'members', 'all') NOT NULL DEFAULT 'disabled',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (municipality_id, room_code),
  CONSTRAINT fk_mzs_mun FOREIGN KEY (municipality_id)
    REFERENCES municipalities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Extensible per-zone access rules (for future use: firms, groups, individual users)
-- Not actively used yet, but schema is ready for extension.

CREATE TABLE IF NOT EXISTS bauzone_access (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  municipality_id BIGINT UNSIGNED NOT NULL,
  room_code VARCHAR(10) NOT NULL DEFAULT 'main',
  zone_x INT UNSIGNED NULL,
  zone_y INT UNSIGNED NULL,
  target_type ENUM('role', 'user', 'firma', 'group') NOT NULL,
  target_ref VARCHAR(191) NOT NULL,
  permission ENUM('build', 'full', 'none') NOT NULL DEFAULT 'build',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ba_lookup (municipality_id, room_code, target_type, target_ref),
  CONSTRAINT fk_ba_mun FOREIGN KEY (municipality_id)
    REFERENCES municipalities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
