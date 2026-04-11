#!/usr/bin/env node
/**
 * generate-municipalities.mjs
 *
 * Fetches the official list of all Swiss municipalities from the
 * cividi/ch-municipalities GitHub repository (based on swissBOUNDARIES3D data
 * from the Swiss Federal Office of Topography).
 *
 * Generates a SQL migration file that inserts all ~2'100+ municipalities
 * into the `municipalities` table with:
 *   - name, slug, canton_code, canton_name, bfs_number
 *
 * Usage:
 *   node scripts/generate-municipalities.mjs
 *
 * Output:
 *   sql/052_all_swiss_municipalities.sql
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'sql', '052_all_swiss_municipalities.sql');

// ── Canton mapping (official 26 cantons) ─────────────────────────────────────
const CANTON_MAP = {
  'ZH': 'Zuerich',
  'BE': 'Bern',
  'LU': 'Luzern',
  'UR': 'Uri',
  'SZ': 'Schwyz',
  'OW': 'Obwalden',
  'NW': 'Nidwalden',
  'GL': 'Glarus',
  'ZG': 'Zug',
  'FR': 'Freiburg',
  'SO': 'Solothurn',
  'BS': 'Basel-Stadt',
  'BL': 'Basel-Landschaft',
  'SH': 'Schaffhausen',
  'AR': 'Appenzell Ausserrhoden',
  'AI': 'Appenzell Innerrhoden',
  'SG': 'St. Gallen',
  'GR': 'Graubuenden',
  'AG': 'Aargau',
  'TG': 'Thurgau',
  'TI': 'Tessin',
  'VD': 'Waadt',
  'VS': 'Wallis',
  'NE': 'Neuenburg',
  'GE': 'Genf',
  'JU': 'Jura',
};

// Canton number (BFS Kantonsnummer) → Canton code
const CANTON_NR_TO_CODE = {
  1: 'ZH', 2: 'BE', 3: 'LU', 4: 'UR', 5: 'SZ', 6: 'OW',
  7: 'NW', 8: 'GL', 9: 'ZG', 10: 'FR', 11: 'SO', 12: 'BS',
  13: 'BL', 14: 'SH', 15: 'AR', 16: 'AI', 17: 'SG', 18: 'GR',
  19: 'AG', 20: 'TG', 21: 'TI', 22: 'VD', 23: 'VS', 24: 'NE',
  25: 'GE', 26: 'JU',
};

// ── Data source URLs (fallback chain) ────────────────────────────────────────
const DATA_SOURCES = [
  // cividi GeoJSON (most reliable, has BFS_NUMMER + canton KUERZEL)
  'https://raw.githubusercontent.com/cividi/ch-municipalities/main/data/gemeinden.geojson',
  // cividi JSON
  'https://raw.githubusercontent.com/cividi/ch-municipalities/main/data/gemeinden.json',
  // BFS official API
  'https://www.agvchapp.bfs.admin.ch/api/communes/search?limit=3000&offset=0&snapshotDate=01.01.2025&communeStatus=1',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert name to URL-safe slug */
function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** Escape single quotes for SQL */
function sqlEscape(str) {
  return str.replace(/'/g, "''");
}

/** Sanitize municipality name (remove parenthetical canton hints, trim) */
function sanitizeName(raw) {
  // Some BFS names have format "Bern (BE)" or "Zürich" — keep clean
  return raw.trim();
}

// ── Fetch with fallback ─────────────────────────────────────────────────────

async function fetchData() {
  for (const url of DATA_SOURCES) {
    try {
      console.log(`  Trying: ${url}`);
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'BuenzliFight-MunicipalityGenerator/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        console.log(`  → HTTP ${resp.status}, trying next...`);
        continue;
      }
      const data = await resp.json();
      console.log(`  → Success!`);
      return { data, sourceUrl: url };
    } catch (err) {
      console.log(`  → Error: ${err.message}, trying next...`);
    }
  }
  throw new Error('All data sources failed. Check your internet connection.');
}

// ── Parse different formats ─────────────────────────────────────────────────

