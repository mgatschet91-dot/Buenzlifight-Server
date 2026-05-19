const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs');

// ── Datei-basierter Speicher (gamesave.json) ──────────────────────────────────
function getStoreFile() {
  return path.join(app.getPath('userData'), 'gamesave.json');
}
function loadStore() {
  try {
    const file = getStoreFile();
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return {};
}
function saveStore(data) {
  try { fs.writeFileSync(getStoreFile(), JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

ipcMain.handle('store:getAll',       ()           => loadStore());
ipcMain.handle('store:get',          (_, key)     => loadStore()[key] ?? null);
ipcMain.handle('store:set',          (_, key, val) => { const s = loadStore(); s[key] = val; saveStore(s); });
ipcMain.handle('store:remove',       (_, key)     => { const s = loadStore(); delete s[key]; saveStore(s); });
ipcMain.handle('store:bulkSave',     (_, data)    => saveStore(data));
ipcMain.handle('store:getStorePath', ()           => getStoreFile());

const isDev = process.argv.includes('--dev');
const isDebug = process.argv.includes('-console'); // DevTools oeffnen (z.B. Steam Launch-Option: -console)
const PORT = 3001;

// ── Steam Connect-String aus Launch-Args lesen ────────────────────────────────
// Steam übergibt beim Beitreten via Einladung: BuenzliFight.exe +connect +ref/CODE/slug
function getSteamConnectArg() {
  const argv = process.argv;
  // Format 1: +connect +ref/CODE/slug
  const connectIdx = argv.indexOf('+connect');
  if (connectIdx !== -1 && argv[connectIdx + 1]) return argv[connectIdx + 1];
  // Format 2: direkt +ref/CODE/slug als Argument
  const refArg = argv.find(a => a.startsWith('+ref/'));
  if (refArg) return refArg;
  return null;
}

// ── Steam Sprache aus Launch-Args lesen ───────────────────────────────────────
// Steam übergibt: BuenzliFight.exe -language german
const STEAM_LANG_MAP = {
  german: 'de', english: 'en', french: 'fr', italian: 'it',
  spanish: 'es', portuguese: 'pt', russian: 'ru', japanese: 'ja',
  koreana: 'ko', schinese: 'zh', tchinese: 'zh-TW', dutch: 'nl',
  polish: 'pl', turkish: 'tr',
};
function getSteamLanguage() {
  const argv = process.argv;
  const langIdx = argv.findIndex(a => a === '-language' || a === '--language');
  if (langIdx !== -1 && argv[langIdx + 1]) {
    const raw = argv[langIdx + 1].toLowerCase();
    return STEAM_LANG_MAP[raw] || raw;
  }
  return null;
}

let nextServer = null;
let mainWindow = null;
let steamClient = null;

// ── Steam ─────────────────────────────────────────────────────────────────────
function initSteam() {
  try {
    const steamworks = require('steamworks.js');
    steamClient = steamworks.init(4563360);
    console.log('[Steam] OK:', steamClient.localplayer.getName());
    console.log('[Steam] auth-Methoden:', Object.getOwnPropertyNames(Object.getPrototypeOf(steamClient.auth) || {}).join(', ') || Object.keys(steamClient.auth || {}).join(', '));
  } catch (e) {
    console.warn('[Steam] Nicht verfügbar:', e.message);
    steamClient = null;
  }
}

// ── Chromium Hit-Test-Koordinaten nach Resize/Start reparieren ───────────────
// Electron/Windows-Bug: nach setContentSize oder beim ersten Laden stimmen die
// Input-Koordinaten nicht mit dem visuellen Layout überein.
// Fix: 1-px-Jiggle + sendInputEvent zwingt Chromium zur Neuberechnung.
function _fixHitTest(win, delay = 120) {
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    win.setContentSize(w + 1, h);
    win.setContentSize(w, h);
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.webContents.focus();
      try {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.floor(w / 2), y: Math.floor(h / 2) });
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
      } catch {}
    }, 50);
  }, delay);
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    frame: false,
    resizable: false,   // Kein natives Resize — verhindert die toten Ecken durch Windows-Resize-Handles
    backgroundColor: '#050b07',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, (isDev && fs.existsSync(path.join(__dirname, 'preload.src.js'))) ? 'preload.src.js' : 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const connectArg = getSteamConnectArg();
  const langArg = getSteamLanguage();
  const params = new URLSearchParams();
  if (connectArg) params.set('join', connectArg);
  if (langArg) params.set('lang', langArg);
  const query = params.toString();
  const startUrl = `http://127.0.0.1:${PORT}/steam${query ? '?' + query : ''}`;

  if (isDev || isDebug) {
    loadWithRetry(startUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    loadWithRetry(startUrl);
  }

  mainWindow.webContents.on('did-finish-load', () => _fixHitTest(mainWindow, 300));
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function loadWithRetry(url, retries = 120, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      await mainWindow.loadURL(url);
      return;
    } catch {
      if (i === 0) console.log('[Electron] Warte auf Next.js...');
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  mainWindow.loadURL(`data:text/html,<h1 style="font-family:sans-serif;color:white;background:#050b07;margin:0;padding:40px;min-height:100vh">Next.js Server nicht erreichbar.<br><small>Ist npm run dev:electron gestartet?</small></h1>`);
}

// ── Next.js Standalone ────────────────────────────────────────────────────────
function startNextServer() {
  const serverPath = path.join(
    process.resourcesPath,
    'renderer', 'standalone', 'server.js'
  );
  nextServer = fork(serverPath, [], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
    },
    stdio: 'pipe',
  });

  nextServer.stdout?.on('data', d => process.stdout.write('[Next] ' + d));
  nextServer.stderr?.on('data', d => process.stderr.write('[Next] ' + d));
  nextServer.on('error', e => console.error('[Next] Fehler:', e));

  return new Promise(resolve => {
    nextServer.stdout?.on('data', d => {
      if (d.toString().includes('started server')) resolve();
    });
    setTimeout(resolve, 6000); // Fallback nach 6s
  });
}

