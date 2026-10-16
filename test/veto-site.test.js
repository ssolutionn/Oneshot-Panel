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
    assert.deepEqual(top, ['README.md', '_headers', 'assets', 'core.js', 'index.html', 'vdo.js',
      'veto-room.js', 'veto.css', 'veto.html', 'veto.js']);
    assert.equal(await readFile(path.join(out, 'index.html'), 'utf8'), await readFile(new URL('../veto.html', import.meta.url), 'utf8'));
    const core = await readFile(path.join(out, 'core.js'), 'utf8');
    assert.match(core, /^ {2}id: '',\n {2}gid: '',$/m);
    assert.match(core, /scheduleId: '1GtwcpVnyxY1YOs6ZTrXwJr5mjZqI0QxjLSKjimn9G2o'/, 'the public schedule stays for the form');
    assert.doesNotMatch(core, /oneshot-panel\.pages\.dev/);
    const headers = await readFile(path.join(out, '_headers'), 'utf8');
    assert.match(headers, /connect-src 'self' https:\/\/docs\.google\.com;/);
    assert.match(headers, /frame-src https:\/\/vdo\.ninja;/);
    assert.deepEqual((await readdir(path.join(out, 'assets'))).sort(), ['card', 'favicon-night.png', 'flags', 'fonts', 'maps', 'teams']);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