function parseGeoJSON(data) {
  // cividi GeoJSON: features[].properties uses dot notation:
  //   "gemeinde.BFS_NUMMER", "gemeinde.NAME", "kanton.KUERZEL", "kanton.NAME"
  if (!data.features) return null;

  const municipalities = [];
  for (const feat of data.features) {
    const props = feat.properties;
    if (!props) continue;

    // Support both flat and dot-notation keys
    const bfsNumber = Number(
      props['gemeinde.BFS_NUMMER'] || props.BFS_NUMMER || props.bfs_nummer || props.GMDNR || 0
    );
    const name =
      props['gemeinde.NAME'] || props.NAME || props.GMDNAME || props.name || '';
    const cantonCode =
      props['kanton.KUERZEL'] || props.KUERZEL || props.KT || '';

    if (!bfsNumber || !name || !cantonCode) continue;

    municipalities.push({
      name: sanitizeName(name),
      cantonCode: cantonCode.toUpperCase(),
      bfsNumber,
    });
  }
  return municipalities.length > 0 ? municipalities : null;
}

function parseJSON(data) {
  // cividi JSON: array of { BFS_NUMMER, NAME, KUERZEL }
  if (!Array.isArray(data)) return null;

  const municipalities = [];
  for (const row of data) {
    const bfsNumber = Number(row.BFS_NUMMER || row.bfs_nummer || 0);
    const name = row.NAME || row.name || '';
    const cantonCode = row.KUERZEL || row.KT || '';

    if (!bfsNumber || !name || !cantonCode) continue;

    municipalities.push({
      name: sanitizeName(name),
      cantonCode: cantonCode.toUpperCase(),
      bfsNumber,
    });
  }
  return municipalities.length > 0 ? municipalities : null;
}

function parseBFSApi(data) {
  // BFS API: { communes: [{ communeName, communeId, cantonId }] }
  const communes = data.communes || data;
  if (!Array.isArray(communes)) return null;

  const municipalities = [];
  for (const c of communes) {
    const bfsNumber = Number(c.communeId || c.id || 0);
    const name = c.communeName || c.name || '';
    const cantonNr = Number(c.cantonId || c.canton || 0);
    const cantonCode = CANTON_NR_TO_CODE[cantonNr] || '';

    if (!bfsNumber || !name || !cantonCode) continue;

    municipalities.push({
      name: sanitizeName(name),
      cantonCode,
      bfsNumber,
    });
  }
  return municipalities.length > 0 ? municipalities : null;
}

// ── SQL Generation ──────────────────────────────────────────────────────────

