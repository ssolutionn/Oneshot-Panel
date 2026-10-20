// «Сервер» tab (site only): the referee's journal of a CS2 server that runs on
// this computer. It exists only when the local server (server.js with
// CS2_JOURNAL=1) answers /api/cs2-status; on the hosted site the tab stays
// hidden. Everything from the game (names, chat) is shown with textContent.
const $ = id => document.getElementById(id);
const panel = () => window.oneshotPanel;
const POLL = 1500, KEEP = 20000;
const state = { events: [], seq: 0, status: null, round: 'auto', online: false, timer: 0, busy: false };

async function api(path, options) {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status });
  }
  return response;
}
const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const side = value => value === 'CT' ? 'side-ct' : value === 'T' ? 'side-t' : '';
const span = (text, className = '') => Object.assign(document.createElement('span'), { textContent: text, className });
function name(player) {
  return span(player.name || '?', side(player.side));
}
const KINDS = { kill: 'Kill', damage: 'Damage', chat: 'Chat', bomb: 'Bomb' };
const shown = event => {
  const kind = KINDS[event.type];
  if (event.type === 'round_start' || event.type === 'round_result' || event.type === 'match_start' || event.type === 'game_over') return true;
  return $(`serverShow${kind || 'Other'}`).checked;
};

// A round is a game (every map, every match restarted after live rounds) and its number.
const sameRound = (a, b) => a.game === b.game && a.round === b.round;
function render() {
  const { status } = state;
  const followed = state.round === 'auto' ? { game: status?.game ?? 0, round: status?.round ?? 0 } : state.round;
  // Status line
  const line = $('serverStatus');
  if (!state.online) {
    line.textContent = 'Нет связи с панелью на компьютере сервера. Проверь, что запущен «CS2_JOURNAL=1 npm start».';
  } else if (!status?.lines) {
    line.textContent = 'Ждём лог от сервера CS2: нажми «Как подключить» и выполни три команды в консоли сервера.';
  } else {
    const teams = status.teams || {};
    line.replaceChildren(
      span(status.map || 'карта не определена'), document.createTextNode(' · '),
      span(`${teams.CT || 'CT'} `, 'side-ct'), Object.assign(document.createElement('b'), { textContent: `${status.ct} : ${status.t}` }), span(` ${teams.T || 'T'}`, 'side-t'),
      document.createTextNode(status.live ? ` · раунд ${status.round}` : ' · разминка'),
      ...(status.over ? [document.createTextNode(' · игра окончена')] : []));
  }
  $('serverDot').dataset.kind = state.online ? (status?.lines ? 'good' : 'wait') : 'bad';
  // Round chips: warm-up, the last 30 rounds; each earlier game is headed by its map
  const rounds = [];
  for (const e of state.events) if (!rounds.some(r => sameRound(r, e))) rounds.push({ game: e.game, round: e.round });
  rounds.sort((a, b) => a.game - b.game || a.round - b.round).splice(0, Math.max(0, rounds.length - 30));
  const games = new Set(rounds.map(r => r.game));
  const chips = rounds.flatMap((r, i) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: r.round === 0 ? 'Разм.' : String(r.round) });
    button.setAttribute('aria-pressed', String(state.round !== 'auto' && sameRound(state.round, r)));
    button.addEventListener('click', () => { state.round = r; render(); });
    if (games.size < 2 || rounds[i - 1]?.game === r.game) return [button];
    const map = state.events.findLast(e => e.game === r.game && e.map)?.map;
    return [span(map || 'игра', 'muted'), button];
  });
  const live = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Идущий' });
  live.setAttribute('aria-pressed', String(state.round === 'auto'));
  live.addEventListener('click', () => { state.round = 'auto'; render(); });
  $('serverRounds').replaceChildren(...chips, live);
  // The log of the chosen round
  const list = $('serverLog');
  const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
  const rows = state.events.filter(e => sameRound(e, followed) && shown(e)).map(e => {
    const item = document.createElement('li');
    item.className = `ev-${e.type === 'round_result' || e.type === 'game_over' || e.type === 'match_start' ? 'result' : e.type}`;
    const time = Object.assign(document.createElement('time'), { textContent: e.type === 'round_result' || e.type === 'game_over' ? '' : clock(e.offset) });
    const body = document.createElement('span');
    if (e.type === 'kill') {
      body.append(name(e.killer), ' убил ', name(e.victim), ` · ${e.weapon}${e.headshot ? ' · хедшот' : ''}${e.through ? ' · через стену' : ''}`);
    } else if (e.type === 'damage') {
      body.append(name(e.attacker), ' → ', name(e.victim), `: ${e.damage} (${e.weapon}${e.hitgroup ? ', ' + e.hitgroup : ''}), осталось ${Number.isFinite(e.health) ? e.health : '?'}`);
    } else if (e.type === 'chat') {
      body.append(name(e.player), e.team ? ' [команда]' : '', ': ', e.text);
    } else body.textContent = e.line;
    item.append(time, body);
    return item;
  });
  list.replaceChildren(...(rows.length ? rows : [Object.assign(document.createElement('li'), { className: 'empty', textContent: state.online && status?.lines ? 'В этом раунде пока нет событий по выбранным фильтрам.' : '' })]));
  if (atEnd) list.scrollTop = list.scrollHeight;
}

