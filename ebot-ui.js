// Lobby block «Матчи eBot» (site only): reads the eBot match list through
// this site's /api/ebot proxy every 20 s while the tab is open and visible,
// shows the running matches with score, map and status, and notes score and
// status changes in the lobby journal (oneshot:lobby-note), like the
// bookmakers' lines do. With the hosting secrets EBOT_USER/EBOT_PASSWORD
// set, the same block also runs the match (pause, stop, knife rounds, RCON)
// and creates new matches through /api/ebot-admin — the browser never sees
// the eBot credentials. The eBot server itself is never opened by the
// browser; everything from eBot renders as text.
import { EBOT_PROXY, parseEbotMatches, isLive, ebotEvents, ebotStatusLine } from './ebot.js';

const $ = id => document.getElementById(id);
const ADMIN = '/api/ebot-admin';
const STORE = 'oneshot-ebot';
const POLL = 20000, REPEAT = 20000, REPEAT_LIMIT = 3;
// Live commands eBot understands, with their operator labels; shown only
// when the block is admin-enabled.
const RUN_COMMANDS = [
  ['pauseunpause', 'Пауза ⏯'], ['stop', 'Стоп'], ['stopNoRs', 'Стоп без RS'],
  ['forcestart', 'Конец разминки'], ['passknife', 'Пропустить ножи'],
  ['forceknife', 'Начать ножи'], ['forceknifeend', 'Завершить ножи'],
  ['stopback', 'В разминку']
];

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
};
function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not kept */ }
}

const state = { matches: [], updatedAt: 0, on: read(STORE, true), seen: {}, repeats: 0, timer: 0, busy: false, sending: false };
if (!state.on) $('ebotWatch').checked = false;
$('ebotWatch').addEventListener('change', () => {
  state.on = $('ebotWatch').checked;
  write(STORE, state.on);
  if (state.on) { render(); check(); }
  else { clearTimeout(state.timer); setStatus('Следование выключено.'); }
});

function setStatus(text) { $('ebotStatus').textContent = text; }

function render() {
  const box = $('ebotMatches');
  box.replaceChildren();
  const shown = state.matches.filter(isLive);
  if (!state.matches.length) {
    box.append(el('div', { className: 'empty-panel', textContent: state.updatedAt ?
      'eBot не показывает матчей в списке.' : 'Здесь появятся матчи, которые ведёт eBot.' }));
    return;
  }
  for (const match of shown.length ? shown : state.matches.slice(0, 1)) {
    box.append(matchCard(match));
  }
  setStatus(ebotStatusLine(state.matches, state.updatedAt));
}

// Everything that came from the eBot page is textContent, never innerHTML.
// The card reuses the lobby's .lobby-match look (FACEIT cards).
function matchCard(match) {
  const live = isLive(match);
  const done = !live && /Finished/i.test(match.status);
  return el('div', { className: 'lobby-match' + (live ? ' live' : done ? ' done' : ''), dataset: { match: match.id } },
    el('div', { className: 'lm-top' },
      el('span', { className: 'lm-status', textContent: live ? match.status : 'Завершён' })),
    el('div', { className: 'lm-teams' },
      el('span', { className: 'lm-team', textContent: match.teamA }),
      el('b', { className: 'lm-score', textContent: `${match.scoreA} : ${match.scoreB}` }),
      el('span', { className: 'lm-team right', textContent: match.teamB })),
    el('div', { className: 'lm-meta', textContent: [match.map, `матч #${match.id}`].filter(Boolean).join(' · ') }),
    live && adminReady ? commandRow(match) : null);
}

// Control buttons for a running match. Each click asks /api/ebot-admin to
// send the command; the operator label stays grey until the reply lands.
function commandRow(match) {
  const row = el('div', { className: 'ebot-commands' });
  for (const [command, label] of RUN_COMMANDS) {
    const button = el('button', { type: 'button', className: 'button small', textContent: label });
    button.addEventListener('click', async () => {
      if (state.sending) return;
      state.sending = true;
      button.disabled = true;
      try {
        const reply = await adminCall({ action: 'send', matchId: match.id, command });
        window.dispatchEvent(new CustomEvent('oneshot:lobby-note', {
          detail: reply.accepted ? `eBot: команда «${label}» матча #${match.id} принята` :
            `eBot: команда «${label}» матча #${match.id} не подтверждена` }));
        if (reply.accepted) check();
      } catch (error) {
        setStatus(`eBot: команда не ушла — ${error.message}`);
      } finally {
        state.sending = false;
        button.disabled = false;
      }
    });
    row.append(button);
  }
  return row;
}

