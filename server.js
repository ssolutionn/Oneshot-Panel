import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import faceitProxy from './netlify/functions/faceit.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicFiles = new Set([
  'index.html', 'app.js', 'core.js', 'style.css', 'theme.js',
  'card.html', 'card.js', 'card.css', 'live.js', 'obs.js', 'vdo.js',
  'lobby.js', 'faceit.js', 'obs-bridge.html', 'obs-bridge.js',
  'veto-overlay.html', 'veto-overlay.js', 'veto-overlay.css'
]);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp'
};
export function createServer() {
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://docs.google.com https://open.faceit.com ws://127.0.0.1:* ws://localhost:*; frame-src https://vdo.ninja; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    // The Netlify function, served here too so the lobby works locally.
    if (request.url.startsWith('/api/faceit?') && request.method === 'GET') {
      const reply = await faceitProxy(new Request('http://localhost' + request.url, {
        headers: { authorization: request.headers.authorization || '' }
      }));
      response.writeHead(reply.status, Object.fromEntries(reply.headers));
      response.end(Buffer.from(await reply.arrayBuffer()));
      return;
    }
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, 'http://localhost').pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
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
