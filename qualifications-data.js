import { summarizeMatch } from './faceit.js';

export function safeQualificationUrl(value) {
  try {
    const url = new URL(String(value || ''));
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
      const normalized = raw?.match ? raw : normalizeQualificationMatch(raw);
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
