import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, stat, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildMatchPackage } from '../scripts/build_match_packages.mjs';
import { DEFAULT_SOURCE } from '../core.js';

function fixture(day = '15.10', first = 'Package Test A', second = 'Package Test B') {
  const roster = [];
  for (const [teamIndex, team] of [first, second].entries()) {
    for (let slot = 0; slot < 5; slot++) {
      const nick = teamIndex === 0 && slot < 2 ? ['J-K', 'JK'][slot] : 'fixture' + teamIndex + slot;
      roster.push([
        // The sheet ID is data, including punctuation that cannot become a path.
        team + (slot === 0 ? '/../../' : '-') + slot,
        team, String(slot + 1), nick, 'stream' + teamIndex + slot,
        'room' + teamIndex, '', '', 'Основной', '', '', 'room-password'
      ]);
    }
  }
  const month = day.endsWith('.10') ? 'October' : 'November';
  const schedule = [
    ['Stage', 'Date', 'MSK', 'Team 1', 'Team 2'],
    ['Group A1', month + ' ' + Number(day.slice(0, 2)), '16:00', first, second]
  ];
  return { day, roster, loadSheet: async id => id === DEFAULT_SOURCE.id ? roster : schedule };
}

async function inDirectory(run) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'oneshot-package-test-'));
  try { await run(folder); }
  finally { await rm(folder, {recursive:true, force:true}); }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function put(root, file, text = 'keep') {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), {recursive:true});
  await writeFile(target, text);
  return target;
}

test('Match package keeps normalized nicknames distinct and row IDs out of paths', async () => {
  await inDirectory(async output => {
    const manifest = await buildMatchPackage({...fixture(), output});
    assert.equal(manifest.players.length, 10);
    assert.equal(new Set(manifest.players.map(player => player.card)).size, 10);
    for (const player of manifest.players) {
      assert.match(player.card, /^cards\/player-[a-f0-9]{64}\.jpg$/);
    }
    const first = manifest.players.find(player => player.nick === 'J-K');
    const second = manifest.players.find(player => player.nick === 'JK');
    assert.notEqual(first.card, second.card);
    const collection = await readJson(path.join(output, 'OFFLINE_TEMPLATES', manifest.matches[0].filename));
    const cards = collection.sources.filter(source => source.name.startsWith('CARD '));
    assert.equal(cards.length, 10);
    assert.equal(cards.find(source => source.name.endsWith(' | J-K')).settings.file, first.card);
    assert.equal(cards.find(source => source.name.endsWith(' | JK')).settings.file, second.card);
    assert.equal(new Set(cards.map(source => source.settings.file)).size, 10);
  });
});

test('Repeat generation replaces owned outputs while preserving operator files and a failed prior build', async () => {
  await inDirectory(async folder => {
    const output = path.join(folder, 'package');
    const before = await buildMatchPackage({...fixture(), output});
    const oldManifest = await readFile(path.join(output, 'package-manifest.json'), 'utf8');
    const oldMatch = before.matches[0].filename;
    const oldDerived = [
      'OBS_READY/' + oldMatch, 'OBS_LOCAL/' + oldMatch,
      'previews/' + oldMatch.replace(/\.json$/, '.jpg'), before.players[0].card,
      'verification.json'
    ];
    for (const file of oldDerived) await put(output, file, 'old rendered output');
    const notes = ['operator-notes.txt', 'OFFLINE_TEMPLATES/operator-notes.txt', 'cards/operator-reference.jpg'];
    for (const file of notes) await put(output, file, 'operator content');

    const invalid = fixture('16.10');
    invalid.roster.pop();
    await assert.rejects(buildMatchPackage({...invalid, output}), /пять игроков/);
    assert.equal(await readFile(path.join(output, 'package-manifest.json'), 'utf8'), oldManifest);
    assert.equal(await readFile(path.join(output, oldDerived[0]), 'utf8'), 'old rendered output');

    const after = await buildMatchPackage({
      ...fixture('16.10', 'Package Test C', 'Package Test D'), output
    });
    assert.equal(after.day, '16.10');
    assert.equal((await readJson(path.join(output, 'package-manifest.json'))).day, '16.10');
    assert.deepEqual((await readdir(path.join(output, 'OFFLINE_TEMPLATES'))).filter(name => name.endsWith('.json')),
      [after.matches[0].filename]);
    for (const file of oldDerived) await assert.rejects(stat(path.join(output, file)), {code:'ENOENT'});
    for (const file of notes) assert.equal(await readFile(path.join(output, file), 'utf8'), 'operator content');
    assert.deepEqual(await readdir(folder), ['package']);
  });
});

test('An invalid previous manifest cannot redirect stale-file cleanup', async () => {
  await inDirectory(async folder => {
    const output = path.join(folder, 'package');
    const manifest = await buildMatchPackage({...fixture(), output});
    const outside = await put(folder, 'outside.jpg', 'operator photo');
    manifest.players[0].card = '../outside.jpg';
    await writeFile(path.join(output, 'package-manifest.json'), JSON.stringify(manifest));
    await assert.rejects(buildMatchPackage({...fixture('16.10'), output}), /Invalid previous package manifest/);
    assert.equal(await readFile(outside, 'utf8'), 'operator photo');
  });
});

test('A symlink in an output directory cannot redirect package writes', async t => {
  if (process.platform === 'win32') return t.skip('Directory symlinks require additional Windows privileges.');
  await inDirectory(async folder => {
    const output = path.join(folder, 'package');
    const outside = path.join(folder, 'operator');
    await mkdir(output);
    await mkdir(outside);
    await put(outside, 'operator-notes.txt', 'operator content');
    await symlink(outside, path.join(output, 'OFFLINE_TEMPLATES'), 'dir');
    await assert.rejects(buildMatchPackage({...fixture(), output}), /symbolic link/);
    assert.deepEqual(await readdir(outside), ['operator-notes.txt']);
  });
});
