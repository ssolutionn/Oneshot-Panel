// LAN event data without a server or a sheet: a Drive folder (ZIP or picked
// folder) with one subfolder per team becomes teams, trimmed photos and logos,
// and every CARD in OBS becomes a self-contained page with its photo inside
// (a data: URL), so OBS needs nothing from the site. No DOM here: the pure
// parts run in Node tests; lan-images.js does the canvas work in the browser.
import { personKey, cardKey } from './core.js';

const NAME_FIT = 4;
export const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;
const LOGO_NAMES = new Set(['logo', 'лого', 'логотип', 'emblem']);
const DATA_IMAGE = /^data:image\/(?:png|webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_ENTRIES = 3000, MAX_FILE = 60 * 1024 * 1024, MAX_TOTAL = 800 * 1024 * 1024;

// ---------- ZIP (Drive «Скачать папку») ----------
// Stored and deflated entries, no ZIP64, no encryption. Entries are read one
// at a time, so a big archive is never held decompressed in memory.
export async function readZip(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('Это не ZIP-архив.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new Error('ZIP слишком большой: скачай папку по частям.');
  if (count > MAX_ENTRIES) throw new Error(`В архиве больше ${MAX_ENTRIES} файлов.`);
  const entries = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error('ZIP повреждён.');
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    total += size;
    if (size > MAX_FILE || total > MAX_TOTAL) throw new Error('Слишком большие файлы в архиве.');
    entries.push({
      path: name.replace(/\\/g, '/'), size,
      async blob() {
        if (flags & 1) throw new Error('Архив с паролем не читается.');
        if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error('ZIP повреждён.');
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + packed);
        if (method === 0) return new Blob([data]);
        if (method !== 8) throw new Error('Неизвестный способ сжатия в ZIP.');
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const out = [];
        let length = 0;
        for await (const chunk of stream) {
          length += chunk.length;
          if (length > Math.max(size, 1) + 1024) throw new Error('ZIP повреждён.');
          out.push(chunk);
        }
        return new Blob(out);
      }
    });
  }
  return entries;
}

// ---------- team folders ----------
// files: [{ path: 'Event/Team/nick.png', size, blob() }] — from a ZIP or from a
// picked folder (webkitRelativePath). Returns teams and plain-words problems.
export function collectTeams(files) {
  const teams = new Map(), problems = [];
  // What Finder and Windows add (__MACOSX/…, ._x.png, desktop.ini) is not ours,
  // and must not decide how deep the team folders are.
  const ignored = parts => !parts.at(-1) || parts.at(-1).startsWith('.') || parts.includes('__MACOSX') || /^desktop\.ini$/i.test(parts.at(-1));
  const kept = files.filter(file => !ignored(String(file.path).split('/').filter(Boolean)));
  // «Event/Team/nick.png»: team folders sit one level below the root folder of
  // the archive. When there are such, an image right in the root belongs to no team.
  const nested = kept.some(file => String(file.path).split('/').filter(Boolean).length >= 3);
  for (const file of kept) {
    const parts = String(file.path).split('/').filter(Boolean);
    const name = parts.at(-1);
    if (HEIC_EXT.test(name)) {
      problems.push(`${parts.slice(-2).join('/')}: HEIC не читается браузером и OBS — сохрани как PNG`);
      continue;
    }
    if (!IMAGE_EXT.test(name)) continue;
    if (parts.length < 2 || (nested && parts.length === 2)) {
      problems.push(`${name}: лежит вне папки команды — положи в папку «Команда»`);
      continue;
    }
    const team = parts.at(-2).trim();
    const entry = teams.get(team) || { name: team, logo: null, players: new Map() };
    teams.set(team, entry);
    const stem = name.replace(/\.[^.]+$/, '').trim();
    if (LOGO_NAMES.has(stem.toLowerCase())) { entry.logo = file; continue; }
    // Drive names a repeated upload «nick (1).png».
    const nick = stem.replace(/\s*\(\d+\)$/, '').trim();
    if (!nick) problems.push(`${parts.slice(-2).join('/')}: пустой ник`);
    else if ([...entry.players.keys()].some(n => personKey(n) === personKey(nick))) {
      problems.push(`${team}: ник ${nick} встречается дважды — взят первый файл`);
    } else entry.players.set(nick, file);
  }
  return { teams: [...teams.values()].filter(t => t.players.size || t.logo), problems };
}
export const rosterLine = team =>
  [...team.players.keys()].sort((a, b) => a.localeCompare(b, 'ru', { sensitivity: 'base' })).join(', ');

