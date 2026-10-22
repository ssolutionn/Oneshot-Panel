// Same-origin proxy for the FACEIT Data API. It forwards only the lobby's
// read-only paths. The admin's own key (Authorization header) goes straight to
// FACEIT; without one, the site's key from the hosting secret FACEIT_API_KEY
// is used — it stays on the server and is never sent to a browser, and only
// pages of this site may use it. server.js serves the same proxy locally.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ALLOWED = new RegExp(`^/(championships/${UUID}(/matches)?|matches/1-${UUID}(/stats)?)$`, 'i');

// Proof that a page of this site asks: Fetch Metadata, else an Origin that is
// this site (sent with POST and cross-origin requests). A plain same-origin GET
// from a browser without Fetch Metadata (old Safari, http on a LAN address)
// proves nothing and is refused: the admin's own key still works there.
export function fromThisSite(request) {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = request.headers.get('origin');
  return Boolean(origin) && origin === new URL(request.url).origin;
}

export async function proxyFaceit(request, serverKey = '') {
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  const sent = request.headers.get('authorization') || '';
  if (request.method !== 'GET' || !ALLOWED.test(path)) {
    return Response.json({ error: 'not-allowed', message: 'Прокси пропускает только запросы лобби.' }, { status: 400 });
  }
  let key = /^Bearer \S+$/.test(sent) ? sent : '';
  if (!key && String(serverKey || '').trim()) {
    // Other websites and scripts must not spend the site's key. A request
    // that proves nothing about where it came from (curl, no headers) is
    // refused too.
    if (!fromThisSite(request)) {
      return Response.json({ error: 'not-allowed', message: 'Ключ сайта доступен только самой панели, а этот браузер не сообщил, откуда запрос. Впиши свой ключ FACEIT в поле «Ключ».' }, { status: 403 });
    }
    key = `Bearer ${String(serverKey).trim()}`;
  }
  if (!key) {
    return Response.json({ error: 'no-key', message: 'На сайте не задан ключ FACEIT_API_KEY.' }, { status: 401 });
  }
  const target = new URL('https://open.faceit.com/data/v4' + path);
  for (const name of ['type', 'offset', 'limit']) {
    const value = url.searchParams.get(name);
    if (value !== null && /^[a-z0-9]{1,12}$/i.test(value)) target.searchParams.set(name, value);
  }
  let response;
  try {
    response = await fetch(target, {
      headers: { Authorization: key, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    return Response.json({ error: 'FACEIT did not answer' }, { status: 502 });
  }
  return new Response(response.body, {
    status: response.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default request => proxyFaceit(request,
  globalThis.Netlify?.env?.get?.('FACEIT_API_KEY') || globalThis.process?.env?.FACEIT_API_KEY || '');

export const config = { path: '/api/faceit' };
