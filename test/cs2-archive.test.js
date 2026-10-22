import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Archive, fileName, safeName } from '../server/cs2-archive.js';

test('safeName: map names and strings are kept clean', () => {
  assert.equal(safeName('de_mirage'), 'de_mirage');
  assert.equal(safeName('Workshop/123/de_inferno'), 'workshop-123-de_inferno');
  assert.equal(safeName(''), 'unknown');
  assert.equal(safeName('   '), 'unknown');
  assert.equal(safeName('a'.repeat(100)).length, 40, 'bounded length');
});

test('fileName: timestamp and safe map name', () => {
  const name = fileName({ map: 'de_mirage', at: Date.parse('2026-10-21T18:31:05Z') });
  assert.match(name, /^20261021-\d{6}_de_mirage\.jsonl$/);
});

test('Archive: writes JSONL files, reads them back, lists and deletes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2archive-'));
  try {
    const archive = new Archive({ dir });
    assert.equal(archive.enabled, true);
    assert.deepEqual(archive.list(), []);

    // A game starts writing raw log lines and events.
    archive.open(1, 'de_mirage');
    archive.keepRaw(1, 'de_mirage', 'L 10/21/2026 - Line 1\nL 10/21/2026 - Line 2');
    archive.write({ type: 'event', seq: 1, name: 'round_start' });
    archive.close();

    const list = archive.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].map, 'de_mirage');

    const read = archive.read(list[0].name);
    assert.equal(read.head.game, 1);
    assert.deepEqual(read.raw, ['L 10/21/2026 - Line 1', 'L 10/21/2026 - Line 2']);
    assert.equal(read.events.length, 1);

    // Delete
    assert.equal(archive.remove(list[0].name), true);
    assert.deepEqual(archive.list(), []);
    assert.equal(archive.read('nonexistent.jsonl'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Archive: path traversal attempts are refused', () => {
  const archive = new Archive({ dir: os.tmpdir() });
  assert.equal(archive.read('../../../etc/passwd'), null);
  assert.equal(archive.remove('../../../etc/passwd'), false);
});

test('Archive: prune drops old or oversized files beyond limits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2prune-'));
  try {
    const files = [];
    for (let i = 1; i <= 3; i++) {
      const archive = new Archive({ dir });
      archive.open(i, `map${i}`);
      archive.write({ type: 'raw', game: i, line: `line for map ${i}` });
      files.push(archive.file);
      archive.close();
    }
    // Give each file a strictly increasing mtime so prune's sort is unambiguous
    const base = Date.now() - 10000;
    files.forEach((file, idx) => fs.utimesSync(file, new Date(base + idx * 1000), new Date(base + idx * 1000)));

    const checker = new Archive({ dir, limit: 2 });
    assert.equal(checker.list().length, 3);
    checker.prune();
    const remaining = checker.list();
    assert.equal(remaining.length, 2, 'limited to 2 files');
    assert.ok(!remaining.some(f => f.map === 'map1'), 'oldest file dropped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
