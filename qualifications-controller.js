import { FaceitClient, FACEIT_PROXY, parseFaceitUrl } from './faceit.js';
import { pushUrl, vdoId } from './core.js';
import {
  normalizeQualificationMatch, mergeQualificationMatches, qualificationEvents,
  safeQualificationUrl, validateQualificationConnect, validateQualificationId, qualificationIdCollisions
} from './qualifications-data.js';

const POLL_MS = 20000;
const MAX_MATCHES = 32;
const MAX_CONNECT_LENGTH = 300;
const $ = id => typeof document === 'undefined' ? null : document.getElementById(id);
const identityKey = value => String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function matchQualificationPlayers(teams, snapshot) {
  const existing = [...(snapshot?.playersA || []), ...(snapshot?.playersB || [])].filter(player => player?.id && player?.room);
  const allPlayers = (teams || []).flatMap(team => team.players || []);
  const counts = new Map();
  for (const player of allPlayers) counts.set(player.id, (counts.get(player.id) || 0) + 1);
  return (teams || []).map(team => ({
    ...team,
    players: (team.players || []).map(player => {
      if (counts.get(player.id) > 1) return { ...player, camera: null, matchMethod: 'duplicate-id' };
      const nick = identityKey(player.nickname);
      const teamName = identityKey(team.name);
      const nickMatches = existing.filter(candidate => identityKey(candidate.nick) === nick);
      const exact = teamName ? nickMatches.filter(candidate => {
        const candidateTeam = identityKey(teamNameFromPlayer(candidate, snapshot));
        return candidateTeam === teamName;
      }) : [];
      const knownOtherTeam = nickMatches.some(candidate => identityKey(teamNameFromPlayer(candidate, snapshot)) &&
        identityKey(teamNameFromPlayer(candidate, snapshot)) !== teamName);
      const matches = exact.length ? exact : teamName && knownOtherTeam ? [] : nickMatches;
      const camera = matches.length === 1 ? matches[0] : null;
      return { ...player, camera, matchMethod: camera ? exact.length ? 'team-nickname' : 'nickname' : matches.length ? 'ambiguous' : 'missing' };
    })
  }));
}

function teamNameFromPlayer(player, snapshot) {
  if ((snapshot?.playersA || []).includes(player)) return snapshot?.a?.name || '';
  if ((snapshot?.playersB || []).includes(player)) return snapshot?.b?.name || '';
  return '';
}

function safeText(node, value) {
  if (node) node.textContent = String(value ?? '');
}