// Redrawn only when something changed: a list rebuilt every poll would drop
// the referee's text selection.
let drawn = '';
async function poll() {
  if (state.busy) return;
  state.busy = true;
  try {
    const { status, events } = await (await api(`/api/cs2-events?since=${state.seq}`)).json();
    state.online = true;
    state.status = status;
    if (status.seq < state.seq) { state.events = []; state.seq = 0; } // the server restarted: start over
    for (const event of events) { state.events.push(event); state.seq = Math.max(state.seq, event.seq); }
    if (state.events.length > KEEP) state.events.splice(0, state.events.length - KEEP);
  } catch { state.online = false; }
  finally {
    state.busy = false;
    const now = JSON.stringify([state.online, state.status, state.seq]);
    if (now !== drawn) { drawn = now; render(); }
  }
}

async function start() {
  try {
    const status = await (await api('/api/cs2-status')).json();
    if (!status?.ok) return;
  } catch { return; } // not the local panel: no tab
  $('serverNavBtn').hidden = false;
  $('serverView').dataset.ready = 'true';
  poll();
  state.timer = setInterval(poll, POLL);
}

$('serverSetup').addEventListener('click', async () => {
  try {
    const { commands } = await (await api('/api/cs2-setup')).json();
    await panel().copy(commands.join('\n'));
    panel().toast('Три команды скопированы: вставь их в консоль сервера CS2.');
  } catch { panel().toast('Не удалось получить команды: панель сервера не отвечает.'); }
});
$('serverCopyRound').addEventListener('click', async () => {
  const { game, round: n } = state.round === 'auto' ? { game: state.status?.game ?? 0, round: state.status?.round ?? 0 } : state.round;
  try {
    const text = await (await api(`/api/cs2-round?n=${n}&g=${game}`)).text();
    if (!text) return panel().toast('В этом раунде ещё ничего нет.');
    await panel().copy(text);
    panel().toast(`Раунд ${n} скопирован.`);
  } catch { panel().toast('Не удалось получить раунд.'); }
});
for (const id of ['Kill', 'Damage', 'Chat', 'Bomb', 'Other']) $(`serverShow${id}`).addEventListener('change', render);
$('serverSayForm').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('serverSay').value.trim();
  if (!text) return;
  $('serverSayForm').querySelector('button').disabled = true;
  try {
    await api('/api/cs2-say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    $('serverSay').value = '';
    panel().toast('Отправлено в чат сервера.');
  } catch (error) {
    panel().toast(error.message === 'same-origin' ? 'Панель открыта не по localhost: запрос отклонён.' : `Сообщение не ушло: ${error.message}`);
  } finally { $('serverSayForm').querySelector('button').disabled = false; }
});
start();
