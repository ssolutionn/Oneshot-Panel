// Кнопка «Статистика» и диалог статистики матча eBot (только сайт).
// Открывается с карточки матча в блоке «Матчи eBot»: таблица игроков со
// страницы /matchs/view/<id> (через /api/ebot?view=) и хитмапа событий
// (через POST /api/ebot?heatmap=). Карта — радары eBot из
// assets/maps/radar/ (браузер в eBot не ходит: CSP img-src 'self');
// для карт без радара — наша миниатюра с честной пометкой.
// Всё из eBot — только textContent; рисование — canvas. Без eBot
// диалог просто показывает ошибку, блок не ломается.
import { parseStatsPage, parseHeatmap, heatmapParams, HEATMAP_TYPES } from './ebot-stats-parse.js';

const $ = id => document.getElementById(id);
// Радиары eBot кладём рядом с миниатюрами; фоллбэк — наши jpg.
const RADAR_DIR = '/assets/maps/radar/';
const FALLBACK_DIR = '/assets/maps/';
// Карты, у которых есть радар eBot (файл скачан в репозиторий). eBot
// хранит точку в координатах СВОЕГО радара, поэтому фон обязан
// совпадать; остальных карт у eBot нет — там честный фоллбэк.
const RADARS = new Set([
  'de_dust2', 'de_mirage', 'de_inferno', 'de_nuke', 'de_cbble',
  'de_cache', 'de_train', 'de_season'
]);

// ---------- карточка: кнопка «Статистика» ----------

// Карточки рисует ebot-ui.js; свой модуль их не правит — кнопку
// «Статистика» добавляем в каждый .lm-top после перерисовки списка
// (MutationObserver), клик ловим делегированием. Кнопка на любой
// карточке: статистика есть и у завершённого матча, и у живого.
const matchesBox = $('ebotMatches');
const observer = new MutationObserver(addStatButtons);
observer.observe(matchesBox, { childList: true, subtree: true });
addStatButtons();

function addStatButtons() {
  for (const card of matchesBox.querySelectorAll('.lobby-match')) {
    if (card.querySelector('[data-ebot-stats]')) continue;
    const top = card.querySelector('.lm-top');
    if (!top) continue;
    const button = Object.assign(document.createElement('button'), {
      type: 'button', className: 'button small', textContent: 'Статистика',
      title: 'Таблица игроков и хитмапа матча'
    });
    button.setAttribute('data-ebot-stats', '');
    // «Консоль» стоит у статуса; статистика — справа, как реже нужная.
    top.append(button);
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-ebot-stats]');
  if (!button) return;
  const card = button.closest('.lobby-match');
  const matchId = card?.dataset.match;
  if (matchId) openStats(matchId);
});

// ---------- диалог ----------

const state = {
  matchId: null, match: null, players: [], teams: ['', ''],
  sort: { key: 'kill', dir: -1 },
  heat: { points: [], mode: 'heat', busy: false },
  radar: { img: null, width: 500, height: 509, approximate: false }
};

function status(text) { $('ebotStatsStatus').textContent = text; }

