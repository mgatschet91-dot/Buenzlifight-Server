# Deploy Notes — Firma Level-Up System

## Einmalig auf Produktiv-DB ausführen

Bestehende Firmen-Levels basierend auf Reputation korrigieren:

```sql
UPDATE companies SET level = CASE
  WHEN reputation >= 1400 THEN 10
  WHEN reputation >= 1000 THEN 9
  WHEN reputation >= 700 THEN 8
  WHEN reputation >= 480 THEN 7
  WHEN reputation >= 320 THEN 6
  WHEN reputation >= 200 THEN 5
  WHEN reputation >= 120 THEN 4
  WHEN reputation >= 60 THEN 3
  WHEN reputation >= 20 THEN 2
  ELSE 1
END
WHERE is_active = 1;
```

**Keine Tabellenänderungen nötig** — die `level`-Spalte existiert bereits in `companies`.

## Was wurde geändert

### Server (`server-core/http/handler.js`)
- Firma-Level steigt jetzt automatisch bei Auftragsabschluss (basierend auf Reputation)
- Level wird beim Laden der Firmendetails automatisch korrigiert falls veraltet
- `calcCompanyLevel(reputation)` berechnet Level 1-10 aus Reputation
- `completeContract` Response enthält neu: `reputation_gain`, `new_reputation`, `new_level`, `leveled_up`
- Bugfix: `createContractFromEvent` liest jetzt `company.level` korrekt aus DB

### Client (`mapGame/`)
- `FirmaPanel.tsx` — Level-Fortschrittsbalken mit Reputation-Anzeige, Level-Up-Nachricht
- `companyApi.ts` — Erweiterte Return-Types
- `Game.tsx` — Altes Tip-System (TipToast) entfernt
- Diverse `.tsx` Dateien — Umlaute korrigiert (ae→ä, oe→ö, ue→ü)
- `GemeindePanel.tsx` — `\u00B7` Unicode-Bug gefixt, "Attraktivität" korrigiert

### Gelöschte Dateien
- `mapGame/src/hooks/useTipSystem.ts` (ersetzt durch TutorialOverlay)
- `mapGame/src/components/ui/TipToast.tsx` (ersetzt durch TutorialOverlay)

## Level-Schwellenwerte

| Level | Reputation | Ca. Aufträge (Diff. 2) |
|-------|-----------|----------------------|
| 1     | 0         | 0                    |
| 2     | 20        | ~5                   |
| 3     | 60        | ~15                  |
| 4     | 120       | ~30                  |
| 5     | 200       | ~50                  |
| 6     | 320       | ~80                  |
| 7     | 480       | ~120                 |
| 8     | 700       | ~175                 |
| 9     | 1000      | ~250                 |
| 10    | 1400      | ~350                 |

Reputation pro Auftrag: `Schwierigkeit × 2`
