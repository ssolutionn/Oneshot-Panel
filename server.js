import http from 'node:http';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bookmakersResponse } from './netlify/functions/bookmakers.mjs';
import { proxyFaceit } from './netlify/functions/faceit.mjs';
import { proxyEbot } from './netlify/functions/ebot.mjs';
import { proxyEbotAdmin } from './netlify/functions/ebot-admin.mjs';
import { createEbotAdmin, ebotSocketUrl } from './server/ebot-admin.js';
import { ebotTarget } from './netlify/functions/ebot.mjs';
import { nodeRelay } from './server/veto-relay-node.mjs';
import { FileRelayStore } from './server/veto-relay-file.js';
import {shortIdValid,shortPathValid} from './assets/veto-short-protocol.js';
import { createCs2, handleCs2, loadToken } from './server/cs2-api.js';
import { createConsoleHub } from './server/ebot-console.js';
import { eventScript, eventSlug } from './events/event-script.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicFiles = new Set([
  'index.html', 'app.js', 'core.js', 'style.css', 'theme.js',
  'card.html', 'card.js', 'card.css', 'live.js', 'obs.js', 'vdo.js',
  'lobby.js', 'faceit.js', 'ebot.js', 'notifications.js', 'notification-worker.js', 'obs-bridge.html', 'obs-bridge.js',
  'veto.html', 'veto.js', 'veto.css', 'veto-room.js', 'veto-watch.js', 'bookmakers.js', 'bookies.js', 'lan.js', 'lan-event.js', 'lan-images.js', 'cs2.js',
  'oneshot-webcams.js', 'ebot-ui.js', 'ebot-stats.js', 'ebot-stats-parse.js', 'veto-mobile.html'
]);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};
// The page's /event.js (events/event-script.js): which event this panel is.
// EVENT=reu npm start opens the panel of events/reu; CyberClash by default.
export function eventFile(slug = '') {
  const file = name => path.join(root, 'events', name, 'event.json');
  const chosen = eventSlug({ slug, exists: name => fs.existsSync(file(name)) });
  return eventScript(JSON.parse(fs.readFileSync(file(chosen), 'utf8')));
}
// cs2: the referee's journal of a CS2 server on this computer (server/cs2-api.js);
// off unless given, so tests and plain static hosting never open it.
export function createServer({cs2 = null, event = eventFile(process.env.EVENT || ''), relayStore = new FileRelayStore(process.env.VETO_RELAY_DIR || path.join(root, '.veto-relay-data')),
  shortStore = new FileRelayStore(path.join(process.env.VETO_RELAY_DIR || path.join(root, '.veto-relay-data'),'links'),shortIdValid)} = {}) {
  // Консоль матча eBot (server/ebot-console.js): SSE-поток логов/чата и RCON
  // живого матча. Создаётся лениво с теми же секретами EBOT_*, что и
  // /api/ebot-admin, поэтому консоль работает и в локальной панели, и на
  // хостинге, где функции есть; хаб держится в замыкании сервера, как cs2.
  let consoleHub = null;
  const ebotHub = () => {
    if (!consoleHub) {
      const target = ebotTarget(process.env.EBOT_URL || '');
      const user = (process.env.EBOT_USER || '').trim();
      const password = process.env.EBOT_PASSWORD || '';
      if (!target || !user || !password) return null;
      consoleHub = createConsoleHub({
        admin: createEbotAdmin({
          baseUrl: target.href, user, password,
          socketUrl: ebotSocketUrl(target.href),
        }),
      });
    }
    return consoleHub;
  };
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    response.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://docs.google.com https://open.faceit.com https://oneshot-veto.pages.dev https://oneshot-veto.cyberclash.workers.dev ws://127.0.0.1:* ws://localhost:*; frame-src https://vdo.ninja https://cdn-backup.vdo.ninja; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    if (cs2 && await handleCs2(request, response, cs2)) return;
    if (await nodeRelay(request, response, relayStore, shortStore)) return;
    // eBot admin actions (netlify/functions/ebot-admin.mjs): commands, create
    // and start go through the server-side client, credentials from
    // EBOT_USER/EBOT_PASSWORD, same-origin as the panel. POST, so it sits
    // before the GET/HEAD-only static part below.
    if (request.url.split('?')[0] === '/api/ebot-admin' && request.method === 'POST') {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const reply = await proxyEbotAdmin(new Request('http://localhost/api/ebot-admin', {
          method: 'POST',
          headers: {
            'content-type': request.headers['content-type'] || '',
            'content-length': String(Buffer.concat(chunks).length),
            'sec-fetch-site': request.headers['sec-fetch-site'] || '',
            origin: request.headers.origin === `http://${request.headers.host}` ? 'http://localhost' : '',
            'x-ebot-token': request.headers['x-ebot-token'] || ''
          },
          body: Buffer.concat(chunks)
        }), {
          EBOT_URL: process.env.EBOT_URL || '',
          EBOT_USER: process.env.EBOT_USER || '',
          EBOT_PASSWORD: process.env.EBOT_PASSWORD || '',
          EBOT_ADMIN_TOKEN: process.env.EBOT_ADMIN_TOKEN || '',
          EBOT_ADMIN_OPEN: process.env.EBOT_ADMIN_OPEN || ''
        });
        const body = Buffer.from(await reply.arrayBuffer());
        response.writeHead(reply.status, Object.fromEntries(reply.headers));
        response.end(body);
      } catch {
        if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'upstream', message: 'eBot не ответил.' }));
      }
      return;
    }
    // Матч-консоль eBot (server/ebot-console.js): POST — start/send/stop,
    // GET ?stream=<id> — SSE с логами/чатом/ответами RCON. Хаб создаётся
    // только с секретами EBOT_*; оба роута до GET-гейта, как ebot-admin.
    if (request.url.split('?')[0] === '/api/ebot-console') {
      const hub = ebotHub();
      if (!hub) {
        response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'no-credentials', message: 'Задай секреты EBOT_USER и EBOT_PASSWORD хостинга.' }));
        return;
      }
      if (request.method === 'GET' && hub.sseHandler(request, response)) return;
      if (request.method === 'POST' && await hub.postHandler(request, response)) return;
      response.writeHead(405, { Allow: 'GET, POST' });
      response.end();
      return;
    }
    // The eBot match list (netlify/functions/ebot.mjs), locally too: the
    // same proxy as the hosting function, server-side fetch of the public
    // eBot page. POST ?heatmap=<id> — точки хитмапы, читаем тело до
    // GET-гейта и передаём в тот же proxyEbot.
    if (request.url.split('?')[0] === '/api/ebot' &&
        (request.method === 'GET' || request.method === 'POST')) {
      try {
        const init = { method: request.method };
        if (request.method === 'POST') {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          init.headers = { 'content-type': request.headers['content-type'] || '' };
          init.body = body;
        }
        const reply = await proxyEbot(new Request('http://localhost' + request.url, init), process.env.EBOT_URL);
        const body = Buffer.from(await reply.arrayBuffer());
        response.writeHead(reply.status, Object.fromEntries(reply.headers));
        response.end(body);
      } catch {
        if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'upstream', message: 'eBot не ответил.' }));
      }
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    // Bookmakers' line check (netlify/functions/bookmakers.mjs), locally too.
    if (request.url.startsWith('/api/bookmakers?') && request.method === 'GET') {
      try {
        const reply = await bookmakersResponse(new Request('http://localhost' + request.url));
        const body = Buffer.from(await reply.arrayBuffer());
        response.writeHead(reply.status, Object.fromEntries(reply.headers));
        response.end(body);
      } catch {
        if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'upstream' }));
      }
      return;
    }
    // The Netlify function, served here too so the lobby works locally.
    if (request.url.startsWith('/api/faceit?') && request.method === 'GET') {
      // An upstream that fails mid-body must answer 502, not stop the server.
      try {
        const reply = await proxyFaceit(new Request('http://localhost' + request.url, {
          headers: {
            authorization: request.headers.authorization || '',
            'sec-fetch-site': request.headers['sec-fetch-site'] || '',
            // Local Origin is http://<host>; compare it to the server's own.
            origin: request.headers.origin === `http://${request.headers.host}` ? 'http://localhost' : ''
          }
        }), process.env.FACEIT_API_KEY);
        const body = Buffer.from(await reply.arrayBuffer());
        response.writeHead(reply.status, Object.fromEntries(reply.headers));
        response.end(body);
      } catch {
        if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'upstream', message: 'FACEIT не ответил.' }));
      }
      return;
    }
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/event.js') {
        response.writeHead(200, { 'Content-Type': mime['.js'], 'Cache-Control': 'no-cache' });
        response.end(request.method === 'HEAD' ? undefined : event);
        return;
      }
      const relative = pathname === '/' ? 'index.html' : shortPathValid(pathname)?'veto.html':pathname.slice(1);
      const target = path.resolve(root, relative);
      const asset =
        /^assets\/[\w./-]+$/.test(relative) &&
        target.startsWith(path.join(root, 'assets') + path.sep) &&
        !relative.split('/').some(part => part.startsWith('.'));
      if (!target.startsWith(root + path.sep) ||
          !(publicFiles.has(relative) || asset)) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      const data = await readFile(target);
      response.writeHead(200, {
        'Content-Type': mime[path.extname(target)] ||
          'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      response.writeHead(error instanceof URIError ? 400 : 404);
      response.end('Not found');
    }
  });
}
if (process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  // CS2_JOURNAL=1: take the log of a CS2 server on this computer (logaddress_add_http).
  const dataDir = path.join(root, '.cs2-data');
  const cs2 = process.env.CS2_JOURNAL === '1' ?
    createCs2({ token: loadToken({ dir: dataDir }), port, dataDir,
      rawLog: process.env.CS2_RAW_LOG === '1' ? path.join(dataDir, 'raw.log') : '' }) : null;
  createServer({ cs2 }).listen(port, host, () => {
    console.log(`Oneshot Panel listening on ${host}:${port}`);
    if (!cs2) return;
    console.log('\nCS2: журнал сервера включён. Выполни на сервере CS2 (консоль или RCON):');
    for (const command of [`logaddress_add_http "http://127.0.0.1:${port}/api/cs2-log?token=${cs2.token}"`, 'mp_logdetail 3', 'log on']) console.log('  ' + command);
    console.log(cs2.rconConfig.password ? '  (RCON: сообщения на сервер включены)' : '  (RCON выключен: задай CS2_RCON_PASSWORD, чтобы писать в чат сервера)');
    // What the panel can do here, in one place, so an operator does not have
    // to read the source to find out why a tab is empty.
    if (cs2.roster) console.log(`  Ростер SteamID: ${dataDir}/roster.json`);
    else console.log('  Ростер SteamID выключен (CS2_ROSTER=0).');
    console.log(cs2.archive ? `  Архив игр: ${cs2.archive.dir}` : '  Архив игр выключен: задай CS2_ARCHIVE_DIR.');
    console.log(cs2.launcher?.available ? `  Запуск сервера CS2: ${cs2.launcher.bin}` :
      '  Запуск сервера выключен: задай CS2_LAUNCH=1, CS2_SERVER_BIN и CS2_SERVER_DIR.');
  });
}
