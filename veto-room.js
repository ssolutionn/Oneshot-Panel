// The captains' veto room (veto.html) without DOM: links, the signed move
// log, replay through the panel's veto rules, the coin and the clock.
// Each captain's link carries their own ECDSA key: a move counts only when
// the captain whose turn it is signed it, whoever relays the log.
import { VETO_RULES, MAP_POOL, appendVeto, validateVeto, vetoText } from './core.js';

export const VETO_MINUTES = 5;
const enc = new TextEncoder();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const CURVE = { name: 'ECDSA', namedCurve: 'P-256' };

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

// Link payload: #v=<base64url JSON>. r room code, t teams, f format, c coin
// winner (0/1), p public keys [[x, y], [x, y]], me 'a' | 'b' | 's', k the
// captain's private key (captains only).
export function encodeLink(base, payload) {
  const url = new URL(base);
  url.hash = 'v=' + b64url(enc.encode(JSON.stringify(payload)));
  return url.href;
}
export function decodeLink(hash) {
  const match = /(?:^#?|&)v=([A-Za-z0-9_-]+)/.exec(String(hash || ''));
  if (!match) return null;
  let room;
  try { room = JSON.parse(new TextDecoder().decode(unb64url(match[1]))); } catch { return null; }
  const key = v => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
  if (!room || typeof room.r !== 'string' || !/^[A-Z2-9]{16}$/.test(room.r) ||
      !Array.isArray(room.t) || room.t.length !== 2 || !room.t.every(t => typeof t === 'string' && t.trim()) ||
      room.t[0] === room.t[1] || !Object.hasOwn(VETO_RULES, room.f) || ![0, 1].includes(room.c) ||
      !['a', 'b', 's'].includes(room.me) || !Array.isArray(room.p) || room.p.length !== 2 ||
      !room.p.every(p => Array.isArray(p) && p.length === 2 && p.every(key)) ||
      (room.me !== 's' && !key(room.k))) return null;
  return room;
}
export const seat = room => room.me === 'a' ? 0 : room.me === 'b' ? 1 : null;

// A new room: three links (captain of teams[0], of teams[1], spectators).
// The coin is tossed here, once, so nobody can re-roll it on the page.
export async function createRoom(base, teams, format, coin = random(1)[0] % 2) {
  const names = teams.map(t => String(t || '').trim());
  if (!names[0] || !names[1] || names[0] === names[1]) throw new Error('Нужны две разные команды.');
  if (!Object.hasOwn(VETO_RULES, format)) throw new Error('Неизвестный формат вето.');
  const r = [...random(16)].map(b => ALPHABET[b % 32]).join('');
  const keys = [];
  for (let i = 0; i < 2; i++) {
    const pair = await crypto.subtle.generateKey(CURVE, true, ['sign', 'verify']);
    keys.push(await crypto.subtle.exportKey('jwk', pair.privateKey));
  }
  const room = { r, t: names, f: format, c: coin, p: keys.map(k => [k.x, k.y]) };
  return {
    room,
    links: {
      a: encodeLink(base, { ...room, me: 'a', k: keys[0].d }),
      b: encodeLink(base, { ...room, me: 'b', k: keys[1].d }),
      s: encodeLink(base, { ...room, me: 's' })
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

const keyCache = new Map();
function publicKey(room, team) {
  const [x, y] = room.p[team];
  const id = x + y;
  if (!keyCache.has(id)) {
    keyCache.set(id, crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, ext: true },
      CURVE, false, ['verify']));
  }
  return keyCache.get(id);
}
export function privateKey(room) {
  const team = seat(room);
  if (team === null) return null;
  const [x, y] = room.p[team];
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, d: room.k, ext: true },
    CURVE, false, ['sign']);
}

// Entry: { k: 'order' | 'ban' | 'pick' | 'side', v, at, s }. The signature
// covers the room, the place in the log and the previous signature.
function signed(room, index, prev, entry) {
  return enc.encode(['oneshot-veto-v1', room.r, index, prev, entry.k, entry.v, entry.at].join('|'));
}

// What the log means. Throws on the first entry that breaks the rules
// (signatures are checked by verifyLog).
export function replay(room, log) {
  const state = { first: null, actions: [], pending: null, startedAt: null };
  for (const entry of log) {
    const turn = nextTurn(room, state);
    if (!entry || entry.k !== turn.kind) throw new Error('Нарушен порядок вето.');
    if (entry.k === 'order') {
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
// Whose move it is and what kind: order (coin winner), ban, pick, side
// (the opponent of the pick), or done.
export function nextTurn(room, state) {
  if (state.first === null) return { kind: 'order', team: room.c };
  if (state.pending) return { kind: 'side', team: 1 - state.pending.team };
  const index = state.actions.length;
  const kind = VETO_RULES[room.f][index];
  if (!kind) return { kind: 'done', team: null };
  return { kind, team: (state.first + index) % 2 };
}

// The longest valid prefix of a log: rules and signatures.
export async function verifyLog(room, log, checked = new Set()) {
  const good = [];
  if (!Array.isArray(log)) return good;
  let prev = '';
  for (const entry of log.slice(0, 16)) {
    if (!entry || typeof entry !== 'object' || typeof entry.s !== 'string' ||
        typeof entry.v !== 'string' || !Number.isFinite(entry.at)) break;
    let state;
    try { state = replay(room, good); } catch { break; }
    const turn = nextTurn(room, state);
    if (turn.kind === 'done' || entry.k !== turn.kind) break;
    try { replay(room, [...good, entry]); } catch { break; }
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
  const turn = nextTurn(room, replay(room, log));
  if (turn.kind !== kind || turn.team !== seat(room)) throw new Error('Сейчас не твой ход.');
  const entry = { k: kind, v: String(value), at: Math.round(at) };
  replay(room, [...log, entry]);
  const prev = log.length ? log[log.length - 1].s : '';
  entry.s = b64url(await crypto.subtle.sign(SIGN, key, signed(room, log.length, prev, entry)));
  return [...log, entry];
}

// Two verified logs of the same room: the longer one wins; on a tie the
// smaller signature at the first difference, so every page settles the same.
export function pickLog(a, b) {
  if (b.length !== a.length) return b.length > a.length ? b : a;
  for (let i = 0; i < a.length; i++) {
    if (a[i].s !== b[i].s) return b[i].s < a[i].s ? b : a;
  }
  return a;
}

// The 5-minute clock starts with the coin winner's choice of order.
export function clock(state, now = Date.now(), minutes = VETO_MINUTES) {
  if (state.startedAt === null) return { started: false, left: minutes * 60000, over: false };
  const left = minutes * 60000 - Math.max(0, now - Math.min(state.startedAt, now));
  return { started: true, left: Math.max(0, left), over: left <= 0 };
}
export function formatClock(ms) {
  const seconds = Math.ceil(ms / 1000);
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
  return { format: room.f, first: state.first ?? room.c, actions: state.actions, pending: state.pending };
}

// Discord message for one captain. Their link is personal: whoever has it
// can make moves for that team.
export function captainMessage(room, team, link) {
  return [
    `**CyberClash · вето ${room.t[0]} vs ${room.t[1]} (${room.f})**`,
    `Капитан **${room.t[team]}**, это твоя личная ссылка на вето:`,
    link,
    '',
    '• Кто начинает — решит монетка на сайте, когда оба капитана зайдут.',
    `• На всё вето ${VETO_MINUTES} минут.`,
    '• Ссылку никому не пересылай: по ней можно ходить за твою команду.'
  ].join('\n');
}
