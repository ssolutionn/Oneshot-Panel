// /api/bookmakers?id=<bookmaker>: fetches that bookmaker's public line feeds
// on the server (browsers can't: CORS and the site's CSP), keeps only the
// CyberClash events and answers small JSON. One bookmaker per request keeps
// each call short and lets one slow feed not hold the others. The fixed feed
// URLs live in bookmakers.js; nothing from the request reaches a URL but the
// id. Cloudflare (functions/api/bookmakers.js) and server.js use it too.
import { BOOKMAKERS, parseFeed } from '../../bookmakers.js';
import { readWinline } from '../../assets/bookmaker-winline.js';
import { readPublicText } from '../../assets/bookmaker-transport.js';
import { validDay, emptyDay, normalizeDay } from '../../assets/bookmaker-history.js';

const safeError = error => {
  const message = String(error?.message || '');
  if (/^HTTP \d{3}(?: — публичный поток недоступен)?$/.test(message) || /^(?:нет связи|долго не отвечает|нет ответа|слишком большой ответ источника|ошибка вызова сетевого клиента)$/.test(message)) return message;
  if (message.startsWith('Winline:') || /^(?:формат линии изменился|Неизвестный|Неполный|Некорректный|Слишком большой|Формат снимка)/.test(message)) return message;
  return 'не удалось прочитать формат линии';
};

const FEED_BUDGET = 24000, ATTEMPT_TIMEOUT = 6000;
const cacheByFetcher = new WeakMap();
// Workers expose fetch on their global object; retain its receiver.
const publicFetch = (url, init) => globalThis.fetch(url, init);
const HEADERS = {
  Accept: 'application/json, text/html;q=0.9',
  'Accept-Language': 'ru-RU,ru;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
};

// Tries the feed's mirrors in turn; the first that answers counts.
async function fetchFeed(urls, fetchImpl, sourceHeaders = {}) {
  let lastError='нет ответа';
  const deadline=Date.now()+FEED_BUDGET;
  for(const url of urls){
    const remaining=deadline-Date.now();if(remaining<=0)break;
    try{
      return await readPublicText(url,fetchImpl,{
        headers:{...HEADERS,...sourceHeaders},
        timeoutMs:Math.min(urls.length===1?18000:ATTEMPT_TIMEOUT,
          Math.max(1000,Math.floor(FEED_BUDGET/urls.length)),remaining)
      });
    }catch(error){
      const message=String(error?.message||'');
      lastError=/^HTTP \d{3}$/.test(message)||['долго не отвечает','слишком большой ответ источника'].includes(message) ?
        message : 'нет связи';
    }
  }
  throw new Error(lastError);
}

export async function checkBookmaker(id, fetchImpl = publicFetch, now = Date.now()) {
  const bookmaker = BOOKMAKERS.find(b => b.id === id);
  if (!bookmaker) return { status: 400, body: { error: 'unknown', message: 'Неизвестная букмекерская контора.' } };
  const started = Date.now();
  const results = await Promise.allSettled(bookmaker.feeds.map(async feed =>
    bookmaker.kind === 'winline' ? (await readWinline(fetchImpl)).map(e => ({...e, url:bookmaker.eventUrl(e)})) :
      parseFeed(bookmaker, await fetchFeed(feed.urls, fetchImpl, feed.headers), feed.live, now)));
  const events = [], errors = [];
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') events.push(...result.value);
    else errors.push(`${bookmaker.feeds[i].live ? 'лайв' : 'линия'}: ${safeError(result.reason)}`);
  }
  // The same match can sit in both line and live for a moment: live wins.
  const unique = new Map();
  for (const e of events) if (!unique.has(e.id) || e.live) unique.set(e.id, e);
  return {
    status: 200,
    body: {
      id: bookmaker.id, name: bookmaker.name, page: bookmaker.page,
      ok: errors.length < bookmaker.feeds.length, errors,
      coverage: bookmaker.feeds.some(feed => feed.live) ? 'line-and-live' : 'prematch',
      checkedAt: now, ms: Date.now() - started, events: [...unique.values()]
    }
  };
}

// Cache only completed, serializable public data. Cloudflare request I/O and
// timers belong to their request: sharing an in-flight promise across requests
// can leave all later clients waiting after the original page is closed.
async function currentBookmaker(id, fetchImpl) {
  let cache = cacheByFetcher.get(fetchImpl);
  if (!cache) { cache = new Map(); cacheByFetcher.set(fetchImpl, cache); }
  const previous = cache.get(id);
  if (previous && previous.until > Date.now()) return previous.value;
  const value = await checkBookmaker(id, fetchImpl);
  if (!cache.get(id) || cache.get(id).value.body.checkedAt <= value.body.checkedAt) {
    cache.set(id, {
      value,
      until: Date.now() + (value.body.ok ? 20000 : 3000)
    });
  }
  return value;
}


const HISTORY_ROOT = 'https://raw.githubusercontent.com/ssolutionn/Oneshot-Panel/bookmaker-history/days/';
async function historyResponse(day, fetchImpl, headers) {
  if (!validDay(day)) return Response.json({error:'date',message:'Неверная дата истории.'},{status:400,headers});
  try {
    const text = await readPublicText(HISTORY_ROOT + day + '.json', fetchImpl, {timeoutMs:8000,maxBytes:2*1024*1024});
    return Response.json({ok:true,archive:normalizeDay(JSON.parse(text),day)},{headers});
  } catch(error) {
    if (error.message === 'HTTP 404') return Response.json({ok:true,archive:emptyDay(day),missing:true},{headers});
    return Response.json({ok:false,message:'Не удалось загрузить общий архив. Наблюдения этого браузера сохранены.'},{status:502,headers});
  }
}

export async function bookmakersResponse(request, fetchImpl = publicFetch) {
  const headers = {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; form-action 'none'"
  };
  if (request.method !== 'GET') {
    return Response.json({error: 'not-allowed', message: 'Доступно только чтение.'},
      {status:405, headers:{...headers, allow:'GET'}});
  }
  const params = new URL(request.url).searchParams;
  if (params.has('history')) return historyResponse(params.get('history'),fetchImpl,headers);
  const id = params.get('id') || '';
  if (!BOOKMAKERS.some(b => b.id === id)) {
    return Response.json({error: 'unknown', message: 'Неизвестная букмекерская контора.'},
      {status:400, headers});
  }
  const {status, body} = await currentBookmaker(id, fetchImpl);
  return Response.json(body, {status, headers});
}

export default request => bookmakersResponse(request);
export const config = { path: '/api/bookmakers' };
