import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyFaceit} from '../netlify/functions/faceit.mjs';
import {createServer} from '../server.js';

const PATH = '/championships/11111111-2222-4333-8444-555555555555/matches';

test('FACEIT proxy rejects writes and URL/path injection before any upstream request', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected upstream request'); };
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const reply = await proxyFaceit(new Request('https://panel.example/api/faceit?path=' + encodeURIComponent(PATH),
        {method}), 'secret-fixture');
      assert.equal(reply.status, 405);
      assert.equal(reply.headers.get('allow'), 'GET');
      assert.equal(reply.headers.get('cache-control'), 'no-store');
      assert.ok(!(await reply.text()).includes('secret-fixture'));
    }
    for (const value of ['https://example.com/', '//127.0.0.1/', PATH + '/../players',
      PATH + '?token=secret', PATH + '\r\nX-Test: true', '/players/me']) {
      const reply = await proxyFaceit(new Request('https://panel.example/api/faceit?path=' + encodeURIComponent(value),
        {headers: {authorization:'Bearer fixture'}}));
      assert.equal(reply.status, 400, value);
      assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('FACEIT proxy uses a fixed read-only origin, blocks redirects and protects every response', async () => {
  const original = globalThis.fetch;
  let options, target;
  globalThis.fetch = async (url, init) => {
    target = String(url); options = init;
    return new Response('{"items":[]}', {status:200, headers:{'set-cookie':'do-not-forward=1'}});
  };
  try {
    const request = new Request('https://panel.example/api/faceit?path=' + encodeURIComponent(PATH) +
      '&url=http://127.0.0.1&evil=1', {headers:{authorization:'Bearer private-fixture'}});
    const reply = await proxyFaceit(request);
    assert.equal(target, 'https://open.faceit.com/data/v4' + PATH);
    assert.equal(options.redirect, 'error');
    assert.equal(reply.headers.get('set-cookie'), null);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    assert.equal(reply.headers.get('referrer-policy'), 'no-referrer');
    assert.match(reply.headers.get('content-security-policy'), /default-src 'none'/);
    assert.ok(!(await reply.text()).includes('private-fixture'));
    globalThis.fetch = async () => { throw new Error('Network failure private-fixture'); };
    const failure = await proxyFaceit(request);
    assert.equal(failure.status, 502);
    assert.equal(failure.headers.get('cache-control'), 'no-store');
    assert.ok(!(await failure.text()).includes('private-fixture'));
  } finally { globalThis.fetch = original; }
});

test('Static panel exposes no repository internals and accepts no modifying methods', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const target of ['/.env', '/.env.local', '/.git/HEAD', '/server.js',
      '/netlify/functions/faceit.mjs', '/claude-artifact/data/snapshot.json',
      '/assets/%2e%2e%2f.env', '/assets/%2e%2e%2fserver.js', '/work/operator-notes.txt']) {
      assert.equal((await fetch(base + target)).status, 404, target);
    }
    for (const method of ['POST','PUT','PATCH','DELETE']) {
      const reply = await fetch(base + '/api/faceit?path=' + encodeURIComponent(PATH), {method});
      assert.equal(reply.status, 405);
    }
    const page = await fetch(base);
    assert.match(page.headers.get('content-security-policy'), /form-action 'none'/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('permissions-policy'), /camera=\(self\)/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