async function openStats(matchId) {
  state.matchId = String(matchId);
  state.match = null;
  state.players = [];
  state.teams = ['', ''];
  state.heat.points = [];
  state.radar.img = null;
  $('ebotStatsMatch').textContent = `Матч #${matchId}`;
  $('ebotStatsHead').replaceChildren();
  $('ebotStatsBody').replaceChildren();
  showTab('players');
  $('ebotStatsDialog').showModal();
  status('Загружаем статистику матча…');
  try {
    const response = await fetch(`/api/ebot?view=${encodeURIComponent(matchId)}`, { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.page !== 'string') {
      throw new Error(body.message || `HTTP ${response.status}`);
    }
    // Карточку списка читает ebot-ui.js; сюда он кладёт текущий снимок.
    const parsed = parseStatsPage(body.page);
    state.players = parsed.players;
    state.teams = parsed.teams;
    renderMatch();
    renderTable();
    status(state.players.length ? '' : 'eBot не показал статистику игроков этого матча.');
  } catch (error) {
    status(`Статистика не загрузилась: ${error.message}`);
  }
}

// Шапка: команды и счёт карточки (счёт у списка свежее, чем у страницы).
function currentMatchCard() {
  return document.querySelector(`.lobby-match[data-match="${CSS.escape(state.matchId || '')}"]`);
}

function renderMatch() {
  let teamA = state.teams[0], teamB = state.teams[1], score = '';
  const card = currentMatchCard();
  if (card) {
    const teams = [...card.querySelectorAll('.lm-team')].map(node => node.textContent);
    const scoreNode = card.querySelector('.lm-score');
    if (teams.length >= 2) { teamA ||= teams[0]; teamB ||= teams[1]; }
    if (scoreNode) score = scoreNode.textContent;
  }
  $('ebotStatsMatch').textContent = `${teamA || 'Команда A'} ${score} ${teamB || 'Команда B'}`.replace(/\s+/g, ' ').trim() +
    ` · матч #${state.matchId}`;
}

// ---------- табы ----------

function showTab(name) {
  const players = name === 'players';
  $('ebotStatsTabPlayers').classList.toggle('selected', players);
  $('ebotStatsTabHeat').classList.toggle('selected', !players);
  $('ebotStatsTabPlayers').setAttribute('aria-selected', String(players));
  $('ebotStatsTabHeat').setAttribute('aria-selected', String(!players));
  $('ebotStatsPlayers').hidden = !players;
  $('ebotStatsHeat').hidden = players;
  if (!players && !state.heat.points.length) loadHeatmap();
}
$('ebotStatsTabPlayers').addEventListener('click', () => showTab('players'));
$('ebotStatsTabHeat').addEventListener('click', () => showTab('heat'));
$('ebotStatsClose').addEventListener('click', () => $('ebotStatsDialog').close());

// ---------- таблица игроков ----------

const COLUMNS = [
  ['nick', 'Ник', 'left'], ['kill', 'К', 'num'], ['assist', 'А', 'num'],
  ['death', 'D', 'num'], ['kd', 'K/D', 'num'], ['points', 'Очки', 'num'],
  ['hsRate', 'HS%', 'num']
];

function renderTable() {
  const head = $('ebotStatsHead');
  head.replaceChildren();
  for (const [key, label, align] of COLUMNS) {
    const th = document.createElement('th');
    th.scope = 'col';
    if (align === 'left') th.classList.add('left');
    th.textContent = label;
    th.title = 'Сортировать по этому столбцу';
    th.setAttribute('aria-sort', sortedState(key));
    th.addEventListener('click', () => {
      state.sort = state.sort.key === key
        ? { key, dir: -state.sort.dir }
        : { key, dir: key === 'nick' ? 1 : -1 };
      renderTable();
    });
    head.append(th);
  }
  const body = $('ebotStatsBody');
  body.replaceChildren();
  const rows = sortedPlayers();
  let team = null;
  for (const player of rows) {
    if (player.team !== team) {
      team = player.team;
      const headRow = document.createElement('tr');
      const cell = document.createElement('th');
      cell.colSpan = COLUMNS.length;
      cell.scope = 'colgroup';
      cell.className = 'ebot-stats-team';
      cell.dataset.team = teamOf(player);
      cell.textContent = team;
      headRow.append(cell);
      body.append(headRow);
    }
    const tr = document.createElement('tr');
    for (const [key] of COLUMNS) {
      const td = document.createElement('td');
      td.textContent = valueText(player[key]);
      if (key === 'nick') td.className = 'ebot-stats-nick';
      tr.append(td);
    }
    body.append(tr);
  }
}

function sortedState(key) {
  if (state.sort.key !== key) return 'none';
  return state.sort.dir > 0 ? 'ascending' : 'descending';
}

// Команда какой это стороны: первая встреченная — A, вторая — B.
function teamOf(player) {
  if (player.team === state.teams[0]) return 'a';
  if (player.team === state.teams[1]) return 'b';
  return 'a';
}

function sortedPlayers() {
  const rows = [...state.players];
  const { key, dir } = state.sort;
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    const an = typeof av === 'number', bn = typeof bv === 'number';
    const result = an && bn ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''), 'ru');
    return result * dir || String(a.nick).localeCompare(String(b.nick), 'ru');
  });
  return rows;
}

function valueText(value) {
  return value === undefined || value === '' ? '—' : String(value);
}

// ---------- хитмапа ----------

