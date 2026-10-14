import {
  DEFAULT_SOURCE, decodeGviz, parseTeams, parseSchedule, scheduleDay,
  defaultLineup, lineupCandidates, roleSuffix, selectedPlayers,
  validatePlayers, validateMatch, viewUrl, directorUrl,
  observerText, playerText, buildObs, safeFilename, validateMetadata,
  MAP_POOL, VETO_RULES, validateVeto, appendVeto, vetoText
} from './core.js';

const $ = id => document.getElementById(id);
const state = {
  teams: [], schedule: [], a: '', b: '', keysA: [], keysB: [],
  matchKey: '', tab: 'observer', lastSync: null, stale: false,
  scheduleDay: '',
  source: { ...DEFAULT_SOURCE }, template: null, templateError: '',
  veto: { format: 'BO3', first: 0, actions: [], matchKey: '' },
  pending: null
};
let toastTimer, refreshId = 0, controller, templatePromise;

function readStorage(key) {
  try { return JSON.parse(localStorage.getItem(key)); }
  catch { return null; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

const savedSource = readStorage('webcam-desk-source');
if (savedSource &&
    /^[\w-]{20,100}$/.test(savedSource.id) &&
    /^\d+$/.test(savedSource.gid)) {
  state.source = {
    id: savedSource.id, gid: savedSource.gid,
    scheduleId: /^[\w-]{20,100}$/.test(savedSource.scheduleId || '') ?
      savedSource.scheduleId : savedSource.id,
    scheduleGid: /^\d+$/.test(savedSource.scheduleGid || '') ?
      savedSource.scheduleGid : null
  };
}
const savedMatch = readStorage('oneshot-webcam-match-v1');
if (savedMatch && savedMatch.source === JSON.stringify(state.source)) {
  for (const key of ['a', 'b', 'matchKey']) {
    if (typeof savedMatch[key] === 'string') state[key] = savedMatch[key];
  }
  for (const key of ['keysA', 'keysB']) {
    if (Array.isArray(savedMatch[key]) &&
        savedMatch[key].length <= 5 &&
        savedMatch[key].every(k => typeof k === 'string')) {
      state[key] = savedMatch[key];
    }
  }
  if (savedMatch.tab === 'players') state.tab = 'players';
  try {
    validateVeto(savedMatch.veto.actions,
      savedMatch.veto.format, savedMatch.veto.first);
    state.veto = savedMatch.veto;
  } catch { /* Ignore invalid stored progress. */ }
}
$('matchTime').value =
  !validateMetadata(savedMatch?.time || '', 'Матч') ?
    savedMatch.time :
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow', hour: '2-digit',
      minute: '2-digit', hourCycle: 'h23'
    }).format(new Date());
$('matchStage').value =
  typeof savedMatch?.stage === 'string' ?
    savedMatch.stage.slice(0, 100) : '';