// ---------- admin transport ----------

let adminReady = false, adminProbed = false, adminCatalog = null;

async function adminCall(payload) {
  const response = await fetch(ADMIN, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}

// One probe: if the hosting secrets are set, the block gains its admin
// parts (command buttons, the create form). Errors leave it read-only.
async function probeAdmin() {
  if (adminProbed) return;
  adminProbed = true;
  try {
    adminCatalog = await adminCall({ action: 'catalog' });
    adminReady = true;
    buildCreateForm();
    render();
  } catch { /* read-only: no credentials or eBot down */ }
}

// The create form: teams, map and server come from the eBot admin catalog.
function buildCreateForm() {
  if (!adminReady || !adminCatalog || $('ebotCreate')) return;
  const maps = el('select');
  for (const map of adminCatalog.maps || []) maps.append(el('option', { value: map, textContent: map }));
  const servers = el('select');
  for (const server of adminCatalog.servers || []) {
    servers.append(el('option', { value: server.id, textContent: server.label }));
  }
  const teamA = el('input', { type: 'text', placeholder: 'Команда A', maxLength: 25 });
  const teamB = el('input', { type: 'text', placeholder: 'Команда B', maxLength: 25 });
  const submit = el('button', { type: 'submit', className: 'button primary', textContent: 'Создать матч' });
  const form = el('form', { id: 'ebotCreate', className: 'ebot-create' },
    el('label', { className: 'mini-label' }, 'Новый матч у eBot', teamA, teamB, maps, servers, submit));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!teamA.value.trim() || !teamB.value.trim()) return;
    submit.disabled = true;
    try {
      const result = await adminCall({
        action: 'create', teamA: teamA.value.trim(), teamB: teamB.value.trim(),
        map: maps.value, serverId: servers.value
      });
      window.dispatchEvent(new CustomEvent('oneshot:lobby-note', {
        detail: `eBot: создан матч${result.id ? ' #' + result.id : ''} ${teamA.value.trim()} — ${teamB.value.trim()}` }));
      setStatus(`Матч создан${result.id ? ' (#' + result.id + ')' : ''}. Нажми «▶» на карточке, чтобы стартовать.`);
      check();
    } catch (error) {
      setStatus(`Матч не создан: ${error.message}`);
    } finally {
      submit.disabled = false;
    }
  });
  $('ebotPanel').append(form);
}

async function check() {
  if (state.busy || !state.on) return;
  state.busy = true;
  try {
    const response = await fetch(EBOT_PROXY, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const body = await response.json();
    if (typeof body.page !== 'string') throw new Error('формат');
    const matches = parseEbotMatches(body.page);
    // The first read of each match id is a note, so a panel opened late
    // still announces the running match once (per browser, per match).
    const fresh = matches.filter(m => !state.seen[m.id]);
    const events = ebotEvents(state.matches, matches);
    for (const m of matches) state.seen[m.id] = 1;
    state.matches = matches;
    state.updatedAt = Date.now();
    state.repeats = 0;
    render();
    for (const event of fresh.length ? events.filter(e => e.type === 'start') : events) {
      window.dispatchEvent(new CustomEvent('oneshot:lobby-note', { detail: event.text }));
    }
  } catch (error) {
    if (++state.repeats <= REPEAT_LIMIT) {
      setStatus(`eBot не отвечает (${state.repeats}). Проверяем ещё раз.`);
    } else {
      setStatus('eBot недоступен. Проверь сервер eBot.');
    }
  } finally {
    state.busy = false;
    if (state.on) state.timer = setTimeout(check, state.repeats ? REPEAT : POLL);
  }
}

const wake = () => {
  if (!state.on) return;
  clearTimeout(state.timer);
  if (!document.hidden) check();
};
document.addEventListener('visibilitychange', wake);
window.addEventListener('focus', wake);
window.addEventListener('online', wake);
render();
check();
probeAdmin();
