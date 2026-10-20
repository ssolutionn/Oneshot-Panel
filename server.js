import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bookmakersResponse } from './netlify/functions/bookmakers.mjs';
import { proxyFaceit } from './netlify/functions/faceit.mjs';
import { nodeRelay } from './server/veto-relay-node.mjs';
import { FileRelayStore } from './server/veto-relay-file.js';
import {shortIdValid,shortPathValid} from './assets/veto-short-protocol.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicFiles = new Set([
  'index.html', 'app.js', 'core.js', 'style.css', 'theme.js',
  'card.html', 'card.js', 'card.css', 'live.js', 'obs.js', 'vdo.js',
  'lobby.js', 'faceit.js', 'notifications.js', 'notification-worker.js', 'obs-bridge.html', 'obs-bridge.js',
  'veto.html', 'veto.js', 'veto.css', 'veto-room.js', 'veto-watch.js', 'bookmakers.js', 'bookies.js', 'lan.js'
]);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};
export function createServer({relayStore = new FileRelayStore(process.env.VETO_RELAY_DIR || path.join(root, '.veto-relay-data')),
  shortStore = new FileRelayStore(path.join(process.env.VETO_RELAY_DIR || path.join(root, '.veto-relay-data'),'links'),shortIdValid)} = {}) {
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    response.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://docs.google.com https://open.faceit.com https://oneshot-veto.pages.dev https://oneshot-veto.cyberclash.workers.dev ws://127.0.0.1:* ws://localhost:*; frame-src https://vdo.ninja https://cdn-backup.vdo.ninja; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    if (await nodeRelay(request, response, relayStore, shortStore)) return;
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
  createServer().listen(port, host, () =>
    console.log(`Oneshot Panel listening on ${host}:${port}`));
}
