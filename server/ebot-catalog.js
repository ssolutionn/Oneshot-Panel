// Каталог eBot: серверы, сезоны и команды через авторизованную админку.
// Транспорт не дублируется — он целиком в server/ebot-admin.js
// (createEbotAdmin, тот же логин, та же кука сессии): страницы читает
// admin.page(path) — авторизованный GET с перелогином при протухшей
// сессии. Пока метод page в EbotAdmin отсутствует, его надо добавить
// (патч в отчёте к этой задаче), пока — модуль честно отказывается
// работать с клиентом без page.
// Маршруты проверены по web/apps/backend/config/routing.yml живого eBot:
// /admin.php/servers и /admin.php/seasons — default_index (/:module),
// команды — teams_index /teams/index/:page (пагинация по 12).
// Парсеры толерантны к макету: заголовки колонок ищутся по тексту,
// отсутствующие колонки дают пустые поля, все данные отдаются текстом
// без HTML. RCON-пароля страница серверов не показывает — поле
// появляется только если eBot начнёт отдавать такую колонку.

const MAX_TEAM_PAGES = 50;

// ---------- разбор HTML (макет tolerant) ----------

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Текст ячейки: сначала раскодируем сущности, потом снимаем теги —
// иначе &lt;b&gt; переживал бы очистку и возвращался как разметка.
function cellText(html) {
  return decodeEntities(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Нормализованный заголовок: «IP Adress» → «ipadress», «used?» → «used».
function normHeader(html) {
  return cellText(html).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Первая таблица, в чьих заголовках есть один из якорей. Страницы
// каталогов eBot таблицы без id не маркируют — опознаём по содержимому.
function findTable(html, anchors) {
  for (const table of String(html ?? '').match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || []) {
    const headerRow = table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/i);
    if (!headerRow) continue;
    const headers = [...headerRow[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
      .map(m => normHeader(m[1]));
    if (!anchors.some(a => headers.includes(a))) continue;
    // Только tbody: итоговые и служебные строки живут в tfoot/thead.
    const body = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
    const rows = [];
    for (const row of (body ? body[1] : table).match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || []) {
      if (/<th\b/i.test(row)) continue;
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(m => ({ text: cellText(m[1]), html: m[1] }));
      if (cells.length) rows.push({ cells, html: row });
    }
    return { headers, rows };
  }
  return null;
}

// Индекс колонки по списку кандидатов нормализованных заголовков.
function columnIndex(headers, candidates) {
  for (const c of candidates) {
    const i = headers.indexOf(c);
    if (i !== -1) return i;
  }
  return -1;
}

function cellAt(row, headers, candidates) {
  const i = columnIndex(headers, candidates);
  return i === -1 || i >= row.cells.length ? { text: '', html: '' } : row.cells[i];
}

// href ссылки внутри ячейки (текст «Link» url не содержит).
function hrefOf(html) {
  const m = String(html).match(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/i);
  return m ? decodeEntities(m[2] !== undefined ? m[2] : m[3]) : '';
}

// ---------- парсеры страниц (чистые, для тестов) ----------

// Таблица серверов: #ID / IP Adress / Name / used? / Action.
// «Name» в eBot — это hostname, «IP Adress» — «ip:port».
export function parseServersPage(html) {
  const table = findTable(html, ['ipadress', 'ip', 'used']);
  if (!table) return [];
  const out = [];
  for (const row of table.rows) {
    const id = cellAt(row, table.headers, ['id']).text;
    // «No Servers registered.» и прочие не-числовые строки пропускаем.
    if (!/^\d+$/.test(id)) continue;
    const ipRaw = cellAt(row, table.headers, ['ipadress', 'ip']).text;
    const pair = ipRaw.match(/^(.+):(\d+)$/);
    const usedText = cellAt(row, table.headers, ['used']).text.toLowerCase();
    const server = {
      id: Number(id),
      hostname: cellAt(row, table.headers, ['name', 'hostname']).text,
      ip: pair ? pair[1].trim() : ipRaw,
      port: pair ? pair[2] : '',
      used: /in\s*use/.test(usedText),
    };
    const rcon = cellAt(row, table.headers, ['rconpassword', 'rcon']).text;
    // Колонки нет в текущем макете — поле появляется только если eBot
    // начнёт её отдавать; секрет в ответ не попадает без нужды.
    if (rcon) server.rconPassword = rcon;
    out.push(server);
  }
  return out;
}

// Таблица сезонов: #ID / Name / Start / End / Link / (пустой th) / кнопки.
// active — иконка flag_green/flag_red (текста в ячейке нет).
export function parseSeasonsPage(html) {
  const table = findTable(html, ['start', 'end', 'season']);
  if (!table) return [];
  const out = [];
  for (const row of table.rows) {
    const id = cellAt(row, table.headers, ['id']).text;
    if (!/^\d+$/.test(id)) continue;
    const linkCell = cellAt(row, table.headers, ['link']);
    out.push({
      id: Number(id),
      name: cellAt(row, table.headers, ['name']).text,
      active: /flag_green/.test(row.html),
      start: cellAt(row, table.headers, ['start']).text,
      end: cellAt(row, table.headers, ['end']).text,
      link: hrefOf(linkCell.html) || linkCell.text,
    });
  }
  return out;
}

// Таблица команд: #ID / (флаг) / Name / Shorthandle / Team Link.
// country — класс иконки flag-<cc>; составов на странице списка нет
// (viewSuccess — заглушка), players не отдаём.
export function parseTeamsPage(html) {
  const table = findTable(html, ['shorthandle', 'teamlink', 'name']);
  if (!table) return [];
  const out = [];
  for (const row of table.rows) {
    const id = cellAt(row, table.headers, ['id']).text;
    if (!/^\d+$/.test(id)) continue;
    const linkCell = cellAt(row, table.headers, ['teamlink', 'link']);
    const flag = row.html.match(/flag-([a-z]{2})\b/);
    out.push({
      id: Number(id),
      name: cellAt(row, table.headers, ['name']).text,
      shorthandle: cellAt(row, table.headers, ['shorthandle', 'tag', 'handle']).text,
      country: flag ? flag[1].toUpperCase() : '',
      link: hrefOf(linkCell.html) || linkCell.text,
    });
  }
  return out;
}

// ---------- каталог поверх админ-клиента ----------

export function createEbotCatalog({ admin } = {}) {
  if (!admin || typeof admin.page !== 'function') {
    throw new Error('Нужен eBot-админ с методом page (клиент из server/ebot-admin.js).');
  }
  return new EbotCatalog(admin);
}

class EbotCatalog {
  #admin;

  constructor(admin) {
    this.#admin = admin;
  }

  // Авторизованная страница: статус проверяем сами, транспортные ошибки
  // (сеть, протухшая сессия) уже русские из ebot-admin.js.
  async #page(path, what) {
    const res = await this.#admin.page(path);
    if (!res || res.status !== 200) {
      const status = res && res.status ? ' (HTTP ' + res.status + ')' : '';
      throw new Error('eBot не отдал ' + what + status);
    }
    return res.text();
  }

  async servers() {
    return parseServersPage(await this.#page('/admin.php/servers', 'список серверов'));
  }

  async seasons() {
    return parseSeasonsPage(await this.#page('/admin.php/seasons', 'список сезонов'));
  }

  // Команды в eBot разбиты страницами по 12 (sfDoctrinePager): идём по
  // /teams/index/<n>, пока страница не опустеет. Если сервер проигнорировал
  // номер страницы и вернул первую заново — останавливаемся, чтобы не
  // крутить цикл на одних и тех же командах.
  async teams({ maxPages = MAX_TEAM_PAGES } = {}) {
    const all = [];
    let firstId = null;
    for (let page = 1; page <= maxPages; page++) {
      const html = await this.#page('/admin.php/teams/index/' + page, 'список команд');
      const teams = parseTeamsPage(html);
      if (!teams.length) break;
      if (page > 1 && String(teams[0].id) === firstId) break;
      firstId = String(teams[0].id);
      all.push(...teams);
    }
    return all;
  }
}
