import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom, decodeLink, roomSecrets, privateKey, signMove, verifyLog, replay,
  nextTurn, pickLog, clock, formatClock, mapBoard, resultText, captainMessage
} from '../veto-room.js';

const BASE = 'https://oneshot-panel.pages.dev/veto.html';

async function seats(format = 'BO3', coin = 0) {
  const { links, room } = await createRoom(BASE, ['UPGRADE', 'Lavked'], format, coin);
  const a = decodeLink(new URL(links.a).hash), b = decodeLink(new URL(links.b).hash);
  const s = decodeLink(new URL(links.s).hash);
  return { room, links, a, b, s, ka: await privateKey(a), kb: await privateKey(b) };
}

test('links: each captain gets their own key, spectators none', async () => {
  const { links, a, b, s } = await seats();
  assert.equal(a.me, 'a');
  assert.equal(b.me, 'b');
  assert.equal(s.me, 's');
  assert.equal(s.k, undefined);
  assert.notEqual(a.k, b.k);
  assert.deepEqual(a.p, s.p);
  assert.ok(links.a.startsWith(BASE + '#v='));
  assert.ok(links.a.length < 600, 'fits a Discord message');
  assert.equal(decodeLink('#v=broken'), null);
  assert.equal(decodeLink(''), null);
  assert.equal(await privateKey(s), null);
  await assert.rejects(createRoom(BASE, ['A', 'A'], 'BO3'), /две разные/);
});

test('room secrets: derived from the code, the code stays out', async () => {
  const { a, b } = await seats();
  const sa = await roomSecrets(a), sb = await roomSecrets(b);
  assert.deepEqual(sa.streams, sb.streams);
  assert.equal(sa.password, sb.password);
  assert.notEqual(sa.streams[0], sa.streams[1]);
  assert.ok(!sa.streams.join().includes(a.r) && !sa.password.includes(a.r));
});

test('BO3: coin winner orders, picks get the opponent\'s side, decider is left', async () => {
  const { a, b, s, ka, kb } = await seats('BO3', 1);
  let log = [];
  assert.deepEqual(nextTurn(s, replay(s, log)), { kind: 'order', team: 1 });
  await assert.rejects(signMove(a, log, ka, 'order', '0'), /не твой ход/);
  log = await signMove(b, log, kb, 'order', '0', 1000); // Lavked gives UPGRADE the first ban
  log = await signMove(a, log, ka, 'ban', 'Ancient');
  log = await signMove(b, log, kb, 'ban', 'Anubis');
  log = await signMove(a, log, ka, 'pick', 'Mirage');
  assert.deepEqual(nextTurn(s, replay(s, log)), { kind: 'side', team: 1 });
  await assert.rejects(signMove(a, log, ka, 'side', 'CT'), /не твой ход/);
  log = await signMove(b, log, kb, 'side', 'CT');
  log = await signMove(b, log, kb, 'pick', 'Nuke');
  log = await signMove(a, log, ka, 'side', 'T');
  log = await signMove(a, log, ka, 'ban', 'Cache');
  await assert.rejects(signMove(b, log, kb, 'ban', 'Cache'), /уже выбрана/);
  log = await signMove(b, log, kb, 'ban', 'Dust2');

  const verified = await verifyLog(s, JSON.parse(JSON.stringify(log)));
  assert.equal(verified.length, log.length);
  const state = replay(s, verified);
  assert.equal(nextTurn(s, state).kind, 'done');
  assert.equal(resultText(s, state), [
    'UPGRADE removed Ancient', 'Lavked removed Anubis',
    'UPGRADE pick Mirage (Lavked CT)', 'Lavked pick Nuke (UPGRADE T)',
    'UPGRADE removed Cache', 'Lavked removed Dust2', 'Inferno was left over'
  ].join('\n'));
  const board = mapBoard(s, state);
  assert.deepEqual(board.find(m => m.map === 'Inferno'), { map: 'Inferno', status: 'decider' });
  assert.deepEqual(board.find(m => m.map === 'Mirage'),
    { map: 'Mirage', status: 'pick', team: 0, side: 'CT', sideTeam: 1 });
});

test('verifyLog: forged, edited or foreign moves are dropped', async () => {
  const { a, b, s, ka, kb } = await seats('BO1', 0);
  let log = await signMove(a, [], ka, 'order', '1');
  log = await signMove(b, log, kb, 'ban', 'Nuke');
  // Captain B signs a move in A's turn by hand.
  const forged = { k: 'ban', v: 'Mirage', at: 5 };
  const other = await seats('BO1', 0);
  const stolen = await signMove(other.a, [], other.ka, 'order', '1');
  assert.equal((await verifyLog(s, [...log, { ...forged, s: log[1].s }])).length, 2);
  assert.equal((await verifyLog(s, [{ ...log[0], v: '0' }, log[1]])).length, 0, 'edited entry');
  assert.equal((await verifyLog(s, stolen)).length, 0, 'other room');
  assert.equal((await verifyLog(s, [log[1]])).length, 0, 'out of order');
  const checked = new Set();
  await verifyLog(s, log, checked);
  assert.equal((await verifyLog(s, [{ ...log[0], v: '0' }], checked)).length, 0, 'cache keys the content');
});

test('pickLog: longer wins, ties settle the same everywhere', async () => {
  const { a, ka } = await seats('BO1', 0);
  const base = await signMove(a, [], ka, 'order', '0');
  const one = await signMove(a, base, ka, 'ban', 'Nuke');
  const two = await signMove(a, base, ka, 'ban', 'Mirage');
  assert.equal(pickLog(base, one), one);
  assert.equal(pickLog(one, base), one);
  assert.equal(pickLog(one, two), pickLog(two, one));
});

test('clock: five minutes from the order choice, then "over"', () => {
  assert.deepEqual(clock({ startedAt: null }, 0), { started: false, left: 300000, over: false });
  assert.equal(clock({ startedAt: 1000 }, 61000).left, 240000);
  assert.equal(clock({ startedAt: 1000 }, 400000).over, true);
  assert.equal(clock({ startedAt: 9000 }, 1000).left, 300000, 'a clock ahead of ours');
  assert.equal(formatClock(300000), '5:00');
  assert.equal(formatClock(61001), '1:02');
  assert.equal(formatClock(0), '0:00');
});

test('captain message: names the team and warns about the link', async () => {
  const { room, links } = await seats();
  const text = captainMessage(room, 1, links.b);
  assert.match(text, /Капитан \*\*Lavked\*\*/);
  assert.match(text, /никому не пересылай/);
  assert.ok(text.includes(links.b));
});