// ---------- what the browser keeps ----------
export const ASSETS_STORE = 'oneshot-lan-assets-v1';
export function normalizeAssets(value) {
  const photos = {}, logos = {};
  const take = (from, into) => {
    for (const [key, data] of Object.entries(from && typeof from === 'object' ? from : {})) {
      if (typeof data === 'string' && DATA_IMAGE.test(data) && data.length <= 400000) into[key] = data;
    }
  };
  take(value?.photos, photos);
  take(value?.logos, logos);
  return { v: 1, photos, logos };
}
export function readAssets(storage = globalThis.localStorage) {
  try { return normalizeAssets(JSON.parse(storage.getItem(ASSETS_STORE))); } catch { return normalizeAssets(null); }
}
export function writeAssets(assets, storage = globalThis.localStorage) {
  try { storage.setItem(ASSETS_STORE, JSON.stringify(normalizeAssets(assets))); return true; } catch { return false; }
}
// The photos of a whole event do not fit localStorage (~5 M characters per
// site): they live in IndexedDB, and `assets` is the copy the cards read
// synchronously. The first load moves what older versions kept in localStorage.
export function indexedAssets(factory = globalThis.indexedDB) {
  const open = () => new Promise((resolve, reject) => {
    const request = factory.open('oneshot-lan', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('assets');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = (mode, action) => open().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction('assets', mode), request = action(transaction.objectStore('assets'));
    transaction.oncomplete = () => { db.close(); resolve(request.result); };
    transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error || new Error('IndexedDB')); };
  }));
  return { get: () => run('readonly', store => store.get(ASSETS_STORE)), put: value => run('readwrite', store => store.put(value, ASSETS_STORE)) };
}
const anyAssets = assets => Object.keys(assets.photos).length + Object.keys(assets.logos).length > 0;
export class AssetStore {
  constructor({ db = null, storage = globalThis.localStorage } = {}) {
    Object.assign(this, { db, storage, assets: normalizeAssets(null) });
  }
  async load() {
    const legacy = readAssets(this.storage);
    try {
      if (!this.db) throw new Error('no IndexedDB');
      const kept = await this.db.get();
      if (!kept) {
        this.assets = legacy;
        if (anyAssets(legacy)) await this.save(legacy);
        return this.assets;
      }
      this.assets = normalizeAssets(kept);
      try { this.storage.removeItem(ASSETS_STORE); } catch { /* fine */ }
    } catch { this.db = null; this.assets = legacy; } // private mode and the like: localStorage as before
    return this.assets;
  }
  // false: the browser had no room; what was kept before stays.
  async save(value) {
    const assets = normalizeAssets(value);
    if (this.db) {
      try { await this.db.put(assets); } catch { return false; }
      try { this.storage.removeItem(ASSETS_STORE); } catch { /* fine */ }
    } else if (!writeAssets(assets, this.storage)) return false;
    this.assets = assets;
    return true;
  }
}
// The key of an event team's or player's picture. personKey of a name never
// holds «#», so these never meet the name keys of older versions («T1» and id t1).
export const ownKey = id => '#' + id;
export const photoOf = (assets, team, nick) => assets.photos[cardKey(team, nick)] || '';
export const logoOf = (assets, team) => assets.logos[personKey(team)] || '';

