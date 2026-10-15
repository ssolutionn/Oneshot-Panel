// Same-origin proxy for the FACEIT Data API, used only when the browser may
// not call open.faceit.com directly (CORS). It keeps nothing: the admin's own
// key arrives in the Authorization header and goes straight to FACEIT. Only
// the lobby's read-only paths are forwarded. server.js serves it locally.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ALLOWED = new RegExp(`^/(championships/${UUID}(/matches)?|matches/1-${UUID}(/stats)?)$`, 'i');

export default async function faceit(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  const key = request.headers.get('authorization') || '';
  if (request.method !== 'GET' || !ALLOWED.test(path) || !/^Bearer \S+$/.test(key)) {
    return Response.json({ error: 'Not allowed' }, { status: 400 });
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

export const config = { path: '/api/faceit' };
