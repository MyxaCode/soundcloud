function clean(s) {
  return String(s || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(official\s*(audio|video|music video|lyric video|lyrics)?|lyric video|lyrics|audio only|visualizer|hd|hq|4k)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function queries(artist, title) {
  var out = [];
  function add(a, t) {
    a = clean(a);
    t = clean(t).replace(/\s+[-–—]\s*$/, '').trim();
    if (!t) return;
    var key = (a + '\n' + t).toLowerCase();
    for (var i = 0; i < out.length; i++) {
      if ((out[i].artist + '\n' + out[i].title).toLowerCase() === key) return;
    }
    out.push({ artist: a, title: t });
  }
  add(artist, title);
  var raw = String(title || '');
  var m = raw.match(/^(.{1,60}?)\s+[-–—|]\s+(.+)$/);
  if (m) {
    add(m[1], m[2]);
    add(artist, m[2]);
    add('', m[2]);
  }
  add(artist, raw.replace(/\b(feat|ft|featuring)\.?\s+.+$/i, ''));
  return out.slice(0, 5);
}

function fromLrclib(obj) {
  if (!obj || typeof obj !== 'object') return null;
  var synced = obj.syncedLyrics || null;
  var plain = obj.plainLyrics || null;
  if (!synced && !plain) return null;
  return { synced: synced, plain: plain, duration: Number(obj.duration) || 0 };
}

function parseLrclib(text) {
  try { return fromLrclib(JSON.parse(text)); } catch (e) { return null; }
}

function pickSearch(text, duration) {
  var list;
  try { list = JSON.parse(text); } catch (e) { return null; }
  if (!Array.isArray(list) || !list.length) return null;
  var hits = [];
  for (var i = 0; i < list.length; i++) {
    var hit = fromLrclib(list[i]);
    if (hit) hits.push(hit);
  }
  if (!hits.length) return null;
  hits.sort(function (a, b) {
    var da = (duration > 1 && a.duration) ? Math.abs(a.duration - duration) : (a.synced ? 0 : 30);
    var db = (duration > 1 && b.duration) ? Math.abs(b.duration - duration) : (b.synced ? 0 : 30);
    if (da !== db) return da - db;
    return (b.synced ? 1 : 0) - (a.synced ? 1 : 0);
  });
  return hits[0];
}

function parseTextyl(text) {
  var list;
  try { list = JSON.parse(text); } catch (e) { return null; }
  if (!Array.isArray(list) || !list.length) return null;
  var lines = [];
  for (var i = 0; i < list.length; i++) {
    var row = list[i];
    if (!row || typeof row.lyrics !== 'string') continue;
    var sec = Number(row.seconds);
    if (!isFinite(sec)) continue;
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    var whole = Math.floor(s);
    var frac = Math.round((s - whole) * 100);
    var stamp = m + ':' + (whole < 10 ? '0' : '') + whole + '.' + (frac < 10 ? '0' : '') + frac;
    lines.push('[' + stamp + ']' + row.lyrics);
  }
  return lines.length ? lines.join('\n') : null;
}

function parseOvh(text) {
  try {
    var j = JSON.parse(text);
    if (j && typeof j.lyrics === 'string' && j.lyrics.trim()) return j.lyrics.trim();
  } catch (e) {}
  return null;
}

module.exports = { queries: queries, parseLrclib: parseLrclib, pickSearch: pickSearch, parseTextyl: parseTextyl, parseOvh: parseOvh };
