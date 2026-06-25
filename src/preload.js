const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// bridge for the in-page settings UI (config, links, logging)
contextBridge.exposeInMainWorld('SSBridge', {
  getConfig: () => { try { return ipcRenderer.sendSync('ss-get-config'); } catch { return {}; } },
  setConfig: (patch) => ipcRenderer.send('ss-set-config', patch),
  openExternal: (url) => ipcRenderer.send('ss-open-external', url),
  log: (msg) => ipcRenderer.send('ss-log', msg)
});

// inject the settings panel + equalizer into the page's main world
let UI = '';
try {
  UI = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
} catch (e) {
  console.error('[ui] read failed:', e.message);
}
function inject() {
  if (!UI) return;
  try {
    const s = document.createElement('script');
    s.textContent = UI;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch { /* not ready yet */ }
}
inject();
document.addEventListener('DOMContentLoaded', inject);

// -------------------------------------------------------------------------
// Now-playing scraping runs HERE in the preload (isolated world) and goes
// straight to the main process via ipcRenderer - exactly like soundcloud-rpc.
// This is the reliable path that drives the Discord Rich Presence.
// -------------------------------------------------------------------------
function abs(u) { return !u ? null : (u.indexOf('http') === 0 ? u : 'https://soundcloud.com' + u); }
function hiRes(a) { return a ? a.replace(/-t\d+x\d+\./, '-t500x500.') : null; }

let lastKey = '';
let lastNow = null, lastTrackId = null;
function scrape() {
  try {
    const titleEl = document.querySelector('.playbackSoundBadge__titleLink');
    if (!titleEl) return;
    const artistEl = document.querySelector('.playbackSoundBadge__lightLink');
    const title = (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
    const artist = artistEl ? (artistEl.getAttribute('title') || artistEl.textContent || '').trim() : '';
    const url = abs(titleEl.getAttribute('href'));

    let artwork = null;
    const span = document.querySelector('.playControls span.sc-artwork')
      || document.querySelector('.playbackSoundBadge span.sc-artwork');
    if (span) { const m = (span.style.backgroundImage || '').match(/url\(["']?(.*?)["']?\)/); if (m) artwork = hiRes(m[1]); }

    let nowVal = NaN, maxVal = NaN;
    const wrap = document.querySelector('.playbackTimeline__progressWrapper');
    if (wrap) { nowVal = parseFloat(wrap.getAttribute('aria-valuenow')); maxVal = parseFloat(wrap.getAttribute('aria-valuemax')); }

    // playing detection: the moving progress bar is the source of truth (the
    // play-button class lies sometimes). Only fall back to the button when we
    // have no progress delta yet (first poll on a track / after a seek).
    const trackId = url || title;
    const sameTrack = (trackId === lastTrackId);
    let playing;
    if (sameTrack && lastNow != null && !isNaN(nowVal) && nowVal > lastNow + 0.2) playing = true;            // advancing
    else if (sameTrack && lastNow != null && !isNaN(nowVal) && Math.abs(nowVal - lastNow) < 0.05) playing = false; // frozen
    else playing = true;                                                                                     // first poll on a track: assume playing, frozen-check corrects next tick
    if (!isNaN(nowVal)) lastNow = nowVal;
    lastTrackId = trackId;

    let startTimestamp = 0, endTimestamp = 0;
    if (!isNaN(nowVal) && !isNaN(maxVal) && maxVal > 0) {
      startTimestamp = Date.now() - Math.round(nowVal * 1000);
      endTimestamp = startTimestamp + Math.round(maxVal * 1000);
    }

    const data = {
      playing: !!playing,
      title: String(title || ''),
      artist: String(artist || ''),
      artwork: artwork ? String(artwork) : null,
      url: url ? String(url) : null,
      startTimestamp: startTimestamp,
      endTimestamp: endTimestamp
    };

    const key = JSON.stringify([data.playing, data.title, data.artist, data.url]);
    if (key === lastKey) return;
    lastKey = key;
    ipcRenderer.send('now-playing', data);
  } catch (e) { /* transient DOM states */ }
}
setInterval(scrape, 1500);
