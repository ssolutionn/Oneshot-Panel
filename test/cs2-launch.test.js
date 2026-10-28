import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAPS, MAP_NAMES, CVARS, normalizeSettings, buildCfg, buildArgs, createLauncher } from '../server/cs2-launch.js';

test('normalizeSettings: cvars take their type and range, unknown ones are refused', () => {
  const good = normalizeSettings({ cvars: { mp_maxrounds: '24', mp_freezetime: 15, mp_halftime: '1', mp_roundtime: '2' } });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.cvars, { mp_maxrounds: 24, mp_freezetime: 15, mp_halftime: 1, mp_roundtime: 2 });
  const bad = normalizeSettings({ cvars: { mp_maxrounds: 1000, mp_freezetime: 'many', mp_halftime: 'maybe', sv_unknown_cvar: '1' } });
  assert.equal(bad.errors.length, 4, 'each bad value is named in words');
  assert.ok(bad.errors.every(error => /[А-Яа-я]/.test(error)), 'in Russian, fit for the screen');
  assert.ok(!Object.hasOwn(bad.cvars, 'sv_unknown_cvar'));
  assert.deepEqual(normalizeSettings({}).cvars, {}, 'nothing given, nothing set');
});

test('normalizeSettings: a map outside the pool is refused, both spellings accepted', () => {
  const ok = normalizeSettings({ map: 'Mirage' });
  assert.deepEqual([ok.map, ok.errors], ['de_mirage', []]);
  assert.equal(normalizeSettings({ map: 'de_dust2' }).map, 'de_dust2');
  const bad = normalizeSettings({ map: '../../etc/passwd' });
  assert.equal(bad.map, '');
  assert.match(bad.errors[0], /не из пула/);
});

test('normalizeSettings: ports and player count are bounded; fixed tickrate is not offered', () => {
  const ok = normalizeSettings({ gameport: 27015, maxplayers: 12 });
  assert.deepEqual([ok.switches.gameport, ok.switches.maxplayers], [27015, 12]);
  assert.ok(normalizeSettings({ gameport: 80 }).errors.length, 'a privileged port is refused');
  assert.ok(normalizeSettings({ maxplayers: 500 }).errors.length);
  assert.match(normalizeSettings({ tick: '128' }).errors.join(' '), /tick не поддерживается/, 'CS2 has no supported fixed -tick mode');
});

test('normalizeSettings: text that goes into the cfg is checked', () => {
  assert.deepEqual(normalizeSettings({ hostname: 'CyberClash #1', rconPassword: 's3cret-pass' }).errors, []);
  assert.ok(normalizeSettings({ hostname: 'name\nrcon_password hack' }).errors.length, 'a newline cannot add a cvar');
  assert.ok(normalizeSettings({ rconPassword: 'has space' }).errors.length);
  assert.ok(normalizeSettings({ rconPassword: '"quoted"' }).errors.length);
  assert.ok(normalizeSettings({ steamKey: 'not-a-key' }).errors.length);
  assert.deepEqual(normalizeSettings({ steamKey: 'ABCDEF0123456789ABCDEF0123456789' }).errors, []);
});

test('buildCfg: the journal lines are always there, and nothing can break out of a line', () => {
  const cfg = buildCfg({ hostname: 'Test', cvars: { mp_maxrounds: 24 }, map: 'de_mirage', logUrl: 'http://127.0.0.1:3000/api/cs2-log?token=T' });
  assert.match(cfg, /^log on$/m);
  assert.match(cfg, /^mp_logdetail 3$/m);
  assert.match(cfg, /^logaddress_add_http "http:\/\/127\.0\.0\.1:3000\/api\/cs2-log\?token=T"$/m);
  assert.match(cfg, /^map de_mirage$/m);
  assert.match(cfg, /^mp_maxrounds 24$/m);
});

