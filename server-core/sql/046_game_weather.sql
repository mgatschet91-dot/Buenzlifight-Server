CREATE TABLE IF NOT EXISTS game_weather (
  id INT UNSIGNED NOT NULL DEFAULT 1,
  weather_data JSON NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO game_weather (id, weather_data, fetched_at) VALUES (
  1,
  '{"type":"clear","intensity":0,"temperature":5.0,"temperature_min":5.0,"temperature_max":5.0,"windspeed":0,"is_day":1,"wmo_codes":[0],"source_cities":[]}',
  NOW()
) ON DUPLICATE KEY UPDATE id=id;
