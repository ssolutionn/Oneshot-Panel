// VDO.Ninja in hidden iframes: the webcam status of the selected match and
// the data link between the panel and the OBS dock (obs-bridge.html).
// Messages on the link are sealed with AES-GCM from the pairing code, so only
// pages that know the code can send commands to OBS.

import { isVdoStreamId } from './core.js';

const VDO = 'https://vdo.ninja/';
// Signalling/ICE can take much longer than a heartbeat gap. Never tear down
// a new connection on the shorter deadline used for an established channel.
export const VDO_CONNECT_TIMEOUT = 30000, VDO_CONNECT_MAX_TIMEOUT = 90000, VDO_IDLE_TIMEOUT = 15000;
const enc = new TextEncoder(), dec = new TextDecoder();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function b64(bytes) {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text);
}
function unb64(text) {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}

// 16 characters from a 32-letter alphabet: 80 random bits, shown as XXXX-XXXX-…
export function newBridgeCode(random = n => crypto.getRandomValues(new Uint8Array(n))) {
  const code = [...random(16)].map(b => ALPHABET[b % 32]).join('');
  return code.match(/.{4}/g).join('-');
}
export function normalizeCode(value) {
  const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === 16 && [...code].every(c => ALPHABET.includes(c)) ?
    code.match(/.{4}/g).join('-') : '';
}
// Stream ID and VDO.Ninja password are derived from the code; the code
// itself never reaches VDO.Ninja.
export async function bridgeSecrets(code) {
  const clean = normalizeCode(code);
  if (!clean) throw new Error('Неверный код связи с OBS.');
  const digest = hex(await crypto.subtle.digest('SHA-256', enc.encode('oneshot-bridge:' + clean)));
  const material = await crypto.subtle.importKey('raw', enc.encode(clean), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('oneshot-obs-bridge-v1'), iterations: 100000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { code: clean, stream: 'oneshot' + digest.slice(0, 20), password: digest.slice(20, 44), key };
}
export async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return { v: 1, iv: b64(iv), data: b64(data) };
}
export async function unseal(key, box) {
  if (!box || box.v !== 1 || typeof box.iv !== 'string' || typeof box.data !== 'string') return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data));
    return JSON.parse(dec.decode(plain));
  } catch { return null; }
}

// The OBS dock publishes a data-only stream and panels view it: on the
// released VDO.Ninja, data-only pages in a shared room do not connect.
export function bridgeUrl({ stream, password }, role) {
  const url = new URL(VDO);
  const side = role === 'dock' ? { push: stream } : { view: stream };
  url.search = new URLSearchParams({ ...side, password, label: `oneshot-${role}` }).toString() +
    '&dataonly&cleanoutput';
  return url.href;
}
// A scene-style viewer of the team's streams that takes no audio or video:
// it only learns which stream IDs are publishing right now.
export function watchUrl(room, ids, password = '') {
  const url = new URL(VDO);
  url.search = new URLSearchParams({ room, ...(password ? { password } : {}), view: ids.join(','), label: 'oneshot-status' }).toString() +
    '&scene&novideo&noaudio&cleanoutput';
  return url.href;
}

// The IDs VDO.Ninja really reports as publishing. A peer whose stream ID it
// does not know yet comes back under a key "undefined" (also "null"/"false"):
// those are not pushes, so they never reach a seat, a link or OBS.
export function streamIdsOf(data) {
  if (!data || typeof data !== 'object') return [];
  return Object.keys(data).filter(id => isVdoStreamId(id) && data[id] !== false)
    .sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
}
// Who publishes in a room (a LAN's director room): a scene viewer without
// audio or video, asked for its stream IDs until three answers in a row agree
// or the time is up. Only VDO-safe IDs, in natural order (pc2 before pc10).
export function scanUrl(room, password = '') {
  const url = new URL(VDO);
  url.search = new URLSearchParams({ room, ...(password ? { password } : {}), label: 'oneshot-scan' }).toString() +
    '&scene&novideo&noaudio&cleanoutput';
  return url.href;
}
export function scanRoom(room, password = '', { wait = 12000, every = 1000 } = {}) {
  return new Promise(resolve => {
    const iframe = frame(scanUrl(room, password), 'Поиск компов');
    let last = '', same = 0;
    const listener = event => {
      if (event.source !== iframe.contentWindow || !event.data?.streamIDs || typeof event.data.streamIDs !== 'object') return;
      const ids = streamIdsOf(event.data.streamIDs);
      const key = ids.join(',');
      same = ids.length && key === last ? same + 1 : 0;
      last = key;
      if (same >= 2) done();
    };
    const timer = setInterval(() => iframe.contentWindow?.postMessage({ getStreamIDs: true }, '*'), every);
    const limit = setTimeout(done, wait);
    function done() {
      clearInterval(timer); clearTimeout(limit);
      removeEventListener('message', listener);
      iframe.remove();
      resolve(last ? last.split(',') : []);
    }
    addEventListener('message', listener);
  });
}

function frame(src, title) {
  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.title = title;
  iframe.allow = 'autoplay';
  iframe.className = 'vdo-frame';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  document.body.append(iframe);
  return iframe;
}

