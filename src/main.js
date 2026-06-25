const { app, BrowserWindow, session, shell, ipcMain, nativeImage, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const DiscordPresence = require('./discordPresence');
const log = require('./log');

const isDev = !app.isPackaged;

// ---------------------------------------------------------------- config ----
const DEFAULT_CONFIG = {
  // public SoundCloud Discord app (has the soundcloud-logo asset) - works out of the box
  discordClientId: '1090770350251458592',
  signature: 'Made by ServerSide',

  // Discord Rich Presence
  richPresence: true,
  displayWhenPaused: true,
  displaySmallIcon: true,
  displayButtons: true,

  // Client
  adBlock: true,
  minimizeToTray: false,

  // Equalizer
  eqEnabled: false,
  eqPreset: 'Flat',
  eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  volumeBoost: 0,
  bassBoost: 0,
  accent: '#ff5500',
  rainbowBar: false,
  viz: true,
  customCss: ''
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
    // migrate the stale placeholder clientId saved by older builds
    if (!merged.discordClientId || merged.discordClientId === '0000000000000000000') {
      merged.discordClientId = DEFAULT_CONFIG.discordClientId;
      try { fs.writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8'); } catch (e) {}
    }
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

// ----------------------------------------------------------------- state ----
let config = { ...DEFAULT_CONFIG };
let presence = null;
let mainWindow = null;
let splash = null;
let tray = null;

const SC_URL = 'https://soundcloud.com/discover';
// clean Chrome UA (no Electron token, version matches the bundled Chromium) so
// SoundCloud's bot protection lets the user sign in
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

// --------------------------------------------------------------- helpers ----
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

// ----------------------------------------------- network: CORS + CSP --------
// We control the session, so we force CORS on the audio streams (lets the
// equalizer process the sound instead of being muted) and drop the page CSP
// so our settings UI can be injected into the page's own context.
function setupSession() {
  const ses = session.defaultSession;

  // Present as a normal Chrome browser with consistent client hints so the
  // sign-in flow isn't flagged as a bot.
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

// --------------------------------------------------------------- windows ----
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
      sandbox: false, // allow the preload to require ./ui.js and use Node APIs
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

// --------------------------------------------------- chrome extensions ------
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

// ------------------------------------------------------------------ ipc -----
function registerIpc() {
  ipcMain.on('ss-get-config', (e) => { e.returnValue = config; });

  ipcMain.on('ss-set-config', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return;
    config = { ...config, ...patch };
    saveConfig();

    if (presence) {
      presence.config = config;
      if (!config.richPresence) presence.clear();
      else presence.update(presence.last);
    }
    if ('minimizeToTray' in patch) {
      if (config.minimizeToTray) setupTray();
    }
  });

  ipcMain.on('now-playing', (_e, data) => {
    log.w('[ipc] now-playing: title=' + (data && data.title) + ' playing=' + (data && data.playing) + ' artwork=' + (data && data.artwork ? 'yes' : 'no'));
    if (presence) presence.update(data);
  });
  ipcMain.on('ss-open-external', (_e, url) => { shell.openExternal(url).catch(() => {}); });
  ipcMain.on('ss-log', (_e, msg) => log.w('[ui] ' + msg));
}

// ------------------------------------------------------------------ boot ----
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

app.on('before-quit', () => { app.isQuitting = true; });

app.on('window-all-closed', () => {
  if (presence) presence.destroy();
  if (process.platform !== 'darwin') app.quit();
});