function generateSQL(municipalities) {
  // Sort by canton, then by BFS number
  municipalities.sort((a, b) => {
    if (a.cantonCode !== b.cantonCode) return a.cantonCode.localeCompare(b.cantonCode);
    return a.bfsNumber - b.bfsNumber;
  });

  // Deduplicate by BFS number (prefer first entry)
  const seen = new Set();
  const unique = [];
  for (const m of municipalities) {
    if (seen.has(m.bfsNumber)) continue;
    seen.add(m.bfsNumber);
    unique.push(m);
  }

  // Deduplicate by (name, canton_code) — handle edge cases
  const nameCantonSeen = new Set();
  const final = [];
  for (const m of unique) {
    const key = `${m.name.toLowerCase()}::${m.cantonCode}`;
    if (nameCantonSeen.has(key)) {
      // Append BFS number to slug to make it unique
      m.slugSuffix = `-${m.bfsNumber}`;
    }
    nameCantonSeen.add(key);
    final.push(m);
  }

  // Also ensure slug uniqueness
  const slugSeen = new Set();
  for (const m of final) {
    let slug = slugify(m.name) + (m.slugSuffix || '');
    let attempt = 0;
    const baseSlug = slug;
    while (slugSeen.has(slug)) {
      attempt++;
      slug = `${baseSlug}-${m.cantonCode.toLowerCase()}`;
      if (slugSeen.has(slug)) {
        slug = `${baseSlug}-${m.bfsNumber}`;
      }
    }
    slugSeen.add(slug);
    m.slug = slug;
  }

  // Build SQL
  const lines = [
    '-- ============================================================',
    '-- 052_all_swiss_municipalities.sql',
    '-- Alle Schweizer Gemeinden (generiert)',
    `-- Generiert am: ${new Date().toISOString().split('T')[0]}`,
    `-- Anzahl Gemeinden: ${final.length}`,
    `-- Quelle: cividi/ch-municipalities (swissBOUNDARIES3D)`,
    '-- ============================================================',
    '',
    '-- Verwende INSERT ... ON DUPLICATE KEY UPDATE, damit das Script',
    '-- sowohl bei leerer Tabelle als auch bei bestehenden Daten laeuft.',
    '',
  ];

  // Generate in batches of 50 for readability
  const BATCH_SIZE = 50;
  for (let i = 0; i < final.length; i += BATCH_SIZE) {
    const batch = final.slice(i, i + BATCH_SIZE);
    const cantonCode = batch[0].cantonCode;

    if (i === 0 || final[i - 1]?.cantonCode !== cantonCode) {
      const cantonName = CANTON_MAP[cantonCode] || cantonCode;
      lines.push(`-- ── Kanton ${cantonName} (${cantonCode}) ──`);
    }

    lines.push('INSERT INTO municipalities (name, slug, canton_code, canton_name, bfs_number, is_active)');
    lines.push('VALUES');

    const valueLines = batch.map((m, idx) => {
      const cantonName = CANTON_MAP[m.cantonCode] || m.cantonCode;
      const comma = idx < batch.length - 1 ? ',' : '';
      return `  ('${sqlEscape(m.name)}', '${sqlEscape(m.slug)}', '${m.cantonCode}', '${sqlEscape(cantonName)}', ${m.bfsNumber}, 1)${comma}`;
    });
    lines.push(...valueLines);

    lines.push('ON DUPLICATE KEY UPDATE');
    lines.push('  name = VALUES(name),');
    lines.push('  canton_code = VALUES(canton_code),');
    lines.push('  canton_name = VALUES(canton_name),');
    lines.push('  bfs_number = VALUES(bfs_number),');
    lines.push('  is_active = VALUES(is_active),');
    lines.push('  updated_at = CURRENT_TIMESTAMP;');
    lines.push('');
  }

  // Summary comment
  lines.push('-- ── Zusammenfassung ──');
  const cantonCounts = {};
  for (const m of final) {
    cantonCounts[m.cantonCode] = (cantonCounts[m.cantonCode] || 0) + 1;
  }
  for (const [code, count] of Object.entries(cantonCounts).sort()) {
    lines.push(`-- ${code}: ${count} Gemeinden`);
  }
  lines.push(`-- TOTAL: ${final.length} Gemeinden`);

  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Schweizer Gemeinden Generator ===\n');
  console.log('Lade Gemeindedaten...');

  const { data, sourceUrl } = await fetchData();

  console.log('\nParse Daten...');
  let municipalities = parseGeoJSON(data) || parseJSON(data) || parseBFSApi(data);

  if (!municipalities || municipalities.length === 0) {
    console.error('Konnte keine Gemeinden aus den Daten extrahieren!');
    console.error('Daten-Struktur:', JSON.stringify(data).substring(0, 500));
    process.exit(1);
  }

  console.log(`  → ${municipalities.length} Gemeinden gefunden`);

  // Validate
  const missingCanton = municipalities.filter(m => !CANTON_MAP[m.cantonCode]);
  if (missingCanton.length > 0) {
    console.warn(`\n⚠ ${missingCanton.length} Gemeinden mit unbekanntem Kanton:`);
    for (const m of missingCanton.slice(0, 10)) {
      console.warn(`   ${m.name} (${m.cantonCode}, BFS: ${m.bfsNumber})`);
    }
  }

  console.log('\nGeneriere SQL...');
  const sql = generateSQL(municipalities);

  writeFileSync(OUTPUT_PATH, sql, 'utf-8');
  console.log(`\n✅ SQL geschrieben: ${OUTPUT_PATH}`);
  console.log(`   ${municipalities.length} Gemeinden in ${Object.keys(CANTON_MAP).length} Kantonen`);
}

main().catch(err => {
  console.error('Fehler:', err);
  process.exit(1);
});
