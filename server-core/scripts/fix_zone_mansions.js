'use strict';

/**
 * Einmalige Migration: Zone-entwickelte Mansions zurücksetzen.
 * Nur action_type='zone' Tiles mit buildingType='mansion' werden angefasst.
 * User-platzierte Mansions (action_type='place') bleiben unberührt.
 *
 * Ausführen mit: node scripts/fix_zone_mansions.js
 */

const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '0815',
  database: process.env.DB_NAME || 'buenzlifight',
};

async function main() {
  const db = await mysql.createConnection(DB_CONFIG);
  console.log('Verbunden mit Datenbank:', DB_CONFIG.database);

  // Zählen vor dem Fix
  const [before] = await db.query(
    `SELECT COUNT(*) AS cnt FROM game_items
     WHERE action_type = 'zone'
     AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.buildingType')) = 'mansion'`
  );
  const [userBefore] = await db.query(
    `SELECT COUNT(*) AS cnt FROM game_items WHERE action_type = 'place' AND tool = 'mansion'`
  );
  console.log('Zone-Mansions (werden gefixt):', before[0].cnt);
  console.log('User-Mansions (werden NICHT angefasst):', userBefore[0].cnt);

  if (before[0].cnt === 0) {
    console.log('Nichts zu tun.');
    await db.end();
    return;
  }

  // Alle zone-entwickelten Mansion Origin-Tiles laden
  const [mansions] = await db.query(
    `SELECT id, municipality_id, room_code, x, y, metadata
     FROM game_items
     WHERE action_type = 'zone'
     AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.buildingType')) = 'mansion'`
  );

  let fixed = 0;
  let companionsFixed = 0;

  for (const m of mansions) {
    const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : (m.metadata || {});
    const ox = Number(m.x);
    const oy = Number(m.y);

    // Origin-Tile → house_medium Level 2
    const newMeta = {
      ...meta,
      buildingType: 'house_medium',
      level: 2,
      constructionProgress: 100,
      constructed: true,
      serverLevelAuthoritative: true,
      abandoned: false,
    };
    delete newMeta.footprintWidth;
    delete newMeta.footprintHeight;
    delete newMeta.population;

    await db.query(
      `UPDATE game_items SET metadata = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(newMeta), m.id]
    );
    fixed++;
    console.log(`  Mansion (${ox},${oy}) in ${m.room_code} → house_medium L2`);

    // Begleittiles des 2×2 Footprints → house_small Level 1
    const companions = [
      { x: ox + 1, y: oy },
      { x: ox,     y: oy + 1 },
      { x: ox + 1, y: oy + 1 },
    ];
    const companionMeta = JSON.stringify({
      buildingType: 'house_small',
      level: 1,
      constructionProgress: 100,
      constructed: true,
      abandoned: false,
    });
    for (const c of companions) {
      const [r] = await db.query(
        `UPDATE game_items SET metadata = ?, updated_at = NOW()
         WHERE municipality_id = ? AND room_code = ? AND x = ? AND y = ? AND action_type = 'zone'`,
        [companionMeta, m.municipality_id, m.room_code, c.x, c.y]
      );
      if (r.affectedRows > 0) companionsFixed++;
    }
  }

  // Nachkontrolle
  const [after] = await db.query(
    `SELECT COUNT(*) AS cnt FROM game_items
     WHERE action_type = 'zone'
     AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.buildingType')) = 'mansion'`
  );
  const [userAfter] = await db.query(
    `SELECT COUNT(*) AS cnt FROM game_items WHERE action_type = 'place' AND tool = 'mansion'`
  );

  console.log('');
  console.log('=== Ergebnis ===');
  console.log('Gefixte Mansions:', fixed);
  console.log('Gefixte Begleittiles:', companionsFixed);
  console.log('Verbleibende zone-Mansions:', after[0].cnt, '(sollte 0 sein)');
  console.log('User-Mansions:', userAfter[0].cnt, '(unverändert)');

  await db.end();
}

main().catch(err => {
  console.error('Fehler:', err.message);
  process.exit(1);
});
