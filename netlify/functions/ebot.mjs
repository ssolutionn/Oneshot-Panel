// Same-origin proxy for an eBot-CSGO-Web match list (the Flegma CS2 build on
// 37.230.228.105). The list of matches in progress is public on the eBot
// page; the panel reads it here so the browser opens no third-party origin
// (CSP keeps connect-src 'self'). The server's own URL and, if the host
// needs one, a shared read come from the hosting secret EBOT_URL; nothing
// from the request reaches a URL. server.js serves this locally too.
// Три действия: GET без параметров — список матчей (кэш 7 с), GET ?view=<id>
// — HTML-страница матча (кэш 60 с, парсит ebot-stats-parse.js), POST
// ?heatmap=<id> + form-urlencoded — точки хитмапы (строгая проверка полей,
// в eBot уходит только пересобранный набор).
const EBOT_DEFAULT_URL = 'http://37.230.228.105/';

// TTL-кэш для тестов (см. ниже).
export const __ttlScale = { ms: 1 };

// Кэш страницы списка: изолят serverless живёт дольше одного запроса, а
// вкладка eBot у каждого оператора опрашивает каждые 20 с. Несколько
// операторов не должны вместе долбить eBot каждые 20 с каждый — страницу
// отдаём из кэша, пока ей меньше 7 с; уровень eBot-страницы мельче
// 20-секундного опроса, так что свежесть для операторов сохраняется.
const PAGE_TTL_MS = () => 7000 * __ttlScale.ms;
let pageCache = { at: 0, url: '', page: '' };

export function ebotTarget(envUrl = '') {
  const raw = String(envUrl || '').trim() || EBOT_DEFAULT_URL;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || !/^[\w.-]+(?::\d+)?$/.test(url.host) ||
      url.username || url.password || url.search || url.hash) return null;
  return url;
}

