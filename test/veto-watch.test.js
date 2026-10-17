import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, decodeLink, captainKey, signMove, signRoomMessage, coinCommit, roomSecrets } from '../veto-room.js';
import { seal } from '../vdo.js';
import { RoomWatch, adminRoom, roomToPanel, roomMoves } from '../veto-watch.js';

const BASE = 'https://oneshot-veto.example/';
const b64 = bytes => Buffer.from(bytes).toString('base64url');

// The panel's room (from createRoom, keys known) and both captains.
async function room(format = 'BO3') {
  const made = await createRoom(BASE, ['UPGRADE', 'Lavked'], format);
  const a = decodeLink(new URL(made.links.a).hash), b = decodeLink(new URL(made.links.b).hash);
  return { made, a, b, ka: await captainKey(a), kb: await captainKey(b) };
}
// Coin (A wins with zero bytes), A bans first, then the given moves in turn.
async function play({ a, b, ka, kb }, moves) {
  const nonce = b64(Buffer.alloc(16, 0));
  let log = await signMove(a, [], ka, 'commit', await coinCommit(a, nonce));
  log = await signMove(b, log, kb, 'seed', b64(Buffer.alloc(16, 0)));
  log = await signMove(a, log, ka, 'reveal', nonce);
  log = await signMove(a, log, ka, 'order', '0');
  for (const [team, kind, value] of moves) log = await signMove(team ? b : a, log, team ? kb : ka, kind, value);
  return log;
}
// A watch with a fake transport: deliver(message, team) comes through that
// captain's stream.
async function watching(made, saved = null) {
  let deliver, changes = 0;
  const calls = [];
  const watch = new RoomWatch({ ...made.room, p: [...made.room.p], me: 'o' }, {
    saved, onChange: () => changes++, onCall: (team, at) => calls.push([team, at]),
    connect: (secrets, fn) => { deliver = fn; return { stop() {} }; }
  });
  await watch.ready;
  const secrets = await roomSecrets(made.room);
  const send = async (message, team) => {
    deliver(await seal(secrets.key, message), team);
    await new Promise(resolve => setTimeout(resolve, 30));
    await watch.queue;
  };
  return { watch, send, calls, changes: () => changes };
}

test('admin room: any link is watched as the admin, a captain secret is dropped', async () => {
  const { made } = await room();
  const fromCaptain = adminRoom(made.links.a);
  assert.equal(fromCaptain.room.me, 'o');
  assert.equal(fromCaptain.room.k, undefined);
  assert.equal(fromCaptain.adminLink, made.links.o);
  assert.equal(adminRoom(made.links.s).adminLink, made.links.o);
  assert.equal(adminRoom('https://example.org/#v=broken'), null);
  assert.equal(adminRoom('not a link'), null);
  assert.equal(adminRoom('javascript:alert(1)#v=AAAA'), null);
});

test('room to panel: same order, swapped teams, other match, before the order', async () => {
  const seats = await room();
  const log = await play(seats, [[0, 'ban', 'Anubis'], [1, 'ban', 'Nuke'], [0, 'pick', 'Dust2']]);
  const { watch } = await watching(seats.made, { r: seats.made.room.r, log });
  const state = watch.state;
  const same = roomToPanel(watch.room, state, ['UPGRADE', 'Lavked']);
  assert.deepEqual(same, {
    format: 'BO3', first: 0, pending: 'Dust2',
    actions: [{ map: 'Anubis', type: 'ban', team: 0 }, { map: 'Nuke', type: 'ban', team: 1 }]
  });
  const swapped = roomToPanel(watch.room, state, ['lavked ', 'Upgrade']);
  assert.equal(swapped.first, 1);
  assert.deepEqual(swapped.actions.map(a => a.team), [1, 0]);
  assert.equal(roomToPanel(watch.room, state, ['UPGRADE', 'PCIFIC']), null);
  assert.equal(roomToPanel(watch.room, { ...state, first: null }, ['UPGRADE', 'Lavked']), null);
  assert.deepEqual(roomMoves(watch.room, log).map(m => [m.kind, m.team, m.value]), [
    ['coin', 0, ''], ['order', 0, '0'], ['ban', 0, 'Anubis'], ['ban', 1, 'Nuke'], ['pick', 0, 'Dust2']
  ]);
});

test('watch: signed moves, presence by stream, calls; junk and forgeries change nothing', async () => {
  const seats = await room();
  const { watch, send, calls, changes } = await watching(seats.made);
  assert.equal(watch.online(0), false);
  const log = await play(seats, [[0, 'ban', 'Anubis']]);
  await send({ t: 'log', from: 'b', log: log.slice(0, 2), p: seats.made.room.p }, 0);
  assert.equal(watch.online(0), true, 'presence is the stream the message came through, not from');
  assert.equal(watch.online(1), false);
  assert.equal(watch.log.length, 2);
  const called = await signRoomMessage(seats.b, seats.kb,
    { t: 'log', log, p: seats.made.room.p, call: 1792141200000 });
  await send(called, 1);
  assert.equal(watch.log.length, log.length);
  assert.deepEqual(calls, [[1, 1792141200000]]);
  await send({ t: 'log', from: 'b', log, p: seats.made.room.p, call: 1792141200001 }, 1);
  assert.deepEqual(calls, [[1, 1792141200000]], 'an unsigned stream collision cannot call the admin');
  assert.ok(changes() >= 2);
  // B's move signed with A's key (A playing for B) is not taken.
  const forged = await signMove({ ...seats.a, me: 'b' }, log, seats.ka, 'ban', 'Nuke');
  await send({ t: 'log', log: forged }, 1);
  assert.equal(watch.log.length, log.length);
  await send({ t: 'nope' }, 0);
  await send({ t: 'log', log: 'x' }, 0);
  assert.equal(watch.log.length, log.length);
  // A different move at a step already seen: the first stays, the conflict is kept.
  const other = await play(seats, [[0, 'ban', 'Mirage']]);
  await send({ t: 'log', log: other }, 0);
  assert.equal(watch.log[watch.log.length - 1].v, 'Anubis');
  assert.ok(watch.conflict);
  assert.deepEqual(watch.saved().log, watch.log);
  watch.stop();
});

test('watch: keys from a pasted link come with the captains\' messages', async () => {
  const seats = await room('BO1');
  const pasted = adminRoom(seats.made.links.s);
  let deliver;
  const watch = new RoomWatch(pasted.room, { connect: (s, fn) => { deliver = fn; return { stop() {} }; } });
  await watch.ready;
  const secrets = await roomSecrets(pasted.room);
  const log = await play(seats, [[0, 'ban', 'Anubis']]);
  deliver(await seal(secrets.key, { t: 'log', log, p: [null, null] }), 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  await watch.queue;
  assert.equal(watch.log.length, 0, 'no keys yet: nothing verifies');
  deliver(await seal(secrets.key, { t: 'log', log, p: seats.made.room.p }), 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  await watch.queue;
  assert.equal(watch.log.length, log.length);
});
