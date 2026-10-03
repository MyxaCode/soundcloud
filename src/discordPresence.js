const log = require('./log');

let ClientCtor = null;
try {
  ClientCtor = require('@xhayper/discord-rpc').Client;
} catch (e) {
  console.error('[Discord] @xhayper/discord-rpc not installed:', e.message);
}

function trim(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function pad(s) {
  s = String(s || '');
  return s.length < 2 ? s + ' ' : s;
}
function clock(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

class DiscordPresence {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.connected = false;
    this.last = null;
    this.retryTimer = null;

    const id = config.discordClientId;
    if (!ClientCtor) { log.w('[discord] library missing'); return; }
    if (!id || id === '0000000000000000000') { log.w('[discord] no clientId'); return; }
    this.connect();
  }

  connect() {
    try {
      log.w('[discord] connecting clientId=' + this.config.discordClientId);
      this.client = new ClientCtor({ clientId: this.config.discordClientId, transport: { type: 'ipc' } });

      this.client.on('ready', () => {
        this.connected = true;
        log.w('[discord] READY as ' + (this.client.user && this.client.user.username));
        if (this.last) this.update(this.last);
      });
      this.client.on('connected', () => { this.connected = true; log.w('[discord] connected'); });
      this.client.on('disconnected', () => { this.connected = false; log.w('[discord] disconnected'); this.scheduleReconnect(); });

      this.client.login()
        .then(() => log.w('[discord] login resolved'))
        .catch((e) => { log.w('[discord] login error: ' + (e && e.message)); this.scheduleReconnect(); });
    } catch (e) {
      log.w('[discord] connect threw: ' + (e && e.message));
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, 10000);
  }

  clear() {
    try { if (this.client && this.client.user) this.client.user.clearActivity().catch(() => {}); } catch (e) {}
  }

  update(track) {
    this.last = track;

    const c = this.config;
    if (!c.richPresence) { log.w('[discord] update skip: richPresence off'); this.clear(); return; }
    if (!track || !track.title) { log.w('[discord] update skip: no track/title'); this.clear(); return; }

    if (!this.client || !this.client.user) {
      log.w('[discord] update deferred: not connected yet (will replay on ready)');
      return;
    }

    const playing = !!track.playing;
    if (!playing && !c.displayWhenPaused) { this.clear(); return; }

    const artist = track.artist || '';
    const who = artist || 'SoundCloud';
    const dur = Number(track.duration) || (
      track.endTimestamp && track.startTimestamp
        ? Math.round((track.endTimestamp - track.startTimestamp) / 1000)
        : 0
    );
    const len = clock(dur);
    const activity = {
      type: 2,
      name: 'SoundCloud',
      details: pad(trim(track.title, 128)),
      state: playing
        ? pad(trim(who + (len ? ' · ' + len : ''), 128))
        : pad(trim('Paused · ' + who + (len ? ' · ' + len : ''), 128)),
      largeImageKey: track.artwork || 'soundcloud-logo',
      largeImageText: trim(who + ' — ' + (track.title || 'SoundCloud'), 128),
      instance: false
    };

    if (c.displaySmallIcon) {
      activity.smallImageKey = 'soundcloud-logo';
      activity.smallImageText = playing ? 'Playing' : 'Paused';
    }
    if (playing && track.startTimestamp && track.endTimestamp) {
      activity.startTimestamp = track.startTimestamp;
      activity.endTimestamp = track.endTimestamp;
    }
    if (c.displayButtons) {
      var listen = (track.url && /^https:\/\/([a-z0-9-]+\.)*soundcloud\.com\//i.test(track.url))
        ? track.url
        : 'https://soundcloud.com/discover';
      activity.buttons = [{ label: 'Listen on SoundCloud', url: listen }];
    }

    log.w('[discord] setActivity: ' + activity.details + ' / ' + activity.state + ' (playing=' + playing + ')');
    try {
      const r = this.client.user.setActivity(activity);
      if (r && r.then) r.then(() => log.w('[discord] setActivity ok')).catch((e) => log.w('[discord] setActivity err: ' + (e && e.message)));
    } catch (e) {
      log.w('[discord] setActivity threw: ' + (e && e.message));
    }
  }

  destroy() {
    try { if (this.client) { this.clear(); this.client.destroy(); } } catch (e) {}
  }
}

module.exports = DiscordPresence;
