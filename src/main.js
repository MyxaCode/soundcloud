const { app, BrowserWindow, session, shell, ipcMain, nativeImage, Tray, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
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
  });

  ipcMain.on('now-playing', (_e, data) => {
    log.w('[ipc] now-playing: title=' + (data && data.title) + ' playing=' + (data && data.playing) + ' artwork=' + (data && data.artwork ? 'yes' : 'no'));
    if (presence) presence.update(data);
  });
  ipcMain.on('ss-open-external', (_e, url) => { shell.openExternal(url).catch(() => {}); });
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

    createSplash();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

app.on('before-quit', () => { app.isQuitting = true; flushSave(); });

app.on('window-all-closed', () => {
  flushSave();
  if (presence) presence.destroy();
  if (process.platform !== 'darwin') app.quit();
});
