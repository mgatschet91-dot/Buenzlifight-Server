# Meinort – Backlog & Fixes

## 🔴 Fixes (dringend)

- [ ] **BUG: Bildkonvertierung auf Debian-Server — dieselben 4 Dateien endlos als „nicht gefunden" gemeldet**
  - Immer dieselben 4 UUIDs (z.B. `ffc384bc-...`, `ff133d94-...`, `b06564f2-...`, `fcbb60f8-...`) wiederholen sich im Log in einer Endlosschleife
  - Vermutung: Konverter läuft über eine Liste die auch Temp-Dateien enthält, die längst gelöscht sind
  - Fix: Nur Dateien konvertieren die aktiv in der Datenbank referenziert sind (JOIN über die relevante Tabelle), Temp-Einträge ignorieren
  - Zusätzlich: Fehler-Handling verbessern — bereits als fehlend bekannte Dateien nicht erneut versuchen (Blacklist / Skip-Flag in DB)

- [ ] **BUG: Zu viel Geld abgezogen beim Bauen — Betrag nicht nachvollziehbar**
  - User-Report (HuMeN, 25.04.2026): 6K+ verfügbar → 4× Skatepark à 300 CHF + 4× Baum à 15 CHF gekauft
  - Sollte kosten: 4×300 + 4×15 = **1'260 CHF** — abgezogen wurden aber **über 6K**
  - Muster: Könnte derselbe Bug wie Spital Lv2→Lv3 (4K angezeigt, 8K abgezogen) — Kosten werden möglicherweise mit einem Multiplikator (Level / Anzahl bestehender Gebäude / Klick-Doppelauslösung) multipliziert
  - Ohne detaillierten Log schwer reproduzierbar → direkt verknüpft mit „Gemeinde-Log 24h + Suche"

- [ ] **BUG: Buchungseinträge zu ungenau — kein Verwendungszweck bei Baukosten**
  - In der Kostenaufstellung steht nur „Baukosten" ohne Angabe welches Gebäude gebaut wurde
  - Fix: Buchungstext soll Gebäudename + Menge enthalten, z.B. „4× Skatepark (300 CHF)" und „4× Baum (15 CHF)"

- [ ] **BUG: Upgrade-Kosten werden abgezogen, Upgrade wird aber nicht übernommen**
  - Kredit von 6K aufgenommen → Upgrade per Klick ausgelöst → Geld weg, Upgrade nicht aktiv
  - In der Kostenaufstellung nicht auffindbar — es erscheint nur der Kreditposten (6K), keine Ausgabe
  - Noch offen: ob Upgrade wirklich nicht gestartet wird, oder nur der Ledger-Eintrag fehlt

- [x] **Parkfeld / Grosses Parkfeld entfernen** ← *fertig* — aus Shop/Toolbar entfernt, Parkplatz (1×1) bleibt

---

## 🟡 Backlog (Ideen / To-Do)

- [ ] **In-Game Support / Feedback System**
  - User-Seite: Panel im Client zum Einreichen von Bug-Reports oder Feature-Wünschen (Typ wählbar: Bug / Idee)
  - Admin-Seite: Eingehende Meldungen sehen, kommentieren, und direkt als Backlog-Eintrag übernehmen
  - Einträge landen in DB-Tabelle (`support_tickets` o.ä.), Admin kann Status setzen (offen / in Arbeit / erledigt)

- [ ] **Native Mobile App (leicht & schnell)**
  - Eigene App für iOS & Android (z.B. React Native oder Expo)
  - Fokus auf Performance — kein aufgeblähter Web-Wrapper
  - Kernelement: Karte/Map, Chat, Gemeinde-Übersicht, Notifications
  - Push-Notifications für Ereignisse (Wahlen, Disasters, Nachrichten)

- [ ] **Gemeinde-Log: auf 24 Stunden erweitern + Suche einbauen**
  - Aktuell werden Logs nur begrenzt angezeigt — History auf die letzten 24h ausweiten
  - Suchfeld einbauen: nach Typ, Betrag, Zeitraum oder Stichwort filtern
  - Wichtig zur Nachvollziehbarkeit der Geld-Bugs (falsche Abbuchungen lassen sich so gezielt finden)
  - Gefilterte Ansicht nach Typ (Einnahmen, Ausgaben, Steuern, Kredite, Upgrades etc.)

- [x] **Handelspartner: Phase 2 (Diplomatische Aktionen, Handelsbilanz, LKW-Routen, IDLE-Payouts)** ← *fertig*
  - Diplomatische Aktionen (Notfallhilfe, Städtefest, Arbeitsmigration) mit Cooldown-System
  - Handelsbilanz-Tab: total verdient, investiert, Export-Kapazität pro Fabrik/Lager
  - LKW-Routen: Trade Trucks fahren von Fabriken zu Kartenrand (Richtung Partnerstadt)
  - IDLE-ready Tages-Payouts via Server-Tick (calendar day check, Ledger-Eintrag mit Partnernahme)
  - Vollständige i18n: alle Strings in UI_LABELS via `msg()`/`mm()`/`gt()`, keine hardcodierten Texte
  - Tier-Zeiten: 3 / 6 / 12 Tage (nicht mehr Stunden)