// ── Single Instance Lock (Steam Einladung wenn Spiel schon läuft) ────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_, argv) => {
    // Spiel läuft bereits — Fenster in Vordergrund + Connect-String verarbeiten
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Connect-String aus den neuen argv-Parametern lesen
    const connectIdx = argv.indexOf('+connect');
    const connectArg = connectIdx !== -1 ? argv[connectIdx + 1]
      : argv.find(a => a.startsWith('+ref/')) || null;
    if (connectArg && mainWindow) {
      const url = `http://127.0.0.1:${PORT}/steam?join=${encodeURIComponent(connectArg)}`;
      mainWindow.webContents.loadURL(url);
    }
  });
}

// ── GPU-Flags für Pixi.js / WebGL ────────────────────────────────────────────
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-webgl2');

// Steam Overlay braucht diese Flags (immer, auch Dev)
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-direct-composition');

// ── App Start ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // CORS-Headers für Requests von Electron an core.buenzlifight.ch ergänzen
  const { session } = require('electron');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith('access-control-')) delete headers[key];
    }
    // Spezifischen Origin setzen (credentials: include verbietet Wildcard *)
    const reqOrigin = (details.requestHeaders?.['Origin'] || details.requestHeaders?.['origin'] || 'http://127.0.0.1:3001');
    headers['access-control-allow-origin'] = [reqOrigin];
    headers['access-control-allow-credentials'] = ['true'];
    headers['access-control-allow-methods'] = ['GET, POST, PUT, PATCH, DELETE, OPTIONS'];
    headers['access-control-allow-headers'] = ['Content-Type, Authorization, X-Game-Token'];
    callback({ responseHeaders: headers });
  });

  initSteam();
  if (!isDev) await startNextServer(); // --debug startet auch den Server (dist-Debug)
  createWindow();
});

