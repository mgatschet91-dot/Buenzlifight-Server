/**
 * Konvertiert das BünzliFight Logo (logo.png) zu build/icon.ico
 * Benötigt: npm install sharp (wird einmalig ausgeführt)
 */
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..', '..');
const SRC_PNG = path.join(ROOT, 'mapGame', 'public', 'assets', 'logo.png');
const BUILD   = path.join(__dirname, '..', 'build');
const OUT_ICO = path.join(BUILD, 'icon.ico');

if (!fs.existsSync(SRC_PNG)) {
  console.error('[Icon] logo.png nicht gefunden:', SRC_PNG);
  process.exit(1);
}

// sharp installieren falls nicht vorhanden
const sharpPath = path.join(__dirname, '..', 'node_modules', 'sharp');
if (!fs.existsSync(sharpPath)) {
  console.log('[Icon] Installiere sharp...');
  execSync('npm install sharp --save-dev', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
}

const sharp = require('sharp');
const zlib  = require('zlib');

if (!fs.existsSync(BUILD)) fs.mkdirSync(BUILD, { recursive: true });

// ICO-Größen die Windows/Steam braucht
const SIZES = [16, 32, 48, 64, 128, 256];

async function run() {
  console.log('[Icon] Erstelle icon.ico aus logo.png...');

  // Alle Größen als PNG-Buffer rendern
  const pngs = await Promise.all(
    SIZES.map(s =>
      sharp(SRC_PNG)
        .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    )
  );

  // ICO-Format zusammenbauen
  // Header: 6 Bytes
  const header = Buffer.allocUnsafe(6);
  header.writeUInt16LE(0, 0);           // reserved
  header.writeUInt16LE(1, 2);           // type: 1 = ICO
  header.writeUInt16LE(SIZES.length, 4); // count

  // Directory: 16 Bytes pro Eintrag
  const dirSize   = SIZES.length * 16;
  const dataOffset = 6 + dirSize;

  const dirs   = [];
  const chunks = [];
  let offset = dataOffset;

  for (let i = 0; i < SIZES.length; i++) {
    const s   = SIZES[i];
    const png = pngs[i];

    const dir = Buffer.allocUnsafe(16);
    dir[0] = s === 256 ? 0 : s;  // width  (0 = 256)
    dir[1] = s === 256 ? 0 : s;  // height (0 = 256)
    dir[2] = 0;                   // color count
    dir[3] = 0;                   // reserved
    dir.writeUInt16LE(1, 4);      // color planes
    dir.writeUInt16LE(32, 6);     // bits per pixel
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);

    dirs.push(dir);
    chunks.push(png);
    offset += png.length;
  }

  const ico = Buffer.concat([header, ...dirs, ...chunks]);
  fs.writeFileSync(OUT_ICO, ico);

  console.log(`[Icon] build/icon.ico erstellt (${SIZES.join('+')}px) aus logo.png`);
}

run().catch(e => { console.error('[Icon] Fehler:', e.message); process.exit(1); });
