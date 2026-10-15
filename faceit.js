// FACEIT Data API v4 for the Лобби tab: which matches of the tournament are
// running, when a map or a match ends, and the texts admins send to players.
// Pure functions (tested) plus a small fetch client; no DOM.
import { personKey } from './core.js';

export const FACEIT_API = 'https://open.faceit.com/data/v4';
// netlify/functions/faceit.mjs and server.js forward to the API when the
// browser may not call it directly (CORS).
export const FACEIT_PROXY = '/api/faceit';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// https://www.faceit.com/ru/championship/<uuid>/<name>, …/cs2/championship/…,
// a bare UUID, or a matchroom …/room/1-<uuid>.
export function parseFaceitUrl(value) {
  const text = String(value || '').trim();
  const room = new RegExp(`/room/(1-${UUID})`, 'i').exec(text);
  if (room) return { kind: 'match', id: room[1].toLowerCase() };
  const champ = new RegExp(`/championships?/(${UUID})`, 'i').exec(text);
  if (champ) return { kind: 'championship', id: champ[1].toLowerCase() };
  const bare = new RegExp(`^(${UUID})$`, 'i').exec(text);
  if (bare) return { kind: 'championship', id: bare[1].toLowerCase() };
  return null;
}

// The lobby field: a tournament link and/or match room links (several are
// allowed, separated by spaces or new lines).
export function parseFaceitTargets(value) {
  const text = String(value || '');
  const rooms = [...new Set([...text.matchAll(new RegExp(`(?:/room/|^|\\s)(1-${UUID})`, 'gi'))]
    .map(m => m[1].toLowerCase()))];
  const champ = new RegExp(`/championships?/(${UUID})`, 'i').exec(text)?.[1].toLowerCase() ||
    new RegExp(`^\\s*(${UUID})\\s*$`, 'i').exec(text)?.[1].toLowerCase() || '';
  return champ || rooms.length ? { champ, rooms } : null;
}

export const STATUS_RU = {
  SCHEDULED: 'по расписанию', CHECK_IN: 'чек-ин', CREATED: 'создан',
  VOTING: 'вето', CONFIGURING: 'настройка сервера', READY: 'готов к старту',
  ONGOING: 'идёт', FINISHED: 'закончен', CANCELLED: 'отменён', ABORTED: 'прерван',
  MANUAL_RESULT: 'результат вручную', PAUSED: 'пауза',
  SUBSTITUTION: 'замены', CAPTAIN_PICK: 'выбор капитанов'
};
const LIVE = new Set(['VOTING', 'CONFIGURING', 'READY', 'ONGOING', 'PAUSED']);
const DONE = new Set(['FINISHED', 'CANCELLED', 'ABORTED', 'MANUAL_RESULT']);

