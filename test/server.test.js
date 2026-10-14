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
    assert.ok((await page.text()).includes('Oneshot webcam panel'));
    assert.ok(page.headers.get('content-security-policy')
      .includes("script-src 'self'"));
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

test('Netlify serves the same security headers as server.js', async () => {
  const toml = fs.readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await fetch(`http://127.0.0.1:${server.address().port}`);
    for (const name of [
      'Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy'
    ]) {
      const value = toml.match(new RegExp(`^\\s*${name} = "(.*)"$`, 'm'))?.[1];
      assert.equal(value, page.headers.get(name), name);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
