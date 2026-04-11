-- Changelog-Einträge für die Landing-Page (Admin-verwaltbar)
CREATE TABLE IF NOT EXISTS changelog_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  version VARCHAR(16) NOT NULL,
  tag ENUM('neu','fix','entfernt') NOT NULL DEFAULT 'neu',
  message VARCHAR(500) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_version (version),
  INDEX idx_published (published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bestehende hardcoded Einträge migrieren
INSERT IGNORE INTO changelog_entries (version, tag, message, sort_order) VALUES
-- v2.1
('v2.1', 'neu', 'Sozialhilfe-System — Gemeinde-Sozialfonds für Bürger', 1),
('v2.1', 'neu', 'Firmenkredite — Gemeindekasse finanziert Darlehen', 2),
('v2.1', 'neu', 'Alle 2''175 Schweizer Gemeinden verfügbar', 3),
('v2.1', 'neu', 'Banksystem mit persönlichen Konten & Transaktionen', 4),
('v2.1', 'neu', 'Gemeinde-Finanzbuch (Ledger) & Treasury', 5),
('v2.1', 'neu', 'Echtzeit-Wetter (Open-Meteo CH)', 6),
('v2.1', 'neu', 'Schild-System gegen Event-Schäden', 7),
('v2.1', 'neu', 'Falschparkierer-Events', 8),
('v2.1', 'entfernt', 'Bobba-System (Server-Cleanup)', 9),
-- v2.0
('v2.0', 'fix', 'Mobile UI — Header-Texte überlappen nicht mehr', 1),
('v2.0', 'fix', 'Mobile Hauptseite, Login & Registrierung scrollbar', 2),
('v2.0', 'fix', 'Ausloggen funktioniert jetzt korrekt', 3),
('v2.0', 'neu', 'Einladen, Sprache & Beenden im Mobile-Toolbar-Menü', 4),
('v2.0', 'neu', 'Achievements mit Progressbar und Sounds', 5),
('v2.0', 'neu', 'Wappen wird als PNG im Core-Server gespeichert', 6),
('v2.0', 'neu', 'FAQ-Seite & Discord-Link', 7),
('v2.0', 'entfernt', 'Demand-Bars (R/C/I) aus dem Header', 8);
