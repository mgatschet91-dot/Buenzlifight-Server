-- Migration 142: Performance-Indizes für häufig abgefragte Tabellen
-- Grössten Impact auf: Interval-Jobs, Parking-Ticks, Buenzli-Dispatch

-- buenzli_dispatches: alle 5min nach status='searching' AND arrives_at <= NOW() gefiltert
ALTER TABLE buenzli_dispatches
  ADD INDEX idx_status_arrives (status, arrives_at);

-- parking_violations: alle 30s nach municipality_id + status='unpaid' gefiltert
ALTER TABLE parking_violations
  ADD INDEX idx_muni_status_created (municipality_id, status, created_at);

-- game_items: alle 3s vollständig pro Room geladen (stats/disaster/crime-tick)
ALTER TABLE game_items
  ADD INDEX idx_muni_room (municipality_id, room_code);

-- parked_vehicles: Ablauf-Tick scannt nach parked_at + leave_after_seconds
ALTER TABLE parked_vehicles
  ADD INDEX idx_parked_at (parked_at);

-- game_rooms: JOIN bei Buenzli-Dispatch + Infra-Recompute
ALTER TABLE game_rooms
  ADD INDEX idx_muni_active (municipality_id, is_active);

-- user_friends: Join-Handler lädt alle Freunde eines Users
ALTER TABLE user_friends
  ADD INDEX idx_user_status (user_id, status),
  ADD INDEX idx_friend_status (friend_id, status);
