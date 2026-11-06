// Вкладка «eBot» (только сайт): полноценная админка матчей поверх уже
// работающего лобби-блока ebot-ui.js — таблица всех матчей (не только
// живых), команды команд, форма создания и модалка деталей. Лобби-блок
// не трогаем: вкладка независима и не ломает его опрос. Все данные eBot
// — только textContent через el() (паттерн ebot-ui.js), innerHTML нет.
// Топ-уровень модуля DOM не трогает: чистые функции внизу работают в
// node --test, DOM-код запускается только initEbotAdminTab (сайт).
import { EBOT_PROXY, parseEbotMatches, isLive } from './ebot.js';
import { formatMatchRow, statusClass, validateCreateForm, teamRowText } from './ebot-admin-core.js';

const $ = id => document.getElementById(id);
const ADMIN = '/api/ebot-admin';
const POLL = 20000, REPEAT = 20000, REPEAT_LIMIT = 3;

// Чистые функции (форматирование строки, класс статуса, валидация формы)
// — в ebot-admin-core.js, без DOM, покрыты test/ebot-admin-ui.test.js.

const el = (tag, props = {}, ...children) => {
  // dataset — readonly в DOM (Object.assign бросает TypeError); заполняем
  // отдельным шагом, как это делает ebot-ui.js.
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) for (const [key, value] of Object.entries(dataset)) node.dataset[key] = value;
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
};

// Командные команды матча в строке таблицы: те же команды, что шлёт
// лобби-блок (action:'send'), одной кнопкой на действие.
const ROW_COMMANDS = [
  ['pauseunpause', 'Пауза'],
  ['stop', 'Стоп']
];

