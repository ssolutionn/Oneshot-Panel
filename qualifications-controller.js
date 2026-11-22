import { FaceitClient, FACEIT_PROXY, parseFaceitUrl } from './faceit.js';
import { pushUrl, vdoId } from './core.js';
import { CamWatch } from './vdo.js';
import { showNotification } from './notifications.js';
import {
  normalizeQualificationMatch, mergeQualificationMatches, qualificationEvents,
  safeQualificationUrl, validateQualificationConnect, validateQualificationId, qualificationIdCollisions,
  qualificationVdo, qualificationPushLink, qualificationRoomLink, qualificationTeamText, qualificationMatchText
} from './qualifications-data.js';

const POLL_MS = 20000;
const URL_STORE = 'oneshot-qualifications';
const savedUrl = () => {
  try { return String(JSON.parse(localStorage.getItem(URL_STORE)) || ''); } catch { return ''; }
};
const MAX_MATCHES = 32;
const MAX_CONNECT_LENGTH = 256; // same cap as validateQualificationConnect
const $ = id => typeof document === 'undefined' ? null : document.getElementById(id);
const setsEqual = (a, b) => a.size === b.size && [...a].every(value => b.has(value));
const identityKey = value => String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// `allTeams` is window.oneshotPanel.teams(): every team parsed from the sheet,
// so a 32-match championship is not limited to the two teams picked for air.
export function matchQualificationPlayers(teams, snapshot, allTeams = []) {
  const roster = allTeams.flatMap(team => (team.players || []).map(player => ({ ...player, teamName: team.name })))
    .concat([...(snapshot?.playersA || []).map(player => ({ ...player, teamName: snapshot?.a?.name || '' })),
      ...(snapshot?.playersB || []).map(player => ({ ...player, teamName: snapshot?.b?.name || '' }))])
    .filter(player => player?.id && player?.room);
  // The picked match is also part of the sheet roster; count each player once.
  const seen = new Set();
  const existing = roster.filter(player => {
    const key = `${player.key || player.id}\0${player.room}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
      // A player carrying his own team (sheet roster) is compared by it; the
      // selected-two view falls back to finding the player in playersA/playersB.
      const candidateTeam = candidate => identityKey(candidate.teamName || teamNameFromPlayer(candidate, snapshot));
      const exact = teamName ? nickMatches.filter(candidate => candidateTeam(candidate) === teamName) : [];
      const knownOtherTeam = nickMatches.some(candidate => candidateTeam(candidate) && candidateTeam(candidate) !== teamName);
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

// A camera tick or poll must not wipe the field the operator is typing into.
export function inputFocusedIn(list) {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  return Boolean(list?.contains?.(active) && active?.tagName === 'INPUT' && active.type === 'text');
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
  alert = $('qualificationsAlert'),
  clientFactory = key => new FaceitClient(key, (...args) => fetch(...args),
    { proxy: typeof location === 'undefined' ? FACEIT_PROXY : new URL(FACEIT_PROXY, location.origin).href }),
  watchFactory = onChange => new CamWatch(onChange),
  vdoFactory = qualificationVdo,
  notify = (message, { error = false } = {}) => {
    if (alert) {
      alert.textContent = message;
      alert.hidden = !error;
    }
    void showNotification('Oneshot · Квалификации', message, { tag: 'oneshot-qualifications', section: 'qualifications' });
  },
  interval = POLL_MS
} = {}) {
  const state = {
    client: null, timer: null, generation: 0, inFlight: null, matches: new Map(),
    connects: new Map(), watcher: null, online: new Set(), checking: new Set(),
    seeded: false, stopped: true, lastError: '', championshipId: '', degraded: false, down: false, rosterCache: new Map()
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
    if (inputFocusedIn(list)) return;
    const fragment = document.createDocumentFragment();
    for (const record of state.matches.values()) {
      const { match, teams, rosterAvailable } = record;
      const card = document.createElement('article');
      card.className = 'qcard';
      card.dataset.matchId = match.id;
      const live = match.status === 'ONGOING';
      const soon = match.status === 'SCHEDULED';
      const done = match.status === 'FINISHED' || match.status === 'CANCELLED';
      card.dataset.state = live ? 'live' : soon ? 'soon' : 'done';

      // Top bar: status chip + score
      const top = document.createElement('header');
      top.className = 'qcard-top';
      const chip = document.createElement('span');
      chip.className = 'qchip';
      safeText(chip, live ? 'идёт' : soon ? 'скоро' : 'завершён');
      top.append(chip);
      const score = document.createElement('span');
      score.className = 'qscore';
      safeText(score, `${match.score[0]} : ${match.score[1]}`);
      top.append(score);
      card.append(top);

      // Title with teams
      const title = document.createElement('h3');
      title.className = 'qcard-title';
      const t0 = document.createElement('span');
      safeText(t0, teams[0]?.name || match.teams[0]);
      const vs = document.createElement('span');
      vs.className = 'qvs';
      safeText(vs, ' vs ');
      const t1 = document.createElement('span');
      safeText(t1, teams[1]?.name || match.teams[1]);
      title.append(t0, vs, t1);
      card.append(title);

      // Teams with players
      if (rosterAvailable) {
        const qteams = document.createElement('div');
        qteams.className = 'qteams';
        for (let idx = 0; idx < teams.length; idx++) {
          const team = teams[idx];
          const section = document.createElement('section');
          section.className = 'qteam';
          const h4 = document.createElement('h4');
          safeText(h4, team.name);
          const count = document.createElement('span');
          count.className = 'qcount';
          const onlineCount = team.players.filter(p => {
            const stream = streamFor(p.id);
            return stream && state.online.has(stream);
          }).length;
          safeText(count, `${onlineCount}/${team.players.length} онлайн`);
          h4.append(' ', count);
          section.append(h4);
          const ul = document.createElement('ul');
          for (const player of team.players) {
            const li = document.createElement('li');
            const cam = player.camera;
            const stream = streamFor(player.id);
            const online = Boolean(stream) && state.online.has(stream);
            const checking = Boolean(stream) && state.checking.has(stream);
            li.dataset.cam = online ? 'online' : checking ? 'checking' : 'off';
            const dot = document.createElement('span');
            dot.className = 'qdot';
            li.append(dot);
            const nick = document.createElement('span');
            nick.className = 'qnick';
            safeText(nick, player.nickname);
            li.append(nick);
            const acts = document.createElement('span');
            acts.className = 'qacts';
            // Player push link
            if (cam?.id) {
              const copy = document.createElement('button');
              copy.type = 'button';
              copy.dataset.qCopyPush = player.nickname;
              copy.setAttribute('aria-label', `Ссылка VDO.Ninja для ${player.nickname}`);
              safeText(copy, 'Ссылка');
              acts.append(copy);
            }
            li.append(acts);
            ul.append(li);
          }
          section.append(ul);
          qteams.append(section);
        }
        card.append(qteams);
      } else {
        const missing = document.createElement('p');
        missing.className = 'muted';
        safeText(missing, 'FACEIT не отдал состав');
        card.append(missing);
      }

      // Footer: four clear actions only, no jargon.
      const foot = document.createElement('footer');
      foot.className = 'qcard-foot';
      if (record.room) {
        const openRoom = document.createElement('button');
        openRoom.type = 'button';
        openRoom.className = 'qprimary';
        openRoom.dataset.qOpenRoom = '';
        safeText(openRoom, 'Открыть комнату');
        foot.append(openRoom);
      }
      const copyAll = document.createElement('button');
      copyAll.type = 'button';
      copyAll.dataset.qCopyAll = '';
      safeText(copyAll, 'Скопировать все ссылки');
      foot.append(copyAll);

      const href = safeQualificationUrl(record.raw?.faceit_url || match.url);
      if (href) {
        const link = document.createElement('a');
        link.className = 'qlink';
        link.href = href;
        link.rel = 'noopener';
        safeText(link, 'Матч на FACEIT ↗');
        foot.append(link);
      }

      const connectRow = document.createElement('div');
      connectRow.className = 'qconnect-row';
      const connect = document.createElement('input');
      connect.type = 'text';
      connect.className = 'qconnect';
      connect.maxLength = MAX_CONNECT_LENGTH;
      connect.placeholder = 'connect 1.2.3.4:27015';
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
      connectRow.append(connect);
      const copyConnect = document.createElement('button');
      copyConnect.type = 'button';
      copyConnect.dataset.qCopyConnect = '';
      safeText(copyConnect, 'Копировать');
      copyConnect.addEventListener('click', async () => {
        const value = state.connects.get(match.id);
        if (!value) return;
        try {
          await navigator.clipboard.writeText(value);
          safeText(status, 'Команда скопирована.');
        } catch {
          safeText(status, 'Не удалось скопировать команду.');
        }
      });
      connectRow.append(copyConnect);
      foot.append(connectRow);

      card.append(foot);
      fragment.append(card);
    }
    if (!state.matches.size) {
      const empty = document.createElement('div');
      empty.className = 'qualifications-empty';
      safeText(empty, 'Матчей нет. Вставьте ссылку на чемпионат FACEIT.');
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
  }

  // Only watch live matches and upcoming matches starting within 1 hour.
// Otherwise 32 matches × 10 players = 320 hidden iframes, and CamWatch reconnects waste resources.
  const isWatched = (record, now = Date.now()) => {
    const m = record.match;
    if (m.status === 'ONGOING') return true;
    if (m.status === 'SCHEDULED' && m.scheduledAt && m.scheduledAt - now < 60 * 60 * 1000) return true;
    return false;
  };

  const rebuildWatchers = snapshot => {
    state.online = new Set();
    state.checking = new Set();
    cameraAssignments.clear();
    const groups = new Map();
    for (const record of state.matches.values()) {
      if (!isWatched(record)) continue;
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
    // CamWatch keeps an unchanged room's iframe, so a steady camera list keeps
    // one signalling session across polls instead of reconnecting every tick.
    if (!state.watcher && safeGroups.length) {
      state.watcher = watchFactory((online, checking) => {
        const same = setsEqual(state.online, online) && setsEqual(state.checking, checking);
        state.online = online;
        state.checking = checking;
        if (!same) render();
      });
    }
    state.watcher?.watch(safeGroups);
    return snapshot;
  };

  // The championship matches list can omit players; match details carry the
  // roster. One detail call per room id, cached until the championship changes.
  async function hydrateRosters() {
    if (typeof state.client?.match !== 'function') return;
    const wanted = [];
    for (const record of state.matches.values()) {
      if (record.teams.some(team => team.players.length)) continue;
      const id = record.match?.id || '';
      if (!/^1-[0-9a-f-]{36}$/i.test(id)) continue;
      if (!state.rosterCache.has(id)) wanted.push(id);
    }
    await Promise.all([...new Set(wanted)].map(async id => {
      try { state.rosterCache.set(id, await state.client.match(id)); }
      catch { /* retry on a later poll rather than freezing the empty roster */ }
    }));
    for (const record of state.matches.values()) {
      if (record.teams.some(team => team.players.length)) continue;
      const detail = state.rosterCache.get(record.match?.id);
      // Only a real match answer may replace the list data; a stray payload
      // (proxy error body, an {items} list) must not erase the existing card.
      if (detail?.match_id) Object.assign(record, normalizeQualificationMatch(detail));
    }
  }

  async function poll() {
    if (state.stopped || state.inFlight) return state.inFlight;
    const generation = state.generation;
    const request = (async () => {
      try {
        const target = parseFaceitUrl(input?.value);
        if (!input?.value) {
          state.stopped = true;
          clearInterval(state.timer);
          state.timer = null;
          state.watcher?.stop();
          state.watcher = null;
          safeText(status, 'Вставь ссылку на чемпионат FACEIT.');
          return;
        }
        if (!target || target.kind !== 'championship') throw new Error('Вставьте ссылку на чемпионат FACEIT, не на комнату матча.');
        if (state.championshipId && state.championshipId !== target.id) {
          state.matches = new Map();
          state.connects.clear();
          state.watcher?.stop();
          state.watcher = null;
          state.online = new Set();
          state.checking = new Set();
          cameraAssignments.clear();
          state.rosterCache.clear();
          state.seeded = false;
          state.down = false;
          state.degraded = false;
          state.lastNotified = '';
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
        if (!successes.length) {
          // Keep the cards, but say it once per outage, not every poll.
          if (!state.down) notify('FACEIT временно недоступен; последние данные сохранены.', { error: true });
          state.down = true;
          state.lastError = 'FACEIT временно недоступен; последние данные сохранены.';
          safeText(status, state.lastError);
          return;
        }
        state.matches = merged;
        state.seeded = true;
        await hydrateRosters();
        const snapshot = panel?.snapshot?.();
        const allTeams = panel?.teams?.() || [];
        for (const record of state.matches.values()) {
          record.raw ||= record.match;
          record.teams = matchQualificationPlayers(record.teams, snapshot, allTeams);
          record.rosterAvailable = record.teams.some(team => team.players.length > 0);
        }
        // Generate VDO rooms and stream IDs: every player gets a VDO link.
        // One room per match, IDs read as FACEIT nicknames. OneShot camera wins if matched.
        for (const record of state.matches.values()) {
          const vdo = vdoFactory(state.championshipId, record.match.id, record.teams);
          record.room = vdo.room;
          const roster = record.teams.flatMap(t => t.players);
          const generated = new Map(roster.map((p, i) => [p, vdo.players[i]?.id]));
          for (const team of record.teams) for (const player of team.players) {
            if (!player.camera) player.camera = { id: generated.get(player) || '', room: vdo.room, password: '', source: 'generated' };
            else player.camera.source = 'oneshot';
          }
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
        // One alert per outage, not one per 20-second poll.
        const degraded = results.some(result => result.status === 'rejected');
        if (degraded && !state.degraded) notify('Часть списков FACEIT недоступна.');
        state.degraded = degraded;
        state.down = false;
        state.lastError = '';
        state.lastNotified = '';
        if (alert) alert.hidden = true;
        try { localStorage.setItem(URL_STORE, JSON.stringify(input?.value || '')); } catch { /* not kept */ }
      } catch (error) {
        if (generation !== state.generation || state.stopped) return;
        state.lastError = error?.message || 'Не удалось обновить FACEIT.';
        safeText(status, state.lastError);
        // A bad link or a missing key repeats identically; say it once.
        if (state.lastError !== state.lastNotified) notify(state.lastError, { error: true });
        state.lastNotified = state.lastError;
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
    state.watcher?.stop();
    state.watcher = null;
  }

  async function start() {
    stop();
    if (input && !input.value && savedUrl()) input.value = savedUrl();
    state.stopped = false;
    state.generation++;
    state.client = null;
    state.timer = setInterval(() => { poll(); }, interval);
    await poll();
  }

  const copyToClipboard = async (text, okMessage = 'Ссылка скопирована.') => {
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
      safeText(status, okMessage);
    } catch { safeText(status, 'Не удалось скопировать.'); }
  };
  const clickHandler = event => {
    const target = event.target;
    const card = target?.closest?.('[data-match-id]');
    const record = card ? state.matches.get(card.dataset.matchId) : null;

    if (target?.matches?.('[data-qualification-copy-player]')) {
      const playerId = target.dataset.qualificationCopyPlayer;
      const camera = cameraFor(playerId);
      if (!camera?.id || !camera.room) return;
      void copyToClipboard(pushUrl(camera));
      return;
    }

    if (!record) return;
    // Player push link by nickname (the generated one)
    if (target?.matches?.('[data-q-copy-push]')) {
      const nickname = target.dataset.qCopyPush;
      const player = record.teams.flatMap(t => t.players).find(p => p.nickname === nickname);
      if (player?.camera?.id) void copyToClipboard(qualificationPushLink(player.camera));
      return;
    }
    // All links (both teams)
    if (target?.matches?.('[data-q-copy-all]')) {
      const teams = record.teams.map(t => ({
        name: t.name,
        players: t.players.map(p => ({ nickname: p.nickname, link: p.camera?.id ? qualificationPushLink(p.camera) : '' }))
      }));
      void copyToClipboard(qualificationMatchText(teams), 'Ссылки матча скопированы.');
      return;
    }
    // Room link
    if (target?.matches?.('[data-q-copy-room]') && record.room) {
      void copyToClipboard(qualificationRoomLink(record.room), 'Ссылка на комнату скопирована.');
      return;
    }
    // Open room
    if (target?.matches?.('[data-q-open-room]') && record.room) {
      window.open?.(qualificationRoomLink(record.room), '_blank', 'noopener');
      return;
    }
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
