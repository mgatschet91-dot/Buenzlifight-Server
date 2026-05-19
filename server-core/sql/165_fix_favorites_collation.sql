-- Fix Collation-Konflikt in user_room_favorites (utf8mb4_0900_ai_ci → utf8mb4_unicode_ci)
ALTER TABLE user_room_favorites
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
