// Same-origin proxy for the FACEIT Data API. It forwards only the lobby's
// read-only paths. The admin's own key (Authorization header) goes straight to
// FACEIT; without one, the site's key from the hosting secret FACEIT_API_KEY
// is used — it stays on the server and is never sent to a browser, and only
// pages of this site may use it. server.js serves the same proxy locally.
// Functions do not inherit Cloudflare's static _headers rules.
const RESPONSE_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; form-action 'none'"
};
function jsonError(body, status, extra = {}) {
  return Response.json(body, {status, headers: {...RESPONSE_HEADERS, ...extra}});
}
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ALLOWED = new RegExp(`^/(championships/${UUID}(/matches)?|matches/1-${UUID}(/stats)?)$`, 'i');

export async function proxyFaceit(request, serverKey = '') {
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  const sent = request.headers.get('authorization') || '';
  if (request.method !== 'GET') {
    return jsonError({error: 'not-allowed', message: 'Доступно только чтение.'}, 405, {allow: 'GET'});
  }
  if (!ALLOWED.test(path)) {
    return jsonError({ error: 'not-allowed', message: 'Прокси пропускает только запросы лобби.' }, 400);
  }
  let key = /^Bearer \S+$/.test(sent) ? sent : '';
  if (!key && String(serverKey || '').trim()) {
    // Other websites must not spend the site's key through their visitors.
    const site = request.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin') {
      return jsonError({ error: 'not-allowed', message: 'Ключ сайта доступен только самой панели.' }, 403);
    }
    key = `Bearer ${String(serverKey).trim()}`;
  }
  if (!key) {
    return jsonError({ error: 'no-key', message: 'На сайте не задан ключ FACEIT_API_KEY.' }, 401);
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
      redirect: 'error',
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    return jsonError({ error: 'FACEIT did not answer' }, 502);
  }
  return new Response(response.body, {
    status: response.status,
    headers: RESPONSE_HEADERS
  });
}

export default request => proxyFaceit(request,
  globalThis.Netlify?.env?.get?.('FACEIT_API_KEY') || globalThis.process?.env?.FACEIT_API_KEY || '');

export const config = { path: '/api/faceit' };
