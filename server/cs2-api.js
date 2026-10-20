// The «Сервер» tab's backend, for server.js: receives the CS2 server's log
// (logaddress_add_http), keeps the referee's journal and sends chat lines by
// RCON. It sits on the computer that runs the CS2 server:
//  - the log endpoint needs the secret token (it is part of the URL given to CS2);
//  - everything the panel reads or does is allowed only from this computer
//    (loopback and a localhost Host header, which also stops DNS rebinding),
//    and a write needs a same-origin JSON request (stops other websites);
//  - CS2_ALLOW_REMOTE=1 lets other computers in, but then every request needs the token.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Journal } from './cs2-log.js';
import { rconExec, sayCommand } from './cs2-rcon.js';

export const MAX_BODY = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// The token lives in CS2_LOG_TOKEN or, made once, in <dir>/token.
export function loadToken({ env = process.env, dir }) {
  const fixed = String(env.CS2_LOG_TOKEN || '').trim();
  if (fixed) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(fixed)) throw new Error('CS2_LOG_TOKEN: 16–128 символов A-Z a-z 0-9 _ -');
    return fixed;
  }
  const file = path.join(dir, 'token');
  try {
    const saved = readFileSync(file, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(saved)) return saved;
  } catch { /* none yet */ }
  const made = randomBytes(24).toString('base64url');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, made + '\n', { mode: 0o600 });
  return made;
}
const sameToken = (given, token) => {
  const a = Buffer.from(String(given || '')), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
const hostName = header => String(header || '').replace(/:\d+$/, '').toLowerCase();

// rawLog: a file that keeps what the server sent, untouched (CS2_RAW_LOG=1), to
// look at a format the journal does not understand yet. Stops at 20 MB.
export const RAW_LIMIT = 20 * 1024 * 1024;
export function keepRaw(file, text) {
  if (!file) return;
  try {
    let size = 0;
    try { size = statSync(file).size; } catch { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); }
    if (size < RAW_LIMIT) appendFileSync(file, text.endsWith('\n') ? text : text + '\n', { mode: 0o600 });
  } catch { /* the journal works without it */ }
}

export function createCs2({ token, env = process.env, journal = new Journal(), rcon = rconExec, port = 3000, rawLog = '' } = {}) {
  if (!token) throw new Error('Нужен токен.');
  return {
    token, journal, port, rcon, rawLog,
    allowRemote: env.CS2_ALLOW_REMOTE === '1',
    rconConfig: { host: env.CS2_RCON_HOST || '127.0.0.1', port: Number(env.CS2_RCON_PORT) || 27015, password: env.CS2_RCON_PASSWORD || '' }
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('size'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Is this request one the operator's own browser makes on this computer?
function fromHere(req, cs2, url) {
  const local = LOOPBACK.has(req.socket.remoteAddress) && LOCAL_HOSTS.has(hostName(req.headers.host));
  if (local) return true;
  return cs2.allowRemote && sameToken(url.searchParams.get('token') || req.headers['x-oneshot-token'], cs2.token);
}
// A write from a page of this site only: JSON (so a browser asks first) and the same origin.
function sameSiteWrite(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return false;
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  return req.headers.origin === `http://${req.headers.host}`;
}

// Returns true when the request was for this tab's API (and has been answered).
export async function handleCs2(req, res, cs2) {
  // A request line the URL parser refuses must be answered, not thrown: an
  // unhandled rejection here would take the whole panel down.
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
  if (!url.pathname.startsWith('/api/cs2-')) return false;
  try {
    if (url.pathname === '/api/cs2-log') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method' }), true;
      if (!sameToken(url.searchParams.get('token'), cs2.token)) return send(res, 403, { error: 'token' }), true;
      if (!cs2.allowRemote && !LOOPBACK.has(req.socket.remoteAddress)) return send(res, 403, { error: 'remote' }), true;
      const body = await readBody(req);
      keepRaw(cs2.rawLog, body);
      cs2.journal.push(body);
      return send(res, 200, 'ok', 'text/plain; charset=utf-8'), true;
    }
    if (!fromHere(req, cs2, url)) return send(res, 403, { error: 'local-only' }), true;
    if (req.method === 'GET' && url.pathname === '/api/cs2-status') {
      return send(res, 200, { ok: true, rcon: Boolean(cs2.rconConfig.password), ...cs2.journal.status() }), true;
    }
    if (req.method === 'GET' && url.pathname === '/api/cs2-events') {
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      return send(res, 200, { status: cs2.journal.status(), events: cs2.journal.since(since) }), true;
    }
    if (req.method === 'GET' && url.pathname === '/api/cs2-round') {
      return send(res, 200, cs2.journal.roundText(Number(url.searchParams.get('n')) || 0), 'text/plain; charset=utf-8'), true;
    }
    if (req.method === 'GET' && url.pathname === '/api/cs2-setup') {
      const base = `http://127.0.0.1:${cs2.port}`;
      return send(res, 200, { commands: [`logaddress_add_http "${base}/api/cs2-log?token=${cs2.token}"`, 'mp_logdetail 3', 'log on'] }), true;
    }
    if (req.method === 'POST' && url.pathname === '/api/cs2-say') {
      if (!sameSiteWrite(req)) return send(res, 403, { error: 'same-origin' }), true;
      let text;
      try { text = JSON.parse(await readBody(req, 4096)).text; } catch { return send(res, 400, { error: 'json' }), true; }
      let command;
      try { command = sayCommand(text); } catch (error) { return send(res, 400, { error: error.message }), true; }
      try { await cs2.rcon({ ...cs2.rconConfig, command }); } catch (error) { return send(res, 502, { error: error.message }), true; }
      return send(res, 200, { ok: true }), true;
    }
    return send(res, 404, { error: 'not-found' }), true;
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 400, { error: 'request' });
    return true;
  }
}
