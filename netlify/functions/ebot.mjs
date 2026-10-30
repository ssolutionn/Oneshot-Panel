// Same-origin proxy for an eBot-CSGO-Web match list (the Flegma CS2 build on
// 37.230.228.105). The list of matches in progress is public on the eBot
// page; the panel reads it here so the browser opens no third-party origin
// (CSP keeps connect-src 'self'). The server's own URL and, if the host
// needs one, a shared read come from the hosting secret EBOT_URL; nothing
// from the request reaches a URL. server.js serves this locally too.
const EBOT_DEFAULT_URL = 'http://37.230.228.105/';

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
  if (request.method !== 'GET' || url.search) {
    return Response.json({ error: 'not-allowed', message: 'Прокси отдаёт только список матчей eBot.' }, { status: 400 });
  }
  const target = ebotTarget(envUrl);
  if (!target) {
    return Response.json({ error: 'config', message: 'EBOT_URL задан неверно.' }, { status: 500 });
  }
  target.pathname = '/matchs/current';
  let response;
  try {
    response = await fetch(target, {
      headers: { Accept: 'text/html;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    return Response.json({ error: 'upstream', message: 'eBot не ответил.' }, { status: 502 });
  }
  // The page is HTML; the panel parses it. A login redirect means the list
  // is not public on this install — surfaced as a plain error, no body leak.
  if (response.status >= 300) {
    return Response.json({ error: 'upstream', message: 'eBot закрыл список матчей.' }, { status: 502 });
  }
  const html = await response.text();
  return Response.json({ page: html }, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default request => proxyEbot(request,
  globalThis.Netlify?.env?.get?.('EBOT_URL') || globalThis.process?.env?.EBOT_URL || '');

export const config = { path: '/api/ebot' };