function persist() {
  writeStorage('oneshot-webcam-match-v1', {
    source: JSON.stringify(state.source),
    a: state.a, b: state.b, keysA: state.keysA, keysB: state.keysB,
    matchKey: state.matchKey, time: $('matchTime').value,
    stage: $('matchStage').value, tab: state.tab, veto: state.veto
  });
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  })[c]);
}
function getTeam(side) {
  return state.teams.find(t => t.name === state[side]);
}
function chosen(side) {
  return selectedPlayers(getTeam(side),
    state[side === 'a' ? 'keysA' : 'keysB']);
}
function valid() {
  return validateMatch(getTeam('a'), getTeam('b'),
    state.keysA, state.keysB);
}
function showError(text) {
  $('errorBox').textContent = text;
  $('errorBox').hidden = !text;
}
function updateSourceLinks() {
  $('sidebarSource').href =
    `https://docs.google.com/spreadsheets/d/${state.source.id}/edit#gid=${state.source.gid}`;
}
async function sheetRows(source, gid, range, signal, id = source.id) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq`);
  url.search = new URLSearchParams({
    gid, range, headers: '0', tqx: 'out:json',
    _t: String(Date.now())
  });
  const response = await fetch(url, {
    credentials: 'omit', signal, cache: 'no-store'
  });
  if (!response.ok) {
    throw new Error(`Google Sheets недоступен (${response.status}).`);
  }
  return decodeGviz(await response.text());
}
function reconcileKeys(team, keys) {
  if (!keys.length) return defaultLineup(team);
  const available = new Set(team?.players.map(p => p.key));
  return keys.map(key => available.has(key) ? key : '');
}
async function loadTemplate() {
  if (templatePromise) return templatePromise;
  templatePromise = (async () => {
    try {
      const response = await fetch('/assets/obs-template.json');
      if (!response.ok) {
        throw new Error('Не загружен шаблон OBS. Попробуй обновить страницу.');
      }
      const template = await response.json();
      if (!Array.isArray(template.sources)) {
        throw new Error('Некорректный шаблон OBS.');
      }
      state.template = template;
      state.templateError = '';
    } catch (error) {
      state.templateError = error.message;
    } finally {
      templatePromise = null;
      renderOutput();
    }
  })();
  return templatePromise;
}
async function refresh() {
  const request = ++refreshId;
  controller?.abort();
  controller = new AbortController();
  const source = { ...state.source }, signal = controller.signal;
  const timer = setTimeout(() =>
    controller?.signal === signal &&
      controller.abort(new DOMException(
        'Таблица долго отвечает.', 'TimeoutError')), 20000);
  $('refreshBtn').disabled = true;
  $('refreshBtn').textContent = 'Обновляем…';
  showError('');
  if (!state.template) loadTemplate();
  try {
    const [roster, schedule] = await Promise.allSettled([
      sheetRows(source, source.gid, 'A1:K2000', signal),
      source.scheduleGid ?
        sheetRows(source, source.scheduleGid, 'A1:H1000',
          signal, source.scheduleId || source.id) :
        Promise.resolve([])
    ]);
    if (request !== refreshId) return;
    if (roster.status !== 'fulfilled') throw roster.reason;
    const teams = parseTeams(roster.value);
    const names = teams.map(t => t.name);
    state.teams = teams;
    state.schedule = (
      schedule.status === 'fulfilled' ?
        parseSchedule(schedule.value) : state.schedule
    ).filter(m => names.includes(m.team1) && names.includes(m.team2));

    if (!names.includes(state.a)) {
      state.a = names[0];
      state.keysA = [];
    }
    if (!names.includes(state.b) || state.b === state.a) {
      state.b = names.find(n => n !== state.a) || '';
      state.keysB = [];
    }
    state.keysA = reconcileKeys(getTeam('a'), state.keysA);
    state.keysB = reconcileKeys(getTeam('b'), state.keysB);
    state.lastSync = new Date();
    state.stale = false;
    render();
    $('syncTitle').textContent = `${teams.length} команд из таблицы`;
    $('syncDot').className = 'good';
    $('syncTime').textContent =
      'Обновлено ' + state.lastSync.toLocaleTimeString('ru-RU', {
        timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit'
      }) + ' МСК';
    if (schedule.status === 'fulfilled') {
      state.scheduleDay = scheduleDay(schedule.value);
    }
    renderScheduleDay();
    if (schedule.status === 'rejected') {
      showError('Составы загружены. Расписание недоступно — выбери команды, время и стадию вручную.');
    } else if (state.scheduleDay && state.scheduleDay !== mskToday()) {
      showError(`Расписание в таблице на ${state.scheduleDay}, а сегодня ${mskToday()} по МСК. Если для нового дня завели новый лист, укажи его GID в «Источник данных».`);
    }
  } catch (error) {
    if (request !== refreshId) return;
    state.stale = true;
    $('syncDot').className = 'stale';
    $('syncTitle').textContent = state.teams.length ?
      'Данные требуют обновления' : 'Нет связи с таблицей';
    showError(
      (signal.reason?.name === 'TimeoutError' ?
        'Google Sheets долго отвечает. Попробуй обновить ещё раз.' :
        error.message) +
      (state.lastSync ? ' Показаны ранее загруженные составы.' : '')
    );
    if (!state.teams.length) {
      $('teamGrid').innerHTML =
        '<div class="empty-panel">Не удалось загрузить составы. Проверь источник и доступ на просмотр по ссылке, затем обнови данные.</div>';
    }
    renderOutput();
    renderVeto();
  } finally {
    clearTimeout(timer);
    if (request === refreshId) {
      $('refreshBtn').disabled = false;
      $('refreshBtn').textContent = '↻ Обновить';
    }
  }
}

function mskToday() {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit'
  }).format(new Date());
}
function renderScheduleDay() {
  $('scheduleLabel').textContent = 'Матч по расписанию' +
    (state.scheduleDay ? ` · ${state.scheduleDay}` : '');
}
// Images come from veto.oneshot.su; if a file is missing, show no broken icon.
function dropBrokenImage(img) {
  if (img.complete && !img.naturalWidth) img.remove();
  else img.addEventListener('error', () => img.remove(), { once: true });
}

function render() {
  $('matchSelect').innerHTML =
    '<option value="">Выбери команды вручную</option>' +
    state.schedule.map(m => `<option value="${escapeHtml(m.key)}">${escapeHtml(
      [m.time, m.stage, `${m.team1} vs ${m.team2}`]
        .filter(Boolean).join(' · ')
    )}</option>`).join('');
  if (!state.schedule.some(m =>
      m.key === state.matchKey &&
      m.team1 === state.a && m.team2 === state.b)) {
    state.matchKey = '';
  }
  $('matchSelect').value = state.matchKey;

  $('teamGrid').innerHTML = ['a', 'b'].map((side, index) => {
    const team = getTeam(side);
    if (!team) return '<div class="empty-panel">Команда не выбрана</div>';
    const keys = state[side === 'a' ? 'keysA' : 'keysB'];
    const eligible = lineupCandidates(team);
    return `<article class="team-card">
      <div class="card-top">
        <div class="team-letter">${index ? 'B' : 'A'}</div>
        <div class="team-heading">
          <label for="team-${side}">${index ? 'ВТОРАЯ' : 'ПЕРВАЯ'} КОМАНДА</label>
          <select id="team-${side}" data-team="${side}">
            ${state.teams.map(t => `<option
              ${t.name === team.name ? 'selected' : ''}
              value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join('')}
          </select>
        </div>
        <span class="slot-caption">${index ? '06–10' : '01–05'}</span>
      </div>
      <div class="camera-list">${Array.from({ length: 5 }, (_, i) => {
        const player = team.players.find(p => p.key === keys[i]);
        return `<div class="player-row">
          <span class="slot-number">${String(index * 5 + i + 1).padStart(2, '0')}</span>
          <div class="player-info">
            <select data-player="${side}" data-slot="${i}" aria-label="Игрок ${index * 5 + i + 1}">
              <option value="">Выбери игрока</option>
              ${eligible.map(p => `<option
                value="${escapeHtml(p.key)}"
                ${p.key === keys[i] ? 'selected' : ''}
                ${keys.includes(p.key) && p.key !== keys[i] ? 'disabled' : ''}
              >${escapeHtml(p.nick + roleSuffix(p))}</option>`).join('')}
            </select>
            <span class="player-subline">${player ?
              escapeHtml(`room: ${player.room} / ${player.role.toLowerCase()}`) :
              'Место не заполнено'}</span>
          </div>
          <button class="copy-icon" data-view="${side}" data-slot="${i}"
            aria-label="Скопировать VIEW ${player ? escapeHtml(player.nick) : ''}"
            title="Копировать VIEW" ${!player ? 'disabled' : ''}>⧉</button>
        </div>`;
      }).join('')}</div>
      <div class="card-actions">
        <button class="text-button" data-reset="${side}">↻ Порядок из таблицы</button>
        <div class="card-bottom">
          <button class="text-button" data-copy-team="${side}"
            ${validatePlayers(chosen(side)) ? 'disabled' : ''}>Игрокам ⧉</button>
          <a class="text-button" target="_blank" rel="noreferrer"
            href="${escapeHtml(directorUrl(team))}">Директор</a>
        </div>
      </div>
    </article>`;
  }).join('');

  $('teamGrid').querySelectorAll('[data-team]').forEach(el =>
    el.addEventListener('change', () => {
      const side = el.dataset.team;
      state[side] = el.value;
      state[side === 'a' ? 'keysA' : 'keysB'] = defaultLineup(getTeam(side));
      state.matchKey = '';
      render();
    }));
  $('teamGrid').querySelectorAll('[data-player]').forEach(el =>
    el.addEventListener('change', () => {
      state[el.dataset.player === 'a' ? 'keysA' : 'keysB']
        [Number(el.dataset.slot)] = el.value;
      render();
    }));
  $('teamGrid').querySelectorAll('[data-reset]').forEach(el =>
    el.addEventListener('click', () => {
      const side = el.dataset.reset;
      state[side === 'a' ? 'keysA' : 'keysB'] = defaultLineup(getTeam(side));
      render();
      toast('Порядок восстановлен из таблицы');
    }));
  $('teamGrid').querySelectorAll('[data-view]').forEach(el =>
    el.addEventListener('click', () => {
      const player = chosen(el.dataset.view)[Number(el.dataset.slot)];
      if (player) copy(viewUrl(player));
    }));
  $('teamGrid').querySelectorAll('[data-copy-team]').forEach(el =>
    el.addEventListener('click', () => {
      const side = el.dataset.copyTeam, players = chosen(side);
      const error = validatePlayers(players);
      if (error) return toast(error);
      copy(playerText(getTeam(side), players));
    }));
  renderOutput();
  renderVeto();
  persist();
}