function factionName(match, faction) {
  const team = match?.teams?.[faction];
  return String(team?.name || team?.nickname || faction || '').trim();
}
// FACEIT dates are Unix seconds.
const when = value => Number.isFinite(value) && value > 0 ? value * 1000 : null;
// "de_mirage" → "Mirage" unless the vote lists the map's display name.
export function mapName(guid, entities = []) {
  const entity = entities.find(e => e && (e.guid === guid || e.game_map_id === guid || e.class_name === guid));
  if (entity?.name) return String(entity.name);
  const text = String(guid || '').replace(/^de_/, '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function summarizeMatch(raw) {
  const factions = Object.keys(raw?.teams || {}).sort();
  const [f1 = 'faction1', f2 = 'faction2'] = factions.length === 2 ? factions : ['faction1', 'faction2'];
  const score = raw?.results?.score || {};
  const maps = Array.isArray(raw?.detailed_results) ? raw.detailed_results.map(r => ({
    winner: r?.winner === f1 ? 0 : r?.winner === f2 ? 1 : null
  })) : [];
  const picks = raw?.voting?.map?.pick;
  const entities = Array.isArray(raw?.voting?.map?.entities) ? raw.voting.map.entities : [];
  const status = String(raw?.status || '').toUpperCase();
  return {
    id: String(raw?.match_id || ''),
    url: String(raw?.faceit_url || '').replace('{lang}', 'ru'),
    status, statusText: STATUS_RU[status] || status.toLowerCase(),
    live: LIVE.has(status), done: DONE.has(status),
    teams: [factionName(raw, f1), factionName(raw, f2)],
    factions: [f1, f2],
    score: [Number(score[f1]) || 0, Number(score[f2]) || 0],
    winner: raw?.results?.winner === f1 ? 0 : raw?.results?.winner === f2 ? 1 : null,
    maps, bestOf: Number(raw?.best_of) || null,
    picks: Array.isArray(picks) ? picks.map(guid => mapName(guid, entities)) : [],
    round: raw?.round ?? null, group: raw?.group ?? null,
    scheduledAt: when(raw?.scheduled_at), startedAt: when(raw?.started_at),
    finishedAt: when(raw?.finished_at)
  };
}

// Maps already decided: the series score or the per-map results, whichever
// FACEIT has filled in so far.
export function mapsPlayed(match) {
  return Math.max(match.score[0] + match.score[1], match.maps.filter(m => m.winner !== null).length);
}

// Events between two polls of the same match. A map that ends the series is
// reported once, as the end of the match.
export function matchEvents(before, after) {
  if (!after?.id) return [];
  if (!before) return [];
  const events = [];
  const ended = !before.done && after.done;
  const played = mapsPlayed(after), was = mapsPlayed(before);
  if (played > was && !ended) {
    for (let map = was + 1; map <= played; map++) {
      const result = after.maps[map - 1];
      events.push({ type: 'map', match: after, map, winner: result?.winner ?? null });
    }
  }
  if (ended) events.push({ type: after.status === 'FINISHED' ? 'match' : 'cancelled', match: after });
  else if (after.status === 'PAUSED' && before.status !== 'PAUSED') events.push({ type: 'paused', match: after });
  else if (before.status === 'PAUSED' && after.status !== 'PAUSED') events.push({ type: 'resumed', match: after });
  else if (!before.live && after.live && after.status !== before.status) {
    events.push({ type: 'start', match: after });
  }
  return events;
}

// /matches/{id}/stats after the match: "Mirage 13:4" per map, in the order
// of the match's teams.
export function mapScores(stats, teams) {
  const rounds = Array.isArray(stats?.rounds) ? stats.rounds : [];
  return rounds.map(round => {
    const map = mapName(round?.round_stats?.Map);
    const sides = (Array.isArray(round?.teams) ? round.teams : []).map(t => ({
      key: personKey(t?.team_stats?.Team), score: t?.team_stats?.['Final Score']
    }));
    const [a, b] = teams.map(name => sides.find(side => side.key && side.key === personKey(name)));
    const score = a && b ? `${a.score}:${b.score}` :
      String(round?.round_stats?.Score || '').replace(/\s*\/\s*/, ':');
    return score ? `${map} ${score}` : map;
  }).filter(Boolean);
}

export function scoreLine(match) {
  return `${match.teams[0]} ${match.score[0]}:${match.score[1]} ${match.teams[1]}`;
}
export function eventText(event) {
  const m = event.match;
  if (event.type === 'map') {
    const winner = event.winner === null ? '' : ` — карту взяли ${m.teams[event.winner]}`;
    return `Карта ${event.map}${m.picks[event.map - 1] ? ` (${m.picks[event.map - 1]})` : ''} закончилась${winner}. Счёт: ${scoreLine(m)}`;
  }
  if (event.type === 'match') return `Матч закончился: ${scoreLine(m)}`;
  if (event.type === 'paused') return `Пауза в матче ${m.teams[0]} vs ${m.teams[1]} (FACEIT)`;
  if (event.type === 'resumed') return `Матч ${m.teams[0]} vs ${m.teams[1]} продолжился`;
  if (event.type === 'cancelled') return `Матч ${m.teams[0]} vs ${m.teams[1]}: ${m.statusText}`;
  if (event.type === 'start') return `${m.teams[0]} vs ${m.teams[1]}: ${m.statusText}`;
  return '';
}

// "Next xx:07": players are in different time zones, so only minutes go out.
export function nextStart(finishedAt, delayMinutes = 10) {
  const date = new Date((finishedAt || Date.now()) + delayMinutes * 60000);
  return `xx:${String(date.getMinutes()).padStart(2, '0')}`;
}
export const DEFAULT_TEMPLATES = {
  thanks: 'GG WP, {team1} and {team2}! Thanks for the game.',
  next: 'Next {time}\n\n@{team1} @{team2}\n\nWait for command'
};
export function fillTemplate(template, values) {
  return String(template || '').replace(/\{(team1|team2|time|score|maps)\}/g, (_, key) => values[key] ?? '');
}

// proxy: absolute URL of FACEIT_PROXY on the panel's site, or '' to call the
// API only directly. After one failed direct call (CORS) the proxy is used.
export class FaceitClient {
  constructor(key, fetchImpl = (...args) => fetch(...args), { proxy = '' } = {}) {
    Object.assign(this, { key: String(key || '').trim(), fetchImpl, proxy, viaProxy: false });
  }
  send(url) {
    const headers = { Accept: 'application/json' };
    if (this.key) headers.Authorization = `Bearer ${this.key}`;
    return this.fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
  }
  async get(path, params = {}) {
    if (!this.key && !this.proxy) throw new Error('Нужен API-ключ FACEIT.');
    // No key in the panel: the site's proxy uses its own (hosting secret).
    if (!this.key) this.viaProxy = true;
    const direct = new URL(FACEIT_API + path);
    for (const [name, value] of Object.entries(params)) direct.searchParams.set(name, value);
    let response;
    if (!this.viaProxy) {
      try { response = await this.send(direct.href); } catch (error) {
        if (!this.proxy || error?.name === 'TimeoutError') throw new Error('FACEIT не отвечает. Проверь интернет.');
        this.viaProxy = true;
      }
    }
    if (this.viaProxy) {
      const proxied = new URL(this.proxy);
      proxied.search = new URLSearchParams({ path, ...params }).toString();
      try { response = await this.send(proxied.href); } catch {
        throw new Error('FACEIT не отвечает. Проверь интернет.');
      }
      if (!/json/.test(response.headers?.get?.('content-type') || 'json')) {
        throw new Error('Браузер не пускает запросы к FACEIT, а у сайта нет прокси /api/faceit (он есть на Netlify и в server.js).');
      }
    }
    if (response.ok) return response.json();
    // FACEIT explains errors as {errors: [{message}]}, the proxy as {error, message}.
    let body = {};
    try { body = await response.json(); } catch { /* no details */ }
    const detail = String(body?.errors?.[0]?.message || body?.message || '').slice(0, 200);
    if (body?.error === 'no-key') {
      throw new Error('Нужен API-ключ FACEIT: впиши его в поле или добавь секрет FACEIT_API_KEY в настройках хостинга.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('FACEIT не принял API-ключ: проверь ключ и разрешённые сайты в App Studio.' + (detail ? ` (${detail})` : ''));
    }
    if (response.status === 404) throw new Error('FACEIT не нашёл турнир или матч по этой ссылке.');
    if (response.status === 429) throw new Error('FACEIT просит реже обновлять: слишком много запросов.');
    throw new Error(`FACEIT ответил ошибкой ${response.status}${detail ? `: ${detail}` : '.'}`);
  }
  championship(id) { return this.get(`/championships/${id}`); }
  matches(id, type, limit = 20) {
    return this.get(`/championships/${id}/matches`, { type, offset: 0, limit }).then(r => r.items || []);
  }
  match(id) { return this.get(`/matches/${id}`); }
  stats(id) { return this.get(`/matches/${id}/stats`); }
}
