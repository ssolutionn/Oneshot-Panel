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
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Journal } from './cs2-log.js';
import { rconExec, sayCommand } from './cs2-rcon.js';
import { summarize, playerStats, roundStats, toCsv, toNdjson } from './cs2-stats.js';
import { RosterStore, mergeWithCatalog } from './cs2-roster.js';
import { Archive } from './cs2-archive.js';
import { createLauncher, normalizeSettings, buildCfg, CVARS, MAP_NAMES } from './cs2-launch.js';

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

// The panel's own player/team catalogs, so the roster can be merged with what
// the organizer already entered (assets/players/players.json, teams.json). Read
// on demand and cached: they change only when someone re-imports an event folder.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function loadCatalogs(dir = root) {
  try {
    const [players, teams] = await Promise.all([
      readFile(path.join(dir, 'assets', 'players', 'players.json'), 'utf8'),
      readFile(path.join(dir, 'assets', 'teams', 'teams.json'), 'utf8')
    ]);
    return { players: JSON.parse(players).players || [], logos: JSON.parse(teams) };
  } catch { return { players: [], logos: {} }; }
}

export function createCs2({ token, env = process.env, journal = new Journal(), rcon = rconExec, port = 3000, rawLog = '',
  roster = null, archive = null, launcher = null, dataDir = '', catalogs = loadCatalogs } = {}) {
  if (!token) throw new Error('Нужен токен.');
  const base = {
    token, journal, port, rcon, rawLog, catalogs,
    // The three new pieces are opt-in, so tests and a plain journal keep working
    // exactly as before and nothing writes to disk unless it was asked to:
    // no dataDir → no roster, no CS2_ARCHIVE_DIR → no archive, no CS2_LAUNCH=1 →
    // no launcher (the page then says why instead of showing a dead button).
    roster: roster ?? (dataDir && env.CS2_ROSTER !== '0' ? new RosterStore({ dir: dataDir }) : null),
    archive: archive ?? (env.CS2_ARCHIVE_DIR ? new Archive({ dir: env.CS2_ARCHIVE_DIR }) : null),
    launcher: launcher ?? (env.CS2_LAUNCH === '1' ? createLauncher({ env, cwd: env.CS2_SERVER_DIR || '' }) : null),
    allowRemote: env.CS2_ALLOW_REMOTE === '1',
    rconConfig: { host: env.CS2_RCON_HOST || '127.0.0.1', port: Number(env.CS2_RCON_PORT) || 27015, password: env.CS2_RCON_PASSWORD || '' }
  };
  if (base.roster) base.roster.load();
  return base;
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
      const added = cs2.journal.push(body);
      // Two side effects on the same log, both optional and both unable to
      // break the journal: who the players are (SteamID), and the full game on
      // disk. A failure here must not cost the referee the live journal.
      try { cs2.roster?.push(added); } catch { /* the roster is a convenience */ }
      try {
        const status = cs2.journal.status();
        if (cs2.archive) {
          cs2.archive.keepRaw(status.game, status.map, body);
          for (const event of added) cs2.archive.write({ type: 'event', ...event });
        }
      } catch { /* the broadcast does not depend on the archive */ }
      return send(res, 200, 'ok', 'text/plain; charset=utf-8'), true;
    }
    if (!fromHere(req, cs2, url)) return send(res, 403, { error: 'local-only' }), true;
    if (req.method === 'GET' && url.pathname === '/api/cs2-status') {
      return send(res, 200, {
        ok: true, rcon: Boolean(cs2.rconConfig.password), ...cs2.journal.status(),
        // What this panel can do here: the page hides a control whose backend
        // is not turned on, instead of showing a button that answers 400.
        features: {
          roster: Boolean(cs2.roster), rosterSize: cs2.roster?.size() || 0,
          archive: Boolean(cs2.archive), launch: Boolean(cs2.launcher)
        }
      }), true;
    }
    if (req.method === 'GET' && url.pathname === '/api/cs2-events') {
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      return send(res, 200, { status: cs2.journal.status(), events: cs2.journal.since(since) }), true;
    }
    if (req.method === 'GET' && url.pathname === '/api/cs2-round') {
      const game = url.searchParams.get('g');
      return send(res, 200, cs2.journal.roundText(Number(url.searchParams.get('n')) || 0, game === null ? undefined : Number(game) || 0), 'text/plain; charset=utf-8'), true;
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

    // ── Broadcast stats ───────────────────────────────────────────────────────
    // The journal's events, counted into what a graphic needs. `?g=` picks a
    // game (the last one by default); `?format=csv|ndjson` picks the encoding.
    if (req.method === 'GET' && url.pathname === '/api/cs2-stats') {
      const gParam = url.searchParams.get('g');
      let scope;
      if (gParam !== null) {
        const parsed = Number(gParam);
        scope = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
      }
      const events = cs2.journal.events;
      const format = url.searchParams.get('format') || '';
      if (format === 'csv') {
        const csv = toCsv(playerStats(events, scope));
        return send(res, 200, `﻿${csv}`, 'text/csv; charset=utf-8'), true;
      }
      if (format === 'ndjson') {
        return send(res, 200, toNdjson(cs2.journal.since(0, Number.MAX_SAFE_INTEGER)), 'application/x-ndjson; charset=utf-8'), true;
      }
      if (format === 'rounds') return send(res, 200, { rounds: roundStats(events, scope) }), true;
      return send(res, 200, summarize(events, cs2.journal.status(), { game: scope })), true;
    }
    // What the panel offers, so the page builds its controls from one source.
    if (req.method === 'GET' && url.pathname === '/api/cs2-cvars') {
      return send(res, 200, { cvars: CVARS, maps: MAP_NAMES }), true;
    }

    // ── Roster (SteamID) ──────────────────────────────────────────────────────
    // The SteamIDs the log has shown, merged with the panel's own catalogs. A
    // graphic or a HUD-manager import reads this; a player the log has not shown
    // yet has an empty steamid64 and `source: ""`, visibly, not silently.
    if (req.method === 'GET' && url.pathname === '/api/cs2-roster') {
      if (!cs2.roster) return send(res, 200, { enabled: false, players: [] }), true;
      try {
        const { players, logos } = await cs2.catalogs();
        const rows = mergeWithCatalog(cs2.roster.roster, players, logos);
        return send(res, 200, { enabled: true, size: cs2.roster.size(), players: rows }), true;
      } catch (error) {
        return send(res, 500, { error: 'catalogs', message: error.message }), true;
      }
    }

    // ── Archive of finished games ─────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/cs2-archive') {
      if (!cs2.archive) return send(res, 200, { enabled: false, files: [] }), true;
      const name = url.searchParams.get('file');
      if (name) {
        const game = cs2.archive.read(name);
        return game ? send(res, 200, game) : send(res, 404, { error: 'not-found' }), true;
      }
      return send(res, 200, { enabled: true, ...cs2.archive.status(), files: cs2.archive.list().map(({ name, map, bytes, mtime }) => ({ name, map, bytes, mtime })) }), true;
    }
    if (req.method === 'POST' && url.pathname === '/api/cs2-archive-delete') {
      if (!sameSiteWrite(req)) return send(res, 403, { error: 'same-origin' }), true;
      let name;
      try { name = JSON.parse(await readBody(req, 4096)).name; } catch { return send(res, 400, { error: 'json' }), true; }
      return send(res, cs2.archive?.remove(name) ? 200 : 404, { ok: Boolean(cs2.archive) }), true;
    }

    // ── Starting the server ───────────────────────────────────────────────────
    // Status is always readable; starting and stopping are same-origin writes.
    if (req.method === 'GET' && url.pathname === '/api/cs2-launch') {
      if (!cs2.launcher) return send(res, 200, { enabled: false }), true;
      return send(res, 200, { enabled: true, ...cs2.launcher.status() }), true;
    }
    if (req.method === 'GET' && url.pathname === '/api/cs2-launch-output') {
      if (!cs2.launcher) return send(res, 200, '', 'text/plain; charset=utf-8'), true;
      const tail = Number(url.searchParams.get('tail')) || 8000;
      return send(res, 200, cs2.launcher.output.slice(-Math.max(0, Math.min(tail, MAX_BODY))), 'text/plain; charset=utf-8'), true;
    }
    if (req.method === 'POST' && url.pathname === '/api/cs2-launch-start') {
      if (!sameSiteWrite(req)) return send(res, 403, { error: 'same-origin' }), true;
      if (!cs2.launcher) return send(res, 400, { error: 'Панель не запускает сервер CS2 (не задан CS2_SERVER_BIN или CS2_LAUNCH).' }), true;
      let settings;
      try { settings = normalizeSettings(JSON.parse(await readBody(req, 16384))); }
      catch { return send(res, 400, { error: 'Не понял настройки.' }), true; }
      if (settings.errors.length) return send(res, 400, { error: settings.errors.join(' ') }), true;
      // The log address the started server posts back to, so a server the panel
      // started fills the journal by itself.
      const logUrl = `http://127.0.0.1:${cs2.port}/api/cs2-log?token=${cs2.token}`;
      let cfgName;
      try { cfgName = cs2.launcher.writeCfg(buildCfg({ ...settings, rconPassword: cs2.rconConfig.password, logUrl })); }
      catch (error) { return send(res, 500, { error: error.message }), true; }
      try {
        const started = cs2.launcher.start({ ...settings, cfgName: cfgName.replace(/\.cfg$/, '') });
        return send(res, 200, { ok: true, pid: started.pid }), true;
      } catch (error) { return send(res, 500, { error: error.message }), true; }
    }
    if (req.method === 'POST' && url.pathname === '/api/cs2-launch-stop') {
      if (!sameSiteWrite(req)) return send(res, 403, { error: 'same-origin' }), true;
      let force = false;
      try { force = Boolean(JSON.parse(await readBody(req, 1024)).force); } catch { /* no body: a plain stop */ }
      const stopped = cs2.launcher?.stop({ force });
      return stopped === undefined ? send(res, 400, { error: 'Панель не запускает сервер CS2.' }) :
        send(res, 200, { ok: stopped }), true;
    }
    return send(res, 404, { error: 'not-found' }), true;
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 400, { error: 'request' });
    return true;
  }
}