function renderOutput() {
  const error = valid();
  const metadataError =
    validateMetadata($('matchTime').value, $('matchStage').value);
  $('downloadBtn').disabled = !!error || !!metadataError || !state.template;
  $('copyAllBtn').disabled = !!error;
  $('swapBtn').disabled = !getTeam('a') || !getTeam('b');
  $('exportHint').textContent =
    error || metadataError || state.templateError ||
    (!state.template ? 'Загружаем шаблон OBS…' :
      `${state.stale ? 'По ранее загруженным данным. ' : ''}1–5: ${state.a} · 6–10: ${state.b}`);
  $('filenamePreview').textContent =
    !error && !metadataError ?
      safeFilename(state.a, state.b,
        $('matchTime').value, $('matchStage').value) : '';
  const playersTab = state.tab === 'players';
  for (const [id, selected] of [
    ['tabObserver', !playersTab], ['tabPlayers', playersTab]
  ]) {
    $(id).classList.toggle('selected', selected);
    $(id).setAttribute('aria-selected', String(selected));
    $(id).tabIndex = selected ? 0 : -1;
  }
  $('outputPanel').setAttribute('aria-labelledby',
    playersTab ? 'tabPlayers' : 'tabObserver');
  $('previewLabel').textContent = playersTab ?
    'Команда, жирный ник и отдельная PUSH-ссылка' :
    'Ники и VIEW-ссылки строго по слотам 1–10';
  $('output').value = error ? '' : playersTab ?
    playerText(getTeam('a'), chosen('a')) + '\n\n' +
      playerText(getTeam('b'), chosen('b')) :
    observerText(getTeam('a'), getTeam('b'), chosen('a'), chosen('b'));
  $('copyFoot').textContent = playersTab ?
    'Только выбранные игроки. Ссылки директора сюда не попадают.' :
    'Имена, ссылки и JSON используют один порядок десяти слотов.';
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано в буфер обмена');
    return;
  } catch { /* Continue with the same payload. */ }
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  let ok = false;
  try { ok = document.execCommand('copy'); }
  catch { /* Manual fallback below. */ }
  finally { field.remove(); }
  if (ok) return toast('Скопировано');
  $('manualCopy').value = text;
  if (!$('copyDialog').open) $('copyDialog').showModal();
  $('manualCopy').focus();
  $('manualCopy').select();
}

