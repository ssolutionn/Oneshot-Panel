// CS2 server log → a referee's journal: rounds, kills, damage, chat, bomb.
// The server sends its log lines with `logaddress_add_http` (damage needs
// `mp_logdetail 3`). Pure functions and one class, no I/O: the HTTP side is
// server/cs2-api.js. Log text comes from players (their names, their chat):
// everything here is data, never markup.
export const MAX_EVENTS = 30000;
const SIDE = { CT: 'CT', TERRORIST: 'T', T: 'T' };
const PLAYER = /^(.*)<(\d+)><([^>]*)><([^>]*)>$/;
const KEYED = (text, key) => text.match(new RegExp(`\\(${key} "([^"]*)"\\)`))?.[1];

// "Name<2><[U:1:123]><CT>" — a name may itself hold < and >, so the tail is read from the end.
export function parsePlayer(text) {
  const match = PLAYER.exec(String(text).trim());
  if (!match) return null;
  return { name: match[1], userid: Number(match[2]), steam: match[3], side: SIDE[match[4]] || '' };
}
const timeOf = line => {
  const match = /^L (\d\d)\/(\d\d)\/(\d{4}) - (\d\d):(\d\d):(\d\d)(?:\.\d+)?: /.exec(line);
  return match ? { clock: `${match[4]}:${match[5]}:${match[6]}`, rest: line.slice(match[0].length) } : { clock: '', rest: line.replace(/^L /, '') };
};

// One line → an event or null (lines that do not matter to a referee).
export function parseLine(raw) {
  const line = String(raw).replace(/[\r\n\0]+/g, '').trim();
  if (!line) return null;
  const { clock, rest } = timeOf(line);
  const base = { clock };
  let m;
  // "A" [x y z] killed "B" [x y z] with "ak47" (headshot penetrated)
  if ((m = /^"(.+?)" \[[^\]]*\] killed "(.+?)" \[[^\]]*\] with "([^"]*)"(.*)$/.exec(rest))) {
    const killer = parsePlayer(m[1]), victim = parsePlayer(m[2]);
    if (killer && victim) return { ...base, type: 'kill', killer, victim, weapon: m[3], headshot: /headshot/.test(m[4]), through: /penetrated/.test(m[4]) };
  }
  // "A" [x y z] attacked "B" [x y z] with "ak47" (damage "27") ... (health "73") (hitgroup "chest")
  if ((m = /^"(.+?)" \[[^\]]*\] attacked "(.+?)" \[[^\]]*\] with "([^"]*)"(.*)$/.exec(rest))) {
    const attacker = parsePlayer(m[1]), victim = parsePlayer(m[2]);
    if (attacker && victim) {
      return { ...base, type: 'damage', attacker, victim, weapon: m[3], damage: Number(KEYED(m[4], 'damage')) || 0,
        health: Number(KEYED(m[4], 'health')), hitgroup: KEYED(m[4], 'hitgroup') || '' };
    }
  }
  if ((m = /^"(.+?)" (say|say_team) "(.*)"\s*$/.exec(rest))) {
    const player = parsePlayer(m[1]);
    if (player) return { ...base, type: 'chat', player, team: m[2] === 'say_team', text: m[3] };
  }
  if ((m = /^"(.+?)" triggered "(Planted_The_Bomb|Defused_The_Bomb|Begin_Bomb_Defuse_With_Kit|Begin_Bomb_Defuse_Without_Kit|Dropped_The_Bomb|Got_The_Bomb)"/.exec(rest))) {
    const player = parsePlayer(m[1]);
    if (player) return { ...base, type: 'bomb', player, action: m[2] };
  }
  if ((m = /^World triggered "(Round_Start|Round_End|Match_Start|Game_Commencing|Restart_Round_[^"]*)"(?: on "([^"]*)")?/.exec(rest))) {
    const name = m[1];
    return { ...base, type: name === 'Round_Start' ? 'round_start' : name === 'Round_End' ? 'round_end' : name === 'Match_Start' ? 'match_start' : 'restart', map: m[2] || '' };
  }
  // Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "8") (T "7")
  if ((m = /^Team "(CT|TERRORIST)" triggered "([^"]+)" \(CT "(\d+)"\) \(T "(\d+)"\)/.exec(rest))) {
    return { ...base, type: 'round_result', winner: SIDE[m[1]], reason: m[2], ct: Number(m[3]), t: Number(m[4]) };
  }
  if ((m = /^Game Over: \S+\s+(\S+) score (\d+):(\d+)/.exec(rest))) return { ...base, type: 'game_over', map: m[1], ct: Number(m[2]), t: Number(m[3]) };
  if ((m = /^(?:Loading|Started) map "([^"]+)"/.exec(rest))) return { ...base, type: 'map', map: m[1] };
  if ((m = /^Team playing "(CT|TERRORIST)": (.+)$/.exec(rest))) return { ...base, type: 'team', side: SIDE[m[1]], name: m[2].trim() };
  if ((m = /^"(.+?)" (connected|entered the game|disconnected|switched from team <([^>]*)> to <([^>]*)>)/.exec(rest))) {
    const player = parsePlayer(m[1]);
    if (player) return { ...base, type: 'presence', player, action: m[2].startsWith('switched') ? 'switch' : m[2], to: SIDE[m[4]] || '' };
  }
  return null;
}

