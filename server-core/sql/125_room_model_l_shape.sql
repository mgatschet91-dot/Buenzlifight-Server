-- Migration 125: model_l_shape Template-Daten erstellen
-- Das Modell war in residence_rooms vergeben aber nie in room_models/room_floors/room_staircases angelegt.
-- Führt dazu, dass loadTemplateForUser nur 1 Etage ohne Treppe zurückgibt.

-- Modell registrieren
INSERT INTO room_models (model_name, display_name, is_default, sort_order)
VALUES ('model_l_shape', 'L-Mansion', 0, 20)
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), sort_order = VALUES(sort_order);

-- Geometrie-Spalten setzen (wie model_standard)
UPDATE room_models SET
  grid_size   = 20,
  wall_n      = 1,
  wall_s      = 0,
  wall_e      = 0,
  wall_w      = 1,
  door_wall   = 'S',
  door_offset = 0.0,
  door_width  = 1.8,
  door_height = 2.2
WHERE model_name = 'model_l_shape';

-- Oberstockwerk: breitere Fläche (20x8) im hinteren Bereich
INSERT INTO room_floors (model_name, floor_index, y_height, x0, x1, z0, z1) VALUES
  ('model_l_shape', 1, 7.0, -10.0, 10.0, -10.0, -2.0)
ON DUPLICATE KEY UPDATE
  y_height = VALUES(y_height),
  x0 = VALUES(x0), x1 = VALUES(x1),
  z0 = VALUES(z0), z1 = VALUES(z1);

-- Treppe: rechte Seite, verbindet EG (y=0) mit OG (y=7)
-- Zone x0=6, x1=9 → dx=3 (Breite), z0=-2, z1=8 → dz=10 → dir='N'
-- anchor_x = (6+9)/2 = 7.5, anchor_z = z1 = 8
INSERT INTO room_staircases (model_name, x0, x1, z0, z1, from_floor, to_floor) VALUES
  ('model_l_shape', 6.0, 9.0, -2.0, 8.0, 0, 1)
ON DUPLICATE KEY UPDATE
  x0 = VALUES(x0), x1 = VALUES(x1),
  z0 = VALUES(z0), z1 = VALUES(z1);
