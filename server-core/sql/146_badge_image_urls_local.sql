-- Migration 146: Badge image_urls von bobba.io auf lokalen Server umstellen
UPDATE badges SET image_url = NULL WHERE image_url LIKE '%bobba.io%';
