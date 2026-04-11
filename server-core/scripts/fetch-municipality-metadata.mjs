#!/usr/bin/env node
/**
 * fetch-municipality-metadata.mjs
 *
 * Fetches real-world metadata for all Swiss municipalities from:
 *   1. Wikidata SPARQL  — population, area (km²), elevation (m ü. M.)
 *   2. OpenPLZ API      — postal code, district (Bezirk)
 *
 * Generates a SQL migration that:
 *   - ADDs new columns to `municipalities` (if not exist)
 *   - UPDATEs every municipality row with the fetched data
 *
 * Usage:
 *   node scripts/fetch-municipality-metadata.mjs
 *
 * Output:
 *   sql/054_municipality_metadata.sql
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'sql', '054_municipality_metadata.sql');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Wikidata SPARQL — population, area, elevation per BFS number
// ─────────────────────────────────────────────────────────────────────────────

const SPARQL_QUERY = `
SELECT ?bfsNumber ?municipalityLabel
       (MAX(?pop) AS ?population)
       (MAX(?ar)  AS ?area)
       (MAX(?el)  AS ?elevation)
WHERE {
  ?municipality wdt:P31 wd:Q70208.          # instance of: municipality of Switzerland
  ?municipality wdt:P771 ?bfsNumber.        # Swiss municipality code (BFS)
  OPTIONAL { ?municipality wdt:P1082 ?pop. }
  OPTIONAL { ?municipality wdt:P2046 ?ar.  }
  OPTIONAL { ?municipality wdt:P2044 ?el.  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en". }
}
GROUP BY ?bfsNumber ?municipalityLabel
ORDER BY ?bfsNumber
`;

async function fetchWikidata() {
  const url = 'https://query.wikidata.org/sparql?'
    + new URLSearchParams({ query: SPARQL_QUERY, format: 'json' });

  console.log('[Wikidata] Querying SPARQL endpoint...');
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/sparql-results+json',
      'User-Agent': 'BuenzliFight-MetadataFetcher/1.0 (https://buenzlifight.ch)',
    },
  });
  if (!res.ok) throw new Error(`Wikidata SPARQL error: ${res.status} ${res.statusText}`);

  const json = await res.json();
  const bindings = json.results.bindings;
  console.log(`[Wikidata] Received ${bindings.length} results`);

  // Deduplicate by BFS number (take first / highest values via GROUP BY MAX)
  const map = new Map();
  for (const b of bindings) {
    const bfs = parseInt(b.bfsNumber.value, 10);
    if (map.has(bfs)) continue; // already have this BFS
    map.set(bfs, {
      bfs_number: bfs,
      name_de: b.municipalityLabel?.value || null,
      population: b.population?.value ? Math.round(parseFloat(b.population.value)) : null,
      area_km2: b.area?.value ? parseFloat(parseFloat(b.area.value).toFixed(2)) : null,
      elevation_m: b.elevation?.value ? Math.round(parseFloat(b.elevation.value)) : null,
    });
  }
  console.log(`[Wikidata] ${map.size} unique municipalities after dedup`);
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. OpenPLZ API — postal code + district per BFS number
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOpenPlz() {
  console.log('[OpenPLZ] Fetching communes per canton...');

  // Step 1: Get all cantons
  const cantonsRes = await fetch('https://openplzapi.org/ch/Cantons', {
    headers: { 'accept': 'text/json' },
  });
  if (!cantonsRes.ok) throw new Error(`OpenPLZ cantons error: ${cantonsRes.status}`);
  const cantons = await cantonsRes.json();
  console.log(`[OpenPLZ] ${cantons.length} cantons found`);

  // Step 2: Fetch all communes per canton (no pagination param!)
  const communeMap = new Map(); // BFS -> { district }
  for (const canton of cantons) {
    const url = `https://openplzapi.org/ch/Cantons/${canton.key}/Communes`;
    const res = await fetch(url, { headers: { 'accept': 'text/json' } });
    if (!res.ok) {
      console.warn(`[OpenPLZ] Canton ${canton.shortName} error: ${res.status}`);
      continue;
    }
    const communes = await res.json();
    for (const c of communes) {
      const bfs = parseInt(c.key, 10);
      if (!bfs || communeMap.has(bfs)) continue;
      communeMap.set(bfs, {
        district: c.district?.name || null,
      });
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[OpenPLZ] ${communeMap.size} communes with district info`);

  // Step 3: Fetch PLZ per commune via Localities endpoint
  // Iterate all 4-digit PLZ prefixes (1000-9999) in hundreds
  console.log('[OpenPLZ] Fetching postal codes (PLZ ranges)...');
  const plzMap = new Map(); // BFS -> postal_code
  for (let plzPrefix = 1; plzPrefix <= 9; plzPrefix++) {
    for (let plzHundreds = 0; plzHundreds <= 9; plzHundreds++) {
      const searchPlz = `${plzPrefix}${plzHundreds}`;
      // Paginate to get all results
      let page = 1;
      while (true) {
        const url = `https://openplzapi.org/ch/Localities?postalCode=${searchPlz}&page=${page}&pageSize=50`;
        const res = await fetch(url, { headers: { 'accept': 'text/json' } });
        if (!res.ok) break;
        const locs = await res.json();
        if (!Array.isArray(locs) || locs.length === 0) break;
        for (const loc of locs) {
          const bfs = parseInt(loc.commune?.key, 10);
          if (!bfs || plzMap.has(bfs)) continue;
          plzMap.set(bfs, loc.postalCode);
        }
        if (locs.length < 50) break;
        page++;
      }
    }
    console.log(`[OpenPLZ]   PLZ ${plzPrefix}xxx done, ${plzMap.size} communes mapped`);
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[OpenPLZ] ${plzMap.size} communes with PLZ`);

  // Merge: BFS -> { postal_code, district }
  const merged = new Map();
  const allBfs = new Set([...communeMap.keys(), ...plzMap.keys()]);
  for (const bfs of allBfs) {
    merged.set(bfs, {
      postal_code: plzMap.get(bfs) || null,
      district: communeMap.get(bfs)?.district || null,
    });
  }
  console.log(`[OpenPLZ] ${merged.size} total unique communes`);
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Merge & generate SQL migration
// ─────────────────────────────────────────────────────────────────────────────

function escapeSql(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  return `'${String(val).replace(/'/g, "''")}'`;
}

function generateSql(wikidataMap, plzMap) {
  const lines = [];

  lines.push('-- ============================================================');
  lines.push('-- 054_municipality_metadata.sql');
  lines.push('-- Echte Schweizer Gemeindedaten (Wikidata + OpenPLZ)');
  lines.push(`-- Generiert am: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`-- Wikidata: ${wikidataMap.size} Gemeinden`);
  lines.push(`-- OpenPLZ:  ${plzMap.size} Gemeinden mit PLZ/Bezirk`);
  lines.push('-- ============================================================');
  lines.push('');

  // Add columns (idempotent)
  const columns = [
    { name: 'population', def: 'INT UNSIGNED NULL' },
    { name: 'area_km2', def: 'DECIMAL(10,2) NULL' },
    { name: 'elevation_m', def: 'INT NULL' },
    { name: 'postal_code', def: 'VARCHAR(10) NULL' },
    { name: 'district', def: 'VARCHAR(150) NULL' },
  ];

  for (const col of columns) {
    lines.push(`SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS`);
    lines.push(`  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'municipalities' AND COLUMN_NAME = '${col.name}');`);
    lines.push(`SET @ddl = IF(@col_exists = 0,`);
    lines.push(`  'ALTER TABLE municipalities ADD COLUMN ${col.name} ${col.def}',`);
    lines.push(`  'SELECT 1');`);
    lines.push(`PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;`);
    lines.push('');
  }

  lines.push('-- ── Daten-Updates ──────────────────────────────────────────────');
  lines.push('');

  // Merge all BFS numbers
  const allBfs = new Set([...wikidataMap.keys(), ...plzMap.keys()]);
  const sorted = [...allBfs].sort((a, b) => a - b);

  let updateCount = 0;
  for (const bfs of sorted) {
    const wd = wikidataMap.get(bfs) || {};
    const plz = plzMap.get(bfs) || {};

    const sets = [];
    if (wd.population != null) sets.push(`population = ${wd.population}`);
    if (wd.area_km2 != null) sets.push(`area_km2 = ${wd.area_km2}`);
    if (wd.elevation_m != null) sets.push(`elevation_m = ${wd.elevation_m}`);
    if (plz.postal_code) sets.push(`postal_code = ${escapeSql(plz.postal_code)}`);
    if (plz.district) sets.push(`district = ${escapeSql(plz.district)}`);

    if (sets.length === 0) continue;

    lines.push(`UPDATE municipalities SET ${sets.join(', ')} WHERE bfs_number = ${bfs};`);
    updateCount++;
  }

  lines.push('');
  lines.push(`-- Total: ${updateCount} UPDATE statements`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Municipality Metadata Fetcher ===\n');

  const [wikidataMap, plzMap] = await Promise.all([
    fetchWikidata(),
    fetchOpenPlz(),
  ]);

  console.log('\n[SQL] Generating migration...');
  const sql = generateSql(wikidataMap, plzMap);

  writeFileSync(OUTPUT_PATH, sql, 'utf-8');
  console.log(`[SQL] Written to ${OUTPUT_PATH}`);
  console.log(`[SQL] File size: ${(sql.length / 1024).toFixed(1)} KB`);
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