export async function proxyEbot(request, envUrl = '') {
  const url = new URL(request.url);
  const target = ebotTarget(envUrl);
  if (!target) {
    return Response.json({ error: 'config', message: 'EBOT_URL задан неверно.' }, { status: 500 });
  }
  if (request.method === 'POST' && url.searchParams.get('heatmap') !== null) {
    return proxyEbotHeatmap(request, url, target);
  }
  if (url.searchParams.get('view') !== null) {
    if (request.method !== 'GET') {
      return Response.json({ error: 'not-allowed', message: 'Страница матча — GET.' }, { status: 400 });
    }
    return proxyEbotView(request, url, target);
  }
  if (request.method !== 'GET' || url.search) {
    return Response.json({ error: 'not-allowed', message: 'Прокси отдаёт только список матчей eBot.' }, { status: 400 });
  }
  target.pathname = '/matchs/current';
  const at = Date.now();
  if (pageCache.at && pageCache.url === target.href && at - pageCache.at < PAGE_TTL_MS()) {
    return Response.json({ page: pageCache.page }, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    });
  }
  let response;
  try {
    response = await fetchPage(target);
  } catch {
    return upstream('eBot не ответил.');
  }
  // The page is HTML; the panel parses it. A login redirect means the list
  // is not public on this install — surfaced as a plain error, no body leak.
  if (response.status >= 300) {
    return upstream('eBot закрыл список матчей.');
  }
  const html = await response.text();
  pageCache = { at, url: target.href, page: html };
  return Response.json({ page: html }, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

// ---------- статистика матча: GET ?view=<matchId> ----------

// Страница view одного матча (~600 КБ): кэшируем на минуту — статистика
// живого матча меняется медленнее, а несколько операторов панели
// открывают её одновременно. Список в кэш не смешивается: свой ключ.
const VIEW_TTL_MS = () => 60000 * __ttlScale.ms;
let viewCache = { at: 0, url: '', page: '' };

async function proxyEbotView(request, url, target) {
  const matchId = url.searchParams.get('view');
  // Номер матча — только цифры: из запроса в URL eBot больше ничего
  // не попадает (тот же принцип, что в ebot-admin).
  if (!/^\d{1,9}$/.test(matchId)) {
    return Response.json({ error: 'not-allowed', message: 'Параметр view — номер матча eBot.' }, { status: 400 });
  }
  for (const [key, value] of url.searchParams) {
    if (key !== 'view' || (key === 'view' && value !== matchId)) {
      return Response.json({ error: 'not-allowed', message: 'Прокси принимает только параметр view.' }, { status: 400 });
    }
  }
  target.pathname = '/matchs/view/' + matchId;
  const at = Date.now();
  if (viewCache.at && viewCache.url === target.href && at - viewCache.at < VIEW_TTL_MS()) {
    return Response.json({ page: viewCache.page }, { headers: JSON_HEADERS });
  }
  let response;
  try {
    response = await fetchPage(target);
  } catch {
    return upstream('eBot не ответил.');
  }
  if (response.status >= 300) {
    // Как у списка: редирект на логин — страница не публична.
    return upstream('eBot закрыл страницу матча.');
  }
  const html = await response.text();
  viewCache = { at, url: target.href, page: html };
  return Response.json({ page: html }, { headers: JSON_HEADERS });
}

// ---------- хитмапа: POST ?heatmap=<matchId>, тело form-urlencoded ----------

// Разрешённые значения формы — ровно те, что панель умеет показать
// (значения <select> самого eBot: hegrenade/flashbang/smokegrenade, не
// короткие «he»/«flash»); всё прочее 400 до похода в eBot. Тело —
// urlencoded, повторные ключи допустимы (rounds[]/players[] от
// jQuery-стиля eBot).
const HEATMAP_TYPES = new Set(['kill', 'flashbang', 'smokegrenade', 'hegrenade', 'decoy', 'molotov', 'allstuff']);
const SIDES = new Set(['all', 'ct', 't']);
const ROUND_RE = /^\d{1,4}$/;
const PLAYER_RE = /^[A-Za-z0-9_-]{1,25}$/;
const MAX_HEATMAP_BODY = 4096;

async function proxyEbotHeatmap(request, url, target) {
  const matchId = url.searchParams.get('heatmap');
  if (!/^\d{1,9}$/.test(matchId)) {
    return Response.json({ error: 'not-allowed', message: 'Параметр heatmap — номер матча eBot.' }, { status: 400 });
  }
  const contentType = request.headers.get('content-type') || '';
  if (contentType && !/^application\/x-www-form-urlencoded\b/i.test(contentType)) {
    return Response.json({ error: 'request', message: 'Тело хитмапы — form-urlencoded.' }, { status: 400 });
  }
  const body = await request.text();
  if (body.length > MAX_HEATMAP_BODY) {
    return Response.json({ error: 'request', message: 'Тело запроса слишком большое.' }, { status: 413 });
  }
  const sent = new URLSearchParams();
  let count = { type: 0, sides: 0 };
  for (const [key, value] of new URLSearchParams(body)) {
    if (key === 'type') {
      if (++count.type > 1 || !HEATMAP_TYPES.has(value)) {
        return Response.json({ error: 'request', message: 'type — тип событий хитмапы.' }, { status: 400 });
      }
      sent.set('type', value);
    } else if (key === 'sides') {
      if (++count.sides > 1 || !SIDES.has(value)) {
        return Response.json({ error: 'request', message: 'sides — all, ct или t.' }, { status: 400 });
      }
      sent.set('sides', value);
    } else if (key === 'rounds[]') {
      if (!ROUND_RE.test(value)) {
        return Response.json({ error: 'request', message: 'rounds — номера раундов.' }, { status: 400 });
      }
      sent.append('rounds[]', value);
    } else if (key === 'players[]') {
      if (!PLAYER_RE.test(value)) {
        return Response.json({ error: 'request', message: 'players — имена игроков.' }, { status: 400 });
      }
      sent.append('players[]', value);
    } else {
      return Response.json({ error: 'request', message: `Неизвестное поле «${key}».` }, { status: 400 });
    }
  }
  if (!sent.has('type')) {
    return Response.json({ error: 'request', message: 'type обязателен.' }, { status: 400 });
  }
  // В eBot уходит только пересобранный из проверенных значений набор.
  target.pathname = '/matchs/heatmap/' + matchId;
  let response;
  try {
    response = await fetch(target, {
      method: 'POST',
      // Ключи уже проверены; пересобранный набор — единственное тело.
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: sent.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    return upstream('eBot не ответил.');
  }
  if (response.status >= 300) {
    return upstream('eBot закрыл хитмапу матча.');
  }
  const text = await response.text();
  // eBot отвечает {"type":"heatmap","points":[…]}; проксируем как JSON
  // без разбора, чтобы не портить массив точек.
  if (!/^\s*\{/.test(text)) {
    return upstream('eBot вернул не хитмапу.');
  }
  return new Response(text, { status: 200, headers: JSON_HEADERS });
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

function upstream(message) {
  return Response.json({ error: 'upstream', message }, { status: 502 });
}

async function fetchPage(target) {
  return fetch(target, {
    headers: { Accept: 'text/html;q=0.9' },
    redirect: 'manual',
    signal: AbortSignal.timeout(12000)
  });
}

export default request => proxyEbot(request,
  globalThis.Netlify?.env?.get?.('EBOT_URL') || globalThis.process?.env?.EBOT_URL || '');

export const config = { path: '/api/ebot' };