// ---------- the card as one page ----------
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const HEX = /^#[0-9a-f]{6}$/i;
export const DEFAULT_COLORS = { accent: '#00d3ef', deep: '#043746', black: '#031b24', cyan: '#00bedf', teal: '#087f91' };
const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const blend = (a, b, p) => '#' + channels(a).map((x, i) => Math.round(x + (channels(b)[i] - x) * p).toString(16).padStart(2, '0')).join('');
// Three chosen colours (an event profile) → the five the card uses; none chosen → {} (defaults).
// The glow takes the accent; the base of the gradient is the deep colour lifted toward the accent.
export function paletteFrom(profile) {
  const pick = key => HEX.test(profile?.[key] || '') ? profile[key] : '';
  const accent = pick('accent'), deep = pick('deep'), black = pick('black');
  const palette = {};
  if (accent) { palette.accent = accent; palette.cyan = accent; }
  if (deep) palette.deep = deep;
  if (black) palette.black = black;
  if (accent || deep) palette.teal = blend(deep || DEFAULT_COLORS.deep, accent || DEFAULT_COLORS.accent, 0.35);
  return palette;
}
export function eventCardHtml({ team = '', nick = '', photo = '', logo = '', colors = {} } = {}) {
  const c = Object.fromEntries(Object.entries(DEFAULT_COLORS).map(([k, v]) => [k, HEX.test(colors?.[k] || '') ? colors[k] : v]));
  const image = value => DATA_IMAGE.test(value || '') ? value : '';
  const p = image(photo), l = image(logo);
  const layout = p ? 'photo' : 'no-photo';
  const name = String(nick || 'Игрок').trim();
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(name)} · ${esc(team)}</title><style>
:root{--ink:#fff;--muted:#d2edf1;--accent:${c.accent};--deep:${c.deep};--black:${c.black};--cyan:${c.cyan};--teal:${c.teal};--scale:1}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:var(--black)}
.card{position:absolute;left:calc((100vw - 1920px * var(--scale)) / 2);top:calc((100vh - 1080px * var(--scale)) / 2);width:1920px;height:1080px;overflow:hidden;transform:scale(var(--scale));transform-origin:0 0;color:var(--ink);font-family:"Arial Black","Segoe UI",Arial,sans-serif;background:radial-gradient(ellipse at 50% 15%,var(--cyan),transparent 65%),linear-gradient(120deg,var(--teal),var(--deep) 48%,var(--teal))}
.photo{position:absolute;left:50%;top:35px;transform:translateX(-50%);height:1000px;width:auto;filter:drop-shadow(0 0 28px var(--teal))}
.shade{position:absolute;inset:0;pointer-events:none}
.id{position:absolute;left:160px;right:160px;top:160px;bottom:130px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.emblem{width:280px;height:280px;object-fit:contain;margin-bottom:30px;filter:drop-shadow(0 10px 28px #00151bb3)}
.team{display:flex;align-items:center;justify-content:center;gap:20px;font-size:46px;font-weight:700;line-height:1.15;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);text-shadow:0 2px 14px #00151bb3}
.team span{min-width:0;max-width:100%;overflow-wrap:anywhere}.logo{flex:none;width:60px;height:60px;object-fit:contain}
.nick{margin:25px 0 0;max-width:100%;white-space:nowrap;font-size:224px;font-weight:900;line-height:1.08;letter-spacing:-.035em;text-shadow:0 6px 30px #00151bb3}
.nick.long{white-space:normal;overflow-wrap:anywhere}
.rule{display:block;width:280px;height:12px;margin:32px auto 0;background:var(--accent);clip-path:polygon(2% 10%,90% 0,97% 25%,100% 60%,94% 85%,13% 100%,0 65%)}
.photo-layout .shade{background:linear-gradient(0deg,var(--black),transparent 43%)}
.photo-layout .id{top:auto;bottom:60px}.photo-layout .emblem,.no-photo-layout .logo{display:none}
.photo-layout .team{font-size:30px;letter-spacing:.1em}.photo-layout .nick{font-size:160px;margin-top:12px}.photo-layout .rule{display:none}
</style></head><body><main class="card ${layout}-layout" id="card">${p ? `<img class="photo" alt="" src="${p}">` : ''}<div class="shade"></div><section class="id">${!p && l ? `<img class="emblem" alt="" src="${l}">` : ''}<div class="team">${p && l ? `<img class="logo" alt="" src="${l}">` : ''}<span>${esc(team)}</span></div><h1 class="nick" id="nick">${esc(name)}</h1><span class="rule"></span></section></main><script>
(function(){var s=function(){document.documentElement.style.setProperty('--scale',String(Math.min(innerWidth/1920,innerHeight/1080)||1))};s();addEventListener('resize',s);
var n=document.getElementById('nick'),w=n.parentElement.clientWidth,z=${p ? 160 : 224};n.style.fontSize=z+'px';while(n.scrollWidth>w&&z>52){z-=${NAME_FIT};n.style.fontSize=z+'px'}n.classList.toggle('long',n.scrollWidth>w)})();
</script></body></html>`;
}
export const eventCardUrl = fields => 'data:text/html;charset=utf-8,' + encodeURIComponent(eventCardHtml(fields));
// A team's placeholder (its logo on the event's background): under each of its
// cameras in OBS, seen while that webcam has no video. The picture covers the
// frame; only a data:image gets in.
export function plateCardUrl(image) {
  if (!DATA_IMAGE.test(image || '')) return '';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><meta charset="utf-8"><title>Заглушка</title><style>' +
    `html,body{margin:0;height:100%;overflow:hidden;background:#031b24 url("${image}") center/cover no-repeat}</style></head><body></body></html>`);
}

// The cards of one match: { [cardKey]: data: URL } for its ten players.
export function cardDocs(players, assets, colors) {
  const docs = {};
  for (const p of players) {
    if (!p?.team || !p?.nick) continue;
    // An event's own teams keep pictures by id (renaming keeps them); older ones by name.
    docs[cardKey(p.team, p.nick)] = eventCardUrl({
      team: p.team, nick: p.nick, colors,
      photo: p.playerId ? assets.photos[ownKey(p.playerId)] || '' : photoOf(assets, p.team, p.nick),
      logo: p.teamId ? assets.logos[ownKey(p.teamId)] || '' : logoOf(assets, p.team)
    });
  }
  return docs;
}

// ---------- to the OBS dock in pieces ----------
// A data channel is not meant for ~100 KB at once: a card goes as parts of
// CHUNK characters, the dock puts them back together.
export const CHUNK = 32000;
export function splitChunks(url, size = CHUNK) {
  const parts = [];
  for (let i = 0; i < url.length; i += size) parts.push(url.slice(i, i + size));
  return parts.length ? parts : [''];
}
export class ChunkAssembler {
  // Big enough for the largest card the panel can make: a photo and a logo of up
  // to 400 000 characters each (normalizeAssets), percent-encoded in the page.
  constructor(limit = 1200000) { this.limit = limit; this.pending = new Map(); this.done = new Map(); }
  has(key) { return this.done.has(key); }
  get(key) { return this.done.get(key); }
  // true when this part completed the card.
  add(key, index, count, data) {
    if (typeof key !== 'string' || !/^[\p{L}\p{N}|:.-]{1,200}$/u.test(key) || typeof data !== 'string' ||
        !Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count ||
        count * CHUNK > this.limit + CHUNK) throw new Error('Неверная часть карточки.');
    let entry = this.pending.get(key);
    if (!entry || entry.count !== count) { entry = { count, parts: new Map() }; this.pending.set(key, entry); }
    entry.parts.set(index, data);
    if (entry.parts.size < count) return false;
    const url = Array.from({ length: count }, (_, i) => entry.parts.get(i)).join('');
    this.pending.delete(key);
    if (!url.startsWith('data:text/html;charset=utf-8,') || url.length > this.limit) throw new Error('Неверная карточка.');
    this.done.set(key, url);
    while (this.done.size > 40) this.done.delete(this.done.keys().next().value);
    return true;
  }
}
// A key that changes with the card, so a changed photo is sent again.
export async function docKey(key, url) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return key + ':' + [...new Uint8Array(digest).slice(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('');
}
