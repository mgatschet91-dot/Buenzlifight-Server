'use strict';

/**
 * Stats für alle 25 Mansion-Varianten (5 Reihen × 5 Spalten).
 * Index: MANSION_STATS[row][col]
 *
 * - maxTenants: wie viele Mieter max. eingeladen werden können
 * - minRent / maxRent: erlaubter Mietpreis-Bereich (Fr/Monat)
 * - waterFlat: Wasser-Grundverbrauch in m³/h (zusätzlich zu pop×0.006)
 * - powerBase: Strom-Grundlast in MW (zusätzlich zu pop×0.002)
 */
const MANSION_STATS = [
  // ── Row 0: Standard (5k – 15k) ──────────────────────────────
  [
    { maxTenants: 1, minRent: 50,  maxRent: 150,  waterFlat: 0.10, powerBase: 1 }, // Villa Bleu       5k
    { maxTenants: 1, minRent: 50,  maxRent: 175,  waterFlat: 0.12, powerBase: 1 }, // Stadtpalais      7.5k
    { maxTenants: 1, minRent: 60,  maxRent: 200,  waterFlat: 0.14, powerBase: 1 }, // Pool-Residenz    10k
    { maxTenants: 1, minRent: 60,  maxRent: 220,  waterFlat: 0.16, powerBase: 1 }, // Sommerhaus       12k
    { maxTenants: 1, minRent: 75,  maxRent: 250,  waterFlat: 0.18, powerBase: 1 }, // Gartenpalais     15k
  ],
  // ── Row 1: Mittelklasse (25k – 48k) ─────────────────────────
  [
    { maxTenants: 2, minRent: 100, maxRent: 300,  waterFlat: 0.20, powerBase: 2 }, // Luxusvilla       25k
    { maxTenants: 2, minRent: 120, maxRent: 350,  waterFlat: 0.24, powerBase: 2 }, // Pavillonvilla    32k
    { maxTenants: 2, minRent: 140, maxRent: 400,  waterFlat: 0.28, powerBase: 2 }, // Beachvilla       38k
    { maxTenants: 2, minRent: 150, maxRent: 440,  waterFlat: 0.32, powerBase: 3 }, // Kolonialvilla    42k
    { maxTenants: 2, minRent: 175, maxRent: 480,  waterFlat: 0.36, powerBase: 3 }, // Herrschaftshaus  48k
  ],
  // ── Row 2: Gehoben (65k – 110k) ─────────────────────────────
  [
    { maxTenants: 3, minRent: 200, maxRent: 600,  waterFlat: 0.32, powerBase: 3 }, // Grandvilla       65k
    { maxTenants: 3, minRent: 230, maxRent: 700,  waterFlat: 0.38, powerBase: 4 }, // Parkpalais       78k
    { maxTenants: 3, minRent: 260, maxRent: 800,  waterFlat: 0.44, powerBase: 4 }, // Seevilla         88k
    { maxTenants: 3, minRent: 280, maxRent: 880,  waterFlat: 0.50, powerBase: 5 }, // Schlossreplika   95k
    { maxTenants: 3, minRent: 320, maxRent: 1000, waterFlat: 0.56, powerBase: 5 }, // Fürstenvilla     110k
  ],
  // ── Row 3: Verwaltung (150k – 260k) ─────────────────────────
  [
    { maxTenants: 4, minRent: 400, maxRent: 1200, waterFlat: 0.55, powerBase: 6 }, // Residenz Imperial  150k
    { maxTenants: 4, minRent: 450, maxRent: 1400, waterFlat: 0.65, powerBase: 7 }, // Residenz Baroque   175k
    { maxTenants: 4, minRent: 480, maxRent: 1500, waterFlat: 0.72, powerBase: 7 }, // Residenz Colonial  185k
    { maxTenants: 4, minRent: 550, maxRent: 1800, waterFlat: 0.82, powerBase: 8 }, // Residenz Versailles 220k
    { maxTenants: 4, minRent: 650, maxRent: 2200, waterFlat: 0.95, powerBase: 9 }, // Residenz Royal     260k
  ],
  // ── Row 4: Präsident (300k – 500k) ──────────────────────────
  [
    { maxTenants: 5, minRent: 800,  maxRent: 2500, waterFlat: 0.85, powerBase: 10 }, // Schloss Meinort    300k
    { maxTenants: 5, minRent: 900,  maxRent: 2800, waterFlat: 1.00, powerBase: 12 }, // Schloss Alpenblick 350k
    { maxTenants: 5, minRent: 1000, maxRent: 3200, waterFlat: 1.15, powerBase: 14 }, // Schloss Föhn       400k
    { maxTenants: 5, minRent: 1200, maxRent: 3600, waterFlat: 1.30, powerBase: 16 }, // Schloss Helvetia   450k
    { maxTenants: 5, minRent: 1400, maxRent: 4000, waterFlat: 1.50, powerBase: 18 }, // Schloss Bundesrat  500k
  ],
];

function getMansionStats(variantRow, variantCol) {
  const r = Math.max(0, Math.min(4, Number(variantRow) || 0));
  const c = Math.max(0, Math.min(4, Number(variantCol) || 0));
  return MANSION_STATS[r][c];
}

module.exports = { MANSION_STATS, getMansionStats };
