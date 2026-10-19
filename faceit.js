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

// faceit_url goes into a link; only a real FACEIT address may become one.
function faceitRoomUrl(value) {
  try {
    const url = new URL(String(value || '').replace('{lang}', 'ru'));
    return url.protocol === 'https:' && /(^|\.)faceit\.com$/.test(url.hostname) ? url.href : '';
  } catch { return ''; }
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
  const bestOf = Number(raw?.best_of) || null;
  const live = LIVE.has(status), done = DONE.has(status);
  const given = [Number(score[f1]) || 0, Number(score[f2]) || 0];
  const wins = [0, 1].map(t => maps.filter(m => m.winner === t).length);
  // While a map is played FACEIT puts that map's rounds into results.score;
  // the series score then comes from the finished maps.
  const rounds = live && !(given[0] === wins[0] && given[1] === wins[1]) ? given : null;
  return {
    id: String(raw?.match_id || ''),
    url: faceitRoomUrl(raw?.faceit_url),
    status, statusText: STATUS_RU[status] || status.toLowerCase(),
    live, done,
    teams: [factionName(raw, f1), factionName(raw, f2)],
    factions: [f1, f2],
    score: rounds ? wins : given, rounds,
    winner: raw?.results?.winner === f1 ? 0 : raw?.results?.winner === f2 ? 1 : null,
    maps, bestOf,
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

// CS2 (MR12): a map is won at 13; from 12:12 overtime is played in sixes,
// first to 4 (16, 19, 22, …), always by at least two rounds.
export function mapWon(a, b) {
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return hi >= 13 && (hi - 13) % 3 === 0 && hi - lo >= 2;
}
// The team one round away from taking the map, or null.
export function mapPointTeam(a, b) {
  if (mapWon(a, b)) return null;
  return mapWon(a + 1, b) ? 0 : mapWon(a, b + 1) ? 1 : null;
}

// Events between two polls of the same match. Each map gives at most one
// "map point" and one "map taken"; the map that decides the series is
// reported once, as the end of the match. `after.sent` remembers what was
// reported, so repeated polls never repeat an alert.
// The series is over: a majority of maps, or every map of a BO2 played.
export function seriesOver(score, bestOf) {
  const best = bestOf || 1;
  return Math.max(score[0], score[1]) >= Math.floor(best / 2) + 1 || score[0] + score[1] >= best;
}
export function matchEvents(before, after) {
  if (!after?.id) return [];
  const sent = after.sent = new Set(before?.sent || []);
  const decided = after.maps.filter(m => m.winner !== null).length;
  // The map being played: rounds dropping back means the next map started,
  // but only after a won map or a big drop (a round backup restore takes
  // back a round or two and is not a new map).
  const rounds = after.rounds, prev = before?.rounds;
  const drop = rounds && prev ? prev[0] + prev[1] - rounds[0] - rounds[1] : 0;
  const nextMap = drop > 0 && (mapWon(prev[0], prev[1]) || drop >= 6);
  after.liveMap = Math.max(decided + 1, !before ? 1 : (before.liveMap || 1) + (nextMap ? 1 : 0));
  if (!before) {
    // First sight: remember what has already happened, alert nothing —
    // including a map point or a won map on the live map after a reload.
    for (let map = 1; map <= mapsPlayed(after); map++) sent.add(`map:${map}`);
    if (after.done) sent.add('match');
    if (after.live && rounds) {
      if (mapWon(rounds[0], rounds[1])) sent.add(`map:${after.liveMap}`).add(`point:${after.liveMap}`);
      else if (mapPointTeam(rounds[0], rounds[1]) !== null) sent.add(`point:${after.liveMap}`);
    }
    return [];
  }
  const events = [];
  const ended = !before.done && after.done;
  const played = mapsPlayed(after);
  if (!ended) {
    for (let map = 1; map <= played; map++) {
      if (sent.has(`map:${map}`)) continue;
      sent.add(`map:${map}`);
      const winner = after.maps[map - 1]?.winner ?? null;
      if (winner !== null && seriesOver(after.score, after.bestOf)) continue; // the match event says it
      events.push({ type: 'map', match: after, map, winner });
    }
  }
  if (after.live && rounds && !ended) {
    const map = after.liveMap, [a, b] = rounds;
    if (mapWon(a, b) && !sent.has(`map:${map}`)) {
      sent.add(`map:${map}`).add(`point:${map}`);
      const winner = a > b ? 0 : 1;
      const score = [0, 1].map(t => after.score[t] + (t === winner && decided < map ? 1 : 0));
      const view = { ...after, score };
      const over = seriesOver(score, after.bestOf);
      if (over && !sent.has('match')) {
        sent.add('match');
        events.push({ type: 'match', match: view, map, rounds });
      } else if (!over) {
        events.push({ type: 'map', match: view, map, winner, rounds });
      }
    } else {
      const team = mapPointTeam(a, b);
      if (team !== null && !sent.has(`point:${map}`) && !sent.has(`map:${map}`)) {
        sent.add(`point:${map}`);
        events.push({ type: 'mappoint', match: after, map, team, rounds });
      }
    }
  }
  if (ended && after.status === 'FINISHED') {
    // Reported already from the rounds: only the bookkeeping (texts, stats) is left.
    events.push({ type: sent.has('match') ? 'final' : 'match', match: after });
    sent.add('match');
  } else if (ended) events.push({ type: 'cancelled', match: after });
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
  const mapLabel = `Карта ${event.map}${m.picks?.[event.map - 1] ? ` (${m.picks[event.map - 1]})` : ''}`;
  const rounds = event.rounds ? `, ${Math.max(...event.rounds)}:${Math.min(...event.rounds)}` : '';
  if (event.type === 'mappoint') {
    return `${mapLabel}: мап-поинт у ${m.teams[event.team]} — ${event.rounds[0]}:${event.rounds[1]}`;
  }
  if (event.type === 'map') {
    const winner = event.winner === null ? '' : ` — карту взяли ${m.teams[event.winner]}${rounds}`;
    return `${mapLabel} закончилась${winner}. Счёт по картам: ${scoreLine(m)}`;
  }
  if (event.type === 'match') return `Матч закончился: ${scoreLine(m)}${rounds ? ` (последняя карта${rounds})` : ''}`;
  if (event.type === 'final') return `Итог матча на FACEIT: ${scoreLine(m)}`;
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
    let viaProxy = this.viaProxy;
    if (!viaProxy) {
      try { response = await this.send(direct.href); } catch (error) {
        if (!this.proxy || error?.name === 'TimeoutError') throw new Error('FACEIT не отвечает. Проверь интернет.');
        // Only this request: a moment offline must not route the rest of the
        // day through the proxy (that switch is kept once the proxy answers).
        viaProxy = true;
      }
      // A client-side key may be refused for this site's address: the same
      // request through the site's proxy leaves from the server instead.
      if (!viaProxy && this.proxy && [400, 401, 403].includes(response.status)) viaProxy = true;
    }
    if (viaProxy) {
      const proxied = new URL(this.proxy);
      proxied.search = new URLSearchParams({ path, ...params }).toString();
      try { response = await this.send(proxied.href); } catch {
        throw new Error('FACEIT не отвечает. Проверь интернет.');
      }
      if (!/json/.test(response.headers?.get?.('content-type') || 'json')) {
        throw new Error('Браузер не пускает запросы к FACEIT, а у сайта нет прокси /api/faceit (он есть на Netlify и в server.js).');
      }
    }
    if (response.ok) {
      if (viaProxy && !this.viaProxy) this.viaProxy = true;
      return response.json();
    }
    // FACEIT explains errors as {errors: [{message}]}, the proxy as {error, message};
    // anything else is shown as it came, so a refusal always says why.
    let body = {}, raw = '';
    try {
      raw = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
      body = JSON.parse(raw);
    } catch { /* not JSON */ }
    const request = `${path.split('/').filter(Boolean).slice(-1)[0]}${params.type ? ' ' + params.type : ''}`;
    const detail = String(body?.errors?.[0]?.message || body?.message || body?.error ||
      raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || 'пустой ответ').slice(0, 200) +
      ` [${request}${viaProxy ? ', через прокси' : ''}]`;
    if (body?.error === 'no-key') {
      throw new Error('Нужен API-ключ FACEIT: впиши его в поле или добавь секрет FACEIT_API_KEY в настройках хостинга.');
    }
    if (/invalid_token/i.test(detail)) {
      throw new Error('FACEIT не принял API-ключ (invalid_token): ключ неверный или не подходит для запросов с сервера. ' +
        'Создай в App Studio ключ Server side, положи его секретом FACEIT_API_KEY в настройках хостинга, а поле ключа в лобби оставь пустым.');
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
