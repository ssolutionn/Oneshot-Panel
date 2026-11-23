import { summarizeMatch } from './faceit.js';

export function safeQualificationUrl(value) {
  try {
    // faceit.js room links carry the {lang} placeholder; show them in Russian.
    const url = new URL(String(value || '').replace('{lang}', 'ru'));
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'www.faceit.com' ? url.href : '';
  } catch { return ''; }
}

export function validateQualificationId(value) {
  const id = String(value ?? '').trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : '';
}

export function qualificationIdCollisions(values) {
  const seen = new Set();
  const collisions = new Set();
  for (const value of values || []) {
    const id = String(value || '');
    if (!id) continue;
    if (seen.has(id)) collisions.add(id);
    seen.add(id);
  }
  return [...collisions];
}

export function validateQualificationConnect(value) {
  const text = String(value ?? '');
  return text.length > 0 && text.length <= 256 && !/[\u0000-\u001f\u007f]/.test(text) ? text : '';
}

export function normalizeQualificationMatch(raw) {
  const match = summarizeMatch(raw);
  // Build the roster in the SAME order summarizeMatch used for the title and
  // the score: FACEIT may return faction2 before faction1, and Object.entries
  // would then put the roster under the wrong name. A faction missing from the
  // payload contributes nothing.
  const byFaction = raw?.teams || {};
  const teams = (match.factions || []).filter(faction => faction in byFaction).map(faction => ({
    name: String(byFaction[faction]?.name || byFaction[faction]?.nickname || faction || ''),
    players: (Array.isArray(byFaction[faction]?.players) ? byFaction[faction].players
      : Array.isArray(byFaction[faction]?.roster) ? byFaction[faction].roster : []).map(player => ({
      id: validateQualificationId(player?.id || player?.player_id),
      nickname: String(player?.nickname || player?.nick || '')
    })).filter(player => player.id || player.nickname)
  }));
  return { match, teams, connect: null };
}