const secondsOf = clock => {
  const m = /^(\d\d):(\d\d):(\d\d)$/.exec(clock || '');
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

// What a referee reads, in one line.
export function describe(event) {
  const who = p => `${p.name}${p.side ? ` (${p.side})` : ''}`;
  switch (event.type) {
    case 'kill': return `${who(event.killer)} убил ${who(event.victim)} · ${event.weapon}${event.headshot ? ' · хедшот' : ''}${event.through ? ' · через стену' : ''}`;
    case 'damage': return `${who(event.attacker)} → ${who(event.victim)}: ${event.damage} урона (${event.weapon}${event.hitgroup ? ', ' + event.hitgroup : ''}), осталось ${Number.isFinite(event.health) ? event.health : '?'}`;
    case 'chat': return `${who(event.player)}${event.team ? ' [команда]' : ''}: ${event.text}`;
    case 'bomb': return `${who(event.player)}: ${({ Planted_The_Bomb: 'поставил бомбу', Defused_The_Bomb: 'разминировал бомбу', Begin_Bomb_Defuse_With_Kit: 'начал разминирование (с китом)', Begin_Bomb_Defuse_Without_Kit: 'начал разминирование', Dropped_The_Bomb: 'выронил бомбу', Got_The_Bomb: 'подобрал бомбу' })[event.action] || event.action}`;
    case 'round_start': return 'Раунд начался';
    case 'round_end': return 'Раунд закончился';
    case 'round_result': return `Победа ${event.winner} (${event.reason.replace('SFUI_Notice_', '')}) · счёт CT ${event.ct} : ${event.t} T`;
    case 'match_start': return `Матч начался${event.map ? ' на ' + event.map : ''}`;
    case 'game_over': return `Игра окончена · ${event.map} · CT ${event.ct} : ${event.t} T`;
    case 'map': return `Карта ${event.map}`;
    case 'team': return `Команда ${event.side}: ${event.name}`;
    case 'presence': return `${event.player.name}: ${({ connected: 'подключился', 'entered the game': 'вошёл в игру', disconnected: 'вышел', switch: 'перешёл' + (event.to ? ' в ' + event.to : '') })[event.action] || event.action}`;
    default: return event.type;
  }
}

// The journal: events in order, each with its round and the time since the
// round began. Round numbers follow the score (CT + T + 1), so they are the
// official ones even across the half-time side swap; before «Match_Start» it is
// warm-up (round 0).
export class Journal {
  constructor(limit = MAX_EVENTS, now = () => Date.now()) {
    Object.assign(this, { limit, now });
    this.events = [];
    this.seq = 0;
    this.lines = 0;
    this.reset();
    this.lastAt = 0;
  }
  reset() {
    Object.assign(this, { map: '', ct: 0, t: 0, round: 0, live: false, startedAt: 0, startedClock: null, teams: { CT: '', T: '' }, over: false });
  }
  // Lines may come in any batch size; unknown lines only count.
  push(text) {
    const added = [];
    for (const raw of String(text).split('\n')) {
      if (!raw.trim()) continue;
      this.lines++;
      const parsed = parseLine(raw);
      this.lastAt = this.now();
      if (!parsed) continue;
      const event = this.apply(parsed);
      if (event) added.push(event);
    }
    return added;
  }
  apply(event) {
    const at = this.now();
    switch (event.type) {
      case 'map': this.reset(); this.map = event.map; break;
      case 'match_start': case 'restart':
        if (event.type === 'match_start' || !this.live) { this.live = event.type === 'match_start'; this.ct = this.t = 0; this.round = 0; this.over = false; if (event.map) this.map = event.map; }
        break;
      case 'team': this.teams[event.side] = event.name; break;
      case 'round_start':
        this.round = this.live ? this.ct + this.t + 1 : 0;
        this.startedAt = at;
        this.startedClock = secondsOf(event.clock);
        break;
      case 'round_result': this.ct = event.ct; this.t = event.t; break;
      case 'game_over': this.over = true; this.ct = event.ct; this.t = event.t; break;
      default:
    }
    // Time in the round: the server's own clock when its lines carry one (the
    // lines come in batches, so receipt time would blur it), else when they came.
    const now = secondsOf(event.clock);
    const offset = !this.startedAt ? 0 : now !== null && this.startedClock !== null ?
      ((now - this.startedClock + 86400) % 86400) * 1000 : Math.max(0, at - this.startedAt);
    const stored = { ...event, seq: ++this.seq, at, round: this.round, offset };
    stored.line = describe(stored); // the whole event in words; a chat event keeps its own `text`
    this.events.push(stored);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    return stored;
  }
  since(seq = 0, limit = 2000) {
    const first = this.events.findIndex(event => event.seq > seq);
    return first < 0 ? [] : this.events.slice(first, first + limit);
  }
  status() {
    return { map: this.map, ct: this.ct, t: this.t, round: this.round, live: this.live, over: this.over, teams: { ...this.teams },
      lines: this.lines, lastAt: this.lastAt, seq: this.seq };
  }
  // A round as plain text, to paste into a chat when teams argue.
  roundText(round) {
    const rows = this.events.filter(event => event.round === round && !['round_end'].includes(event.type));
    if (!rows.length) return '';
    const clock = ms => `${String(Math.floor(ms / 60000)).padStart(1, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
    return `Раунд ${round}${this.map ? ' · ' + this.map : ''}\n` + rows.map(event => `[${clock(event.offset)}] ${event.line}`).join('\n');
  }
}
