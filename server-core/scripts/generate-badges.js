'use strict';

/**
 * Badge-Generator via OpenAI DALL-E 3
 * Usage: node scripts/generate-badges.js --examples a.png,b.png,c.png [--only ACH_Streak7,LVL_5]
 *
 * Setzt voraus: OPENAI_API_KEY als Env-Variable
 * npm install openai (falls noch nicht vorhanden)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUTPUT_DIR = path.join(__dirname, '../public/badges');

// ── Alle Badge-Codes mit Beschreibung ───────────────────────────────────────
const BADGES = [
  // Login-Streaks
  { code: 'ACH_Streak7',        desc: 'calendar with fire streak, 7 days' },
  { code: 'ACH_Streak14',       desc: 'calendar with fire streak, 14 days' },
  { code: 'ACH_Streak30',       desc: 'calendar with fire streak, 30 days' },
  { code: 'ACH_Streak60',       desc: 'calendar with fire streak, 60 days' },
  { code: 'ACH_Streak100',      desc: 'calendar with fire streak, 100 days' },
  { code: 'ACH_Streak365',      desc: 'golden calendar with fire streak, 365 days' },
  // Level
  { code: 'LVL_5',              desc: 'shield with number 5, level badge' },
  { code: 'LVL_10',             desc: 'shield with number 10, level badge' },
  { code: 'LVL_15',             desc: 'silver shield with number 15, level badge' },
  { code: 'LVL_20',             desc: 'gold shield with number 20, level badge' },
  { code: 'LVL_25',             desc: 'diamond shield with number 25, max level badge' },
  // Büenzli-Events
  { code: 'ACH_Report1',        desc: 'megaphone, first report badge' },
  { code: 'ACH_Report10',       desc: 'megaphone with 10, 10 reports badge' },
  { code: 'ACH_Report50',       desc: 'golden megaphone with 50, 50 reports badge' },
  { code: 'ACH_Fix1',           desc: 'wrench, first fix badge' },
  { code: 'ACH_Fix25',          desc: 'golden wrench with star, 25 fixes badge' },
  { code: 'ACH_Corruption',     desc: 'magnifying glass with warning sign, corruption exposed' },
  { code: 'ACH_FalseAlarm',     desc: 'alarm bell with X, false alarm badge' },
  // Firmen
  { code: 'ACH_Company1',       desc: 'briefcase with star, first company founded' },
  { code: 'ACH_Contract1',      desc: 'document with pen, first contract' },
  { code: 'ACH_Contract25',     desc: 'stack of documents, 25 contracts badge' },
  { code: 'ACH_Contract100',    desc: 'golden stack of documents, 100 contracts badge' },
  { code: 'ACH_Revenue10k',     desc: 'coin bag with 10k, revenue badge' },
  { code: 'ACH_Revenue100k',    desc: 'golden coin bag with 100k, big revenue badge' },
  { code: 'ACH_Reputation50',   desc: 'star with checkmark, reputation 50 badge' },
  { code: 'ACH_MediaExpose',    desc: 'newspaper with magnifying glass, media expose badge' },
  { code: 'ACH_EnergieFirma1',  desc: 'lightning bolt with building, energy company badge' },
  { code: 'ACH_WerkhofFirma1',  desc: 'tools and gear, municipal workshop badge' },
  { code: 'ACH_EnergieContr5',  desc: 'lightning bolt with 5, energy contracts badge' },
  { code: 'ACH_WerkhofContr10', desc: 'tools with 10, workshop contracts badge' },
  // Sonstige
  { code: 'ACH_BuenzliHetzer',  desc: 'angry face with megaphone, trouble maker badge' },
  { code: 'ACH_BuenzliProfi',   desc: 'pro badge with megaphone and star, expert badge' },
];

// ── CLI Args ─────────────────────────────────────────────────────────────────
const EXAMPLES_DIR = path.join(__dirname, 'badge-examples');
const args = process.argv.slice(2);
const examplesArg = args.find(a => a.startsWith('--examples='))?.replace('--examples=', '')
  || (args.indexOf('--examples') !== -1 ? args[args.indexOf('--examples') + 1] : null);
const onlyArg = args.find(a => a.startsWith('--only='))?.replace('--only=', '')
  || (args.indexOf('--only') !== -1 ? args[args.indexOf('--only') + 1] : null);

// Beispiele: aus Argument ODER automatisch aus badge-examples/ Ordner
let exampleFiles;
if (examplesArg) {
  exampleFiles = examplesArg.split(',').map(f => f.trim());
} else if (fs.existsSync(EXAMPLES_DIR)) {
  exampleFiles = fs.readdirSync(EXAMPLES_DIR)
    .filter(f => /\.(png|gif)$/i.test(f))
    .slice(0, 4)
    .map(f => path.join(EXAMPLES_DIR, f));
}

if (!exampleFiles || exampleFiles.length === 0) {
  console.error('Keine Beispiel-Bilder gefunden. Lege PNGs in scripts/badge-examples/ oder nutze --examples a.png,b.png');
  process.exit(1);
}

const onlyCodes = onlyArg ? onlyArg.split(',').map(c => c.trim()) : null;
// Bereits vorhandene Badges überspringen (ausser --force)
const force = args.includes('--force');
const toGenerate = (onlyCodes ? BADGES.filter(b => onlyCodes.includes(b.code)) : BADGES)
  .filter(b => force || !fs.existsSync(path.join(OUTPUT_DIR, `${b.code}.png`)));

// ── OpenAI Client ─────────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Fehler: OPENAI_API_KEY nicht gesetzt');
  process.exit(1);
}

async function analyzeExampleStyle(files) {
  const images = files.map(f => {
    const data = fs.readFileSync(f);
    const ext = path.extname(f).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : 'image/gif';
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${data.toString('base64')}` } };
  });

  const body = JSON.stringify({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        ...images,
        {
          type: 'text',
          text: 'Describe ONLY the visual style of these badge icons in max 10 words. Focus on: art style and color palette only. No content descriptions.',
        },
      ],
    }],
    max_tokens: 60,
  });

  const resp = await openaiPost('/v1/chat/completions', body);
  return resp.choices[0].message.content.trim();
}

async function generateBadge(styleDesc, badge) {
  const prompt = `Single flat icon on solid white background. ${badge.desc}. Clean vector style, bold simple shapes, no gradients, no shadows, no text, no frame, white background only.`;

  const body = JSON.stringify({
    model: 'dall-e-3',
    prompt,
    n: 1,
    size: '1024x1024',
    response_format: 'b64_json',
  });

  const resp = await openaiPost('/v1/images/generations', body);
  return resp.data[0].b64_json;
}

function openaiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error.message));
          else resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function downloadAndResize(b64, outputPath) {
  const sharp = require('sharp');
  const raw = Buffer.from(b64, 'base64');

  // 1024x1024 von DALL-E → raw RGBA
  const { data, info } = await sharp(raw)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height;
  const px = (x, y) => (y * w + x) * 4;

  // Flood-fill von allen 4 Ecken → Hintergrundpixel markieren
  // Farb-Ähnlichkeit zur Eckenfarbe (funktioniert mit weiss, blau, grau, etc.)
  const COLOR_TOLERANCE = 40;
  const cornerColors = [[0,0],[w-1,0],[0,h-1],[w-1,h-1]].map(([cx, cy]) => {
    const p = px(cx, cy);
    return [data[p], data[p+1], data[p+2]];
  });
  const isBgColor = (r, g, b) => cornerColors.some(([cr, cg, cb]) =>
    Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b - cb) < COLOR_TOLERANCE * 3
  );

  const visited = new Uint8Array(w * h);
  const queue = [];
  const corners = [[0,0],[w-1,0],[0,h-1],[w-1,h-1]];
  for (const [cx, cy] of corners) {
    const i = cy * w + cx;
    if (!visited[i]) { visited[i] = 1; queue.push([cx, cy]); }
  }
  while (queue.length) {
    const [x, y] = queue.pop();
    const p = px(x, y);
    const r = data[p], g = data[p+1], b = data[p+2];
    if (!isBgColor(r, g, b)) continue; // Icon-Pixel → stopp
    data[p+3] = 0; // transparent
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nx = x+dx, ny = y+dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (!visited[ni]) { visited[ni] = 1; queue.push([nx, ny]); }
    }
  }

  // 512x512 speichern
  await sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 4 } })
    .resize(512, 512)
    .png()
    .toFile(outputPath);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const missing = BADGES.filter(b => !fs.existsSync(path.join(OUTPUT_DIR, `${b.code}.png`)));
  console.log(`\n📋 Fehlende Badges (${missing.length}/${BADGES.length}):`);
  missing.forEach(b => console.log(`   - ${b.code}`));
  console.log(`\n🎨 Analysiere Stil aus ${exampleFiles.length} Beispiel(en)...`);
  const styleDesc = await analyzeExampleStyle(exampleFiles);
  console.log(`Stil: ${styleDesc}\n`);

  console.log(`🏅 Generiere ${toGenerate.length} Badge(s)...\n`);

  for (const badge of toGenerate) {
    const outPath = path.join(OUTPUT_DIR, `${badge.code}.png`);
    if (fs.existsSync(outPath)) {
      console.log(`⏭  ${badge.code}.png existiert bereits — übersprungen`);
      continue;
    }
    try {
      process.stdout.write(`  ${badge.code} (${badge.desc})... `);
      const b64 = await generateBadge(styleDesc, badge);
      await downloadAndResize(b64, outPath);
      console.log('✅');
      // Rate limit: DALL-E 3 erlaubt ~5 req/min
      await new Promise(r => setTimeout(r, 13000));
    } catch (e) {
      console.log(`❌ Fehler: ${e.message}`);
    }
  }

  console.log('\n✨ Fertig! Badges in:', OUTPUT_DIR);
})();
