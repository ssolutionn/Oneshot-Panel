// The captains' veto room (veto.html) without DOM: links, the signed move
// log, replay through the panel's veto rules, the coin and the clock.
// A move counts only when the captain whose turn it is signed it (ECDSA
// P-256), whoever relays the log. A link stays short: a captain's carries a
// 16-byte secret their key grows from, every link only 10-byte fingerprints
// of both public keys; the keys themselves come with the captains' messages
// and are taken only when they match. The coin is tossed in the room by both
// captains (commit, seed, reveal), so nobody — admin included — knows it first.
import { VETO_RULES, MAP_POOL, appendVeto, validateVeto, vetoText } from './core.js';
import { relayEndpoint } from './assets/veto-relay-protocol.js';

export const VETO_MINUTES = 5;
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const CURVE = { name: 'ECDSA', namedCurve: 'P-256' };
const FORMATS = ['BO1', 'BO2', 'BO3', 'BO5'];
// a, b: captains; s: spectators (may go to a public channel); o: the admin
// (organizers only) — like a spectator, plus the HLTV text.
const SEATS = ['a', 'b', 's', 'o'];
// Minutes for the whole veto; 0 = no clock.
export const TIMERS = [5, 3, 7, 10, 15, 0];
const VERSION = 2, ROOM_BYTES = 10, PRINT_BYTES = 10, SEED_BYTES = 16, NAME_BYTES = 60;

function b64url(bytes) {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(text) {
  const plain = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(plain, c => c.charCodeAt(0));
}
function hex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const random = n => crypto.getRandomValues(new Uint8Array(n));
const sha256 = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
const b64 = n => new RegExp(`^[A-Za-z0-9_-]{${Math.ceil(n * 4 / 3)}}$`);

// ---- P-256: a public key from a private scalar (WebCrypto cannot) ----
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const G = [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n, 1n];
const mod = a => ((a % P) + P) % P;
function inverse(a) {
  let [r0, r1, s0, s1] = [mod(a), P, 1n, 0n];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return mod(s0);
}
// Jacobian coordinates; null is the point at infinity (a = -3 doubling).
function double(pt) {
  if (!pt || pt[1] === 0n) return null;
  const [x, y, z] = pt;
  const delta = mod(z * z), gamma = mod(y * y), beta = mod(x * gamma);
  const alpha = mod(3n * (x - delta) * (x + delta));
  const x3 = mod(alpha * alpha - 8n * beta);
  const z3 = mod((y + z) * (y + z) - gamma - delta);
  const y3 = mod(alpha * (4n * beta - x3) - 8n * gamma * gamma);
  return [x3, y3, z3];
}
function add(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1, z1] = p1, [x2, y2, z2] = p2;
  const z1z1 = mod(z1 * z1), z2z2 = mod(z2 * z2);
  const u1 = mod(x1 * z2z2), u2 = mod(x2 * z1z1);
  const s1 = mod(y1 * z2 * z2z2), s2 = mod(y2 * z1 * z1z1);
  const h = mod(u2 - u1), r = mod(2n * (s2 - s1));
  if (h === 0n) return r === 0n ? double(p1) : null;
  const i = mod(4n * h * h), j = mod(h * i), v = mod(u1 * i);
  const x3 = mod(r * r - j - 2n * v);
  const y3 = mod(r * (v - x3) - 2n * s1 * j);
  const z3 = mod(((z1 + z2) * (z1 + z2) - z1z1 - z2z2) * h);
  return [x3, y3, z3];
}
export function publicPoint(d) {
  let point = null;
  for (let bit = 255n; bit >= 0n; bit--) {
    point = double(point);
    if ((d >> bit) & 1n) point = add(point, G);
  }
  const zi = inverse(point[2]), zi2 = mod(zi * zi);
  return [mod(point[0] * zi2), mod(point[1] * zi2 * zi)];
}
const bytes32 = n => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * (31 - i))) & 0xffn));

