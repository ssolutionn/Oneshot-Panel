import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from '../server.js';

test('Static server serves public files and rejects traversal', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('Oneshot Panel'));
    assert.ok(page.headers.get('content-security-policy')
      .includes("script-src 'self'"));
    const theme = await fetch(base + '/theme.js');
    assert.equal(theme.status, 200);
    assert.ok(theme.headers.get('content-type').startsWith('text/javascript'));
    const card = await fetch(base + '/card.html?team=A&nick=B');
    assert.equal(card.status, 200);
    assert.ok((await card.text()).includes('/card.js'));
    for (const file of ['/card.js', '/card.css', '/assets/players/players.json']) {
      assert.equal((await fetch(base + file)).status, 200, file);
    }
    const template = await fetch(base + '/assets/obs-template.json');
    assert.equal(template.status, 200);
    assert.ok(Array.isArray((await template.json()).sources));
    for (const p of [
      '/.git/config', '/package.json', '/test/core.test.js',
      '/assets/..%2fpackage.json', '/assets/..%2f.git/config',
      '/%2e%2e%2fetc/passwd'
    ]) assert.equal((await fetch(base + p)).status, 404, p);
    assert.equal((await fetch(base + '/%zz')).status, 400);
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    const head = await fetch(base, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Netlify and Cloudflare publish the files server.js serves', () => {
  const toml = fs.readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const build = fs.readFileSync(new URL('../scripts/build-site.sh', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(toml, /^\s*command = "sh scripts\/build-site\.sh"$/m);
  const copied = build.match(/^cp ((?!-R)[^\n]+) public\/$/m)[1].trim().split(/\s+/);
  const served = [...server.match(/publicFiles = new Set\(\[([^\]]*)\]/)[1]
    .matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(copied.sort(), served.sort());
  assert.match(build, /^cp -R assets public\/$/m);
  assert.match(build, /cp _headers public\//);
  assert.match(toml, /^\s*publish = "public"$/m);
});

test('Netlify and Cloudflare serve the same security headers as server.js', async () => {
  const toml = fs.readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const cloudflare = fs.readFileSync(new URL('../_headers', import.meta.url), 'utf8');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.match(cloudflare, /^\/\*$/m);
    for (const name of [
      'Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy'
    ]) {
      const value = toml.match(new RegExp(`^\\s*${name} = "(.*)"$`, 'm'))?.[1];
      assert.equal(value, page.headers.get(name), name);
      assert.equal(cloudflare.match(new RegExp(`^  ${name}: (.*)$`, 'm'))?.[1], value, `_headers ${name}`);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