// Таблица eBot отдаёт точки в координатах СВОЕГО радара (PHP уже
// пересчитал игровые координаты в пиксели) — фон тот же радар, и
// никакого масштабирования точек не нужно. Канвас всегда натурального
// размера картинки; ужать его в контейнере — CSS, координаты не трогаем.
async function loadHeatmap() {
  if (state.heat.busy) return;
  state.heat.busy = true;
  try {
    status('Загружаем хитмапу…');
    await ensureRadar();
    const params = heatmapParams({
      type: $('ebotStatsType').value,
      sides: $('ebotStatsSide').value
    });
    const response = await fetch(`/api/ebot?heatmap=${encodeURIComponent(state.matchId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `HTTP ${response.status}`);
    }
    const points = parseHeatmap(await response.json());
    state.heat.points = points;
    drawHeatmap();
    status(points.length ? `Точек: ${points.length}.` : 'По этим фильтрам событий нет.');
  } catch (error) {
    state.heat.points = [];
    drawHeatmap();
    status(`Хитмапа не загрузилась: ${error.message}`);
  } finally {
    state.heat.busy = false;
  }
}

$('ebotStatsHeatForm').addEventListener('submit', event => {
  event.preventDefault();
  loadHeatmap();
});

$('ebotStatsMode').addEventListener('click', () => {
  state.heat.mode = state.heat.mode === 'heat' ? 'dots' : 'heat';
  const dots = state.heat.mode === 'dots';
  const button = $('ebotStatsMode');
  button.textContent = dots ? 'Тепло' : 'Точки';
  button.setAttribute('aria-pressed', String(dots));
  drawHeatmap();
});

// Выбор типа событий из чистого списка ebot-stats-parse.js.
for (const [value, label] of HEATMAP_TYPES) {
  $('ebotStatsType').append(Object.assign(document.createElement('option'), { value, textContent: label }));
}

// Фон: радар eBot для знакомой карты, иначе наша миниатюра
// (координаты лягут с искажением — показываем честную пометку).
async function ensureRadar() {
  const map = radarMapName();
  if (state.radar.img) return;
  // Карта неизвестна списку — не притворяемся dust2: чистый холст с точками.
  if (!map) {
    state.radar.img = null;
    state.radar.width = 500;
    state.radar.height = 509;
    const canvas = $('ebotStatsCanvas');
    canvas.width = 500;
    canvas.height = 509;
    $('ebotStatsRadarNote').hidden = false;
    $('ebotStatsRadarNote').textContent = 'Карта матча не определена — только точки.';
    return;
  }
  const known = RADARS.has(map);
  const url = known ? RADAR_DIR + map + '.png'
    : FALLBACK_DIR + mapNameToJpg(map);
  $('ebotStatsRadarNote').hidden = known;
  state.radar.approximate = !known;
  await new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      state.radar.img = img;
      state.radar.width = img.naturalWidth || 500;
      state.radar.height = img.naturalHeight || 509;
      const canvas = $('ebotStatsCanvas');
      canvas.width = state.radar.width;
      canvas.height = state.radar.height;
      resolve();
    };
    img.onerror = () => {
      // Нет и миниатюры: чистый холст, точки всё равно видны.
      state.radar.img = null;
      state.radar.width = 500;
      state.radar.height = 509;
      const canvas = $('ebotStatsCanvas');
      canvas.width = 500;
      canvas.height = 509;
      $('ebotStatsRadarNote').hidden = false;
      $('ebotStatsRadarNote').textContent = 'Радар карты недоступен — только точки.';
      resolve();
    };
    img.src = url;
  });
}

function radarMapName() {
  const card = currentMatchCard();
  const meta = card?.querySelector('.lm-meta');
  // «de_dust2 · матч #46» — карту пишет карточка списка. Карты нет
  // (список без ячейки карты) — честная пустота, а не чужой de_dust2:
  // точки легли бы на неверный радар без предупреждения.
  return meta?.textContent.match(/de_[a-z0-9_]+/i)?.[0]?.toLowerCase() || '';
}

function mapNameToJpg(map) {
  // de_dust2 → Dust2.jpg — так лежат наши миниатюры.
  return map.replace(/^de_/, '').replace(/(^\w|_\w)/g, m => m.replace('_', '').toUpperCase()) + '.jpg';
}

// Рисование: классическая сетка — счёт точек в клетку 8px, для каждой
// клетки радиальный градиент с альфой по log(счёт), цвет от синего к
// красному по плотности. Без фильтров canvas — работает одинаково во
// всех браузерах (ctx.filter ненадёжен в Safari).
// Режим «Точки» — маркеры события по цвету выбранной стороны
// (CT синий, T красный, обе — белые); для kill eBot отдаёт позицию
// жертвы.
function drawHeatmap() {
  const canvas = $('ebotStatsCanvas');
  const ctx = canvas.getContext('2d');
  const { width, height } = state.radar;
  ctx.clearRect(0, 0, width, height);
  if (state.radar.img) ctx.drawImage(state.radar.img, 0, 0, width, height);
  if (state.heat.mode === 'dots') {
    const side = $('ebotStatsSide').value;
    const color = side === 'ct' ? 'rgba(36,107,222,.7)' : side === 't' ? 'rgba(214,80,32,.7)' : 'rgba(255,255,255,.75)';
    for (const { x, y } of state.heat.points) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (!state.heat.points.length) return;
  // Сетка плотности; крайние клетки обрезаем — точки у границы не
  // пропадают.
  const cell = 8;
  const cols = Math.ceil(width / cell), rows = Math.ceil(height / cell);
  const grid = new Float64Array(cols * rows);
  let max = 0;
  for (const { x, y } of state.heat.points) {
    const gx = Math.min(Math.floor(x / cell), cols - 1);
    const gy = Math.min(Math.floor(y / cell), rows - 1);
    const value = ++grid[gy * cols + gx];
    if (value > max) max = value;
  }
  if (!max) return;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const count = grid[gy * cols + gx];
      if (!count) continue;
      // log: 1 точка едва видна, десяток — уже горячо.
      const density = Math.log(1 + count) / Math.log(1 + max);
      drawBlot(ctx, gx * cell + cell / 2, gy * cell + cell / 2, density, count);
    }
  }
}

// Одна «клякса»: радиальный градиент, цвет интерполируем от синего к
// красному по плотности, альфа тоже растёт с плотностью.
function drawBlot(ctx, x, y, density, count) {
  const radius = 10 + 8 * density;
  const [r, g, b] = heatColor(density);
  const alpha = 0.1 + 0.5 * density;
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
  gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

// rgb(30,40,220) → rgb(235,60,40): холодные скопления синие, горячие
// красные; зелёный проваливается к середине, чтобы жёлтый читался.
function heatColor(density) {
  const cold = [30, 40, 220], hot = [235, 60, 40];
  return cold.map((c, i) => Math.round(c + (hot[i] - c) * density));
}
