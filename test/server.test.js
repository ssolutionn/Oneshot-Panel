import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createServer, eventFile } from '../server.js';

// event.js runs in the page before the first paint: the same script in a sandbox,
// so the test sees what the browser would (data-event/data-kind, the chosen event).
function pageScript(code, { search = '', cookie = '' } = {}) {
  const window = {};
  const document = { cookie, documentElement: { dataset: {} } };
  vm.runInNewContext(code, { window, document, location: { search }, URLSearchParams });
  return { event: window.oneshotEvent, choices: window.oneshotEventChoices, dataset: document.documentElement.dataset };
}

async function servedEventScript(query = '') {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const reply = await fetch(`http://127.0.0.1:${server.address().port}/event.js${query}`);
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-type'), /javascript/);
    assert.match(reply.headers.get('cache-control'), /no-cache/);
    return await reply.text();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('Event chooser: the page knows every event, the address picks one', async () => {
  const text = await servedEventScript();
  const plain = pageScript(text);
  // No choice yet: the event of this panel — CyberClash unless EVENT names another.
  assert.equal(plain.event.slug, 'cyberclash');
  assert.equal(plain.dataset.event, 'cyberclash');
  assert.equal(plain.dataset.kind, 'sheets');
  // The chooser's list: every event that has events/<slug>/event.json.
  assert.deepEqual([...plain.choices].map(choice => choice.slug), ['cyberclash', 'reu']);
  assert.equal(plain.choices.find(choice => choice.slug === 'reu').name, 'ЛАН РЭУ им. Плеханова');
  // The chooser's cookie: the next load opens that event.
  assert.equal(pageScript(text, { cookie: 'oneshot-event=reu' }).event.slug, 'reu');
  assert.equal(pageScript(text, { cookie: 'oneshot-event=reu' }).dataset.kind, 'manual');
  // ?event= wins over the cookie: a link opens its event even after another was picked.
  assert.equal(pageScript(text, { search: '?event=reu', cookie: 'oneshot-event=cyberclash' }).event.slug, 'reu');
  // A stale or foreign choice is not a blank page: the event of this panel.
  assert.equal(pageScript(text, { cookie: 'oneshot-event=nope' }).event.slug, 'cyberclash');
  // Only the events in the list count: no object members posing as an event.
  assert.equal(pageScript(text, { search: '?event=constructor' }).event.slug, 'cyberclash');
  assert.equal(pageScript(text, { cookie: 'oneshot-event=__proto__' }).event.slug, 'cyberclash');
  // A LAN build: the same page, but that event is open by default.
  assert.equal(pageScript(await servedEventScript('?event=reu')).event.slug, 'reu');
  assert.throws(() => eventFile('nope'), /Нет события/);
  // The build writes the same file for the address it builds.
  const build = readFileSync(new URL('../scripts/build-site.sh', import.meta.url), 'utf8');
  assert.match(build, /^node scripts\/event-config\.mjs > public\/event\.js$/m);
});

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
  const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../scripts/build-site.sh', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
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
  const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const cloudflare = readFileSync(new URL('../_headers', import.meta.url), 'utf8');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.match(cloudflare, /^\/\*$/m);
    for (const name of [
      'Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy',
      'Strict-Transport-Security', 'Permissions-Policy'
    ]) {
      const value = toml.match(new RegExp(`^\\s*${name} = "(.*)"$`, 'm'))?.[1];
      assert.equal(value, page.headers.get(name), name);
      assert.equal(cloudflare.match(new RegExp(`^  ${name}: (.*)$`, 'm'))?.[1], value, `_headers ${name}`);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('index.html loads only files the build publishes', () => {
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../scripts/build-site.sh', import.meta.url), 'utf8');
  const copied = new Set(build.match(/^cp ((?!-R)[^\n]+) public\/$/m)[1].trim().split(/\s+/));
  const generated = new Set([...build.matchAll(/> public\/([\w.-]+)/g)].map(match => match[1]));
  // Root-level scripts and styles of the page: they must be in the built site, or
  // the page silently loses a feature (the chooser had no button this way).
  for (const [, file] of page.matchAll(/(?:src|href)="\/([\w.-]+)"/g)) {
    assert.ok(copied.has(file) || generated.has(file), `index.html loads /${file}, а сборка его не кладёт в public/`);
  }
});

test('/event.js of a server started with EVENT: that event, and its kind', async () => {
  for (const [event, slug, kind] of [[undefined, 'cyberclash', 'sheets'], [eventFile('reu'), 'reu', 'manual']]) {
    const server = createServer(event === undefined ? {} : { event });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const reply = await fetch(`http://127.0.0.1:${server.address().port}/event.js`);
      assert.equal(reply.status, 200);
      assert.match(reply.headers.get('content-type'), /javascript/);
      const page = pageScript(await reply.text());
      assert.equal(page.event.slug, slug);
      assert.equal(page.dataset.kind, kind);
    } finally { server.close(); }
  }
});
