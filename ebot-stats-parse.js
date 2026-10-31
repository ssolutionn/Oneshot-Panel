// Чистая логика статистики матча eBot (без DOM, для тестов): разбор HTML
// страницы /matchs/view/<id> и сборка параметров POST /matchs/heatmap/<id>.
// Кнопки «Статистика» и сам диалог — в ebot-stats.js; прокси — в
// netlify/functions/ebot.mjs. Паттерн разбора тот же, что в ebot.js:
// срез тегов ДО декодирования entities, чтобы «&lt;script&gt;» в нике
// не собрался в тег и не вырезал содержимое строки.

// Заголовки таблицы игроков, которые разбираем. Ищем таблицу по паре
// «Player» + «Kill» в заголовках — id="tablePlayers" тоже подходит, но
// заголовки надёжнее: колонки берём ПО ИМЕНЕ, не по позиции (eBot
// меняет набор колонок от версии к версии, сейчас их ~24).
const WANTED = {
  Team: 'team', Player: 'nick', Kill: 'kill', Assist: 'assist', Death: 'death',
  'K/D Rate': 'kd', Points: 'points', HeadShot: 'hs', 'HS Rate': 'hsRate',
  Defuse: 'defuse', Bombe: 'bombe', TK: 'tk', FK: 'fk', 'Pt Clutch': 'ptClutch'
};
// Уникальные по первым символам: «1v1»..«1v5», «1K»..«5K».
for (let i = 1; i <= 5; i++) {
  WANTED['1v' + i] = 'clutch' + i;
  WANTED[i + 'K'] = 'multi' + i;
}

// Статистика игрока: всё в числах, где число имеет смысл. Ник и команда —
// текст (entity-декодированный), срез лишних пробелов как в ebot.js.
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const num = value => NUMBER.test(value) ? Number(value) : value;

// Разбор страницы /matchs/view/<id>: {players, teams}.
// players — строки таблицы stats-players; teams — [A, B] из заголовка
// «Match #N - A vs B». Счёт и карту карточка матча уже знает из списка
// (parseEbotMatches), здесь их не дублируем.
export function parseStatsPage(html) {
  const source = String(html ?? '');
  const players = [];
  const tableMatch = source.match(/id="tablePlayers"[\s\S]*?<\/table>/i);
  if (tableMatch) {
    const table = tableMatch[0];
    const headerRow = table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/i);
    const columns = headerRow
      ? [...headerRow[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m => text(m[1]))
      : [];
    const byName = new Map();
    columns.forEach((name, index) => {
      // Порядок обхода важен: при дубле заголовка берём первый.
      if (!byName.has(name)) byName.set(name, index);
    });
    // Только tbody: итоговая строка «Total» живёт в tfoot и игроком не
    // считается; по заголовкам (<th> в строке) её тоже отсекаем.
    const bodyMatch = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
    const rowSource = bodyMatch ? bodyMatch[1] : table;
    for (const row of (rowSource.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || [])) {
      if (/<th\b/i.test(row)) continue;
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => text(m[1]));
      if (cells.length < 3) continue;
      const player = {};
      for (const [header, field] of Object.entries(WANTED)) {
        const index = byName.get(header);
        if (index !== undefined && index < cells.length) player[field] = num(cells[index]);
      }
      if (player.nick) players.push(player);
    }
  }
  return { players, teams: parseTeams(source) };
}

// Команды из <h4>Match #46 - Alpha vs Bravo</h4>. « vs » — разделитель
// самой страницы; лишние пробелы по краям срезаем.
export function parseTeams(html) {
  const heading = String(html ?? '').match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i);
  if (!heading) return ['', ''];
  const title = text(heading[1]);
  const pair = title.split(/\s+vs\s+/i);
  if (pair.length !== 2) return ['', ''];
  return [pair[0].replace(/^Match\s*#\d+\s*-\s*/i, '').trim(), pair[1].trim()];
}

// Точки хитмапы eBot: {"type":"heatmap","points":[{x,y}...]}. Пропускаем
// точки вне канваса — eBot иногда отдаёт координату впритык к границе.
export function parseHeatmap(json) {
  const points = [];
  const body = typeof json === 'string' ? safeJson(json) : json;
  if (!body || typeof body !== 'object' || !Array.isArray(body.points)) return points;
  for (const point of body.points) {
    if (!point || typeof point !== 'object') continue;
    const x = Number(point.x), y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) continue;
    points.push({ x, y });
  }
  return points;
}

function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }

// ---------- параметры heatmap ----------

// Типы событий хитмапы: значения <select> страницы eBot — «kill»,
// «hegrenade», «flashbang», «smokegrenade», «molotov», «decoy»,
// «allstuff» (проверено на живом eBot; короткие «he»/«flash»/«smoke»
// страница не принимает — пустой ответ). Метки — русские.
export const HEATMAP_TYPES = [
  ['kill', 'Убийства'], ['flashbang', 'Флешки'], ['smokegrenade', 'Смоуки'],
  ['hegrenade', 'Гранаты'], ['decoy', 'Обманки'], ['molotov', 'Молотовы'],
  ['allstuff', 'Все события']
];

// Сборка urlencoded-тела POST /matchs/heatmap/<id>. eBot (jQuery со
// traditional:false) ждёт массивы как «rounds[]=1&rounds[]=2» — обычный
// «rounds=1,2» молча даёт пустую карту. Скобки пишем закодированными
// (%5B%5D): и прокси, и PHP читают их одинаково, а URLSearchParams
// .toString() сервера выдаёт тот же вид. Значения проверяем и здесь, и
// в прокси: прокси — граница доверия, это — ранняя ошибка в UI.
export function heatmapParams({ type = 'kill', rounds = [], sides = 'all', players = [] } = {}) {
  if (!HEATMAP_TYPES.some(([value]) => value === type)) {
    throw new Error('Неизвестный тип событий хитмапы.');
  }
  if (!['all', 'ct', 't'].includes(sides)) {
    throw new Error('Сторона хитмапы: all, ct или t.');
  }
  const parts = [`type=${encodeURIComponent(type)}`, `sides=${encodeURIComponent(sides)}`];
  for (const round of list(rounds)) {
    if (!/^\d{1,4}$/.test(String(round))) throw new Error('Номер раунда хитмапы — число.');
    parts.push(`rounds%5B%5D=${encodeURIComponent(round)}`);
  }
  for (const player of list(players)) {
    if (!/^[A-Za-z0-9_-]{1,25}$/.test(String(player))) {
      throw new Error('Имя игрока хитмапы: буквы, цифры, «_» и «-».');
    }
    parts.push(`players%5B%5D=${encodeURIComponent(player)}`);
  }
  return parts.join('&');
}

function list(value) {
  return Array.isArray(value) ? value : [value];
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
function text(html) {
  return html.replace(/<[^>]*>/g, ' ')
    .replace(/&([a-z#0-9]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, ' ').trim();
}