// Panel ↔ OBS dock (role 'panel' or 'dock'). onMessage gets decrypted
// objects; onPeers gets the number of open data connections.
export class VdoLink {
  constructor(secrets, role, onMessage, onPeers = () => {}) {
    Object.assign(this, { secrets, onMessage, onPeers });
    this.peers = new Set();
    this.iframe = frame(bridgeUrl(secrets, role), 'Связь с OBS');
    this.listener = event => this.receive(event);
    addEventListener('message', this.listener);
  }
  async receive(event) {
    if (event.source !== this.iframe.contentWindow || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    const peer = data.UUID || data.streamID;
    // view-connection: the stream we view (the dock); push-connection: a
    // viewer of our stream (a panel).
    if (data.action === 'push-connection' || data.action === 'view-connection') {
      if (peer) data.value === false ? this.peers.delete(peer) : this.peers.add(peer);
      this.onPeers(this.peers.size);
    }
    const box = data.dataReceived?.oneshot;
    if (box) {
      if (peer) { this.peers.add(peer); this.onPeers(this.peers.size); }
      const message = await unseal(this.secrets.key, box);
      if (message) this.onMessage(message);
    }
  }
  // No type: VDO.Ninja sends to viewers of our stream and to streams we view.
  async send(message) {
    this.iframe.contentWindow?.postMessage({
      sendData: { oneshot: await seal(this.secrets.key, message) }
    }, '*');
  }
  close() {
    removeEventListener('message', this.listener);
    this.iframe.remove();
  }
}

// Which stream IDs of the selected match are publishing. One viewer per team
// room; getStreamIDs is asked every second because join/leave events can be
// missed and a badge that lags is read as a wrong one.
export const camKey = (room, id) => `${room}/${id}`;
// A webcam that answered a moment ago but is not publishing now is marked
// «была недавно»: a stream that just dropped must not read as «нет вебки» on
// the first answer, and a flapping room list must not blink the badge.
export const RECENT_MS = 20000;
export class CamWatch {
  constructor(onChange, interval = 1000, recentMs = RECENT_MS) {
    Object.assign(this, { onChange, interval, recentMs });
    this.rooms = new Map();
    this.live = new Set();
    this.recent = new Set();
    this.listener = event => this.receive(event);
    addEventListener('message', this.listener);
    this.timer = setInterval(() => this.poll(), interval);
  }
  // groups: [{ room, ids: [...] }]. Unchanged rooms keep their iframe.
  watch(groups) {
    const wanted = new Map(groups.filter(g => g.room && g.ids.length)
      .map(g => [g.room, [...new Set(g.ids)].sort()]));
    const passwords = new Map(groups.map(g => [g.room, g.password || '']));
    for (const [room, entry] of this.rooms) {
      if (JSON.stringify(wanted.get(room)) !== JSON.stringify(entry.ids) || passwords.get(room) !== entry.password) {
        entry.iframe.remove();
        this.rooms.delete(room);
      }
    }
    for (const [room, ids] of wanted) {
      if (!this.rooms.has(room)) {
        this.rooms.set(room, {
          room, ids, password: passwords.get(room), live: new Set(), seen: new Map(), answered: false,
          iframe: frame(watchUrl(room, ids, passwords.get(room)), 'Статус вебок')
        });
      }
    }
    this.update();
  }
  receive(event) {
    const entry = [...this.rooms.values()].find(e => e.iframe.contentWindow === event.source);
    if (!entry || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    // Only the room's own list decides who is publishing. «view-connection» of a
    // scene viewer flickers while it opens and drops connections to streams that
    // are not there: a badge that blinks between «нет вебки» and «в эфире» is
    // worse than one that is a second late, so that message is not presence.
    if (!data.streamIDs || typeof data.streamIDs !== 'object') return;
    const next = streamIdsOf(data.streamIDs).filter(id => entry.ids.includes(id));
    // Every answer that names a stream is remembered for «была недавно», even
    // one that does not confirm a state: that is exactly the flapping reply.
    const now = Date.now();
    for (const id of next) entry.seen.set(id, now);
    const same = ids => ids.length === entry.live.size && ids.every(id => entry.live.has(id));
    const first = !entry.answered;
    entry.answered = true;
    if (first) entry.live = new Set(next);
    else if (same(next)) entry.pending = null;
    // A change is shown only when two answers in a row agree: one odd reply
    // (a stream still listed for a moment after it left) must not blink.
    else if (entry.pending && entry.pending.length === next.length && entry.pending.every(id => next.includes(id))) entry.live = new Set(next);
    else entry.pending = next;
    this.update();
  }
  poll() {
    for (const entry of this.rooms.values()) {
      entry.iframe.contentWindow?.postMessage({ getStreamIDs: true }, '*');
    }
  }
  // onChange(live, recent, checking): live is who publishes now; recent is who
  // was named by the room not long ago (RECENT_MS) and is not live any more;
  // checking lists stream IDs whose room has not answered yet, so the panel can
  // say "проверяем" instead of "нет камеры".
  // Each ID is there as itself and as camKey(room, id): two rooms may use the
  // same IDs (a LAN's pc1…pc5 in each team's room).
  update() {
    const entries = [...this.rooms.values()];
    const keys = (e, ids) => [...ids].flatMap(id => [id, camKey(e.room, id)]);
    this.live = new Set(entries.flatMap(e => keys(e, e.live)));
    const now = Date.now();
    this.recent = new Set(entries.flatMap(e => keys(e,
      [...e.seen].filter(([id, at]) => !e.live.has(id) && now - at < this.recentMs).map(([id]) => id))));
    this.onChange(this.live, this.recent,
      new Set(entries.filter(e => !e.answered).flatMap(e => keys(e, e.ids))));
  }
  stop() {
    clearInterval(this.timer);
    removeEventListener('message', this.listener);
    for (const entry of this.rooms.values()) entry.iframe.remove();
    this.rooms.clear();
    this.live = new Set();
    this.recent = new Set();
  }
}
