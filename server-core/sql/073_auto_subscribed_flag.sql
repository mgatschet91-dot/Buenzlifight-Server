-- ── 073: Auto-Subscribed Flag auf Spot-Verträgen ─────────────────────────────
-- Server erstellt automatisch Spot-Verträge wenn Gemeinde ein Defizit hat.
-- auto_subscribed = 1 → wird wieder gekündigt wenn Defizit gedeckt/weg ist.

ALTER TABLE energy_trade_contracts
  ADD COLUMN auto_subscribed TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = vom Server automatisch erstellt (Defizit-Deckung), 0 = manuell';
