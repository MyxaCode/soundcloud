const { app, BrowserWindow, session, shell, ipcMain, nativeImage, Tray, Menu, dialog, globalShortcut, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const DiscordPresence = require('./discordPresence');
const log = require('./log');

const isDev = !app.isPackaged;

const DEFAULT_CONFIG = {
  discordClientId: '1090770350251458592',
  signature: '',

  richPresence: true,
  displayWhenPaused: true,
  displaySmallIcon: true,
  displayButtons: true,

  adBlock: true,
  minimizeToTray: false,

  eqEnabled: false,
  eqPreset: 'Flat',
  eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  volumeBoost: 0,
  bassBoost: 0,
  accent: '#ff5500',
  rainbowBar: false,
  viz: true,
  customCss: '',
  themeSC: false,
  cursor: 'Default',
  images: [],
  hideFooter: false,
  hideUpsell: false,
  hideSidebar: false,
  clearHeader: true,
  vizOnPage: false,
  vizFloat: true,
  vizX: 80,
  vizY: 66,
  vizW: 380,
  vizH: 120,
  vizRainbow: true,
  vizMirror: false,
  vizCaps: true,
  vizOpacity: 0.85,
  vizStyle: 'bars',
  fx8d: false,
  fxReverb: 0,
  speed: 100,
  notify: false,
  globalHotkeys: true,
  autoAccent: false,
  lyrics: false,
  miniPlayer: false,
  cssThemes: []
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    const p = configPath();
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      return { ...DEFAULT_CONFIG };
    }
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const merged = { ...DEFAULT_CONFIG, ...data };
    let dirty = false;
    if (!merged.discordClientId || merged.discordClientId === '0000000000000000000') {
      merged.discordClientId = DEFAULT_CONFIG.discordClientId;
      dirty = true;
    }
    if (!merged.vizMigrated2) {
      merged.vizFloat = true;
      merged.vizX = 80;
      merged.vizY = 66;
      merged.vizW = 380;
      merged.vizH = 120;
      merged.vizMigrated2 = true;
      dirty = true;
    }
    if (dirty) { try { fs.writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8'); } catch (e) {} }
    return merged;
  } catch (e) {
    console.error('[config] failed, using defaults:', e.message);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('[config] save failed:', e.message);
  }
}

let saveTimer = null;
function scheduleSave() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saveConfig(); }, 500); }
function flushSave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } saveConfig(); }
const DISCORD_KEYS = ['richPresence', 'displayWhenPaused', 'displaySmallIcon', 'displayButtons', 'signature'];

let config = { ...DEFAULT_CONFIG };
let presence = null;
let mainWindow = null;
let splash = null;
let tray = null;
let miniWindow = null;

