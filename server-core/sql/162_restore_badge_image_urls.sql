-- Migration 162: Badge image_urls auf NULL setzen (lokale Bilder werden vom Server direkt geliefert)
-- bobba.io ist nicht mehr erreichbar. Alle Badges werden lokal aus public/badges/ bedient.
-- image_url bleibt NULL → Frontend und Server nutzen /badges/{code}.gif Fallback.

UPDATE badges SET image_url = NULL WHERE image_url LIKE '%bobba.io%';
