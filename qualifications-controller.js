import { FaceitClient, FACEIT_PROXY, parseFaceitUrl, summarizeMatch } from './faceit.js';
import { vdoId, pushUrl } from './core.js';

const POLL_MS = 20000;
const MAX_MATCHES = 32;
const MAX_CONNECT_LENGTH = 300;
const $ = id => typeof document === 'undefined' ? null : document.getElementById(id);

function safeText(node, value) {
  if (node) node.textContent = String(value ?? '');
}

function connectValue(value) {
  const text = String(value ?? '');
  return text.length <= MAX_CONNECT_LENGTH && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

function faceitUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'www.faceit.com' ? url.href : '';
  } catch { return ''; }
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
  clientFactory = (key) => new FaceitClient(key, (...args) => fetch(...args), { proxy: FACEIT_PROXY }),
  watchFactory = (onChange) => new window.CamWatch(onChange),
  notify = (message) => { if (window.oneshotQualificationAlert) window.oneshotQualificationAlert(message); },
  interval = POLL_MS
} = {}) {
  const state = { client: null, timer: null, generation: 0, inFlight: null, matches: new Map(), connects: new Map(), watchers: [], seeded: false, stopped: true };

  function render() {
    if (!list || typeof document === 'undefined') return;
    const fragment = document.createDocumentFragment();
    for (const { summary, teams, rosterAvailable, raw } of state.matches.values()) {
      const card = document.createElement('article');
      card.className = 'qualification-card';
      card.dataset.matchId = summary.id;
      const heading = document.createElement('h3');
      safeText(heading, `${summary.teams[0]} — ${summary.teams[1]}`);
      card.append(heading);
      const score = document.createElement('p');
      safeText(score, `${summary.statusText}: ${summary.score[0]} : ${summary.score[1]}`);
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
            const stream = streamFor(summary.id, player.id);
            const link = document.createElement('a');
            link.href = pushUrl({ id: stream, room: room(), password: password() });
            link.rel = 'noopener';
            safeText(link, 'Ссылка игроку');
            row.append(' ', link);
            group.append(row);
          }
          card.append(group);
        }
      }
      const href = faceitUrl(raw?.faceit_url);
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
      connect.setAttribute('aria-label', 'Ручная CS2 connect-команда');
      connect.value = state.connects.get(summary.id) || '';
      connect.addEventListener('input', () => {
        const value = connectValue(connect.value);
        if (value === null) { connect.value = ''; state.connects.delete(summary.id); return; }
        if (value) state.connects.set(summary.id, value); else state.connects.delete(summary.id);
      });
      card.append(connect);
      const copy = document.createElement('button');
      copy.type = 'button';
      safeText(copy, 'Копировать connect');
      copy.addEventListener('click', async () => {
        const value = state.connects.get(summary.id);
        if (!value) return;
        try { await navigator.clipboard.writeText(value); safeText(status, 'Команда скопирована.'); }
        catch { safeText(status, 'Не удалось скопировать команду.'); }
      });
      card.append(copy);
      fragment.append(card);
    }
    list.replaceChildren(fragment);
  }

  function room() { return String(roomInput?.value || '').trim(); }
  function password() { return String(passwordInput?.value || '').trim(); }
  function streamFor(matchId, playerId) { return vdoId(`q_${matchId}_${playerId}`); }

  function rebuildWatchers() {
    for (const watcher of state.watchers) watcher.stop();
    state.watchers = [];
    const streamIds = [];
    const seen = new Set();
    for (const record of state.matches.values()) {
      for (const team of record.teams || []) for (const player of team.players || []) {
        const id = streamFor(record.summary.id, player.id);
        if (seen.has(id)) continue;
        seen.add(id);
        streamIds.push(id);
      }
    }
    if (room() && streamIds.length && typeof window !== 'undefined' && window.CamWatch) {
      const watcher = watchFactory((online, checking) => {
        state.online = online;
        state.checking = checking;
        render();
      });
      watcher.watch([{ room: room(), password: password(), ids: streamIds }]);
      state.watchers.push(watcher);
    }
  }

  async function poll() {
    if (state.stopped || state.inFlight) return state.inFlight;
    const generation = state.generation;
    const request = (async () => {
      try {
        const id = parseFaceitUrl(input?.value)?.id;
        if (!id) throw new Error('Вставьте ссылку на чемпионат FACEIT.');
        if (!state.client) state.client = clientFactory(keyInput?.value || '');
        const results = await Promise.allSettled(['ongoing', 'upcoming', 'past'].map(type => state.client.matches(id, type, MAX_MATCHES)));
        if (generation !== state.generation || state.stopped) return;
        let successes = 0;
        const incoming = new Map();
        results.forEach(result => {
          if (result.status !== 'fulfilled') return;
          successes++;
          for (const raw of result.value || []) {
            const summary = summarizeMatch(raw);
            if (!summary.id || incoming.has(summary.id)) continue;
            const prior = state.matches.get(summary.id);
            // Data extraction is delegated to qualifications-data.js when integrated; no unverified roster shape is guessed here.
            incoming.set(summary.id, prior ? { ...prior, summary, raw } : { summary, raw, teams: [], rosterAvailable: false });
          }
        });
        if (successes) {
          for (const [matchId, record] of incoming) state.matches.set(matchId, record);
          const all = [...state.matches.entries()].slice(0, MAX_MATCHES);
          state.matches = new Map(all);
          if (!state.seeded) state.seeded = true;
          rebuildWatchers();
          render();
          safeText(rosterStatus, 'Для определения состава нужен ответ FACEIT с подтверждённым публичным ростером.');
          safeText(status, results.every(r => r.status === 'fulfilled') ? 'Обновлено.' : 'Часть списков FACEIT недоступна; последние данные сохранены.');
          if (results.some(r => r.status === 'rejected')) notify('Часть списков FACEIT недоступна.');
        } else {
          safeText(status, 'FACEIT временно недоступен; последние данные сохранены.');
          notify('Ошибка обновления FACEIT.');
        }
      } catch (error) {
        if (generation !== state.generation || state.stopped) return;
        safeText(status, error?.message || 'Не удалось обновить FACEIT.');
      }
    })();
    state.inFlight = request.finally(() => {
      if (state.inFlight === wrapped) state.inFlight = null;
    });
    const wrapped = state.inFlight;
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
    if (event.target?.matches?.('[data-qualification-copy-player]')) {
      const card = event.target.closest('[data-match-id]');
      const playerId = event.target.dataset.qualificationCopyPlayer;
      const value = pushUrl({ id: streamFor(card?.dataset.matchId, playerId), room: room(), password: password() });
      navigator.clipboard?.writeText(value).catch(() => {});
    }
  };
  root?.addEventListener('click', clickHandler);

  return { start, stop, poll, render, state, destroy() { stop(); root?.removeEventListener('click', clickHandler); state.connects.clear(); } };
}
