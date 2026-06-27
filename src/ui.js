(function () {
  'use strict';
  if (window.__SS_UI__) return;
  window.__SS_UI__ = true;

  var DEBUG = false;

  var Bridge = window.SSBridge || {
    getConfig: function () { return {}; },
    setConfig: function () {},
    nowPlaying: function () {},
    openExternal: function () {},
    log: function () {},
    pickImage: function () { return Promise.resolve(null); }
  };

  var DEFAULTS = {
    signature: 'Made by ServerSide',
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
    images: []
  };

  var config = Object.assign({}, DEFAULTS, Bridge.getConfig() || {});
  if (!Array.isArray(config.eqGains) || config.eqGains.length !== 10) config.eqGains = DEFAULTS.eqGains.slice();
  if (!config.accent) config.accent = '#ff5500';
  if (!Array.isArray(config.images)) config.images = [];

  // update in-memory config immediately, but coalesce the IPC writes so dragging
  // a slider (especially with embedded images) doesn't flood the main process
  var pendingPatch = {}, saveTimer = null;
  function save(patch) {
    Object.assign(config, patch);
    Object.assign(pendingPatch, patch);
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      var p = pendingPatch; pendingPatch = {};
      try { Bridge.setConfig(p); } catch (e) {}
    }, 250);
  }
  function log() {
    if (!DEBUG) return;
    var msg = [].slice.call(arguments).join(' ');
    try { console.log('[__SS]', msg); } catch (e) {}
    try { Bridge.log(msg); } catch (e) {}
  }

  var RAINBOW = 'linear-gradient(90deg,#ff004c,#ff8a00,#ffe000,#19e68c,#00b2ff,#9b59ff,#ff004c)';
  var THEMES = [
    { n: 'Orange', c: '#ff5500' }, { n: 'Sunset', c: '#ff2d55' }, { n: 'Purple', c: '#9b59ff' },
    { n: 'Blue', c: '#3d7bff' }, { n: 'Cyan', c: '#00c2ff' }, { n: 'Green', c: '#1ed760' },
    { n: 'Pink', c: '#ff4fa3' }, { n: 'Gold', c: '#ffb300' }
  ];

  // ================================================================ EQ DSP ===
  var FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
  var LABELS = ['60', '170', '310', '600', '1k', '3k', '6k', '12k', '14k', '16k'];
  var DOT_COLORS = ['#4f8cff', '#9b59ff', '#ff4fa3', '#ff5f5f', '#ff8a3d',
                    '#ffd23d', '#8ed94f', '#3dd1a6', '#34c3ff', '#5b8cff'];
  var PRESETS = {
    'Flat':         [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'Bass Boost':   [7, 6, 4, 2, 0, 0, 0, 0, 0, 0],
    'Extreme Bass': [12, 11, 8, 4, 1, 0, 0, 0, 0, 0],
    'Bass + Treble':[10, 8, 4, 0, -2, 0, 3, 6, 8, 9],
    'Vocal':        [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
    'Treble':       [0, 0, 0, 0, 0, 2, 4, 5, 6, 6],
    'Loudness':     [7, 5, 1, 0, -1, 0, 2, 5, 6, 6],
    'Electronic':   [6, 5, 1, 0, -2, 1, 1, 3, 5, 6],
    'Rock':         [5, 4, 2, 0, -1, -1, 1, 3, 4, 5],
    'Pop':          [-1, 1, 3, 4, 3, 1, 0, -1, -1, -1]
  };

  function dbToGain(db) { return Math.pow(10, (db || 0) / 20); }

  // SoundCloud plays through its OWN Web Audio graph, so we hook
  // AudioContext.createMediaElementSource and splice our chain into its graph.
  var eqChains = [];
  function buildChain(ctx) {
    var input = ctx.createGain();
    var filters = FREQS.map(function (f, i) {
      var flt = ctx.createBiquadFilter();
      flt.type = i === 0 ? 'lowshelf' : (i === FREQS.length - 1 ? 'highshelf' : 'peaking');
      flt.frequency.value = f; flt.Q.value = 1.0;
      flt.gain.value = config.eqEnabled ? (config.eqGains[i] || 0) : 0;
      return flt;
    });
    var bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf'; bass.frequency.value = 110; bass.gain.value = config.bassBoost || 0;
    var boost = ctx.createGain(); boost.gain.value = dbToGain(config.volumeBoost || 0);
    var limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -0.5; limiter.knee.value = 0; limiter.ratio.value = 12; limiter.attack.value = 0.001; limiter.release.value = 0.1;
    var node = input;
    filters.forEach(function (flt) { node.connect(flt); node = flt; });
    node.connect(bass); bass.connect(boost); boost.connect(limiter);
    var analyser = null;
    try { analyser = ctx.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.78; limiter.connect(analyser); } catch (e) {}
    var chain = { input: input, output: limiter, filters: filters, bass: bass, boost: boost, analyser: analyser };
    eqChains.push(chain);
    return chain;
  }
  function hookContext(proto) {
    if (!proto || proto.__ssHooked || !proto.createMediaElementSource) return;
    proto.__ssHooked = true;
    var orig = proto.createMediaElementSource;
    proto.createMediaElementSource = function (el) {
      var source = orig.call(this, el);
      try {
        var chain = buildChain(this);
        var nConnect = AudioNode.prototype.connect;
        var nDisconnect = AudioNode.prototype.disconnect;
        nConnect.call(source, chain.input);
        source.connect = function () { return nConnect.apply(chain.output, arguments); };
        source.disconnect = function () { try { return nDisconnect.apply(chain.output, arguments); } catch (e) { return nDisconnect.apply(source, arguments); } };
        log('hooked SC source; chains=' + eqChains.length);
      } catch (e) { log('hook err: ' + (e && e.message)); }
      return source;
    };
  }
  function installHook() {
    try { if (window.AudioContext) hookContext(window.AudioContext.prototype); } catch (e) {}
    try { if (window.webkitAudioContext && window.webkitAudioContext !== window.AudioContext) hookContext(window.webkitAudioContext.prototype); } catch (e) {}
  }
  installHook();

  function applyEq() {
    for (var c = 0; c < eqChains.length; c++) {
      var f = eqChains[c].filters;
      for (var i = 0; i < f.length; i++) f[i].gain.value = config.eqEnabled ? (config.eqGains[i] || 0) : 0;
    }
  }
  function applyBoost() { for (var c = 0; c < eqChains.length; c++) eqChains[c].boost.gain.value = dbToGain(config.volumeBoost || 0); }
  function applyBass() { for (var c = 0; c < eqChains.length; c++) if (eqChains[c].bass) eqChains[c].bass.gain.value = config.bassBoost || 0; }

  // =================================================================== CSS ===
  var CSS = [
    '::-webkit-scrollbar{width:9px;height:9px}',
    '::-webkit-scrollbar-track{background:transparent}',
    '::-webkit-scrollbar-thumb{background:#28282b;border-radius:6px}',
    '::-webkit-scrollbar-thumb:hover{background:#37373b}',
    '#ss-panel{--ss-accent:#ff5500;position:fixed;top:0;right:0;height:100%;width:384px;z-index:2147483646;box-sizing:border-box;',
    'background:#0f0f10;border-left:1px solid #1e1e21;color:#ededed;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;',
    'overflow-y:auto;overflow-x:hidden;transform:translateX(101%);transition:transform .28s cubic-bezier(.16,1,.3,1);padding-bottom:34px}',
    '#ss-panel.open{transform:none}',
    '#ss-panel *{box-sizing:border-box}',
    '#ss-panel ::selection{background:var(--ss-accent);color:#fff}',
    '@keyframes ssRB{0%{background-position:0 0}100%{background-position:300% 0}}',
    '@keyframes ssFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-16px)}}',
    '@keyframes ssSway{0%,100%{transform:rotate(-3.5deg)}50%{transform:rotate(3.5deg)}}',
    '@keyframes ssPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}',
    '@keyframes ssDrift{0%,100%{transform:translate(0,0)}25%{transform:translate(9px,-11px)}50%{transform:translate(-7px,-17px)}75%{transform:translate(-10px,-7px)}}',
    '#ss-panel .ss-top{display:flex;align-items:center;gap:11px;padding:17px 20px;border-bottom:1px solid #1b1b1e;position:sticky;top:0;background:rgba(15,15,16,.86);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);z-index:5}',
    '#ss-panel .ss-logo{width:30px;height:30px;flex:0 0 auto;display:block}',
    '#ss-panel .ss-ttl{flex:1;line-height:1.15;min-width:0}',
    '#ss-panel .ss-ttl b{display:block;font-size:14px;font-weight:700;color:#fff;letter-spacing:.2px}',
    '#ss-panel .ss-ttl i{display:block;font-style:normal;font-size:9.5px;font-weight:600;color:var(--ss-accent);letter-spacing:1.8px;text-transform:uppercase;margin-top:2px}',
    '#ss-panel .ss-x{cursor:pointer;color:#76767b;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:14px;transition:.15s;flex:0 0 auto}',
    '#ss-panel .ss-x:hover{background:#1d1d20;color:#fff}',
    '#ss-panel .ss-sec{padding:16px 20px}',
    '#ss-panel .ss-sec + .ss-sec{border-top:1px solid #19191c}',
    '#ss-panel .ss-h{font-size:10.5px;font-weight:700;color:#6c6c71;margin:0 0 13px;letter-spacing:1.5px;text-transform:uppercase}',
    '#ss-panel .ss-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:8px 0}',
    '#ss-panel .ss-row .ss-l{font-size:13.5px;color:#e6e6e8;font-weight:500}',
    '#ss-panel .ss-row .ss-d{font-size:11.5px;color:#74747a;margin-top:3px;line-height:1.4}',
    '#ss-panel .sw{position:relative;width:40px;height:22px;flex:0 0 auto}',
    '#ss-panel .sw input{opacity:0;width:0;height:0;position:absolute}',
    '#ss-panel .sw label{position:absolute;inset:0;background:#2b2b2f;border-radius:99px;cursor:pointer;transition:.2s}',
    '#ss-panel .sw label:before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s cubic-bezier(.16,1,.3,1);box-shadow:0 1px 3px rgba(0,0,0,.35)}',
    '#ss-panel .sw input:checked + label{background:var(--ss-accent)}',
    '#ss-panel .sw input:checked + label:before{transform:translateX(18px)}',
    '#ss-panel select{background:#19191c;color:#e6e6e8;border:1px solid #29292e;border-radius:9px;padding:8px 11px;font-size:12.5px;font-weight:500;outline:none;cursor:pointer;transition:.15s}',
    '#ss-panel select:hover{border-color:#3a3a42}',
    '#ss-panel input[type=range]{-webkit-appearance:none;appearance:none;height:4px;background:#27272b;border-radius:4px;outline:none;cursor:pointer}',
    '#ss-panel input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:var(--ss-accent);cursor:pointer;box-shadow:0 1px 5px rgba(0,0,0,.5);transition:transform .12s}',
    '#ss-panel input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.18)}',
    // theme swatches
    '#ss-themes{display:flex;flex-wrap:wrap;gap:9px;margin:2px 0 4px}',
    '#ss-themes .sw-c{width:26px;height:26px;border-radius:8px;cursor:pointer;position:relative;transition:transform .12s;border:2px solid transparent}',
    '#ss-themes .sw-c:hover{transform:scale(1.12)}',
    '#ss-themes .sw-c.on{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.15)}',
    '#ss-themes .sw-c.rb{background:' + RAINBOW + ';background-size:300% 100%;animation:ssRB 4s linear infinite}',
    '#ss-themes .sw-pick{width:26px;height:26px;border-radius:8px;overflow:hidden;border:2px solid #29292e;cursor:pointer;padding:0;background:#19191c}',
    '#ss-themes .sw-pick input{width:200%;height:200%;border:none;background:none;cursor:pointer;transform:translate(-25%,-25%)}',
    // equalizer + visualizer
    '#ss-eq-canvas{width:100%;height:152px;display:block;background:#0a0a0b;border:1px solid #1b1b1e;border-radius:12px;margin:7px 0 4px;cursor:ns-resize;touch-action:none}',
    '#ss-eq-hint{font-size:11px;color:#5c5c61;text-align:center;margin-top:8px}',
    '#ss-viz{width:100%;height:64px;display:block;background:#0a0a0b;border:1px solid #1b1b1e;border-radius:12px}',
    // bass + boost rows
    '#ss-bass-row,#ss-boost-row{display:flex;align-items:center;gap:13px;margin-top:14px}',
    '#ss-bass-row .ss-bass-lbl{font-size:13px;color:#e6e6e8;font-weight:500;flex:0 0 auto;white-space:nowrap}',
    '#ss-bass-row input,#ss-boost-row input{flex:1}',
    '#ss-bass-row .ss-bass-val,#ss-boost-val{font-size:12px;color:var(--ss-accent);min-width:52px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}',
    // custom css textarea
    '#ss-css{width:100%;height:90px;resize:vertical;background:#0a0a0b;color:#d6d6d8;border:1px solid #29292e;border-radius:10px;padding:10px 11px;font:12px/1.5 ui-monospace,Consolas,monospace;outline:none}',
    '#ss-css:focus{border-color:var(--ss-accent)}',
    '#ss-css-save{margin-top:9px;background:var(--ss-accent);color:#fff;border:none;border-radius:9px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:.15s}',
    '#ss-css-save:hover{filter:brightness(1.1)}',
    // preview card
    '.ss-pv{margin-top:14px;background:#151517;border:1px solid #222226;border-radius:13px;padding:14px}',
    '.ss-pv .hd{font-size:9.5px;font-weight:700;letter-spacing:1.2px;color:#74747a;margin-bottom:11px;text-transform:uppercase}',
    '.ss-pv .bd{display:flex;gap:12px}',
    '.ss-pv .art{width:60px;height:60px;border-radius:9px;background:#252528 center/cover no-repeat;flex:0 0 auto;box-shadow:0 3px 10px rgba(0,0,0,.35)}',
    '.ss-pv .meta{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}',
    '.ss-pv .t{font-size:13.5px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ss-pv .a{font-size:12px;color:#a6a6ac;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}',
    '.ss-pv .bar{height:4px;background:#2a2a2e;border-radius:3px;margin-top:11px;overflow:hidden}',
    '.ss-pv .bar i{display:block;height:100%;width:0;background:var(--ss-accent);border-radius:3px;transition:width .9s linear}',
    '.ss-pv .bar i.rb{background:' + RAINBOW + ';background-size:300% 100%;animation:ssRB 4s linear infinite}',
    '.ss-pv .tm{display:flex;justify-content:space-between;font-size:10px;color:#74747a;margin-top:5px;font-variant-numeric:tabular-nums}',
    '.ss-pv .btn{margin-top:13px;width:100%;text-align:center;background:#212125;color:#ededed;border:none;border-radius:9px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;transition:.15s}',
    '.ss-pv .btn:hover{background:#2a2a2f}',
    '#ss-decor-add{width:100%;background:#19191c;color:#e6e6e8;border:1px solid #2a2a30;border-radius:9px;padding:9px;font-size:12.5px;font-weight:600;cursor:pointer;transition:.15s}',
    '#ss-decor-add:hover{border-color:var(--ss-accent);color:#fff}',
    '#ss-decor-list{margin-top:10px;display:flex;flex-direction:column;gap:10px}',
    '.ss-decor-empty{font-size:11.5px;color:#74747a;text-align:center;padding:6px 0}',
    '.ss-decor-item{display:flex;gap:10px;align-items:flex-start;background:#151517;border:1px solid #222226;border-radius:11px;padding:10px}',
    '.ss-decor-th{width:46px;height:46px;flex:0 0 auto;border-radius:8px;background:#0a0a0b center/contain no-repeat;border:1px solid #26262a}',
    '.ss-decor-ctl{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px}',
    '.ss-decor-line{display:flex;align-items:center;gap:9px}',
    '.ss-decor-line span{font-size:10.5px;color:#85858b;flex:0 0 38px}',
    '.ss-decor-line select,.ss-decor-line input{flex:1;min-width:0}',
    '.ss-decor-line select{font-size:11.5px;padding:5px 8px}',
    '.ss-decor-rm{flex:0 0 auto;color:#75757a;cursor:pointer;font-size:13px;padding:4px 7px;border-radius:7px;transition:.15s}',
    '.ss-decor-rm:hover{background:#2a1620;color:#ff6b6b}',
    '#ss-hint{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2147483646;background:#161618;color:#dcdcdc;border:1px solid #28282c;border-radius:10px;padding:8px 15px;font:12px sans-serif;opacity:0;transition:opacity .3s;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.45)}',
    '#ss-hint.show{opacity:1}'
  ].join('');

  function injectCss() {
    var st = document.createElement('style');
    st.id = 'ss-style'; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // page-level styles injected into SoundCloud (themed progress bar + custom css)
  function hexToHsl(hex) {
    hex = (hex || '#ff5500').replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    var r = parseInt(hex.slice(0,2),16)/255, g = parseInt(hex.slice(2,4),16)/255, b = parseInt(hex.slice(4,6),16)/255;
    var mx = Math.max(r,g,b), mn = Math.min(r,g,b), h = 0, s = 0, l = (mx+mn)/2;
    if (mx !== mn) { var d = mx-mn; s = l > 0.5 ? d/(2-mx-mn) : d/(mx+mn);
      if (mx===r) h=(g-b)/d+(g<b?6:0); else if (mx===g) h=(b-r)/d+2; else h=(r-g)/d+4; h/=6; }
    return { h: h*360, s: s*100, l: l*100 };
  }

  // cursor presets, drawn in the current accent color
  var CURSORS = ['Default', 'Arrow', 'Neon', 'Star', 'Dot'];
  function svgCur(svg, hx, hy) { try { return "url('data:image/svg+xml;base64," + btoa(svg) + "') " + hx + " " + hy; } catch (e) { return ''; } }
  function cursorValue() {
    var a = config.accent || '#9d5cff';
    switch (config.cursor) {
      case 'Arrow': return svgCur('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M4 2 L4 19 L8.5 14.5 L11.5 21 L14.5 19.5 L11.5 13 L18 13 Z" fill="' + a + '" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>', 4, 2);
      case 'Neon': return svgCur('<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="6" fill="none" stroke="' + a + '" stroke-width="2.5"/><circle cx="13" cy="13" r="2.4" fill="' + a + '"/></svg>', 13, 13);
      case 'Star': return svgCur('<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><path d="M13 2 L16 10 L24 10 L17.5 15 L20 23 L13 18 L6 23 L8.5 15 L2 10 L10 10 Z" fill="' + a + '" stroke="#fff" stroke-width="1"/></svg>', 13, 13);
      case 'Dot': return svgCur('<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="6" fill="' + a + '" stroke="#fff" stroke-width="1.5"/></svg>', 9, 9);
      default: return null;
    }
  }

  // recolor the whole SoundCloud page in the accent color
  function scThemeCss() {
    var a = config.accent, hsl = hexToHsl(a), hh = Math.round(hsl.h);
    var rot = Math.round(hsl.h - 16);
    var deep = 'hsl(' + hh + ',32%,7%)', head = 'hsl(' + hh + ',30%,9%)', bar = 'hsl(' + hh + ',34%,10%)', line = 'hsl(' + hh + ',40%,22%)';
    return [
      'html,body,.l-container,#content,.l-content,.stream,.stream__content,.l-listen,.userMain,.l-account,.searchContainer,.l-fixed-content,.userStream{background-color:' + deep + '!important}',
      '.header,.header__middle,.header__right{background:' + head + '!important}.header{border-bottom:1px solid ' + line + '!important}',
      '.playControls,.playControls__inner,.playControls__bg,.playControls__elements{background:' + bar + '!important}',
      '.playControls{border-top:1px solid ' + line + '!important;box-shadow:0 -6px 26px hsla(' + hh + ',60%,40%,.22)!important}',
      '.sc-button-play,.playButton,.sc-button-cta,.waveform__layer,.sc-button-like.sc-button-selected,.sc-button-repost.sc-button-selected,.uploadButton,.upsellBanner,[class*="upsell"] .sc-button,.header a[href*="go"],.header a[href*="pro"]{filter:hue-rotate(' + rot + 'deg) saturate(1.2)!important}',
      '.playbackTimeline__progressBackground{background:' + line + '!important}',
      '.playbackTimeline__progressHandle{background:#fff!important;box-shadow:0 0 9px ' + a + '!important}',
      'a:hover,.soundTitle__title:hover,.playbackSoundBadge__titleLink:hover,.sc-link-light:hover,.sc-link-primary:hover{color:' + a + '!important}',
      '::selection{background:' + a + ';color:#fff}',
      '::-webkit-scrollbar{width:11px;height:11px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:' + a + ';border-radius:8px;border:2px solid ' + deep + '}'
    ].join('');
  }

  var pageStyle = null;
  function applyPageStyles() {
    if (!pageStyle) {
      pageStyle = document.createElement('style'); pageStyle.id = 'ss-page';
      (document.head || document.documentElement).appendChild(pageStyle);
    }
    var css = '@keyframes ssRBpage{0%{background-position:0 0}100%{background-position:300% 0}}';
    if (config.themeSC) css += scThemeCss();
    var cv = cursorValue();
    if (cv) css += '*{cursor:' + cv + ',auto!important}input,textarea,[contenteditable]{cursor:text!important}';
    if (config.customCss) css += '\n' + config.customCss + '\n';
    // the seek bar goes LAST so the rainbow/accent is never covered by pasted CSS
    if (config.rainbowBar) css += '.playbackTimeline__progressBar{background:' + RAINBOW + '!important;background-size:300% 100%!important;animation:ssRBpage 4s linear infinite!important}';
    else css += '.playbackTimeline__progressBar{background:' + config.accent + '!important}';
    pageStyle.textContent = css;
  }

  // ----- on-page image decorations -----
  function cornerCss(pos) {
    var off = 14, pb = 84;
    switch (pos) {
      case 'tl': return 'left:' + off + 'px;top:62px;';
      case 'tr': return 'right:' + off + 'px;top:62px;';
      case 'bl': return 'left:' + off + 'px;bottom:' + pb + 'px;';
      case 'cl': return 'left:' + off + 'px;top:50%;transform:translateY(-50%);';
      case 'cr': return 'right:' + off + 'px;top:50%;transform:translateY(-50%);';
      default:   return 'right:' + off + 'px;bottom:' + pb + 'px;';
    }
  }
  function animFor(a) {
    switch (a) {
      case 'float': return 'ssFloat 4s ease-in-out infinite';
      case 'sway': return 'ssSway 5s ease-in-out infinite';
      case 'pulse': return 'ssPulse 3.2s ease-in-out infinite';
      case 'drift': return 'ssDrift 9s ease-in-out infinite';
      default: return '';
    }
  }
  function renderDecor() {
    var c = document.getElementById('ss-decor');
    if (!c) { c = document.createElement('div'); c.id = 'ss-decor'; c.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:35'; (document.body || document.documentElement).appendChild(c); }
    c.innerHTML = '';
    (config.images || []).forEach(function (im) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;width:' + (im.w || 200) + 'px;pointer-events:none;' + cornerCss(im.pos);
      var img = document.createElement('img');
      img.src = im.src;
      var an = animFor(im.anim);
      img.style.cssText = 'display:block;width:100%;height:auto;opacity:' + (im.opacity != null ? im.opacity : 1) + ';filter:drop-shadow(0 7px 18px rgba(0,0,0,.45));' + (an ? 'animation:' + an + ';' : '');
      wrap.appendChild(img); c.appendChild(wrap);
    });
  }

  // ============================================================== UI build ===
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }
  function sliderFill(input) {
    if (!input) return;
    var mn = parseFloat(input.min) || 0, mx = parseFloat(input.max) || 100;
    var p = ((parseFloat(input.value) - mn) / (mx - mn)) * 100;
    input.style.background = 'linear-gradient(to right,' + config.accent + ' ' + p + '%,#27272b ' + p + '%)';
  }
  function toggleRow(label, desc, key, onChange) {
    var row = el('div', { class: 'ss-row' }), left = el('div');
    left.appendChild(el('div', { class: 'ss-l' }, label));
    if (desc) left.appendChild(el('div', { class: 'ss-d' }, desc));
    var sw = el('div', { class: 'sw' }), id = 'sw-' + key;
    var inp = el('input', { type: 'checkbox', id: id });
    if (config[key]) inp.checked = true;
    var lab = el('label', { for: id });
    inp.addEventListener('change', function () { var p = {}; p[key] = inp.checked; save(p); if (onChange) onChange(inp.checked); });
    sw.appendChild(inp); sw.appendChild(lab);
    row.appendChild(left); row.appendChild(sw); return row;
  }
  function section(title) {
    var s = el('div', { class: 'ss-sec' });
    s.appendChild(el('div', { class: 'ss-h' }, title));
    return s;
  }

  var panel, eqCanvas, presetSel, boostVal, preview, swatchWrap, vizCanvas, decorList;
  var boostInpRef, bassInpRef;

  // ----- image decoration manager -----
  function addImage() {
    Promise.resolve(Bridge.pickImage()).then(function (dataUri) {
      if (!dataUri || dataUri === 'TOO_BIG') return;
      capImage(dataUri, function (finalUri) {
        config.images.push({ src: finalUri, w: 200, pos: 'br', opacity: 1, anim: 'float' });
        save({ images: config.images });
        renderDecor(); buildDecorList();
      });
    });
  }
  function capImage(dataUri, cb) {
    if (dataUri.indexOf('data:image/gif') === 0) { cb(dataUri); return; } // keep GIFs animated
    var img = new Image();
    img.onload = function () {
      var max = 460, w = img.width, h = img.height;
      if (w <= max && h <= max) { cb(dataUri); return; }
      var sc = Math.min(max / w, max / h);
      var cv = document.createElement('canvas'); cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      try { cb(cv.toDataURL('image/png')); } catch (e) { cb(dataUri); }
    };
    img.onerror = function () { cb(dataUri); };
    img.src = dataUri;
  }
  function buildDecorList() {
    if (!decorList) return;
    decorList.innerHTML = '';
    if (!config.images.length) { decorList.appendChild(el('div', { class: 'ss-decor-empty' }, 'No images yet. Add a PNG/GIF to decorate the page.')); return; }
    config.images.forEach(function (im, idx) {
      var row = el('div', { class: 'ss-decor-item' });
      var th = el('div', { class: 'ss-decor-th' }); th.style.backgroundImage = 'url("' + im.src + '")'; row.appendChild(th);
      var ctl = el('div', { class: 'ss-decor-ctl' });
      var pr = el('div', { class: 'ss-decor-line' }); pr.appendChild(el('span', null, 'Spot'));
      var ps = el('select');
      [['br', 'Bottom-right'], ['bl', 'Bottom-left'], ['tr', 'Top-right'], ['tl', 'Top-left'], ['cr', 'Right'], ['cl', 'Left']].forEach(function (o) {
        var op = el('option', { value: o[0] }, o[1]); if (o[0] === im.pos) op.selected = true; ps.appendChild(op);
      });
      ps.addEventListener('change', function () { im.pos = ps.value; save({ images: config.images }); renderDecor(); });
      pr.appendChild(ps); ctl.appendChild(pr);
      var sr = el('div', { class: 'ss-decor-line' }); sr.appendChild(el('span', null, 'Size'));
      var ss = el('input', { type: 'range', min: '60', max: '460', step: '5' }); ss.value = im.w || 200;
      ss.addEventListener('input', function () { im.w = parseInt(ss.value, 10); save({ images: config.images }); renderDecor(); });
      sr.appendChild(ss); ctl.appendChild(sr);
      var orow = el('div', { class: 'ss-decor-line' }); orow.appendChild(el('span', null, 'Fade'));
      var os = el('input', { type: 'range', min: '20', max: '100', step: '5' }); os.value = Math.round((im.opacity != null ? im.opacity : 1) * 100);
      os.addEventListener('input', function () { im.opacity = parseInt(os.value, 10) / 100; save({ images: config.images }); renderDecor(); });
      orow.appendChild(os); ctl.appendChild(orow);
      var mr = el('div', { class: 'ss-decor-line' }); mr.appendChild(el('span', null, 'Motion'));
      var ms = el('select');
      [['none', 'None'], ['float', 'Float'], ['sway', 'Sway'], ['pulse', 'Pulse'], ['drift', 'Drift']].forEach(function (o) {
        var op = el('option', { value: o[0] }, o[1]); if ((im.anim || 'none') === o[0]) op.selected = true; ms.appendChild(op);
      });
      ms.addEventListener('change', function () { im.anim = ms.value; save({ images: config.images }); renderDecor(); });
      mr.appendChild(ms); ctl.appendChild(mr);
      row.appendChild(ctl);
      var rm = el('div', { class: 'ss-decor-rm', title: 'Remove' }, '✕');
      rm.addEventListener('click', function () { config.images.splice(idx, 1); save({ images: config.images }); renderDecor(); buildDecorList(); });
      row.appendChild(rm);
      decorList.appendChild(row);
    });
  }

  function applyAccent() {
    if (panel) panel.style.setProperty('--ss-accent', config.accent);
    if (swatchWrap) {
      Array.prototype.forEach.call(swatchWrap.querySelectorAll('.sw-c'), function (sw) {
        sw.classList.toggle('on', sw.dataset && sw.dataset.c && sw.dataset.c.toLowerCase() === String(config.accent).toLowerCase());
      });
    }
    sliderFill(boostInpRef); sliderFill(bassInpRef);
    drawEq(); applyPageStyles();
  }
  function applyRainbow() {
    if (preview && preview.bar) preview.bar.classList.toggle('rb', !!config.rainbowBar);
    applyPageStyles();
  }

  function buildPanel() {
    injectCss();
    panel = el('div', { id: 'ss-panel' });

    var top = el('div', { class: 'ss-top' });
    top.appendChild(el('div', { class: 'ss-logo' },
      '<svg viewBox="0 0 256 256" width="30" height="30" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="ssLogoGrad" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#ff6a00"/><stop offset="1" stop-color="#ff0a5a"/></linearGradient></defs>' +
      '<rect width="256" height="256" rx="60" fill="url(#ssLogoGrad)"/><g fill="#fff">' +
      '<rect x="40" y="120" width="18" height="64" rx="9"/><rect x="72" y="92" width="18" height="92" rx="9"/>' +
      '<rect x="104" y="58" width="18" height="126" rx="9"/><rect x="136" y="100" width="18" height="84" rx="9"/>' +
      '<rect x="168" y="74" width="18" height="110" rx="9"/><rect x="200" y="116" width="18" height="68" rx="9"/>' +
      '</g></svg>'));
    var ttl = el('div', { class: 'ss-ttl' });
    ttl.appendChild(el('b', null, 'SoundCloud'));
    ttl.appendChild(el('i', null, 'ServerSide'));
    top.appendChild(ttl);
    var x = el('div', { class: 'ss-x' }, '✕'); x.addEventListener('click', closePanel); top.appendChild(x);
    panel.appendChild(top);

    // ---- Discord ----
    var dsc = section('Discord');
    dsc.appendChild(toggleRow('Rich Presence', 'Show your track on your Discord profile', 'richPresence'));
    dsc.appendChild(toggleRow('Show when paused', null, 'displayWhenPaused'));
    dsc.appendChild(toggleRow('Small icon', 'Logo with caption under the artwork', 'displaySmallIcon'));
    dsc.appendChild(toggleRow('Track button', '"Made by ServerSide" button on your profile', 'displayButtons'));
    dsc.appendChild(buildPreview());
    panel.appendChild(dsc);

    // ---- Appearance ----
    var aps = section('Appearance');
    swatchWrap = el('div', { id: 'ss-themes' });
    THEMES.forEach(function (t) {
      var c = el('div', { class: 'sw-c', title: t.n });
      c.dataset.c = t.c; c.style.background = t.c;
      c.addEventListener('click', function () { config.accent = t.c; save({ accent: t.c }); applyAccent(); });
      swatchWrap.appendChild(c);
    });
    // custom color picker
    var pick = el('label', { class: 'sw-pick', title: 'Custom color' });
    var picker = el('input', { type: 'color' });
    try { picker.value = config.accent; } catch (e) { picker.value = '#ff5500'; }
    picker.addEventListener('input', function () { config.accent = picker.value; save({ accent: picker.value }); applyAccent(); });
    pick.appendChild(picker); swatchWrap.appendChild(pick);
    aps.appendChild(swatchWrap);
    aps.appendChild(toggleRow('Theme SoundCloud', 'Recolor the whole page in your accent color', 'themeSC', function () { applyPageStyles(); }));
    aps.appendChild(toggleRow('Rainbow music bar', 'Animated rainbow seek bar (here & in SoundCloud)', 'rainbowBar', function () { applyRainbow(); }));
    var curRow = el('div', { class: 'ss-row' });
    curRow.appendChild(el('div', { class: 'ss-l' }, 'Cursor'));
    var curSel = el('select');
    CURSORS.forEach(function (n) { var o = el('option', { value: n }, n); if (n === config.cursor) o.selected = true; curSel.appendChild(o); });
    curSel.addEventListener('change', function () { config.cursor = curSel.value; save({ cursor: curSel.value }); applyPageStyles(); });
    curRow.appendChild(curSel); aps.appendChild(curRow);
    panel.appendChild(aps);

    // ---- Decorations (images, no CSS needed) ----
    var dec = section('Decorations');
    var addBtn = el('button', { id: 'ss-decor-add' }, '+  Add image');
    addBtn.addEventListener('click', addImage);
    dec.appendChild(addBtn);
    decorList = el('div', { id: 'ss-decor-list' });
    dec.appendChild(decorList);
    panel.appendChild(dec);

    // ---- Equalizer ----
    var eqs = section('Equalizer');
    eqs.appendChild(toggleRow('Enable equalizer', null, 'eqEnabled', function () { applyEq(); drawEq(); }));
    var prow = el('div', { class: 'ss-row' });
    prow.appendChild(el('div', { class: 'ss-l' }, 'Preset'));
    presetSel = el('select');
    Object.keys(PRESETS).concat(['Custom']).forEach(function (n) {
      var o = el('option', { value: n }, n); if (n === config.eqPreset) o.selected = true; presetSel.appendChild(o);
    });
    presetSel.addEventListener('change', function () {
      var n = presetSel.value;
      if (PRESETS[n]) { config.eqGains = PRESETS[n].slice(); save({ eqGains: config.eqGains, eqPreset: n }); applyEq(); drawEq(); }
      else save({ eqPreset: 'Custom' });
    });
    prow.appendChild(presetSel); eqs.appendChild(prow);
    eqCanvas = el('canvas', { id: 'ss-eq-canvas' });
    eqs.appendChild(eqCanvas);
    eqs.appendChild(el('div', { id: 'ss-eq-hint' }, 'Drag the dots to shape the sound'));
    setupEqDrag();
    var bassRow = el('div', { id: 'ss-bass-row' });
    bassRow.appendChild(el('div', { class: 'ss-bass-lbl' }, 'Bass Boost'));
    bassInpRef = el('input', { type: 'range', min: '0', max: '24', step: '1' }); bassInpRef.value = config.bassBoost;
    var bbVal = el('div', { class: 'ss-bass-val' }, '+' + config.bassBoost + ' dB');
    bassInpRef.addEventListener('input', function () {
      config.bassBoost = parseInt(bassInpRef.value, 10);
      bbVal.textContent = '+' + config.bassBoost + ' dB';
      sliderFill(bassInpRef); applyBass(); save({ bassBoost: config.bassBoost });
    });
    bassInpRef.addEventListener('wheel', function (ev) { ev.preventDefault(); }, { passive: false });
    bassRow.appendChild(bassInpRef); bassRow.appendChild(bbVal); eqs.appendChild(bassRow);
    panel.appendChild(eqs);

    // ---- Volume ----
    var vbs = section('Volume Boost');
    var brow = el('div', { id: 'ss-boost-row' });
    boostInpRef = el('input', { type: 'range', min: '0', max: '15', step: '1' }); boostInpRef.value = config.volumeBoost;
    boostVal = el('div', { id: 'ss-boost-val' }, '+' + config.volumeBoost + ' dB');
    boostInpRef.addEventListener('input', function () {
      config.volumeBoost = parseInt(boostInpRef.value, 10);
      boostVal.textContent = '+' + config.volumeBoost + ' dB';
      sliderFill(boostInpRef); applyBoost(); save({ volumeBoost: config.volumeBoost });
    });
    brow.appendChild(boostInpRef); brow.appendChild(boostVal); vbs.appendChild(brow);
    panel.appendChild(vbs);

    // ---- Visualizer ----
    var viz = section('Visualizer');
    viz.appendChild(toggleRow('Live audio visualizer', 'Real-time spectrum of what is playing', 'viz', function () {}));
    vizCanvas = el('canvas', { id: 'ss-viz' });
    viz.appendChild(vizCanvas);
    panel.appendChild(viz);

    // ---- Advanced ----
    var adv = section('Advanced');
    adv.appendChild(toggleRow('Minimize to tray', 'Closing the window hides it to the tray', 'minimizeToTray'));
    adv.appendChild(toggleRow('Ad blocker', 'Applies after restart', 'adBlock'));
    var cssLbl = el('div', { class: 'ss-l', style: 'margin:12px 0 7px' }, 'Custom CSS for SoundCloud');
    adv.appendChild(cssLbl);
    var cssBox = el('textarea', { id: 'ss-css', spellcheck: 'false', placeholder: '/* custom CSS for SoundCloud */' });
    cssBox.value = config.customCss || '';
    adv.appendChild(cssBox);
    var cssSave = el('button', { id: 'ss-css-save' }, 'Apply CSS');
    cssSave.addEventListener('click', function () { config.customCss = cssBox.value; save({ customCss: cssBox.value }); applyPageStyles(); cssSave.textContent = 'Applied ✓'; setTimeout(function () { cssSave.textContent = 'Apply CSS'; }, 1400); });
    adv.appendChild(cssSave);
    panel.appendChild(adv);

    document.body.appendChild(panel);
    applyAccent(); applyRainbow();
    drawEq(); sliderFill(boostInpRef); sliderFill(bassInpRef);
    buildDecorList(); renderDecor();
  }

  function buildPreview() {
    var pv = el('div', { class: 'ss-pv' });
    pv.appendChild(el('div', { class: 'hd' }, 'LISTENING TO SOUNDCLOUD'));
    var bd = el('div', { class: 'bd' }), art = el('div', { class: 'art' }), meta = el('div', { class: 'meta' });
    var t = el('div', { class: 't' }, 'Nothing playing'), a = el('div', { class: 'a' }, '—');
    var bar = el('div', { class: 'bar' }), i = el('i'); bar.appendChild(i);
    var tm = el('div', { class: 'tm' }), t1 = el('span', null, '0:00'), t2 = el('span', null, '0:00');
    tm.appendChild(t1); tm.appendChild(t2);
    meta.appendChild(t); meta.appendChild(a); meta.appendChild(bar); meta.appendChild(tm);
    bd.appendChild(art); bd.appendChild(meta); pv.appendChild(bd);
    var btn = el('button', { class: 'btn' }, 'Made by ServerSide <3');
    btn.addEventListener('click', function () { if (preview.url) Bridge.openExternal(preview.url); });
    pv.appendChild(btn);
    preview = { art: art, t: t, a: a, bar: i, t1: t1, t2: t2, url: null };
    return pv;
  }

  // ====================================================== draggable curve ===
  function geom() {
    var w = eqCanvas.width, h = eqCanvas.height, padX = 26, top = 14, bot = h - 20;
    return { w: w, h: h, padX: padX, top: top, bot: bot, mid: (top + bot) / 2, half: (bot - top) / 2 - 2 };
  }
  function xOf(i, g) { return g.padX + i * (g.w - 2 * g.padX) / (FREQS.length - 1); }
  function yOf(db, g) { return g.mid - (db / 12) * g.half; }
  function dbOf(y, g) { var d = (g.mid - y) / g.half * 12; return Math.max(-12, Math.min(12, Math.round(d))); }

  function drawEq() {
    if (!eqCanvas) return;
    eqCanvas.width = eqCanvas.clientWidth || 330; eqCanvas.height = 150;
    var g = geom(), ctx = eqCanvas.getContext('2d');
    ctx.clearRect(0, 0, g.w, g.h);
    ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
    [12, 6, 0, -6, -12].forEach(function (db) {
      var y = yOf(db, g);
      ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.05)';
      ctx.beginPath(); ctx.moveTo(g.padX, y); ctx.lineTo(g.w - 6, y); ctx.stroke();
      ctx.fillStyle = '#5a5a5a'; ctx.textAlign = 'right';
      if (db === 12 || db === 0 || db === -12) ctx.fillText((db > 0 ? '+' : '') + db, g.padX - 4, y);
    });
    var gains = config.eqEnabled ? config.eqGains : DEFAULTS.eqGains, n = gains.length;
    ctx.beginPath(); ctx.moveTo(xOf(0, g), yOf(gains[0], g));
    for (var i = 1; i < n; i++) {
      var xc = (xOf(i - 1, g) + xOf(i, g)) / 2, yc = (yOf(gains[i - 1], g) + yOf(gains[i], g)) / 2;
      ctx.quadraticCurveTo(xOf(i - 1, g), yOf(gains[i - 1], g), xc, yc);
    }
    ctx.lineTo(xOf(n - 1, g), yOf(gains[n - 1], g));
    ctx.strokeStyle = config.eqEnabled ? config.accent : '#555'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.textAlign = 'center';
    for (var k = 0; k < n; k++) {
      var px = xOf(k, g), py = yOf(gains[k], g);
      ctx.beginPath(); ctx.arc(px, py, k === dragBand ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = config.eqEnabled ? DOT_COLORS[k] : '#5a5a5a'; ctx.fill();
      if (k === dragBand) { ctx.fillStyle = '#fff'; ctx.fillText((gains[k] > 0 ? '+' : '') + gains[k], px, py - 12); }
      ctx.fillStyle = '#6a6a6a'; ctx.fillText(LABELS[k], px, g.h - 8);
    }
  }

  var dragBand = -1;
  function evtToBand(clientX) {
    var r = eqCanvas.getBoundingClientRect(), g = geom();
    var x = (clientX - r.left) * (g.w / r.width);
    var best = 0, bd = 1e9;
    for (var i = 0; i < FREQS.length; i++) { var d = Math.abs(xOf(i, g) - x); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function setBandFromY(band, clientY) {
    var r = eqCanvas.getBoundingClientRect(), g = geom();
    var y = (clientY - r.top) * (g.h / r.height);
    config.eqGains[band] = dbOf(y, g);
    if (!config.eqEnabled) { config.eqEnabled = true; var sw = document.getElementById('sw-eqEnabled'); if (sw) sw.checked = true; }
    config.eqPreset = 'Custom'; if (presetSel) presetSel.value = 'Custom';
    applyEq(); drawEq();
    save({ eqGains: config.eqGains, eqPreset: 'Custom', eqEnabled: config.eqEnabled });
  }
  function setupEqDrag() {
    eqCanvas.addEventListener('mousedown', function (e) { dragBand = evtToBand(e.clientX); setBandFromY(dragBand, e.clientY); e.preventDefault(); });
    document.addEventListener('mousemove', function (e) { if (dragBand >= 0) setBandFromY(dragBand, e.clientY); });
    document.addEventListener('mouseup', function () { if (dragBand >= 0) { dragBand = -1; drawEq(); } });
    eqCanvas.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });
  }

  // ============================================================ visualizer ===
  function resizeViz() { if (vizCanvas) { vizCanvas.width = vizCanvas.clientWidth || 330; vizCanvas.height = 64; } }
  function hexToRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2]; var n = parseInt(h, 16); return [(n>>16)&255,(n>>8)&255,n&255]; }
  // SoundCloud pools many audio sources; find the analyser that actually has sound
  var vizProbe = new Uint8Array(32);
  function activeAnalyser() {
    var best = null, bestE = 0;
    for (var i = eqChains.length - 1; i >= 0 && i >= eqChains.length - 48; i--) {
      var an = eqChains[i].analyser; if (!an) continue;
      an.getByteFrequencyData(vizProbe);
      var e = 0; for (var j = 0; j < vizProbe.length; j++) e += vizProbe[j];
      if (e > bestE) { bestE = e; best = an; }
    }
    return best;
  }
  var vizFrame = 0, vizA = null;
  function vizLoop() {
    requestAnimationFrame(vizLoop);
    if (!vizCanvas || !panelOpen) return;
    var ctx = vizCanvas.getContext('2d');
    var w = vizCanvas.width, h = vizCanvas.height;
    if (!w) { resizeViz(); w = vizCanvas.width; h = vizCanvas.height; }
    ctx.clearRect(0, 0, w, h);
    if (!config.viz) return;
    if ((vizFrame++ % 10) === 0) vizA = activeAnalyser();
    var a = vizA;
    var bars = 56, bw = w / bars, rgb = hexToRgb(config.accent);
    var data = null;
    if (a) { data = new Uint8Array(a.frequencyBinCount); a.getByteFrequencyData(data); }
    for (var i = 0; i < bars; i++) {
      var v = data ? (data[Math.floor(i / bars * data.length * 0.7)] / 255) : (0.04 + 0.02 * Math.sin(i));
      var bh = Math.max(2, v * (h - 6));
      var x = i * bw;
      if (config.rainbowBar) ctx.fillStyle = 'hsl(' + Math.round(i / bars * 320) + ',90%,58%)';
      else ctx.fillStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (0.45 + 0.55 * v) + ')';
      ctx.fillRect(x + 1, h - bh, Math.max(1, bw - 2), bh);
    }
  }

  // =============================================================== hotkeys ===
  var panelOpen = false;
  function openPanel() { if (panel) { panel.classList.add('open'); panelOpen = true; drawEq(); resizeViz(); } }
  function closePanel() { if (panel) { panel.classList.remove('open'); panelOpen = false; } }
  function togglePanel() { panelOpen ? closePanel() : openPanel(); }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'F1') { e.preventDefault(); e.stopPropagation(); togglePanel(); }
    else if (e.key === 'Escape' && panelOpen) closePanel();
  }, true);

  // =========================================================== now playing ===
  function abs(u) { return !u ? null : (u.indexOf('http') === 0 ? u : 'https://soundcloud.com' + u); }
  function hiRes(a) { return a ? a.replace(/-t\d+x\d+\./, '-t500x500.') : null; }
  function mmss(s) { s = Math.max(0, Math.floor(s || 0)); var m = Math.floor(s / 60), r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r; }
  function poll() {
    try {
      if (config.images && config.images.length && !document.getElementById('ss-decor')) renderDecor();
      var titleEl = document.querySelector('.playbackSoundBadge__titleLink');
      if (!titleEl) { updatePreview(null); return; }
      var artistEl = document.querySelector('.playbackSoundBadge__lightLink');
      var title = (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
      var artist = artistEl ? (artistEl.getAttribute('title') || artistEl.textContent || '').trim() : '';
      var artwork = null, span = document.querySelector('.playControls span.sc-artwork') || document.querySelector('.playbackSoundBadge span.sc-artwork');
      if (span) { var m = (span.style.backgroundImage || '').match(/url\(["']?(.*?)["']?\)/); if (m) artwork = hiRes(m[1]); }
      var url = abs(titleEl.getAttribute('href')), now, max;
      var wrap = document.querySelector('.playbackTimeline__progressWrapper');
      if (wrap) { now = parseFloat(wrap.getAttribute('aria-valuenow')); max = parseFloat(wrap.getAttribute('aria-valuemax')); }
      updatePreview({ title: title, artist: artist, artwork: artwork, url: url }, now, max);
    } catch (e) {}
  }
  function updatePreview(data, now, max) {
    if (!preview) return;
    if (!data || !data.title) {
      preview.t.textContent = 'Nothing playing'; preview.a.textContent = '—';
      preview.art.style.backgroundImage = ''; preview.bar.style.width = '0%';
      preview.t1.textContent = '0:00'; preview.t2.textContent = '0:00'; preview.url = null; return;
    }
    preview.t.textContent = data.title;
    preview.a.textContent = data.artist ? 'by ' + data.artist : 'SoundCloud';
    preview.art.style.backgroundImage = data.artwork ? 'url("' + data.artwork + '")' : '';
    preview.url = data.url;
    if (typeof now === 'number' && typeof max === 'number' && max > 0) {
      preview.bar.style.width = Math.min(100, (now / max) * 100) + '%';
      preview.t1.textContent = mmss(now); preview.t2.textContent = mmss(max);
    }
  }

  // ================================================================== boot ===
  function start() {
    if (!document.body) { setTimeout(start, 200); return; }
    buildPanel();
    applyPageStyles();
    setInterval(poll, 1000);
    poll();
    requestAnimationFrame(vizLoop);
    var hint = el('div', { id: 'ss-hint' }, 'Settings, themes & equalizer — press F1');
    document.body.appendChild(hint);
    setTimeout(function () { hint.classList.add('show'); }, 1200);
    setTimeout(function () { hint.classList.remove('show'); }, 6500);
    setTimeout(function () { if (hint.parentNode) hint.parentNode.removeChild(hint); }, 7200);
    window.addEventListener('resize', function () { if (panelOpen) { drawEq(); resizeViz(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