export function createQualificationsController({
  root = $('qualificationsView'),
  input = $('qualificationsUrl'),
  keyInput = $('qualificationsKey'),
  panel = typeof window !== 'undefined' ? window.oneshotPanel : null,
  rosterStatus = $('qualificationsRosterStatus'),
  status = $('qualificationsStatus'),
  list = $('qualificationsMatches'),
  clientFactory = key => new FaceitClient(key, (...args) => fetch(...args), { proxy: FACEIT_PROXY }),
  watchFactory = onChange => new window.CamWatch(onChange),
  notify = message => window.oneshotQualificationAlert?.(message),
  interval = POLL_MS
} = {}) {
  const state = {
    client: null, timer: null, generation: 0, inFlight: null, matches: new Map(),
    connects: new Map(), watchers: [], online: new Set(), checking: new Set(),
    seeded: false, stopped: true, lastError: '', championshipId: ''
  };

  const cameraAssignments = new Map();
  const streamFor = playerId => {
    const valid = validateQualificationId(playerId);
    const camera = valid ? cameraAssignments.get(valid) : null;
    return camera ? vdoId(camera.id) : '';
  };
  const cameraFor = playerId => cameraAssignments.get(validateQualificationId(playerId)) || null;

  function render() {
    if (!list || typeof document === 'undefined') return;
    const fragment = document.createDocumentFragment();
    for (const record of state.matches.values()) {
      const { match, teams, rosterAvailable } = record;
      const card = document.createElement('article');
      card.className = 'qualification-card';
      card.dataset.matchId = match.id;
      const heading = document.createElement('h3');
      safeText(heading, `${match.teams[0]} — ${match.teams[1]}`);
      card.append(heading);
      const score = document.createElement('p');
      safeText(score, `${match.statusText}: ${match.score[0]} : ${match.score[1]}`);
      card.append(score);
      if (!rosterAvailable) {
        const missing = document.createElement('p');
        missing.className = 'muted';
        safeText(missing, 'FACEIT не отдал состав');
        card.append(missing);
      } else {
        for (const team of teams) {
          const group = document.createElement('section');
          const name = document.createElement('h4');
          safeText(name, team.name);
          group.append(name);
          for (const player of team.players) {
            const row = document.createElement('p');
            const nick = document.createElement('span');
            safeText(nick, player.nickname);
            row.append(nick);
            const stream = streamFor(player.id);
            const assigned = cameraFor(player.id);
            const camera = document.createElement('span');
            safeText(camera, assigned ? state.checking.has(stream) ? 'Проверяем вебку' : state.online.has(stream) ? 'Вебка подключена' : 'Вебка не подключена' : player.matchMethod === 'ambiguous' ? 'Нужно уточнить игрока' : 'Нет камеры в OneShot');
            row.append(' ', camera);
            if (assigned?.id && assigned.room) {
              const copy = document.createElement('button');
              copy.type = 'button';
              copy.dataset.qualificationCopyPlayer = player.id;
              copy.setAttribute('aria-label', `Скопировать ссылку VDO.Ninja: ${player.nickname}, ${team.name}`);
              safeText(copy, 'Копировать ссылку');
              row.append(' ', copy);
            }
            group.append(row);
          }
          card.append(group);
        }
      }
      const href = safeQualificationUrl(record.raw?.faceit_url || match.url);
      if (href) {
        const link = document.createElement('a');
        link.href = href;
        link.rel = 'noopener';
        safeText(link, 'Матч FACEIT');
        card.append(link);
      }
      const connect = document.createElement('input');
      connect.type = 'text';
      connect.maxLength = MAX_CONNECT_LENGTH;
      connect.setAttribute('aria-label', `Ручная CS2 connect-команда для ${match.teams.join(' vs ')}`);
      connect.value = state.connects.get(match.id) || '';
      connect.addEventListener('input', () => {
        const value = validateQualificationConnect(connect.value);
        if (!value) {
          connect.value = '';
          state.connects.delete(match.id);
        } else {
          state.connects.set(match.id, value);
        }
      });
      card.append(connect);
      const copy = document.createElement('button');
      copy.type = 'button';
      safeText(copy, 'Копировать connect');
      copy.addEventListener('click', async () => {
        const value = state.connects.get(match.id);
        if (!value) return;
        try {
          await navigator.clipboard.writeText(value);
          safeText(status, 'Команда скопирована.');
        } catch {
          safeText(status, 'Не удалось скопировать команду.');
        }
      });
      card.append(copy);
      fragment.append(card);
    }
    list.replaceChildren(fragment);
  }

  function rebuildWatchers(snapshot) {
    for (const watcher of state.watchers) watcher.stop();
    state.watchers = [];
    state.online = new Set();
    state.checking = new Set();
    cameraAssignments.clear();
    const groups = new Map();
    for (const record of state.matches.values()) {
      for (const team of record.teams || []) for (const player of team.players || []) {
        const camera = player.camera;
        const id = camera ? vdoId(camera.id) : '';
        if (!camera || !id) continue;
        cameraAssignments.set(validateQualificationId(player.id), camera);
        const key = `${camera.room}\0${camera.password || ''}`;
        if (!groups.has(key)) groups.set(key, { room: camera.room, password: camera.password || '', ids: [] });
        groups.get(key).ids.push(id);
      }
    }
    const allIds = [...groups.values()].flatMap(group => group.ids);
    const collisions = new Set(qualificationIdCollisions(allIds));
    const safeGroups = [...groups.values()].map(group => ({
      ...group, ids: [...new Set(group.ids.filter(id => !collisions.has(id)))]
    })).filter(group => group.ids.length);
    if (safeGroups.length && typeof window !== 'undefined' && window.CamWatch) {
      const watcher = watchFactory((online, checking) => {
        state.online = online;
        state.checking = checking;
        render();
      });
      watcher.watch(safeGroups);
      state.watchers.push(watcher);
    }
    return snapshot;
  }

  async function poll() {
    if (state.stopped || state.inFlight) return state.inFlight;
    const generation = state.generation;
    const request = (async () => {
      try {
        const target = parseFaceitUrl(input?.value);
        if (!target || target.kind !== 'championship') throw new Error('Вставьте ссылку на чемпионат FACEIT, не на комнату матча.');
        if (state.championshipId && state.championshipId !== target.id) {
          state.matches = new Map();
          state.connects.clear();
          for (const watcher of state.watchers) watcher.stop();
          state.watchers = [];
          state.online = new Set();
          state.checking = new Set();
          cameraAssignments.clear();
          state.seeded = false;
          render();
        }
        state.championshipId = target.id;
        if (!state.client) state.client = clientFactory(keyInput?.value || '');
        const results = await Promise.allSettled(['ongoing', 'upcoming', 'past'].map(type => state.client.matches(target.id, type, MAX_MATCHES)));
        if (generation !== state.generation || state.stopped) return;
        const successes = results.filter(result => result.status === 'fulfilled');
        const previous = state.matches;
        const before = new Map(previous);
        const merged = mergeQualificationMatches(previous, results);
        if (!successes.length) throw new Error('FACEIT временно недоступен; последние данные сохранены.');
        state.matches = merged;
        state.seeded = true;
        const snapshot = panel?.snapshot?.();
        for (const record of state.matches.values()) {
          record.raw ||= record.match;
          record.teams = matchQualificationPlayers(record.teams, snapshot);
          record.rosterAvailable = record.teams.some(team => team.players.length > 0);
        }
        const events = [];
        for (const [id, record] of state.matches) {
          const prior = before.get(id)?.match;
          if (prior) events.push(...qualificationEvents(prior, record.match));
        }
        rebuildWatchers(snapshot);
        render();
        const rosterAvailable = [...state.matches.values()].some(record => record.rosterAvailable);
        safeText(rosterStatus, rosterAvailable ? '' : 'FACEIT не отдал участников матча в API.');
        safeText(status, results.every(result => result.status === 'fulfilled') ? 'Обновлено.' : 'Часть списков FACEIT недоступна; последние данные сохранены.');
        if (events.length) notify(`Обновился статус или счёт в ${events.length} матче FACEIT.`);
        if (results.some(result => result.status === 'rejected')) notify('Часть списков FACEIT недоступна.');
        state.lastError = '';
      } catch (error) {
        if (generation !== state.generation || state.stopped) return;
        state.lastError = error?.message || 'Не удалось обновить FACEIT.';
        safeText(status, state.lastError);
      }
    })();
    const wrapped = request.finally(() => {
      if (state.inFlight === wrapped) state.inFlight = null;
    });
    state.inFlight = wrapped;
    return wrapped;
  }

  function stop() {
    state.stopped = true;
    state.generation++;
    clearInterval(state.timer);
    state.timer = null;
    for (const watcher of state.watchers) watcher.stop();
    state.watchers = [];
  }

  async function start() {
    stop();
    state.stopped = false;
    state.generation++;
    state.client = null;
    state.timer = setInterval(() => { poll(); }, interval);
    await poll();
  }

  const clickHandler = event => {
    if (!event.target?.matches?.('[data-qualification-copy-player]')) return;
    const card = event.target.closest('[data-match-id]');
    const playerId = event.target.dataset.qualificationCopyPlayer;
    const camera = cameraFor(playerId);
    if (!camera?.id || !camera.room) return;
    const value = pushUrl(camera);
    navigator.clipboard?.writeText(value).catch(() => safeText(status, 'Не удалось скопировать ссылку.'));
  };
  root?.addEventListener('click', clickHandler);
  const submitHandler = event => {
    event.preventDefault();
    start();
  };
  $('qualificationsForm')?.addEventListener('submit', submitHandler);
  const viewHandler = event => {
    if (event.detail === 'qualifications') start();
    else stop();
  };
  if (typeof document !== 'undefined') document.addEventListener('oneshot:view', viewHandler);
  if (typeof window !== 'undefined') window.addEventListener('pagehide', stop);

  return {
    start, stop, poll, render, state,
    destroy() {
      stop();
      root?.removeEventListener('click', clickHandler);
      $('qualificationsForm')?.removeEventListener('submit', submitHandler);
      if (typeof document !== 'undefined') document.removeEventListener('oneshot:view', viewHandler);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', stop);
      state.connects.clear();
    }
  };
}

if (typeof window !== 'undefined' && $('qualificationsView')) {
  const controller = createQualificationsController();
  if (!$('qualificationsView').hidden) controller.start();
}