- [x] **Handelspartner: Partnerschafts-Stufen (Tier-System)** ← *fertig*
  - Stufe 1 Bekannt: +100/Tag (sofort)
  - Stufe 2 Freundschaftlich: +250/Tag (nach 3 Tagen aktiv)
  - Stufe 3 Strategisch: +500/Tag (nach 6 Tagen + 10k investiert)
  - Stufe 4 Alliiert: +1000/Tag (nach 12 Tagen + 50k investiert)
  - DB: `tier`-Spalte in `game_partnerships`, Server-Tick prüft Upgrade-Bedingungen

- [ ] **Handelspartner: Ressourcentausch**
  - Vertrag: Stadt A liefert Strom, Stadt B liefert Wasser → gegenseitiger Boost
  - Sinnvoll für spezialisierte Städte

- [ ] **Handelspartner: Gemeinsame Projekte**
  - Beide zahlen in Topf → nach X Tagen Projekt fertig (Autobahn, Bahnlinie, Forschung)
  - Dauerhafter Bonus für beide Städte

- [ ] **Handelspartner: Handelsbilanz & Geschichte**
  - Gesamtfluss seit Partnerschaft, Verbindungsdatum, Verlaufsgraph Einnahmen

- [ ] **Handelspartner: Diplomatische Aktionen**
  - Notfallhilfe senden (5k Fr.), Arbeitsmigration, Städtefest (+Zufriedenheit)

- [ ] **Handelspartner: LKW-Routen auf der Karte**
  - Visuelle LKW-Route zwischen verbundenen Städten (wie Emergency Vehicles)
  - Erklärung folgt sobald Tier-Basis steht

- [ ] **Handelspartner: Partner-Bewertung / Reputation**
  - Aktive Städte kriegen Stern, inaktive werden "eingeschlafen" (weniger Einkommen)

- [ ] **Handelspartner: Import/Export Marktplatz**
  - Städte bieten Ressourcen an, Preis schwankt nach Angebot/Nachfrage

- [ ] **Handelspartner: Handelsblock / Allianz**
  - 3+ Städte → gemeinsame Boni, shared Katastrophenschutz, Block-Chat

- [ ] **Landwirtschafts-System (Bauernhöfe & Vieh)**
  - Neue Gebäudetypen: Bauernhof, Stall (Kühe/Schafe/Schweine), Getreidesilo, Käserei
  - Jede Farm produziert ein Exportgut: Fleisch, Milch, Käse, Getreide, Wolle
  - Export-LKWs aus Farmen sind Kühltransporter (weißer Truck) statt Industriefahrzeug
  - Handelseinkommen steigt wenn Partner-Stadt Nahrung kauft (Nachfragesystem)
  - Tiere brauchen Weidefläche (eigene Zone) und Wasser-Versorgung
  - Visuell: Tier-NPCs die auf der Weidefläche herumlaufen (Kühe/Schafe sichtbar)

- [ ] **Export-Güter & Cargo-Typen**
  - Verschiedene Gebäude → verschiedene Güter: Fabrik=Industrie, Farm=Agrar, Lager=Handel
  - LKW-Tooltip zeigt was geladen ist (Cargo-Icon + Bezeichnung)
  - Langfristig: Marktpreise für Güter (Angebot/Nachfrage zwischen Städten)

<!-- Neue Einträge hier drunter einfügen -->

---

---

## ✅ Erledigt

- [x] **BUG: Wachstums-Diagnose Panel — 3 Fehler behoben** (`GrowthDebugPanel.tsx`)
  - Roter Punkt bei "Wohnen demand = 0.0" war falsch — DemandFactor war trotzdem 0.38 → Wachstum lief. Fix: Rot nur noch wenn `demandFactor = 0` (demand < −30)
  - Police-Malus war im Client falsch: für Coverage 20–40% zeigte Client "−80%" aber Server macht nur "−20%" (`Math.random() >= 0.8`). Korrigiert auf −20% / policeMult = 0.8
  - Hint-Text `(+30) / 80 = DemandFactor` war kryptisch und abgekürzt → jetzt `→ Faktor: 0.38` direkt lesbar
  - Blocker-Logik für Sicherheit jetzt korrekt: < 20% → −50%, 20–40% → −20% (statt < 25% pauschal)

- [x] **BUG: Upgrade-Kosten wurden doppelt abgezogen + falsche Kostenformel** (`construction.js`)
  - Ursache 1: `deductMunicipalityMoney()` + `applyMunicipalityTransaction()` buchten beide aus treasury → doppelter Abzug
  - Ursache 2: Kostenformel `baseCost * Math.pow(2, currentLevel)` stieg exponentiell (Lv1→2: ×2, Lv2→3: ×4)
  - Fix: `deductMunicipalityMoney()` entfernt, nur noch `applyMunicipalityTransaction()` (macht beides in einem Schritt)
  - Fix: Upgrade-Kosten jetzt flat `baseCost` pro Stufe, kein Multiplikator
