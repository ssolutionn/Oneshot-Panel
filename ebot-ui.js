// Lobby block «Матчи eBot» (site only): reads the eBot match list through
// this site's /api/ebot proxy every 20 s while the tab is open and visible,
// shows the running matches with score, map and status, and notes score and
// status changes in the lobby journal (oneshot:lobby-note), like the
// bookmakers' lines do. With the hosting secrets EBOT_USER/EBOT_PASSWORD
// set, the same block also runs the match (pause, stop, knife rounds, RCON)
// and creates new matches through /api/ebot-admin — the browser never sees
// the eBot credentials. The eBot server itself is never opened by the
// browser; everything from eBot renders as text. The same secrets also
// unlock the match console (log + chat + RCON) through /api/ebot-console:
// SSE stream, everything text-only.
import { EBOT_PROXY, parseEbotMatches, isLive, ebotEvents, ebotStatusLine } from './ebot.js';

const $ = id => document.getElementById(id);
const ADMIN = '/api/ebot-admin';
const CONSOLE = '/api/ebot-console';
const STORE = 'oneshot-ebot';
const POLL = 20000, REPEAT = 20000, REPEAT_LIMIT = 3;
// Чат и RCON: только печатные символы без кавычек и точек с запятой — то же
// ограничение, что проверяет сервер; проверяем и у себя для ранней ошибки.
const SAY_RE = /^[ -~]{1,200}$/;
// Live commands eBot understands, with their operator labels; shown only
// when the block is admin-enabled.
const RUN_COMMANDS = [
  ['pauseunpause', 'Пауза ⏯'], ['stop', 'Стоп'], ['stopNoRs', 'Стоп без RS'],
  ['forcestart', 'Конец разминки'], ['passknife', 'Пропустить ножи'],
  ['forceknife', 'Начать ножи'], ['forceknifeend', 'Завершить ножи'],
  ['stopback', 'В разминку']
];