function renderVeto() {
  const identity = JSON.stringify([state.a, state.b, state.matchKey]);
  if (state.veto.matchKey !== identity) {
    state.veto = {
      format: state.veto.format, first: state.veto.first,
      actions: [], matchKey: identity
    };
    state.pending = null;
  }
  const { actions, format, first } = state.veto;
  const ready = !!getTeam('a') && !!getTeam('b') && state.a !== state.b;
  const finished = actions.length === 6;
  $('vetoFormat').value = format;
  $('vetoFormat').disabled = actions.length > 0 || !!state.pending;
  $('vetoFirst').innerHTML =
    [state.a || 'Первая команда', state.b || 'Вторая команда']
      .map((name, index) =>
        `<option value="${index}">${escapeHtml(name)}</option>`).join('');
  $('vetoFirst').value = String(first);
  $('vetoFirst').disabled = !ready || actions.length > 0 || !!state.pending;

  const team = (first + actions.length) % 2;
  const teams = [state.a, state.b];
  const type = VETO_RULES[format][actions.length];
  $('vetoStatus').textContent = !ready ?
    'Выбери две разные команды.' :
    state.pending ? `Выбери сторону для ${teams[1 - team]} на ${state.pending}.` :
    finished ? 'Вето завершено. Текст готов для HLTV.' :
    `Ход ${actions.length + 1}/6 · ${teams[team]} · ${type === 'pick' ?
      'PICK — выбирает карту' : 'BAN — убирает карту'}`;
  $('sideChoice').hidden = !state.pending;
  $('sideLabel').textContent = state.pending ?
    `${teams[1 - team]} начинает на ${state.pending}:` : '';

  $('mapGrid').innerHTML = MAP_POOL.map(map => {
    const action = actions.find(a => a.map === map);
    const leftover = finished && !action;
    const label = action ?
      `${action.type === 'pick' ? 'PICK' : 'BAN'} · ${teams[action.team]}${action.type === 'pick' ?
        ` · ${teams[1 - action.team]} ${action.side}` : ''}` :
      leftover ? 'DECIDER · was left over' :
      state.pending === map ? 'Выбор стороны…' : 'Выбрать карту';
    return `<button
      class="map-card ${action ? action.type : leftover ? 'leftover' : ''}"
      data-map="${map}"
      ${!ready || !!action || finished || !!state.pending ? 'disabled' : ''}
      aria-label="${escapeHtml(map + ': ' + label)}">
      <img src="/assets/maps/${map}.jpg" alt="" loading="lazy" width="960" height="180">
      <span class="map-name">${map}</span>
      <span class="map-action">${escapeHtml(label)}</span>
    </button>`;
  }).join('');
  $('mapGrid').querySelectorAll('img').forEach(dropBrokenImage);
  $('mapGrid').querySelectorAll('[data-map]').forEach(el =>
    el.addEventListener('click', () => {
      if (VETO_RULES[state.veto.format][state.veto.actions.length] === 'pick') {
        state.pending = el.dataset.map;
        renderVeto();
        $('chooseCT').focus();
      } else commitVeto(el.dataset.map);
    }));
  $('vetoOutput').value =
    ready ? vetoText(teams, actions, format, first) : '';
  $('vetoHint').textContent = finished ?
    'Полное вето · 7 строк' :
    'Неполное вето — текст обновляется после каждого хода.';
  $('copyVeto').disabled = !ready || actions.length === 0 || !!state.pending;
  $('vetoUndo').disabled = !state.pending && actions.length === 0;
  $('vetoReset').disabled = !state.pending && actions.length === 0;
}
function commitVeto(map, side) {
  try {
    state.veto.actions = appendVeto(state.veto.actions,
      state.veto.format, state.veto.first, map, side);
    state.pending = null;
    renderVeto();
    persist();
    // The map buttons were re-rendered; keep keyboard users on the grid.
    ($('mapGrid').querySelector('button:not(:disabled)') || $('copyVeto'))
      .focus({ preventScroll: true });
    if (state.veto.actions.length === 6 && $('autoCopyVeto').checked) {
      copy($('vetoOutput').value);
    }
  } catch (error) { toast(error.message); }
}