// The captain's key from the secret in their link, bound to the room and seat.
async function keyFromSecret(room, team, secret) {
  const digest = await sha256(['oneshot-veto-key-v2', room.r, team, secret].join('|'));
  const d = BigInt('0x' + hex(digest)) % (N - 1n) + 1n;
  const [x, y] = publicPoint(d);
  return { d: b64url(bytes32(d)), x: b64url(bytes32(x)), y: b64url(bytes32(y)) };
}
export async function fingerprint([x, y]) {
  return b64url((await sha256(`oneshot-veto-fp|${x}|${y}`)).slice(0, PRINT_BYTES));
}

// ---- Links: #v=<base64url bytes> ----
// version, seat | format << 2 | timer << 4, room (10), fingerprints A and B
// (10 + 10), the captain's secret (16, captains only), then the team names
// (UTF-8): the length of the first, the first, the second.
export function encodeLink(base, room) {
  const names = room.t.map(t => enc.encode(t));
  const me = SEATS.indexOf(room.me);
  const timer = Math.max(0, TIMERS.indexOf(room.m ?? VETO_MINUTES));
  const parts = [[VERSION, me | FORMATS.indexOf(room.f) << 2 | timer << 4], unb64url(room.r),
    ...room.fp.map(unb64url), me < 2 ? unb64url(room.k) : [], [names[0].length], names[0], names[1]];
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  const url = new URL(base);
  url.hash = 'v=' + b64url(bytes) + (room.relay ? '&via=server&relay=' + encodeURIComponent(relayEndpoint(room.relay, base)) : '');
  return url.href;
}
export function decodeLink(hash) {
  const match = /(?:^#?|&)v=([A-Za-z0-9_-]+)/.exec(String(hash || ''));
  if (!match) return null;
  try {
    const bytes = unb64url(match[1]);
    const me = SEATS[bytes[1] & 3], f = FORMATS[(bytes[1] >> 2) & 3], m = TIMERS[bytes[1] >> 4];
    if (bytes[0] !== VERSION || !me || !f || m === undefined) return null;
    let at = 2;
    const take = n => {
      if (at + n > bytes.length) throw new Error('short');
      return bytes.slice(at, at += n);
    };
    const r = b64url(take(ROOM_BYTES));
    const fp = [b64url(take(PRINT_BYTES)), b64url(take(PRINT_BYTES))];
    const k = seat({ me }) === null ? undefined : b64url(take(SEED_BYTES));
    const first = take(1)[0];
    const t = [dec.decode(take(first)), dec.decode(bytes.slice(at))].map(name => name.trim());
    if (!t[0] || !t[1] || t[0] === t[1] || t.some(name => enc.encode(name).length > NAME_BYTES)) return null;
    const params = new URLSearchParams(String(hash).replace(/^#/, ''));
    const via = params.get('via'), endpoint = params.get('relay');
    if (params.getAll('via').length > 1 || params.getAll('relay').length > 1 ||
        (via && via !== 'server') || Boolean(via) !== Boolean(endpoint)) return null;
    const room = { v: VERSION, r, t, f, m, me, fp, k, p: [null, null] };
    if (via === 'server') room.relay = relayEndpoint(endpoint);
    return room;
  } catch { return null; }
}
export const seat = room => room.me === 'a' ? 0 : room.me === 'b' ? 1 : null;

// A new room: four links (captain of teams[0], of teams[1], spectators, admin).
export async function createRoom(base, teams, format, minutes = VETO_MINUTES, relay = '') {
  const names = teams.map(t => String(t || '').trim());
  if (!names[0] || !names[1] || names[0] === names[1]) throw new Error('Нужны две разные команды.');
  if (names.some(name => enc.encode(name).length > NAME_BYTES)) throw new Error('Слишком длинное название команды.');
  if (!FORMATS.includes(format)) throw new Error('Неизвестный формат вето.');
  if (!TIMERS.includes(Number(minutes))) throw new Error('Неизвестный таймер.');
  const room = { v: VERSION, r: b64url(random(ROOM_BYTES)), t: names, f: format, m: Number(minutes), fp: [], p: [] };
  if (relay) room.relay = relayEndpoint(relay, base);
  const secrets = [b64url(random(SEED_BYTES)), b64url(random(SEED_BYTES))];
  for (const team of [0, 1]) {
    const key = await keyFromSecret(room, team, secrets[team]);
    room.p[team] = [key.x, key.y];
    room.fp[team] = await fingerprint(room.p[team]);
  }
  return {
    room,
    links: {
      a: encodeLink(base, { ...room, me: 'a', k: secrets[0] }),
      b: encodeLink(base, { ...room, me: 'b', k: secrets[1] }),
      s: encodeLink(base, { ...room, me: 's' }),
      o: encodeLink(base, { ...room, me: 'o' })
    }
  };
}

// Stream IDs, VDO.Ninja password and the message key come from the room code;
// the code never reaches VDO.Ninja.
export async function roomSecrets(room) {
  const digest = hex(await crypto.subtle.digest('SHA-256', enc.encode('oneshot-veto:' + room.r)));
  const material = await crypto.subtle.importKey('raw', enc.encode(room.r), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('oneshot-player-veto-v1'), iterations: 100000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return {
    streams: ['ovA' + digest.slice(0, 18), 'ovB' + digest.slice(18, 36)],
    password: digest.slice(36, 60), key
  };
}

// The captain's signing key; throws when the secret does not fit the link
// (a damaged copy): its moves would be refused by everyone.
export async function captainKey(room) {
  const team = seat(room);
  if (team === null) return null;
  const key = await keyFromSecret(room, team, room.k);
  if (await fingerprint([key.x, key.y]) !== room.fp[team]) throw new Error('Ключ капитана не подходит к ссылке.');
  room.p[team] = [key.x, key.y];
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', ...key, ext: true }, CURVE, false, ['sign']);
}
// A public key from a message: taken only when it matches the link.
export async function acceptKey(room, team, key) {
  if (room.p[team]) return room.p[team][0] === key?.[0] && room.p[team][1] === key?.[1];
  if (!Array.isArray(key) || key.length !== 2 || !key.every(c => typeof c === 'string' && b64(32).test(c))) return false;
  if (await fingerprint(key) !== room.fp[team]) return false;
  room.p[team] = [key[0], key[1]];
  return true;
}
const keyCache = new Map();
function publicKey(room, team) {
  if (!room.p[team]) return Promise.reject(new Error('Ключ ещё не пришёл.'));
  const [x, y] = room.p[team];
  const id = x + y;
  if (!keyCache.has(id)) {
    keyCache.set(id, crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, ext: true },
      CURVE, false, ['verify']));
  }
  return keyCache.get(id);
}

// A heartbeat/log envelope can also arrive through the captain's own push
// iframe when their dedicated viewer iframe is stuck. Sign the whole envelope
// so that route proves which captain sent it; spectators know the room's
// encryption key, but never a captain's signing key.
function roomMessageShape(message) {
  const point = value => value === null || (Array.isArray(value) && value.length === 2 &&
    value.every(part => typeof part === 'string' && b64(32).test(part)));
  const entry = value => value && typeof value === 'object' &&
    ['commit', 'seed', 'reveal', 'order', 'ban', 'pick', 'side'].includes(value.k) &&
    typeof value.v === 'string' && value.v.length <= 64 && Number.isSafeInteger(value.at) &&
    typeof value.s === 'string' && b64(64).test(value.s);
  return message?.t === 'log' && Array.isArray(message.log) && message.log.length <= 32 &&
    message.log.every(entry) && Array.isArray(message.p) && message.p.length === 2 && message.p.every(point);
}
function roomMessageBytes(room, message) {
  return enc.encode(JSON.stringify([
    'oneshot-veto-message-v1', room.r, message.from, message.at,
    Number.isSafeInteger(message.call) ? message.call : null,
    message.log, message.p
  ]));
}
export async function signRoomMessage(room, key, message, at = Date.now()) {
  const from = room.me;
  if (!key || !['a', 'b'].includes(from) || !roomMessageShape(message)) {
    throw new Error('Нельзя подписать сообщение комнаты.');
  }
  const signed = { ...message, from, at: Math.round(at) };
  signed.proof = b64url(await crypto.subtle.sign(SIGN, key, roomMessageBytes(room, signed)));
  return signed;
}
export async function verifyRoomMessage(room, message, now = Date.now()) {
  const team = message?.from === 'a' ? 0 : message?.from === 'b' ? 1 : null;
  if (team === null || !roomMessageShape(message) || !Number.isSafeInteger(message.at) ||
      Math.abs(now - message.at) > 10 * 60000 ||
      typeof message.proof !== 'string' || !b64(64).test(message.proof)) return false;
  try {
    return await crypto.subtle.verify(SIGN, await publicKey(room, team),
      unb64url(message.proof), roomMessageBytes(room, message));
  } catch {
    return false;
  }
}

// ---- The coin: A commits to a hidden nonce, B adds a seed, A reveals ----
export const coinNonce = () => b64url(random(16));
export async function coinCommit(room, nonce) {
  return b64url(await sha256(`oneshot-veto-coin|${room.r}|${nonce}`));
}

// Entry: { k: 'commit' | 'seed' | 'reveal' | 'order' | 'ban' | 'pick' | 'side',
// v, at, s }. The signature covers the room, the place in the log and the
// previous signature.
function signed(room, index, prev, entry) {
  return enc.encode(['oneshot-veto-v2', room.r, index, prev, entry.k, entry.v, entry.at].join('|'));
}

// What the log means. Throws on the first entry that breaks the rules
// (signatures and the coin's commitment are checked by verifyLog).
export function replay(room, log) {
  const state = { commit: null, seed: null, coin: null, first: null, actions: [], pending: null, startedAt: null };
  let prevAt = null;
  for (const entry of log) {
    const turn = nextTurn(room, state);
    if (!entry || entry.k !== turn.kind) throw new Error('Нарушен порядок вето.');
    // Times are the signer's clock: a real date, in order (a minute of skew
    // between two devices is fine), and within hours of the previous move.
    if (!Number.isSafeInteger(entry.at) || entry.at < 1600000000000 || entry.at > 4102444800000 ||
        (prevAt !== null && (entry.at < prevAt - 60000 || entry.at > prevAt + 6 * 3600000))) {
      throw new Error('Неверное время хода.');
    }
    prevAt = entry.at;
    if (entry.k === 'commit') {
      if (!b64(32).test(entry.v)) throw new Error('Неверная монетка.');
      state.commit = entry.v;
    } else if (entry.k === 'seed' || entry.k === 'reveal') {
      if (!b64(16).test(entry.v)) throw new Error('Неверная монетка.');
      if (entry.k === 'seed') state.seed = entry.v;
      else state.coin = (unb64url(entry.v)[0] ^ unb64url(state.seed)[0]) & 1;
    } else if (entry.k === 'order') {
      if (!['0', '1'].includes(entry.v)) throw new Error('Неверный выбор порядка.');
      state.first = Number(entry.v);
      state.startedAt = entry.at;
    } else if (entry.k === 'side') {
      if (!['CT', 'T'].includes(entry.v)) throw new Error('Неверная сторона.');
      state.actions = appendVeto(state.actions, room.f, state.first, state.pending.map, entry.v);
      state.pending = null;
    } else {
      const left = validateVeto(state.actions, room.f, state.first);
      if (!left.includes(entry.v)) throw new Error('Эта карта уже выбрана.');
      if (entry.k === 'ban') state.actions = appendVeto(state.actions, room.f, state.first, entry.v);
      else state.pending = { map: entry.v, team: turn.team };
    }
  }
  return state;
}
// Whose move it is and what kind: the coin (commit by A, seed by B, reveal
// by A), order (coin winner), ban, pick, side (the opponent of the pick), done.
export function nextTurn(room, state) {
  if (state.commit === null) return { kind: 'commit', team: 0 };
  if (state.seed === null) return { kind: 'seed', team: 1 };
  if (state.coin === null) return { kind: 'reveal', team: 0 };
  if (state.first === null) return { kind: 'order', team: state.coin };
  if (state.pending) return { kind: 'side', team: 1 - state.pending.team };
  const index = state.actions.length;
  const kind = VETO_RULES[room.f][index];
  if (!kind) return { kind: 'done', team: null };
  return { kind, team: (state.first + index) % 2 };
}
export const COIN_MOVES = ['commit', 'seed', 'reveal'];

// The longest valid prefix of a log: rules, the coin and signatures.
export async function verifyLog(room, log, checked = new Set()) {
  const good = [];
  if (!Array.isArray(log)) return good;
  let prev = '';
  for (const entry of log.slice(0, 32)) {
    if (!entry || typeof entry !== 'object' || typeof entry.s !== 'string' ||
        typeof entry.v !== 'string' || !Number.isFinite(entry.at)) break;
    let state;
    try { state = replay(room, good); } catch { break; }
    const turn = nextTurn(room, state);
    if (turn.kind === 'done' || entry.k !== turn.kind) break;
    try { replay(room, [...good, entry]); } catch { break; }
    if (entry.k === 'reveal' && await coinCommit(room, entry.v) !== state.commit) break;
    const id = [good.length, prev, entry.k, entry.v, entry.at, entry.s].join('|');
    if (!checked.has(id)) {
      let ok = false;
      try {
        ok = await crypto.subtle.verify(SIGN, await publicKey(room, turn.team), unb64url(entry.s),
          signed(room, good.length, prev, entry));
      } catch { ok = false; }
      if (!ok) break;
      checked.add(id);
    }
    good.push({ k: entry.k, v: entry.v, at: entry.at, s: entry.s });
    prev = entry.s;
  }
  return good;
}

// Signs the next move of this captain; throws if it is not their move.
export async function signMove(room, log, key, kind, value, at = Date.now()) {
  const state = replay(room, log);
  const turn = nextTurn(room, state);
  if (turn.kind !== kind || turn.team !== seat(room)) throw new Error('Сейчас не твой ход.');
  const entry = { k: kind, v: String(value), at: Math.round(at) };
  replay(room, [...log, entry]);
  if (kind === 'reveal' && await coinCommit(room, entry.v) !== state.commit) throw new Error('Монетка не сходится.');
  const prev = log.length ? log[log.length - 1].s : '';
  entry.s = b64url(await crypto.subtle.sign(SIGN, key, signed(room, log.length, prev, entry)));
  return [...log, entry];
}

// A verified log from another page is taken only when it continues ours
// move for move (same kind, value and time; signatures may differ, ECDSA
// gives many valid ones). A different move at a step we already have is a
// conflict: one captain signed two moves for the same step. We keep ours —
// a move, once seen, is never undone — and report it.
export function mergeLog(current, incoming) {
  const same = (a, b) => a.k === b.k && a.v === b.v && a.at === b.at;
  const n = Math.min(current.length, incoming.length);
  for (let i = 0; i < n; i++) {
    if (!same(current[i], incoming[i])) return { log: current, conflict: { index: i, ours: current[i], theirs: incoming[i] } };
  }
  return { log: incoming.length > current.length ? incoming : current, conflict: null };
}

// The 5-minute clock starts with the coin winner's choice of order.
export function clock(state, now = Date.now(), minutes = VETO_MINUTES) {
  if (state.startedAt === null) return { started: false, left: minutes * 60000, over: false };
  const left = minutes * 60000 - Math.max(0, now - Math.min(state.startedAt, now));
  return { started: true, left: Math.max(0, left), over: left <= 0 };
}
export function formatClock(ms) {
  const seconds = Math.min(99 * 60 + 59, Math.max(0, Math.ceil(ms / 1000)));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Per-map view for the page: status, who did it and the side.
export function mapBoard(room, state) {
  const cards = new Map(MAP_POOL.map(map => [map, { map, status: 'open' }]));
  for (const a of state.actions) {
    cards.set(a.map, a.type === 'ban' ?
      { map: a.map, status: 'ban', team: a.team } :
      { map: a.map, status: 'pick', team: a.team, side: a.side, sideTeam: 1 - a.team });
  }
  if (state.pending) cards.set(state.pending.map, { map: state.pending.map, status: 'pick', team: state.pending.team });
  if (nextTurn(room, state).kind === 'done') {
    const [left] = validateVeto(state.actions, room.f, state.first);
    if (left) cards.set(left, { map: left, status: 'decider' });
  }
  return [...cards.values()];
}
export function resultText(room, state) {
  return nextTurn(room, state).kind === 'done' ? vetoText(room.t, state.actions, room.f, state.first) : '';
}
// The panel's veto snapshot (actions, first) for importing the result.
export function panelVeto(room, state) {
  return { format: room.f, first: state.first ?? state.coin ?? 0, actions: state.actions, pending: state.pending };
}

// Discord messages. A captain's link is personal: whoever has it can make
// moves for that team.
const MESSAGES = {
  en: {
    head: (room) => `**CyberClash · map veto ${room.t[0]} vs ${room.t[1]} (${room.f})**`,
    captain: name => `Captain of **${name}**, this is your personal veto link:`,
    coin: 'The coin is tossed on the site once both captains are in: each adds a random part, nobody knows the result in advance. The winner decides who bans first.',
    clock: m => m ? `The whole veto takes ${m} minutes.` : 'No time limit.',
    secret: 'Do not forward this link to anyone: it lets you move for your team.',
    watch: room => `Map veto ${room.t[0]} vs ${room.t[1]} (${room.f}) live:`
  },
  ru: {
    head: (room) => `**CyberClash · вето ${room.t[0]} vs ${room.t[1]} (${room.f})**`,
    captain: name => `Капитан **${name}**, это твоя личная ссылка на вето:`,
    coin: 'Монетку бросите на сайте, когда оба капитана зайдут: каждый добавляет свою случайную часть, заранее результат не знает никто. Победитель решает, кто банит первым.',
    clock: m => m ? `На всё вето ${m} ${m % 10 >= 2 && m % 10 <= 4 && (m % 100 < 10 || m % 100 >= 20) ? 'минуты' : 'минут'}.` : 'Без ограничения по времени.',
    secret: 'Ссылку никому не пересылай: по ней можно ходить за твою команду.',
    watch: room => `Вето ${room.t[0]} vs ${room.t[1]} (${room.f}) вживую:`
  }
};
export function captainMessage(room, team, link, lang = 'ru') {
  const t = MESSAGES[lang] || MESSAGES.ru;
  return [t.head(room), t.captain(room.t[team]), link, '', `• ${t.coin}`,
    `• ${t.clock(room.m ?? VETO_MINUTES)}`, `• ${t.secret}`].join('\n');
}
export function spectatorMessage(room, link, lang = 'ru') {
  return `${(MESSAGES[lang] || MESSAGES.ru).watch(room)}\n${link}`;
}

// Display-only relay signing identities. Domain separated from every captain
// and from the OBS control bridge; knowing a display code never grants a move.
export async function displayRelayIdentity(code, role) {
  if (!['dock', 'veto'].includes(role)) throw new Error('Invalid display role');
  const secret = b64url(await sha256('oneshot-display-relay-v1|' + code));
  const key = await keyFromSecret({r:'display-relay-v1'}, role, secret);
  return {
    point:[key.x,key.y], topic:await fingerprint([key.x,key.y]),
    key:await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',...key,ext:true},CURVE,false,['sign'])
  };
}
