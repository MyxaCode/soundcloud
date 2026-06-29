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
    const activity = {
      type: 2,
      name: 'SoundCloud',
      details: pad(trim(track.title, 128)),
      state: playing
        ? pad(trim(artist ? 'by ' + artist : 'SoundCloud', 128))
        : pad(trim('Paused' + (artist ? ' · ' + artist : ''), 128)),
      largeImageKey: track.artwork || 'soundcloud-logo',
      instance: false
    };

    if (c.displaySmallIcon) {
      activity.smallImageKey = 'soundcloud-logo';
      activity.smallImageText = 'SoundCloud';
    }
    if (playing && track.startTimestamp && track.endTimestamp) {
      activity.startTimestamp = track.startTimestamp;
      activity.endTimestamp = track.endTimestamp;
    }
    if (c.displayButtons) {
      activity.buttons = [{ label: 'Listen on SoundCloud', url: 'https://github.com/MyxaCode/soundcloud' }];
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
