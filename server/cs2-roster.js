// Who is who: the SteamID of every player the server log has shown.
//
// The panel knows players by their nick (core.personKey), but a broadcast
// graphic, a HUD manager and a stats export all need the SteamID64, and the log
// is the only source that has it for a team with no HLTV page. Every kill, chat
// line and connection carries «name<userid><[U:1:x]><SIDE>», so the roster fills
// itself on the first warm-up round and then keeps what it learned.
//
// Pure functions plus one store class; the HTTP side is server/cs2-api.js.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { personKey } from '../core.js';
import { steamId64 } from './cs2-stats.js';

export const VERSION = 1;
// A roster is worth keeping, but not forever: entries older than this are
// dropped when the file is rewritten, so a rented PC does not accumulate the
// whole history of every team that ever played on it.
export const KEEP_DAYS = 400;

// The file's shape. `steam` keys are SteamID3 («[U:1:123]»): that is what the
// log gives and it never changes. `byNick` is the reverse lookup a nick-based
// panel needs, and it remembers how sure it is.
export function emptyRoster() {
  return { version: VERSION, players: {}, byNick: {} };
}

const isSteam3 = value => /^\[U:1:\d+\]$/.test(String(value || ''));

// One log identity → what we keep about it. A name may change (a player renames
// mid-match, a stand-in takes the slot), so every name ever seen is kept and the
// newest one is `name`.
export function learnFrom(events, roster = emptyRoster(), now = Date.now()) {
  const learned = [];
  for (const event of events || []) {
    // Every event kind carries its players in its own fields; walk them all.
    const people = [event.player, event.killer, event.victim, event.attacker].filter(Boolean);
    for (const person of people) {
      const steam = person.steam;
      if (!isSteam3(steam) || !person.name) continue; // «BOT» and empty: nothing to learn
      const entry = roster.players[steam] ||
        (roster.players[steam] = { steamid64: steamId64(steam), names: [], name: '', seen: 0, games: 0, side: '' });
      entry.steamid64 = entry.steamid64 || steamId64(steam);
      if (!entry.names.includes(person.name)) entry.names.push(person.name);
      entry.name = person.name;
      if (person.side) entry.side = person.side;
      if (event.game > entry.games) entry.games = event.game;
      const changed = entry.seen !== now;
      entry.seen = now;
      // The nick → SteamID index. A nick that already points elsewhere is a
      // stand-in or a rename: keep both, remember the conflict, prefer the one
      // seen most recently, and say so instead of guessing silently.
      const nick = personKey(person.name);
      if (!nick) continue;
      const known = roster.byNick[nick];
      roster.byNick[nick] = known && known.steam !== steam
        ? { steam, nick: person.name, since: now, previous: known.steam, conflicts: (known.conflicts || 0) + 1 }
        : { steam, nick: person.name, since: now, conflicts: known?.conflicts || 0 };
      if (changed) learned.push(entry);
    }
  }
  return learned.length ? { roster, learned: learned.length } : null;
}

// A nick → SteamID64, the way the panel asks for it: by the same personKey the
// card and the photo matching use, so «SeNka», «senka» and «senka.`» are one
// player. `exact` also tries the name as it is, for nicks whose punctuation the
// log mangled.
export function steamidOf(roster, nick, { team = '' } = {}) {
  const key = personKey(nick);
  if (!key) return '';
  const candidates = Object.values(roster.byNick || {})
    .filter(entry => personKey(entry.nick) === key);
  if (!candidates.length) return '';
  // Several SteamIDs behind one nick: the most recently seen wins, so a stand-in
  // who played last week does not overwrite today's player.
  candidates.sort((a, b) => b.since - a.since);
  const player = roster.players[candidates[0].steam];
  if (!player) return '';
  // A team narrows it down when the same nick played for two teams.
  if (team && player.team && personKey(player.team) !== personKey(team)) return '';
  return player.steamid64;
}

// Roster + the panel's own catalogs (assets/players, assets/teams) → the rows a
// broadcast graphic or a HUD manager import needs. `steamid` is empty for a
// player the log has not shown yet, and `source` says where it came from, so a
// missing one is visible instead of silent.
export function mergeWithCatalog(roster, players = [], teams = {}) {
  const rows = [];
  for (const entry of players || []) {
    const nick = entry.nick || '';
    const team = entry.team || '';
    if (!nick) continue;
    const steamid64 = entry.steamid64 || steamidOf(roster, nick, { team });
    rows.push({
      team, nick, steamid64,
      source: entry.steamid64 ? 'catalog' : steamid64 ? 'log' : '',
      file: entry.file || '', hltv: entry.hltv || '', role: entry.role || ''
    });
  }
  // Players the log saw but the catalog does not know: a stand-in, a last-minute
  // swap, a team nobody entered. They are listed too, because a graphic that
  // silently drops a player is worse than one that shows an unknown nick.
  const known = new Set(rows.map(row => personKey(row.nick)));
  for (const [steam, player] of Object.entries(roster.players || {})) {
    if (!player.name || known.has(personKey(player.name))) continue;
    rows.push({ team: player.team || '', nick: player.name, steamid64: player.steamid64 || steamId64(steam),
      source: 'log', file: '', hltv: '', role: '', steam });
  }
  return rows.sort((a, b) => a.team.localeCompare(b.team, 'ru') || a.nick.localeCompare(b.nick, 'ru'));
}

// Drop entries nobody has seen for a long time; called on save, not on read, so
// a slow disk never delays a log line.
export function prune(roster, now = Date.now(), keepDays = KEEP_DAYS) {
  const before = now - keepDays * 86400000;
  let dropped = 0;
  for (const [steam, player] of Object.entries(roster.players || {})) {
    if (player.seen && player.seen < before) { delete roster.players[steam]; dropped++; }
  }
  for (const [nick, entry] of Object.entries(roster.byNick || {})) {
    if (!roster.players[entry.steam]) delete roster.byNick[nick];
  }
  return dropped;
}

// The roster on disk. Written through, read at start: the panel is one process,
// so there is nothing to lock.
export class RosterStore {
  constructor({ dir, now = Date.now() } = {}) {
    Object.assign(this, { dir, now });
    this.file = dir ? path.join(dir, 'roster.json') : '';
    this.roster = emptyRoster();
    this.loaded = false;
  }
  load() {
    if (!this.file || this.loaded) return this.roster;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved && typeof saved === 'object' && saved.players && saved.byNick) {
        this.roster = { version: VERSION, players: saved.players, byNick: saved.byNick };
      }
    } catch { /* no file yet, or a broken one: start empty */ }
    this.loaded = true;
    return this.roster;
  }
  // Feed journal events; saves only when something was actually learned, so a
  // quiet server does not rewrite the file every batch.
  push(events) {
    this.load();
    const result = learnFrom(events, this.roster, this.now());
    if (result) this.save();
    return result;
  }
  save() {
    if (!this.file) return false;
    try {
      prune(this.roster, this.now());
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.roster, null, 1) + '\n', { mode: 0o600 });
      return true;
    } catch { return false; }
  }
  list() {
    this.load();
    return Object.values(this.roster.players)
      .sort((a, b) => b.seen - a.seen)
      .map(({ names, ...player }) => ({ ...player, names }));
  }
  size() { this.load(); return Object.keys(this.roster.players).length; }
}