export function initEbotAdminTab({ showLobby = () => {} } = {}) {
  const state = {
    matches: [], updatedAt: 0, on: false, timer: 0, busy: false, repeats: 0, sending: false,
    catalog: null, teams: [], seasons: [], openMatch: null
  };

  function setStatus(text) { $('ebotAdminStatus').textContent = text; }

  // ---------- таблица матчей ----------

  function renderMatches() {
    const body = $('ebotAdminBody');
    body.replaceChildren();
    if (!state.matches.length) {
      body.append(el('tr', { className: 'ebot-admin-empty' },
        el('td', { colSpan: 7, textContent: state.updatedAt ?
          'eBot не показывает матчей в списке.' : 'Загружаем список матчей eBot…' })));
      return;
    }
    for (const match of state.matches) body.append(matchRow(match));
  }

  function matchRow(match) {
    const cells = formatMatchRow(match);
    const live = isLive(match);
    return el('tr', { className: statusClass(match.status), dataset: { match: match.id } },
      el('td', { className: 'ea-id', textContent: cells.id }),
      el('td', { className: 'ea-team', textContent: cells.teamA }),
      el('td', { className: 'ea-score', textContent: cells.score }),
      el('td', { className: 'ea-team', textContent: cells.teamB }),
      el('td', { className: 'ea-map', textContent: cells.map }),
      el('td', { className: 'ea-status', textContent: cells.status }),
      actionsCell(match, live));
  }

  // Кнопки строки: Пауза/Стоп шлём сами через /api/ebot-admin; Консоль,
  // Статистика и «В эфир» — события: их механизмы уже живут в лобби
  // (ebot-ui.js / ebot-stats.js), вкладка только просит их открыть.
  function actionsCell(match, live) {
    const cell = el('td', { className: 'ea-actions' });
    if (live) {
      for (const [command, label] of ROW_COMMANDS) {
        cell.append(el('button', {
          type: 'button', className: 'button small', textContent: label,
          title: label + ' матча #' + match.id,
          onclick: () => sendCommand(match, command, label)
        }));
      }
    }
    cell.append(
      el('button', {
        type: 'button', className: 'button small', textContent: 'Консоль',
        title: 'Лог, чат и RCON сервера матча',
        onclick: () => window.dispatchEvent(new CustomEvent('oneshot:ebot-console-open', { detail: match.id }))
      }),
      el('button', {
        type: 'button', className: 'button small', textContent: 'Статистика',
        title: 'Таблица игроков и хитмапа матча',
        onclick: () => window.dispatchEvent(new CustomEvent('oneshot:ebot-stats-open', { detail: match.id }))
      }),
      el('button', {
        type: 'button', className: 'button small', textContent: live ? '● В эфир' : 'В эфир',
        disabled: !live, // завершённым матчам поток не нужен — как в лобби
        title: 'Живой счёт и лента киллов в Лобби',
        onclick: () => {
          // Механизм «В эфир» один и живёт в лобби: переключаем вкладку и
          // просим открыть поток там (интегратор вешает слушатель).
          showLobby();
          window.dispatchEvent(new CustomEvent('oneshot:ebot-live-open', { detail: match.id }));
        }
      }));
    return cell;
  }

  async function sendCommand(match, command, label) {
    if (state.sending) return;
    state.sending = true;
    setStatus(`eBot: команда «${label}» матча #${match.id}…`);
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
    }
  }

  // ---------- модалка деталей ----------

  function openMatchModal(match) {
    state.openMatch = match;
    const cells = formatMatchRow(match);
    $('ebotAdminMatchTitle').textContent = `Матч #${cells.id}: ${cells.teamA} — ${cells.teamB}`;
    $('ebotAdminMatchScore').textContent = `Счёт: ${cells.score}${cells.map ? ` · ${cells.map}` : ''}`;
    $('ebotAdminMatchStatus').textContent = `Статус: ${cells.status}`;
    // Не стартованный матч — сразу кнопка старта (action:'start', как «▶»
    // в лобби-блоке); живым она не нужна.
    const start = $('ebotAdminMatchStart');
    start.hidden = !/^Not started/i.test(match.status);
    start.onclick = async () => {
      start.disabled = true;
      try {
        await adminCall({ action: 'start', matchId: match.id });
        window.dispatchEvent(new CustomEvent('oneshot:lobby-note', { detail: `eBot: матч #${match.id} стартован` }));
        $('ebotAdminMatchDialog').close();
        check();
      } catch (error) {
        $('ebotAdminMatchStatus').textContent = `Старт не удался: ${error.message}`;
      } finally { start.disabled = false; }
    };
    $('ebotAdminMatchDialog').showModal();
  }

  $('ebotAdminMatchClose').addEventListener('click', () => $('ebotAdminMatchDialog').close());

  // Клик по строке (кроме кнопок) — модалка деталей.
  $('ebotAdminBody').addEventListener('click', event => {
    if (event.target.closest('button')) return;
    const row = event.target.closest('tr[data-match]');
    const match = state.matches.find(m => String(m.id) === String(row?.dataset.match));
    if (match) openMatchModal(match);
  });

  // ---------- каталог, сезоны, команды ----------

  async function adminCall(payload) {
    const response = await fetch(ADMIN, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(body.message || `HTTP ${response.status}`), { status: response.status });
    }
    return body;
  }

  // Карточки-счётчики сверху: Серверы / Сезоны / Команды. Читаются тем же
  // /api/ebot-admin (действия catalog/servers/seasons/teams); отказа одного
  // действия остальные не роняют — карточка просто показывает прочерк.
  async function loadCatalog() {
    const parts = await Promise.allSettled([
      adminCall({ action: 'catalog' }),
      adminCall({ action: 'servers' }),
      adminCall({ action: 'seasons' }),
      adminCall({ action: 'teams' })
    ]);
    const [catalog, servers, seasons, teams] = parts.map(p => p.status === 'fulfilled' ? p.value : null);
    state.catalog = catalog || {};
    state.seasons = seasons?.seasons || catalog?.seasons || [];
    state.teams = teams?.teams || catalog?.teams || [];
    const serverList = servers?.servers || catalog?.servers || [];
    renderCatalog(serverList);
    if (catalog || teams || servers) buildCreateForm(serverList);
    else setStatus('eBot: каталог не открыт — управление матчами есть, форма создания и команды недоступны.');
    renderTeams();
  }

  function renderCatalog(servers) {
    $('ebotAdminServersCount').textContent = String(servers.length);
    $('ebotAdminSeasonsCount').textContent = String(state.seasons.length);
    $('ebotAdminTeamsCount').textContent = String(state.teams.length);
    const list = $('ebotAdminServersList');
    list.replaceChildren();
    if (!servers.length) {
      list.append(el('li', { className: 'empty-panel', textContent: 'Список серверов недоступен.' }));
      return;
    }
    for (const server of servers) {
      list.append(el('li', { textContent: typeof server === 'string' ? server : server.label }));
    }
    const seasonList = $('ebotAdminSeasonsList');
    seasonList.replaceChildren();
    for (const season of state.seasons) {
      seasonList.append(el('li', { textContent: typeof season === 'string' ? season : season.label || season.name }));
    }
  }

  // ---------- форма создания ----------

  function buildCreateForm(serverList) {
    if ($('ebotAdminCreateBody').children.length) return;
    const teamOptions = state.teams.map(t => el('option', { value: t.name, textContent: t.name }));
    const maps = el('select', { id: 'ebotAdminMap' },
      el('option', { value: '', textContent: 'Карта…' }),
      ...(state.catalog.maps || []).map(map => el('option', { value: map, textContent: map })));
    const servers = el('select', { id: 'ebotAdminServer' },
      el('option', { value: '', textContent: 'Сервер…' }),
      ...serverList.map(server => el('option', {
        value: typeof server === 'string' ? server : server.id,
        textContent: typeof server === 'string' ? server : server.label
      })));
    const mapsCount = el('select', { id: 'ebotAdminMapsCount' },
      el('option', { value: '1', textContent: '1 карта (BO1)' }),
      el('option', { value: '3', textContent: '3 карты (BO3)', selected: true }),
      el('option', { value: '5', textContent: '5 карт (BO5)' }));
    const overtime = el('select', { id: 'ebotAdminOvertime' },
      el('option', { value: 'yes', textContent: 'Овертайм: да', selected: true }),
      el('option', { value: 'no', textContent: 'Овертайм: нет' }));
    const teamA = el('select', { id: 'ebotAdminTeamA' },
      el('option', { value: '', textContent: 'Команда A…' }), ...teamOptions.map(o => o.cloneNode(true)));
    const teamB = el('select', { id: 'ebotAdminTeamB' },
      el('option', { value: '', textContent: 'Команда B…' }), ...teamOptions.map(o => o.cloneNode(true)));
    const note = el('p', { id: 'ebotAdminCreateNote', className: 'lobby-status', role: 'status' });
    const submit = el('button', { type: 'submit', className: 'button primary', textContent: 'Создать матч' });
    $('ebotAdminCreateBody').replaceChildren(
      el('form', { id: 'ebotAdminCreateForm', className: 'ebot-admin-create' },
        el('label', { className: 'mini-label' }, 'Команда A', teamA),
        el('label', { className: 'mini-label' }, 'Команда B', teamB),
        el('label', { className: 'mini-label' }, 'Карта', maps),
        el('label', { className: 'mini-label' }, 'Сервер', servers),
        el('label', { className: 'mini-label' }, 'Формат', mapsCount),
        el('label', { className: 'mini-label' }, 'Овертайм', overtime),
        submit),
      note);
    $('ebotAdminCreateForm').addEventListener('submit', async event => {
      event.preventDefault();
      const value = { teamA: teamA.value, teamB: teamB.value, map: maps.value, serverId: servers.value, mapsCount: mapsCount.value, overtime: overtime.value };
      const error = validateCreateForm(value);
      if (error) { note.textContent = error; return; }
      submit.disabled = true;
      note.textContent = 'Создаём матч…';
      try {
        const result = await adminCall({
          action: 'create',
          teamA: value.teamA, teamB: value.teamB, map: value.map,
          serverId: value.serverId, mapsCount: Number(value.mapsCount),
          overtime: value.overtime === 'yes'
        });
        note.textContent = `Матч создан${result.id ? ' (#' + result.id + ')' : ''}. Нажми «▶» в строке или «Стартовать» в модалке.`;
        window.dispatchEvent(new CustomEvent('oneshot:lobby-note', {
          detail: `eBot: создан матч${result.id ? ' #' + result.id : ''} ${value.teamA} — ${value.teamB}` }));
        check();
      } catch (error2) {
        note.textContent = `Матч не создан: ${error2.message}`;
      } finally { submit.disabled = false; }
    });
  }

  // ---------- команды eBot ----------

  function renderTeams() {
    const body = $('ebotAdminTeamsBody');
    body.replaceChildren();
    if (!state.teams.length) {
      $('ebotAdminTeamsBox').hidden = true;
      return;
    }
    $('ebotAdminTeamsBox').hidden = false;
    for (const team of state.teams) {
      const row = teamRowText(team);
      const sync = el('button', {
        type: 'button', className: 'button small', textContent: 'Синхронизировать из панели',
        title: 'Создать/обновить eBot-команду из состава панели'
      });
      sync.addEventListener('click', () => syncTeam(team, sync));
      body.append(el('tr', { dataset: { team: team.name } },
        el('td', { className: 'ea-team', textContent: row.name }),
        el('td', { className: 'ea-players', textContent: row.players }),
        el('td', {}, sync)));
    }
  }

  // Составы панели — из snapshot(); на их основе просим сервер создать
  // eBot-команду (действие sync-team). Секретов в браузере нет.
  function syncTeam(team, button) {
    const snap = window.oneshotPanel?.snapshot?.() || null;
    const panelTeam = [snap?.a, snap?.b].find(t => t && t.name && t.name.toLowerCase() === team.name.toLowerCase());
    const players = (panelTeam?.players || []).map(p => p.nick).filter(Boolean);
    if (!panelTeam || !players.length) {
      $('ebotAdminTeamsStatus').textContent =
        `В панели нет команды «${team.name}» с составом — синхронизировать нечего.`;
      return;
    }
    button.disabled = true;
    $('ebotAdminTeamsStatus').textContent = `Синхронизируем «${team.name}»…`;
    adminCall({ action: 'sync-team', name: team.name, players })
      .then(reply => {
        $('ebotAdminTeamsStatus').textContent =
          (reply.created ? `eBot-команда «${team.name}» создана из панели.` : `eBot-команда «${team.name}» уже есть — обновлён состав.`);
        if (Array.isArray(reply.players)) {
          const found = state.teams.find(t => t.name === team.name);
          if (found) { found.players = reply.players; renderTeams(); }
        }
      })
      .catch(error => { $('ebotAdminTeamsStatus').textContent = `Синхронизация не удалась: ${error.message}`; })
      .finally(() => { button.disabled = false; });
  }

  // ---------- опрос списка ----------

  async function check() {
    if (state.busy || !state.on) return;
    state.busy = true;
    try {
      const response = await fetch(EBOT_PROXY, { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const body = await response.json();
      if (typeof body.page !== 'string') throw new Error('формат');
      state.matches = parseEbotMatches(body.page);
      state.updatedAt = Date.now();
      state.repeats = 0;
      renderMatches();
      setStatus(`Матчей: ${state.matches.length} · обновлено ${new Date(state.updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (error) {
      if (++state.repeats <= REPEAT_LIMIT) setStatus(`eBot не отвечает (${state.repeats}). Проверяем ещё раз.`);
      else setStatus('eBot недоступен. Проверь сервер eBot.');
    } finally {
      state.busy = false;
      if (state.on) state.timer = setTimeout(check, state.repeats ? REPEAT : POLL);
    }
  }

  // Опрос живёт, только пока вкладка открыта (событие oneshot:view от
  // showView в live.js) и страница видна.
  function setActive(on) {
    if (on === state.on) return;
    state.on = on;
    clearTimeout(state.timer);
    if (on) { check(); loadCatalog(); }
  }
  document.addEventListener('oneshot:view', event => setActive(event.detail === 'ebot-admin'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.on) check(); });

  renderMatches();
  // Первичная отрисовка, даже если вкладку ещё не открывали.
  if ($('ebotAdminView') && !$('ebotAdminView').hidden) { state.on = true; check(); loadCatalog(); }
}
