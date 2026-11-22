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
  const teams = Object.entries(raw?.teams || {}).map(([faction, team]) => ({
    name: String(team?.name || team?.nickname || faction || ''),
    players: (Array.isArray(team?.players) ? team.players : Array.isArray(team?.roster) ? team.roster : []).map(player => ({
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
// and one match is one room. Same input gives the same links after a reload,
// else links sent to players die; a repeated nickname gets `_2`, `_3`.
export function qualificationVdo(championshipId, matchId, teams = []) {
  const prefix = (teams || []).map(team => vdoSafeName(team.name, 12).toLowerCase()).join('_') || 'match';
  const room = `${prefix}_${tail(`${championshipId}|${matchId}`, 6)}`.slice(0, 60);
  const used = new Map();
  const players = [];
  for (const team of teams || []) for (const player of team.players || []) {
    const base = vdoSafeName(player.nickname, 16);
    const seen = (used.get(base.toLowerCase()) || 0) + 1;
    used.set(base.toLowerCase(), seen);
    players.push({ nickname: player.nickname, id: seen === 1 ? base : `${base}_${seen}` });
  }
  return { room, players };
}

// Push link for a single player — identical format to core.pushUrl so the
// copied text is exactly what a player receives in the "Подготовка" tab.
export function qualificationPushLink({ id, room, password = '' }) {
  const pw = password ? `&password=${encodeURIComponent(password)}` : '';
  return `https://vdo.ninja/?room=${encodeURIComponent(room)}${pw}&broadcast&do&push=${encodeURIComponent(id)}`;
}

// Room link opens the VDO room so the operator sees all active streams of the match.
export function qualificationRoomLink(room) {
  return `https://vdo.ninja/?room=${encodeURIComponent(room)}&list`;
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
  return merged;
}

export function qualificationEvents(before, after) {
  if (!before || !after || before.id !== after.id) return [];
  const events = [];
  if (before.status !== after.status) events.push({ type: 'status', id: after.id, from: before.status, to: after.status });
  if (JSON.stringify(before.score) !== JSON.stringify(after.score)) events.push({ type: 'score', id: after.id, score: after.score });
  return events;
}