const SC_URL = 'https://soundcloud.com/discover';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const AD_HOSTS = [
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.google-analytics.com/*',
  '*://*.googletagmanager.com/*',
  '*://*.googletagservices.com/*',
  '*://*.adnxs.com/*',
  '*://*.scorecardresearch.com/*',
  '*://*.moatads.com/*',
  '*://*.amazon-adsystem.com/*',
  '*://*.quantserve.com/*',
  '*://*.adsafeprotected.com/*'
];

function isSoundCloud(url) {
  try {
    const h = new URL(url).hostname;
    return h.endsWith('soundcloud.com') || h.endsWith('sndcdn.com');
  } catch {
    return false;
  }
}

function extensionsDir() {
  return isDev
    ? path.join(__dirname, '..', 'extensions')
    : path.join(process.resourcesPath, 'extensions');
}

function appIcon() {
  const p = path.join(__dirname, '..', 'assets', 'icon.ico');
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : undefined;
}
function appIconPng() {
  const p = path.join(__dirname, '..', 'assets', 'icon.png');
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : undefined;
}

function httpGet(url, asText, cb, depth) {
  if ((depth || 0) > 4) { cb(new Error('too many redirects')); return; }
  try {
    https.get(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); httpGet(res.headers.location, asText, cb, (depth || 0) + 1); return;
      }
      if (res.statusCode !== 200) { res.resume(); cb(new Error('status ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks); cb(null, asText ? b.toString('utf8') : b); });
    }).on('error', (e) => cb(e));
  } catch (e) { cb(e); }
}

function pageControl(action) {
  if (!mainWindow) return;
  const js = "window.__ssControl && window.__ssControl(" + JSON.stringify(String(action)) + ")";
  mainWindow.webContents.executeJavaScript(js).catch(() => {});
}

const MEDIA_KEYS = {
  'MediaPlayPause': 'playpause',
  'MediaNextTrack': 'next',
  'MediaPreviousTrack': 'prev'
};
function registerHotkeys() {
  try { globalShortcut.unregisterAll(); } catch (e) {}
  if (!config.globalHotkeys) return;
  Object.keys(MEDIA_KEYS).forEach((k) => {
    try { globalShortcut.register(k, () => pageControl(MEDIA_KEYS[k])); } catch (e) {}
  });
}

function computeAccent(buf) {
  try {
    let img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    img = img.resize({ width: 36, height: 36, quality: 'good' });
    const bm = img.toBitmap();
    const size = img.getSize();
    let br = 0, bg = 0, bb = 0, bw = 0, fr = 0, fg = 0, fb = 0, fc = 0;
    for (let i = 0; i + 3 < bm.length; i += 4) {
      const b = bm[i], g = bm[i + 1], r = bm[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const l = (mx + mn) / 510;
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const w = sat * sat * (1 - Math.abs(l - 0.5) * 1.2);
      fr += r * w; fg += g * w; fb += b * w; fc += w;
      br += r; bg += g; bb += b; bw++;
    }
    let r, g, b;
    if (fc > 0.5) { r = fr / fc; g = fg / fc; b = fb / fc; }
    else if (bw > 0) { r = br / bw; g = bg / bw; b = bb / bw; }
    else return null;
    const toHex = (n) => ('0' + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2);
    return '#' + toHex(r) + toHex(g) + toHex(b);
  } catch (e) { return null; }
}

let lastNpKey = '';
function pageCall(fnName, arg) {
  if (!mainWindow) return;
  const js = 'window.' + fnName + ' && window.' + fnName + '(' + JSON.stringify(arg) + ')';
  mainWindow.webContents.executeJavaScript(js).catch(() => {});
}
function showTrackNotification(d) {
  const make = (icon) => {
    try {
      const n = new Notification({ title: d.title, body: d.artist ? 'by ' + d.artist : 'SoundCloud', icon: icon || appIconPng(), silent: true });
      n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
      n.show();
    } catch (e) {}
  };
  if (d.artwork) httpGet(d.artwork, false, (err, buf) => make(!err && buf ? nativeImage.createFromBuffer(buf) : null));
  else make(null);
}
function fetchLyrics(d) {
  const q = 'https://lrclib.net/api/get?artist_name=' + encodeURIComponent(d.artist || '') + '&track_name=' + encodeURIComponent(d.title || '');
  httpGet(q, true, (err, txt) => {
    const payload = { synced: null, plain: null, title: d.title || '' };
    if (!err && txt) {
      try { const j = JSON.parse(txt); payload.synced = j.syncedLyrics || null; payload.plain = j.plainLyrics || null; } catch (e) {}
    }
    pageCall('__ssLyrics', payload);
  });
}
function handleNowPlaying(d) {
  if (!d || !d.title) return;
  const key = d.title + '|' + (d.artist || '');
  if (key === lastNpKey) return;
  lastNpKey = key;
  if (config.notify) showTrackNotification(d);
  if (config.autoAccent && d.artwork) {
    httpGet(d.artwork, false, (err, buf) => {
      if (err || !buf) return;
      const hex = computeAccent(buf);
      if (hex) pageCall('__ssSetAccent', hex);
    });
  }
  if (config.lyrics) fetchLyrics(d);
}

function setupSession() {
  const ses = session.defaultSession;

  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const u = details.url;
    if (u.includes('google') || u.includes('gstatic') || u.includes('apple') || u.includes('icloud')) {
      cb({ requestHeaders: details.requestHeaders });
      return;
    }
    cb({
      requestHeaders: {
        ...details.requestHeaders,
        'User-Agent': UA,
        'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
      }
    });
  });

  if (config.adBlock) {
    ses.webRequest.onBeforeRequest({ urls: AD_HOSTS }, (_d, cb) => cb({ cancel: true }));
  }
}

function createSplash() {
  splash = new BrowserWindow({
    width: 330,
    height: 200,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true }
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 600,
    show: false,
    backgroundColor: '#121212',
    icon: appIcon(),
    title: 'SoundCloud',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWindow.webContents.setUserAgent(UA);
  mainWindow.loadURL(SC_URL, { userAgent: UA });

  let shown = false;
  const reveal = () => {
    if (shown) return;
    shown = true;
    if (splash && !splash.isDestroyed()) splash.close();
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  };
  mainWindow.webContents.on('did-finish-load', reveal);
  setTimeout(reveal, 12000);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSoundCloud(url)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isSoundCloud(url)) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  mainWindow.on('close', (e) => {
    if (config.minimizeToTray && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function setupTray() {
  if (tray) return;
  const icon = appIcon();
  if (!icon) return;
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('SoundCloud');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
  });
}

function createMiniWindow() {
  if (miniWindow) { miniWindow.show(); return; }
  let x, y;
  try {
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workArea;
    x = wa.x + wa.width - 360; y = wa.y + wa.height - 128;
  } catch (e) {}
  miniWindow = new BrowserWindow({
    width: 344, height: 102, x: x, y: y,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    transparent: true, backgroundColor: '#00000000', icon: appIcon(),
    maximizable: false, minimizable: false, fullscreenable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  });
  miniWindow.setAlwaysOnTop(true, 'floating');
  miniWindow.loadFile(path.join(__dirname, 'mini.html'));
  miniWindow.webContents.on('did-finish-load', () => {
    if (presence && presence.last) miniWindow.webContents.send('mini-np', presence.last);
  });
  miniWindow.on('closed', () => {
    miniWindow = null;
    if (config.miniPlayer) { config.miniPlayer = false; scheduleSave(); }
  });
}
function closeMiniWindow() { if (miniWindow) { miniWindow.destroy(); miniWindow = null; } }

async function loadExtensions() {
  const dir = extensionsDir();
  try {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const extPath = path.join(dir, e.name);
      if (!fs.existsSync(path.join(extPath, 'manifest.json'))) continue;
      try {
        const ext = await session.defaultSession.loadExtension(extPath, { allowFileAccess: true });
        console.log('[ext] loaded:', ext.name, ext.version);
      } catch (err) {
        console.error('[ext] failed', e.name, '-', err.message);
      }
    }
  } catch (e) {
    console.error('[ext] dir error:', e.message);
  }
}

function registerIpc() {
  ipcMain.on('ss-get-config', (e) => { e.returnValue = config; });

  ipcMain.on('ss-set-config', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return;
    config = { ...config, ...patch };
    scheduleSave();

    if (presence) {
      presence.config = config;
      if (Object.keys(patch).some((k) => DISCORD_KEYS.indexOf(k) !== -1)) {
        if (!config.richPresence) presence.clear();
        else presence.update(presence.last);
      }
    }
    if ('minimizeToTray' in patch && config.minimizeToTray) setupTray();
    if ('globalHotkeys' in patch) registerHotkeys();
    if ('miniPlayer' in patch) { config.miniPlayer ? createMiniWindow() : closeMiniWindow(); }
    if ('lyrics' in patch && config.lyrics) { lastNpKey = ''; if (presence && presence.last) handleNowPlaying(presence.last); }
    if ('autoAccent' in patch && config.autoAccent) { lastNpKey = ''; if (presence && presence.last) handleNowPlaying(presence.last); }
  });

  ipcMain.on('now-playing', (_e, data) => {
    log.w('[ipc] now-playing: title=' + (data && data.title) + ' playing=' + (data && data.playing) + ' artwork=' + (data && data.artwork ? 'yes' : 'no'));
    if (presence) presence.update(data);
    handleNowPlaying(data);
    if (miniWindow) miniWindow.webContents.send('mini-np', data);
  });
  ipcMain.on('ss-open-external', (_e, url) => { shell.openExternal(url).catch(() => {}); });
  ipcMain.on('ss-control', (_e, action) => pageControl(action));
  ipcMain.on('mini-close', () => { config.miniPlayer = false; scheduleSave(); closeMiniWindow(); });
  ipcMain.on('ss-log', (_e, msg) => log.w('[ui] ' + msg));

  ipcMain.handle('ss-pick-image', async () => {
    try {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: 'Pick an image',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
      const p = r.filePaths[0];
      const ext = path.extname(p).slice(1).toLowerCase();
      const mime = ext === 'jpg' ? 'jpeg' : (ext || 'png');
      const buf = fs.readFileSync(p);
      if (buf.length > 12 * 1024 * 1024) return 'TOO_BIG';
      return 'data:image/' + mime + ';base64,' + buf.toString('base64');
    } catch (e) { return null; }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    config = loadConfig();
    try { log.setPath(path.join(app.getPath('userData'), 'debug.log')); } catch (e) {}
    log.w('app ready; clientId=' + config.discordClientId + ' richPresence=' + config.richPresence);
    presence = new DiscordPresence(config);

    setupSession();
    registerIpc();
    await loadExtensions();
    if (config.minimizeToTray) setupTray();
    registerHotkeys();
    if (config.miniPlayer) createMiniWindow();

    createSplash();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

app.on('before-quit', () => { app.isQuitting = true; flushSave(); });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });

app.on('window-all-closed', () => {
  flushSave();
  if (presence) presence.destroy();
  if (process.platform !== 'darwin') app.quit();
});