app.on('window-all-closed', () => {
  if (nextServer) nextServer.kill();
  app.quit();
});

// ── IPC: Steam ────────────────────────────────────────────────────────────────
ipcMain.handle('steam:user', () => {
  if (!steamClient) return null;
  return {
    name: steamClient.localplayer.getName(),
    steamId: steamClient.localplayer.getSteamId().steamId64.toString(),
  };
});

ipcMain.handle('steam:getTicket', async () => {
  if (!steamClient) return null;
  try {
    const result = await steamClient.auth.getAuthTicketForWebApi('buenzlifight');
    console.log('[Steam] Ticket type:', typeof result, Buffer.isBuffer(result) ? 'Buffer' : '');
    console.log('[Steam] Ticket keys:', result ? Object.getOwnPropertyNames(Object.getPrototypeOf(result)).join(', ') : 'null');

    if (typeof result?.getBytes === 'function') {
      console.log('[Steam] Rufe getBytes() auf...');
      const bytes = await Promise.race([
        result.getBytes(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getBytes Timeout nach 20s')), 20000)),
      ]);
      console.log('[Steam] bytes erhalten, type:', typeof bytes, 'isBuffer:', Buffer.isBuffer(bytes), 'length:', bytes?.length);
      return Buffer.from(bytes).toString('hex').toUpperCase();
    }

    console.error('[Steam] Unbekanntes Ticket-Format:', result);
    return null;
  } catch (e) {
    console.error('[Steam] Ticket Fehler:', e.message);
    return null;
  }
});

ipcMain.handle('steam:language', () => getSteamLanguage());

ipcMain.handle('steam:achievement:unlock', (_, id) => {
  if (!steamClient) return false;
  try { steamClient.achievement.activate(id); return true; } catch { return false; }
});

ipcMain.handle('steam:presence', (_, key, value) => {
  if (!steamClient) return false;
  try { steamClient.friends.setRichPresence(key, value); return true; } catch { return false; }
});

ipcMain.handle('steam:openInviteDialog', (_, connectStr) => {
  if (!steamClient) return false;
  try {
    if (connectStr && typeof steamClient.overlay.activateGameOverlayInviteDialogConnectString === 'function') {
      // Öffnet Steam "Freunde einladen" Dialog mit Connect-String
      // → Freund klickt "Beitreten" → Spiel startet mit dem Connect-String
      steamClient.overlay.activateGameOverlayInviteDialogConnectString(connectStr);
    } else {
      // Fallback: normaler Friends-Tab
      steamClient.overlay.activateGameOverlay('Friends');
    }
    return true;
  } catch (e) {
    console.warn('[Steam] Overlay Fehler:', e.message);
    // Fallback
    try { steamClient.overlay.activateGameOverlay('Friends'); return true; } catch {}
    return false;
  }
});

// ── IPC: Window ───────────────────────────────────────────────────────────────
ipcMain.on('win:minimize', () => mainWindow?.minimize());
ipcMain.on('win:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  _fixHitTest(mainWindow, 200);
});
ipcMain.on('win:close', () => mainWindow?.close());
ipcMain.handle('win:setFullscreen', (_, flag) => { mainWindow?.setFullScreen(flag); });
ipcMain.handle('win:isMaximized', () => mainWindow?.isMaximized() ?? false);
ipcMain.handle('win:isFullscreen', () => mainWindow?.isFullScreen() ?? false);
ipcMain.handle('win:setResolution', (_, width, height) => {
  if (!mainWindow) return;
  mainWindow.setContentSize(width, height);
  mainWindow.center();
  // Zweifach feuern: 150ms (schnell) + 500ms (nach vollständigem Layout-Reflow)
  _fixHitTest(mainWindow, 150);
  _fixHitTest(mainWindow, 500);
});
ipcMain.handle('win:getDisplays', () => {
  const { screen } = require('electron');
  const primary = screen.getPrimaryDisplay();
  return { width: primary.workAreaSize.width, height: primary.workAreaSize.height };
});
