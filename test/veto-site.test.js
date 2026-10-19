import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// The veto's own site (oneshot-veto repo): only veto files, nothing that
// points players to the panel or its roster sheet.
test('veto site build: veto pages and assets only, no roster sheet, no panel address', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'veto-site-'));
  try {
    await promisify(execFile)(process.execPath, [new URL('../scripts/build-veto-site.mjs', import.meta.url).pathname, out]);
    const top = (await readdir(out)).sort();
    assert.deepEqual(top, ['.assetsignore', '.github', 'CLAUDE.md', 'README.md', 'RELAY.md', 'SECURITY.md', '_headers', 'assets', 'core.js', 'functions', 'index.html', 'package.json', 'scripts', 'server', 'vdo.js',
      'veto-room.js', 'veto.css', 'veto.html', 'veto.js', 'worker.js', 'wrangler.jsonc']);
    const worker = JSON.parse(await readFile(path.join(out, 'wrangler.jsonc'), 'utf8'));
    assert.deepEqual(worker.assets, { directory: '.', binding:'ASSETS', run_worker_first:['/api/veto-relay','/api/veto-link','/*_*'] });
    assert.deepEqual(worker.durable_objects.bindings, [{name:'VETO_RELAY',class_name:'VetoRelayTopic'}]);
    assert.deepEqual(worker.migrations[0].new_sqlite_classes, ['VetoRelayTopic']);
    assert.match(await readFile(path.join(out, '.assetsignore'), 'utf8'), /^wrangler\.jsonc$/m);
    const patterns = await readFile(path.join(out, '.assetsignore'), 'utf8');
    assert.match(patterns, /^\.github\/$/m);
    // Repository docs are not published as part of the site.
    for (const doc of ['CLAUDE.md', 'SECURITY.md']) assert.match(patterns, new RegExp(`^${doc.replace('.', '\\.')}$`, 'm'));
    assert.match(patterns, /^scripts\/$/m);
    assert.equal(await readFile(path.join(out, 'index.html'), 'utf8'), await readFile(new URL('../veto.html', import.meta.url), 'utf8'));
    const core = await readFile(path.join(out, 'core.js'), 'utf8');
    assert.match(core, /^ {2}id: '',\n {2}gid: '',$/m);
    assert.match(core, /scheduleId: '1GtwcpVnyxY1YOs6ZTrXwJr5mjZqI0QxjLSKjimn9G2o'/, 'the public schedule stays for the form');
    assert.doesNotMatch(core, /oneshot-panel\.pages\.dev/);
    const headers = await readFile(path.join(out, '_headers'), 'utf8');
    assert.match(headers, /connect-src 'self' https:\/\/docs\.google\.com https:\/\/oneshot-veto\.cyberclash\.workers\.dev;/);
    assert.match(headers, /frame-src https:\/\/vdo\.ninja https:\/\/cdn-backup\.vdo\.ninja;/);
    assert.deepEqual((await readdir(path.join(out, 'assets'))).sort(), ['card', 'favicon-night.png', 'flags', 'fonts', 'maps', 'teams', 'veto-appearance.js', 'veto-backdrop.jpg', 'veto-relay-client.js', 'veto-relay-links.js', 'veto-relay-protocol.js','veto-short-links.js','veto-short-protocol.js']);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