$('chooseCT').addEventListener('click', () => {
  if (state.pending) commitVeto(state.pending, 'CT');
});
$('chooseT').addEventListener('click', () => {
  if (state.pending) commitVeto(state.pending, 'T');
});
$('cancelSide').addEventListener('click', () => {
  state.pending = null;
  renderVeto();
});
$('vetoUndo').addEventListener('click', () => {
  if (state.pending) state.pending = null;
  else state.veto.actions.pop();
  renderVeto();
  persist();
});
$('vetoReset').addEventListener('click', () => {
  if (confirm('Сбросить текущее вето?')) {
    state.veto.actions = [];
    state.pending = null;
    renderVeto();
    persist();
  }
});
$('vetoFormat').addEventListener('change', () => {
  state.veto.format = $('vetoFormat').value;
  renderVeto();
  persist();
});
$('vetoFirst').addEventListener('change', () => {
  state.veto.first = Number($('vetoFirst').value);
  renderVeto();
  persist();
});
$('copyVeto').addEventListener('click', () => copy($('vetoOutput').value));
$('refreshBtn').addEventListener('click', refresh);
$('swapBtn').addEventListener('click', () => {
  [state.a, state.b] = [state.b, state.a];
  [state.keysA, state.keysB] = [state.keysB, state.keysA];
  state.matchKey = '';
  render();
  toast('Команды поменялись сторонами');
});
$('matchSelect').addEventListener('change', () => {
  state.matchKey = $('matchSelect').value;
  const match = state.schedule.find(m => m.key === state.matchKey);
  if (match) {
    state.a = match.team1;
    state.b = match.team2;
    state.keysA = defaultLineup(getTeam('a'));
    state.keysB = defaultLineup(getTeam('b'));
    $('matchTime').value = match.time;
    $('matchStage').value = match.stage;
  }
  render();
});
for (const id of ['matchTime', 'matchStage']) {
  $(id).addEventListener('input', () => { renderOutput(); persist(); });
}
for (const [id, tab] of [
  ['tabObserver', 'observer'], ['tabPlayers', 'players']
]) {
  $(id).addEventListener('click', () => {
    state.tab = tab;
    renderOutput();
    persist();
  });
  $(id).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 'tabObserver' :
        event.key === 'End' ? 'tabPlayers' :
        id === 'tabObserver' ? 'tabPlayers' : 'tabObserver';
      $(next).click();
      $(next).focus();
    }
  });
}
$('copyAllBtn').addEventListener('click', () => copy($('output').value));
$('downloadBtn').addEventListener('click', () => {
  try {
    const filename = safeFilename(state.a, state.b,
      $('matchTime').value, $('matchStage').value);
    const data = buildObs(state.template,
      getTeam('a'), getTeam('b'), state.keysA, state.keysB);
    const url = URL.createObjectURL(new Blob([
      JSON.stringify(data, null, 2) + '\n'
    ], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('JSON готов. OBS → Коллекция сцен → Импорт.');
  } catch (error) { showError(error.message); }
});

function fillSource(source) {
  $('sourceUrl').value =
    `https://docs.google.com/spreadsheets/d/${source.id}/edit`;
  $('sourceGid').value = source.gid;
  $('scheduleUrl').value = source.scheduleGid ?
    `https://docs.google.com/spreadsheets/d/${source.scheduleId || source.id}/edit` : '';
  $('scheduleGid').value = source.scheduleGid || '';
}
function sheetId(value) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/spreadsheets\/d\/([\w-]{20,100})(?:\/|$)/);
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' ||
      url.username || url.password || !match) {
    throw new Error('Вставь ссылку на Google Sheets.');
  }
  return match[1];
}
$('settingsBtn').addEventListener('click', () => {
  fillSource(state.source);
  $('sourceError').hidden = true;
  $('settingsDialog').showModal();
});
$('closeSettings').addEventListener('click', () => $('settingsDialog').close());
$('closeCopy').addEventListener('click', () => $('copyDialog').close());
$('resetSource').addEventListener('click', () => fillSource(DEFAULT_SOURCE));
$('settingsForm').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const id = sheetId($('sourceUrl').value.trim());
    const gid = $('sourceGid').value.trim();
    const scheduleUrl = $('scheduleUrl').value.trim();
    const scheduleGid = $('scheduleGid').value.trim();
    if (!/^\d+$/.test(gid) ||
        (scheduleUrl && !/^\d+$/.test(scheduleGid))) {
      throw new Error('Укажи числовой GID нужного листа.');
    }
    state.source = {
      id, gid, scheduleId: scheduleUrl ? sheetId(scheduleUrl) : null,
      scheduleGid: scheduleUrl ? scheduleGid : null
    };
    const stored = writeStorage('webcam-desk-source', state.source);
    state.teams = [];
    state.schedule = [];
    state.scheduleDay = '';
    renderScheduleDay();
    state.lastSync = null;
    state.a = '';
    state.b = '';
    state.keysA = [];
    state.keysB = [];
    state.matchKey = '';
    updateSourceLinks();
    $('settingsDialog').close();
    $('teamGrid').innerHTML =
      '<div class="empty-panel">Загружаем составы…</div>';
    renderOutput();
    renderVeto();
    refresh();
    if (!stored) {
      toast('Источник подключён. Браузер не разрешил сохранить настройки для следующего открытия.');
    }
  } catch (error) {
    $('sourceError').textContent = error.message;
    $('sourceError').hidden = false;
  }
});

document.querySelectorAll('.brand img').forEach(dropBrokenImage);
updateSourceLinks();
renderOutput();
renderVeto();
loadTemplate();
refresh();
