// The panel's view of a captains' veto room (site only). It watches both
// captains' VDO.Ninja data streams the way the admin's link does on the veto
// site, takes only signed moves that continue the log (veto-room.js) and
// tells the panel about moves, presence and «Call admin». It never sends:
// the captains' pages do not know it is there.
import { unseal } from './vdo.js';
import { connectServerWatch } from './assets/veto-relay-links.js';
import {
  decodeLink, encodeLink, roomSecrets, acceptKey, verifyLog, mergeLog, replay, nextTurn, COIN_MOVES
} from './veto-room.js';

const VDO = 'https://vdo.ninja/';
export const ONLINE_FOR = 8000;

// Any room link, watched as the admin: a captain's secret is dropped. adminLink
// is the same room's admin link on the same site (never a captain's).
export function adminRoom(link) {
  let url;
  try { url = new URL(String(link || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const decoded = decodeLink(url.hash);
  if (!decoded) return null;
  const room = { ...decoded, me: 'o', k: undefined };
  return { room, adminLink: encodeLink(url.origin + url.pathname, room) };
}

// The room's veto in the panel's team order (teams: the panel's two names);
// null until the coin winner has chosen the order, or when the panel shows
// other teams. The pending pick is only its map: the panel knows whose it is.
export function roomToPanel(room, state, teams) {
  if (state.first === null) return null;
  const key = name => String(name || '').trim().toLowerCase();
  const same = key(room.t[0]) === key(teams[0]) && key(room.t[1]) === key(teams[1]);
  const flip = key(room.t[0]) === key(teams[1]) && key(room.t[1]) === key(teams[0]);
  if (!same && !flip) return null;
  const team = t => flip ? 1 - t : t;
  return {
    format: room.f, first: team(state.first),
    actions: state.actions.map(a => ({ ...a, team: team(a.team) })),
    pending: state.pending?.map || null
  };
}

// The moves for a list: { index, kind, team, value, at } (the coin is one line).
export function roomMoves(room, log) {
  const moves = [];
  let state = replay(room, []);
  for (const [index, entry] of log.entries()) {
    const turn = nextTurn(room, state);
    const prev = state.pending?.map;
    state = replay(room, log.slice(0, index + 1));
    if (entry.k === 'reveal') moves.push({ index, kind: 'coin', team: state.coin, value: '', at: entry.at });
    else if (!COIN_MOVES.includes(entry.k)) {
      moves.push({ index, kind: entry.k, team: turn.team, value: entry.v, map: entry.k === 'side' ? prev : '', at: entry.at });
    }
  }
  return moves;
}

// Two hidden view iframes, one per captain's stream: what comes through a
// stream's frame was sent by that stream's captain.
function connectVdo(secrets, deliver) {
  const frames = secrets.streams.map(stream => {
    const url = new URL(VDO);
    url.search = new URLSearchParams({ view: stream, password: secrets.password, label: 'oneshot-veto' }) +
      '&dataonly&cleanoutput';
    const iframe = document.createElement('iframe');
    Object.assign(iframe, { src: url.href, title: 'Вето капитанов', className: 'vdo-frame', tabIndex: -1 });
    iframe.allow = 'autoplay';
    iframe.setAttribute('aria-hidden', 'true');
    document.body.append(iframe);
    return iframe;
  });
  const listen = event => {
    const team = frames.findIndex(frame => frame.contentWindow === event.source);
    const box = event.data?.dataReceived?.oneshotVeto;
    if (team >= 0 && box) deliver(box, team);
  };
  addEventListener('message', listen);
  return {
    stop() {
      removeEventListener('message', listen);
      for (const frame of frames) frame.remove();
    }
  };
}

export class RoomWatch {
  // room: decoded (or from createRoom) with me 'o'; saved: { r, log, p } from
  // an earlier visit; connect: the transport (tests pass their own).
  constructor(room, { onChange = () => {}, onCall = () => {}, saved = null, connect = null } = {}) {
    Object.assign(this, { room, onChange, onCall });
    this.room.p = Array.isArray(room.p) ? room.p : [null, null];
    this.log = [];
    this.seen = [0, 0];
    this.conflict = null;
    this.checked = new Set();
    this.queue = Promise.resolve();
    this.waiting = null;
    this.orderSeen = null;
    this.stopped = false;
    this.ready = (async () => {
      this.secrets = await roomSecrets(room);
      if (saved?.r === room.r) await this.adopt(saved.log, saved.p);
      if (!this.stopped) {
        const deliver = (box, team, online = true) => this.open(box, team, online);
        this.link = connect ? connect(this.secrets, deliver) : room.relay ? connectServerWatch(room, this.secrets, deliver) : connectVdo(this.secrets, deliver);
      }
    })();
  }
  async open(box, team, online = true) {
    const message = await unseal(this.secrets.key, box);
    if (message && !this.stopped) this.receive(message, team, online);
  }
  // team: whose stream the message came through (the message's own from is
  // not trusted).
  receive(message, team, online = true) {
    if (!message || message.t !== 'log' || !Array.isArray(message.log) || ![0, 1].includes(team)) return;
    const back = online && !this.online(team);
    if (online) this.seen[team] = Date.now();
    if (online && Number.isSafeInteger(message.call)) this.onCall(team, message.call);
    const unkeyed = Array.isArray(message.p) && [0, 1].some(i => !this.room.p[i] && message.p[i]);
    if (back) this.onChange(this);
    if (message.log.length < this.log.length && !unkeyed) return;
    // Only the newest log waits for verification: a flood cannot hold real moves back.
    const idle = !this.waiting;
    this.waiting = message;
    if (idle) {
      this.queue.then(() => {
        const next = this.waiting;
        this.waiting = null;
        if (next) this.adopt(next.log, next.p);
      });
    }
  }
  adopt(incoming, keys) {
    this.queue = this.queue.then(async () => {
      if (Array.isArray(keys)) {
        for (const team of [0, 1]) {
          if (!this.room.p[team] && keys[team]) await acceptKey(this.room, team, keys[team]);
        }
      }
      const verified = await verifyLog(this.room, incoming, this.checked);
      const { log, conflict } = mergeLog(this.log, verified);
      const fresh = conflict && !this.conflict;
      if (fresh) this.conflict = conflict;
      if (log === this.log && !fresh) return;
      this.log = log;
      if (!this.stopped) this.onChange(this);
    }).catch(() => {});
    return this.queue;
  }
  get state() { return replay(this.room, this.log); }
  online(team, now = Date.now()) { return now - this.seen[team] < ONLINE_FOR; }
  // The clock runs from the order choice by the signer's time; if that clock
  // is ahead of ours, from the moment we first saw it.
  startedAt(state = this.state) {
    if (state.startedAt === null) return null;
    this.orderSeen ??= Date.now();
    return Math.min(state.startedAt, this.orderSeen);
  }
  saved() { return { r: this.room.r, log: this.log, p: this.room.p }; }
  stop() {
    this.stopped = true;
    this.link?.stop();
  }
}
