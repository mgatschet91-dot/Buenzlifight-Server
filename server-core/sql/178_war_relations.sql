-- 178: Gemeinde-Krieg — Relations & Attack System

-- Beziehungs-Score zwischen zwei Gemeinden (steigt durch Angriffe, sinkt mit Zeit)
CREATE TABLE IF NOT EXISTS municipality_relations (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  municipality_a      INT NOT NULL,
  municipality_b      INT NOT NULL,
  tension_score       INT NOT NULL DEFAULT 0,  -- 0=friedlich, 100=Krieg
  last_attack_at      DATETIME NULL DEFAULT NULL,
  last_attack_by      INT NULL DEFAULT NULL,   -- wer hat zuletzt angegriffen
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pair (municipality_a, municipality_b),
  INDEX idx_a (municipality_a),
  INDEX idx_b (municipality_b)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Angriffs-Log (jeder Angriff wird gespeichert)
CREATE TABLE IF NOT EXISTS municipality_attacks (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  attacker_id         INT NOT NULL,
  target_id           INT NOT NULL,
  attack_type         VARCHAR(40) NOT NULL,
  minigame_score      INT NOT NULL DEFAULT 0,     -- 0-100 wie gut das Minigame gespielt
  result              ENUM('hit','blocked','failed') NOT NULL DEFAULT 'hit',
  cost_paid           INT NOT NULL DEFAULT 0,     -- CHF die Angreifer gezahlt hat
  damage_dealt        INT NOT NULL DEFAULT 0,     -- Schaden am Ziel
  target_event_id     INT NULL DEFAULT NULL,      -- injizierter Event ins Ziel
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_attacker (attacker_id),
  INDEX idx_target (target_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Handelsstopp-Spalte in Partnerships
ALTER TABLE game_partnerships
  ADD COLUMN suspended_until DATETIME NULL DEFAULT NULL;

-- Ausnahmezustand-Tracking pro Gemeinde
CREATE TABLE IF NOT EXISTS municipality_emergency (
  municipality_id     INT PRIMARY KEY,
  is_active           TINYINT(1) NOT NULL DEFAULT 0,
  triggered_at        DATETIME NULL DEFAULT NULL,
  triggered_by        INT NULL DEFAULT NULL,       -- angreifende Gemeinde
  ends_at             DATETIME NULL DEFAULT NULL,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
