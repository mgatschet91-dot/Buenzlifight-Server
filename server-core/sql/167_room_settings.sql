-- Room settings: Wandfarbe + Beleuchtungs-Config pro privater Raum (User)
CREATE TABLE IF NOT EXISTS user_room_settings (
  user_id        BIGINT       NOT NULL PRIMARY KEY,
  wall_color_hex VARCHAR(7)   NOT NULL DEFAULT '#d8c9a8',
  lighting_json  TEXT         NULL,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
