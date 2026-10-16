// /api/bookmakers?id=<bookmaker>: fetches that bookmaker's public line feeds
// on the server (browsers can't: CORS and the site's CSP), keeps only the
// CyberClash events and answers small JSON. One bookmaker per request keeps
// each call short and lets one slow feed not hold the others. The fixed feed
// URLs live in bookmakers.js; nothing from the request reaches a URL but the
// id. Cloudflare (functions/api/bookmakers.js) and server.js use it too.
import { BOOKMAKERS, parseFeed } from '../../bookmakers.js';
import { readWinline } from '../../assets/bookmaker-winline.js';

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
async function fetchFeed(urls, fetchImpl) {
  let lastError = 'нет ответа';
  const deadline = Date.now() + FEED_BUDGET;
  for (const url of urls) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(ATTEMPT_TIMEOUT,
      Math.max(1000, Math.floor(FEED_BUDGET / urls.length)), remaining));
    try {
      const response = await fetchImpl(url, {
        headers: HEADERS, signal: controller.signal, redirect: 'manual'
      });
      if (!response.ok) { lastError = `HTTP ${response.status}`; continue; }
      return await response.text();
    } catch (error) {
      lastError = controller.signal.aborted || error?.name === 'TimeoutError' ? 'долго не отвечает' :
        /illegal invocation/i.test(error?.message || '') ? 'ошибка вызова сетевого клиента' : 'нет связи';
    } finally { clearTimeout(timeout); }
  }
  throw new Error(lastError);
}

export async function checkBookmaker(id, fetchImpl = publicFetch, now = Date.now()) {
  const bookmaker = BOOKMAKERS.find(b => b.id === id);
  if (!bookmaker) return { status: 400, body: { error: 'unknown', message: 'Неизвестная букмекерская контора.' } };
  const started = Date.now();
  const results = await Promise.allSettled(bookmaker.feeds.map(async feed =>
    bookmaker.kind === 'winline' ? (await readWinline(fetchImpl)).map(e => ({...e, url:bookmaker.eventUrl(e)})) :
      parseFeed(bookmaker, await fetchFeed(feed.urls, fetchImpl), feed.live, now)));
  const events = [], errors = [];
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') events.push(...result.value);
    else errors.push(`${bookmaker.feeds[i].live ? 'лайв' : 'линия'}: ${result.reason?.message || 'ошибка'}`);
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

// Public, read-only line data: collapse concurrent requests and keep a short
// in-memory cache. No database, files, credentials or user input are stored.
async function currentBookmaker(id, fetchImpl) {
  let cache = cacheByFetcher.get(fetchImpl);
  if (!cache) { cache = new Map(); cacheByFetcher.set(fetchImpl, cache); }
  const previous = cache.get(id);
  if (previous?.pending) return previous.pending;
  if (previous && previous.until > Date.now()) return previous.value;
  const entry = {};
  entry.pending = checkBookmaker(id, fetchImpl).then(value => {
    entry.value = value;
    entry.until = Date.now() + (value.body.ok ? 20000 : 3000);
    entry.pending = null;
    return value;
  }, error => { cache.delete(id); throw error; });
  cache.set(id, entry);
  return entry.pending;
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
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!BOOKMAKERS.some(b => b.id === id)) {
    return Response.json({error: 'unknown', message: 'Неизвестная букмекерская контора.'},
      {status:400, headers});
  }
  const {status, body} = await currentBookmaker(id, fetchImpl);
  return Response.json(body, {status, headers});
}

export default request => bookmakersResponse(request);
export const config = { path: '/api/bookmakers' };
