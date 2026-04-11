-- ── 072: Auto-Markt-Kauf Einstellung ──────────────────────────────────────────
-- Wenn eine Gemeinde ein Strom-Defizit hat und kein Spot-Vertrag existiert,
-- kauft der Server automatisch zum Notfall-Tarif ein (verhindert Ausfälle).

ALTER TABLE municipality_stats
  ADD COLUMN auto_market_buy_enabled TINYINT(1) NOT NULL DEFAULT 1
    COMMENT '1 = bei Defizit automatisch einkaufen (verhindert Ausfälle), 0 = deaktiviert',
  ADD COLUMN auto_market_buy_tariff  DECIMAL(8,4) NOT NULL DEFAULT 3.00
    COMMENT 'Notfall-Tarif CHF/MW (ohne Vertrag teurer als Spot-Vertrag, aus Gemeindekasse)';
