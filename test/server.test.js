import test from 'node:test';
import assert from 'node:assert/strict';
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