// VDO keeps only [A-Za-z0-9_] in an ID; a one-letter base reads as noise.
export const vdoSafeName = (text, max = 16) => {
  const base = String(text || '').normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').slice(0, max);
  return base.length >= 2 ? base : (base ? 'player' + base : 'cam');
};
const fnv = text => {
  let hash = 0x811c9dc5;
  for (const ch of String(text)) { hash ^= ch.codePointAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash;
};
const tail = (text, n) => {
  let hash = fnv(text), out = '';
  for (let i = 0; i < n; i++) {
    out += 'abcdefghijkmnpqrstuvwxyz23456789'[hash % 32];
    hash = Math.floor(hash / 32) + fnv(out);
  }
  return out;
};
// Stream IDs read as FACEIT nicknames so a player recognises his own link,
// One match = one stable room. Same input → same links after reload.
// FACEIT swaps faction1/faction2 between polls, so a room named after API order
// would change under players' feet. Canonical room sorts the team names;
// the tail depends only on championship+match, so the room never drifts.
export function qualificationVdo(championshipId, matchId, teams = []) {
  const tailPart = tail(`${championshipId}|${matchId}`, 6);
  const names = (teams || []).map(team => vdoSafeName(team.name, 12).toLowerCase());
  const sortedPrefix = [...names].sort().join('_') || 'match';
  const room = `${sortedPrefix}_${tailPart}`.slice(0, 60);
  const nicks = [];
  for (const team of teams || []) for (const player of team.players || []) nicks.push(player.nickname || '');
  const order = nicks.map((nick, index) => ({ nick, index }))
    .sort((a, b) => String(a.nick).localeCompare(String(b.nick)) || a.index - b.index);
  const used = new Map();
  const ids = new Array(nicks.length);
  for (const { nick, index } of order) {
    const base = vdoSafeName(nick, 16);
    const seen = (used.get(base.toLowerCase()) || 0) + 1;
    used.set(base.toLowerCase(), seen);
    ids[index] = seen === 1 ? base : `${base}_${seen}`;
  }
  return { room, players: nicks.map((nickname, i) => ({ nickname, id: ids[i] })) };
}

// FACEIT may put either team into faction1 between restarts; sort the sides by
// name so the desk never shows the same match mirrored. Index-based arrays
// (score/rounds) flip with the teams.
export function canonicalTeamOrder(record) {
  const names = (record?.match?.teams || []).map(name => String(name || ''));
  if (names.length !== 2 || names[0].toLowerCase() <= names[1].toLowerCase()) return record;
  const flip = arr => Array.isArray(arr) && arr.length === 2 ? [arr[1], arr[0]] : arr;
  record.match.teams = flip(record.match.teams);
  record.match.factions = flip(record.match.factions);
  record.match.score = flip(record.match.score);
  if (record.match.rounds) record.match.rounds = flip(record.match.rounds);
  if (Array.isArray(record.teams) && record.teams.length === 2) record.teams = flip(record.teams);
  return record;
}

// The director view lets the operator mute/reposition/see every stream of the room.
// Same shape as core.directorUrl, without the sheet-only password branch.
export function qualificationDirectorLink(room) {
  return `https://vdo.ninja/?director=${encodeURIComponent(room)}`;
}

// Pure filter so the toolbar behaviour is testable without the DOM.
// filter: 'all' | 'live' | 'soon' | 'done'
export function filterQualificationMatches(records, filter) {
  if (filter === 'all' || !filter) return records;
  return records.filter(r => {
    const m = r.match;
    if (filter === 'live') return m?.live;
    if (filter === 'done') return m?.done;
    if (filter === 'soon') return !m?.live && !m?.done;
    return true;
  });
}

// Text for one team, same contract as core.playerText (## Team / **Nick** <push>).
export function qualificationTeamText(teamName, players = []) {
  return `## ${teamName}\nOpen your link and turn on your camera.\n\n` +
    players.map(p => `**${p.nickname}** ${p.link}`).join('\n');
}

// Text for both teams in one message — operator sends this to chat, players see
// their team heading and their own nickname in the line.
export function qualificationMatchText(teams = []) {
  return teams.map(team => qualificationTeamText(team.name, team.players)).join('\n\n');
}

// A normalized record has a match summary; a raw FACEIT item does not. The
// summary may still carry its own `match` key tomorrow, so do not test for it.
const isRecord = value => Boolean(value?.match?.statusText !== undefined || value?.match?.teams);

// A fully successful poll replaces the card set, so matches that left the API
// disappear. If any list failed, the previous cards not seen are kept for the
// duration of the outage rather than silently vanishing from the desk.
export function mergeQualificationMatches(previous, settledResults) {
  const previousMap = previous instanceof Map ? previous : new Map(previous || []);
  const merged = new Map();
  let allSucceeded = true;
  for (const result of settledResults || []) {
    if (result?.status !== 'fulfilled' || !Array.isArray(result.value)) {
      allSucceeded = false;
      continue;
    }
    for (const raw of result.value) {
      if (merged.size >= 32) break;
      const normalized = isRecord(raw) ? raw : normalizeQualificationMatch(raw);
      if (normalized.match?.id) merged.set(normalized.match.id, normalized);
    }
  }
  if (!allSucceeded) {
    for (const [id, record] of previousMap) {
      if (merged.size >= 32) break;
      if (!merged.has(id)) merged.set(id, record);
    }
  }
  // Team order is stabilised in one place only: canonicalTeamOrder(), called
  // after every poll. A second swap here missed `rounds` and mirrored the score.
  return merged;
}

// Live matches first, then upcoming by scheduled time, finished at the bottom.
// Finished matches are kept (not dropped): they sink as new ones arrive.
// Within each group: live any order, upcoming ascending time, finished descending time.
export function sortQualificationMatches(records) {
  const isLive = r => r.match?.live;
  const isSoon = r => !r.match?.done && !r.match?.live;
  const isDone = r => r.match?.done;
  const when = r => Number(r.match?.scheduledAt) || 0;
  return [...records].sort((a, b) => {
    if (isLive(a) && !isLive(b)) return -1;
    if (isLive(b) && !isLive(a)) return 1;
    if (isDone(a) && isSoon(b)) return 1;
    if (isDone(b) && isSoon(a)) return -1;
    if (isDone(a) && isDone(b)) return when(b) - when(a); // newest finished first
    if (isSoon(a) && isSoon(b)) return when(a) - when(b); // soonest upcoming first
    return String(a.match?.id).localeCompare(String(b.match?.id));
  });
}

export function qualificationEvents(before, after) {
  if (!before || !after || before.id !== after.id) return [];
  const events = [];
  if (before.status !== after.status) events.push({ type: 'status', id: after.id, from: before.status, to: after.status });
  if (JSON.stringify(before.score) !== JSON.stringify(after.score)) events.push({ type: 'score', id: after.id, score: after.score });
  return events;
}
