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

function safeText(node, value) {
  if (node) node.textContent = String(value ?? '');
}

export function createQualificationsController({
  root = $('qualificationsView'),
  input = $('qualificationsUrl'),
  keyInput = $('qualificationsKey'),
  roomInput = $('qualificationsRoom'),
  passwordInput = $('qualificationsPassword'),
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
    seeded: false, stopped: true, lastError: ''
  };

  const room = () => String(roomInput?.value || '').trim();
  const password = () => String(passwordInput?.value || '');
  const streamFor = (matchId, playerId) => {
    const valid = validateQualificationId(playerId);
    return valid ? vdoId(`q_${matchId}_${valid}`) : '';
  };

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
            const stream = streamFor(match.id, player.id);
            const camera = document.createElement('span');
            safeText(camera, state.checking.has(stream) ? 'Проверяем вебку' : state.online.has(stream) ? 'Вебка подключена' : 'Вебка не подключена');
            row.append(' ', camera);
            if (stream && room()) {
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

  function rebuildWatchers() {
    for (const watcher of state.watchers) watcher.stop();
    state.watchers = [];
    state.online = new Set();
    state.checking = new Set();
    const streamIds = [];
    for (const record of state.matches.values()) {
      for (const team of record.teams || []) for (const player of team.players || []) {
        const id = streamFor(record.match.id, player.id);
        if (id) streamIds.push(id);
      }
    }
    const collisions = new Set(qualificationIdCollisions(streamIds));
    const ids = [...new Set(streamIds.filter(id => !collisions.has(id)))];
    if (room() && ids.length && typeof window !== 'undefined' && window.CamWatch) {
      const watcher = watchFactory((online, checking) => {
        state.online = online;
        state.checking = checking;
        render();
      });
      watcher.watch([{ room: room(), password: password(), ids }]);
      state.watchers.push(watcher);
    }
  }

  async function poll() {
    if (state.stopped || state.inFlight) return state.inFlight;
    const generation = state.generation;
    const request = (async () => {
      try {
        const target = parseFaceitUrl(input?.value);
        if (!target || target.kind !== 'championship') throw new Error('Вставьте ссылку на чемпионат FACEIT, не на комнату матча.');
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
        for (const record of state.matches.values()) record.raw ||= record.match;
        const events = [];
        for (const [id, record] of state.matches) {
          const prior = before.get(id)?.match;
          if (prior) events.push(...qualificationEvents(prior, record.match));
        }
        rebuildWatchers();
        render();
        const rosterAvailable = [...state.matches.values()].some(record => record.teams?.some(team => team.players?.length));
        safeText(rosterStatus, rosterAvailable ? '' : 'FACEIT не отдал подтверждённый публичный состав.');
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
    const matchId = card?.dataset.matchId;
    const playerId = event.target.dataset.qualificationCopyPlayer;
    const stream = streamFor(matchId, playerId);
    if (!stream || !room()) return;
    const value = pushUrl({ id: stream, room: room(), password: password() });
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