test('buildArgs: one argument per array entry, no shell to escape into', () => {
  const args = buildArgs({ switches: { gameport: 27015 }, map: 'de_mirage', cfgName: 'oneshot' });
  assert.ok(args.includes('27015'), 'the port is its own argv entry');
  assert.ok(!args.includes('-tick'), 'CS2 uses sub-tick; do not pass a fixed tickrate');
  assert.ok(!args.some(arg => /[;&|`]|\$\(/.test(arg)), 'no shell metacharacters anywhere');
  assert.equal(args[args.indexOf('+map') + 1], 'de_mirage');
  assert.equal(args[args.indexOf('+exec') + 1], 'oneshot.cfg');
  assert.deepEqual(args.slice(0, 2), ['-game', 'csgo']);
});

test('createLauncher: without a binary it says so, and nothing runs', () => {
  const launcher = createLauncher({ env: {}, spawnImpl: () => { throw new Error('must not spawn'); } });
  assert.equal(launcher.status().available, false);
  assert.throws(() => launcher.start({}), /CS2_SERVER_BIN/);
});

test('createLauncher: spawn without a shell, from an absolute path only', () => {
  const calls = [];
  const launcher = createLauncher({
    env: { CS2_SERVER_BIN: '/opt/cs2/srcds', CS2_SERVER_DIR: '/opt/cs2' },
    spawnImpl: (bin, args, options) => { calls.push({ bin, args, options }); return fakeChild(); }
  });
  const started = launcher.start({ map: 'de_mirage', switches: {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/opt/cs2/srcds');
  assert.equal(calls[0].options.shell, false, 'no shell: an argument is an argument');
  assert.ok(started.pid);
  assert.equal(launcher.status().running, true);
});

test('createLauncher: a relative path and a double start are refused', () => {
  const launcher = createLauncher({ env: { CS2_SERVER_BIN: 'srcds' }, spawnImpl: fakeChild });
  assert.throws(() => launcher.start({}), /полным путём/);
  const twice = createLauncher({ env: { CS2_SERVER_BIN: '/opt/cs2/srcds' }, spawnImpl: fakeChild });
  twice.start({});
  assert.throws(() => twice.start({}), /уже запущен/);
});

test('createLauncher: a crash is reported in lastExit, not hidden', () => {
  let exitHandler = null;
  const child = fakeChild();
  child.on = (event, handler) => { if (event === 'exit') exitHandler = handler; return child; };
  const launcher = createLauncher({ env: { CS2_SERVER_BIN: '/opt/cs2/srcds' }, spawnImpl: () => child });
  launcher.start({});
  exitHandler(1, null);
  assert.equal(launcher.status().running, false);
  assert.equal(launcher.lastExit.code, 1);
});

test('createLauncher: stop sends SIGTERM first, force sends SIGKILL', () => {
  const signals = [];
  const child = fakeChild();
  child.kill = signal => { signals.push(signal); return true; };
  const launcher = createLauncher({ env: { CS2_SERVER_BIN: '/opt/cs2/srcds' }, spawnImpl: () => child });
  launcher.start({});
  assert.equal(launcher.stop(), true);
  assert.deepEqual(signals, ['SIGTERM']);
  launcher.stop({ force: true });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(launcher.stop(), false, 'nothing left to stop');
});

test('the cvar table and the map pool agree with the panel\'s veto pool', () => {
  for (const name of ['Mirage', 'Dust2', 'Inferno', 'Nuke', 'Ancient', 'Anubis', 'Cache']) {
    assert.ok(MAP_NAMES.includes(name), name);
    assert.match(MAPS[name], /^de_/);
  }
  // The damage lines the journal needs are one checkbox away, on by default.
  assert.equal(CVARS.mp_logdetail.def, 3);
  assert.equal(CVARS.log.def, 1);
});

function fakeChild() {
  return { pid: 4242, exitCode: null, killed: false, stdout: { on() {} }, stderr: { on() {} },
    on() {}, kill() { return true; } };
}