const el = (tag, props = {}, ...children) => {
  // dataset — readonly в DOM (Object.assign бросает TypeError); заполняем
  // отдельным шагом, как это делает ebot-stats.js.
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) for (const [key, value] of Object.entries(dataset)) node.dataset[key] = value;
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
      el('span', { className: 'lm-status', textContent: live ? match.status : 'Завершён' }),
      live && adminReady ? el('button', {
        type: 'button', className: 'button small', textContent: 'Консоль',
        title: 'Живой лог, чат и RCON сервера этого матча',
        onclick: () => openConsole(match.id)
      }) : null),
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
  // Матч ещё не стартован: у eBot для него нет командных кнопок (только
  // роутинг Start/Edit), даём панельную кнопку старта через /api/ebot-admin.
  if (/^Not started/i.test(match.status)) {
    const start = el('button', { type: 'button', className: 'button primary small', textContent: '▶ Стартовать' });
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        await adminCall({ action: 'start', matchId: match.id });
        window.dispatchEvent(new CustomEvent('oneshot:lobby-note', {
          detail: `eBot: матч #${match.id} стартован` }));
        check();
      } catch (error) {
        setStatus(`eBot: старт не удался — ${error.message}`);
      } finally { start.disabled = false; }
    });
    row.append(start);
    return row;
  }
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
  if (!response.ok) {
    // status нужен вызывающим (403 «каталог закрыт» ≠ «нет секретов»).
    throw Object.assign(new Error(body.message || `HTTP ${response.status}`), { status: response.status });
  }
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
  } catch (error) {
    // Закрытый каталог (403, EBOT_ADMIN_OPEN не задан) — секреты всё равно
    // есть: кнопки команд и консоль работают, только формы создания нет.
    if (error.status === 403) {
      adminReady = true;
      render();
    }
    /* прочее: no credentials или eBot down — блок остаётся монитором */
  }
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
    // Журнал: все события сразу; «новый матч» — только по seen (до этого
    // опроса), чтобы смена счёта старого матча не терялась и матч не
    // объявлялся заново после перезагрузки страницы.
    const seenBefore = { ...state.seen };
    const events = ebotEvents(state.matches, matches);
    for (const m of matches) state.seen[m.id] = 1;
    state.matches = matches;
    state.updatedAt = Date.now();
    state.repeats = 0;
    render();
    for (const event of events) {
      if (event.type === 'start' && seenBefore[event.match.id]) continue;
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

// ---------- консоль матча (лог + чат + RCON через /api/ebot-console) ----------

// Один диалог на панель: состояние консоли живёт здесь, кнопка «Консоль»
// перезапускает его на выбранный матч. Всё из eBot — только textContent.
const consoleState = {
  matchId: null, id: null, source: null, retries: 0, opening: false, closing: false
};

function consoleStatus(text) { $('ebotConsoleStatus').textContent = text; }

async function consoleCall(payload) {
  const response = await fetch(CONSOLE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}

// Открыть диалог и поднять консоль-сессию для матча: POST start → SSE.
async function openConsole(matchId) {
  const dialog = $('ebotConsole');
  if (consoleState.opening) return;
  if (consoleState.id && consoleState.matchId === String(matchId)) { dialog.showModal(); return; }
  closeConsoleStream(false);
  $('ebotConsoleLog').replaceChildren();
  $('ebotConsoleChat').replaceChildren();
  $('ebotConsoleRcon').replaceChildren();
  dialog.showModal();
  consoleState.opening = true;
  consoleState.matchId = String(matchId);
  consoleStatus(`Открываем консоль матча #${matchId}…`);
  try {
    const made = await consoleCall({ action: 'start', matchId: String(matchId) });
    consoleState.id = made.id;
    consoleState.retries = 0;
    connectStream();
    consoleStatus(`Консоль матча #${matchId}: лог, чат и RCON живые.`);
  } catch (error) {
    consoleState.matchId = null;
    consoleStatus(`Консоль не открылась: ${error.message}`);
  } finally {
    consoleState.opening = false;
  }
}

// SSE-поток: события log/chat/rcon/stop. Обрыв — до 3 переподключений, у
// остановленной сессии — не подключаемся заново.
function connectStream() {
  if (!consoleState.id) return;
  closeSource();
  const source = new EventSource(`${CONSOLE}?stream=${encodeURIComponent(consoleState.id)}`);
  consoleState.source = source;
  source.addEventListener('log', event => {
    const { line } = parseEvent(event);
    if (typeof line !== 'string') return;
    appendText($('ebotConsoleLog'), line + '\n');
  });
  source.addEventListener('chat', event => {
    const chat = parseEvent(event);
    if (!chat || typeof chat.nick !== 'string' || typeof chat.text !== 'string') return;
    const side = chat.side === 'CT' ? 'side-ct' : chat.side === 'TERRORIST' ? 'side-t' : '';
    $('ebotConsoleChat').append(el('li', {},
      el('span', { className: 'nick ' + side, textContent: chat.nick }),
      el('span', { textContent: ': ' + chat.text })));
    scrollDown($('ebotConsoleChat'));
  });
  source.addEventListener('rcon', event => {
    const { content } = parseEvent(event);
    if (typeof content !== 'string') return;
    appendText($('ebotConsoleRcon'), content + '\n---\n');
  });
  source.addEventListener('stop', () => {
    consoleStatus('Консоль матча закрыта (eBot).');
    closeSource();
    consoleState.id = null;
  });
  source.onerror = () => {
    if (!consoleState.id) return; // stop уже обработан
    closeSource();
    if (++consoleState.retries <= REPEAT_LIMIT) {
      consoleStatus(`Поток консоли оборвался (${consoleState.retries}). Переподключаемся…`);
      setTimeout(connectStream, 2000 * consoleState.retries);
    } else {
      consoleStatus('Поток консоли потерян. Закрой и открой консоль заново.');
    }
  };
}

function closeSource() {
  if (consoleState.source) { consoleState.source.close(); consoleState.source = null; }
}

function parseEvent(event) {
  try { return JSON.parse(event.data); } catch { return null; }
}

// Строка в <pre>: только текст, авто-скролл вниз, хвост 500 строк.
function appendText(node, text) {
  node.append(document.createTextNode(text));
  while (node.childNodes.length > 500) node.removeChild(node.firstChild);
  scrollDown(node);
}

function scrollDown(node) { node.scrollTop = node.scrollHeight; }

// Закрыть поток и сессию. dialogClose — закрыт ли сам диалог (событие).
function closeConsoleStream(notifyServer = true) {
  closeSource();
  if (consoleState.id && notifyServer) {
    const id = consoleState.id;
    consoleState.id = null;
    consoleCall({ action: 'stop', id }).catch(() => { /* сервер сам закроет по таймауту */ });
  } else {
    consoleState.id = null;
  }
}

$('ebotConsoleClose').addEventListener('click', () => {
  $('ebotConsole').close();
  closeConsoleStream();
  consoleStatus('Консоль закрыта.');
});
// Esc закрывает диалог тем же путём (close event, не только кнопка).
$('ebotConsole').addEventListener('close', () => closeConsoleStream());

// Ввод: галочка «в чат» превращает текст в say "…", иначе — RCON-команда.
$('ebotConsoleForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!consoleState.id) return;
  const input = $('ebotConsoleInput');
  const text = input.value.trim();
  if (!text) return;
  const toChat = $('ebotConsoleMode').checked;
  if (toChat && !SAY_RE.test(text)) {
    consoleStatus('Текст в чат: только обычные символы без кавычек и точек с запятой.');
    return;
  }
  const command = toChat ? 'say ' + text : text;
  if (!SAY_RE.test(command)) {
    consoleStatus('Команда RCON: только обычные символы без кавычек и точек с запятой.');
    return;
  }
  input.value = '';
  const button = $('ebotConsoleSend');
  button.disabled = true;
  try {
    const result = await consoleCall({ action: 'send', id: consoleState.id, command });
    appendText($('ebotConsoleRcon'), '> ' + command + '\n' +
      (result.accepted ? (result.reply || '(без ответа)') : '(eBot не подтвердил команду)') + '\n---\n');
    if (!result.accepted) consoleStatus('Команда не подтверждена eBot.');
  } catch (error) {
    consoleStatus(`Команда не ушла: ${error.message}`);
  } finally {
    button.disabled = false;
    input.focus();
  }
});
