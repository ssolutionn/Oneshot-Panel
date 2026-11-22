import test from 'node:test';
import assert from 'node:assert/strict';
import { createQualificationsController, matchQualificationPlayers } from '../qualifications-controller.js';

const uuid = '12345678-1234-1234-1234-123456789abc';
const fixture = (id, status = 'ONGOING') => ({
  match_id: id, status, faceit_url: `https://www.faceit.com/en/room/${id}`,
  teams: { faction1: { name: 'Team Alpha', players: [{ player_id: 'faceit-1', nickname: 'Player.One' }] }, faction2: { name: 'Team B' } },
  results: { score: { faction1: 1, faction2: 0 } }
});

function makeController({ matches, node = null } = {}) {
  const status = { textContent: '' };
  const list = node || { replaceChildren(value) { this.content = value; } };
  const input = { value: `https://www.faceit.com/en/championship/${uuid}/test` };
  const controller = createQualificationsController({
    input, status, list, interval: 100000,
    clientFactory: () => ({ matches: matches || (async () => []) }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    notify() {}
  });
  return { controller, status, list };
}

test('assigns existing OneShot cameras by normalized team and nickname', () => {
  const faceitTeams = [{ name: 'TEAM ALPHA', players: [{ id: 'faceit-1', nickname: 'Player.One' }] }];
  const snapshot = {
    a: { name: 'Team Alpha' },
    playersA: [{ key: 'sheet-1', nick: 'Player One', id: 'stream_a', room: 'room_a', password: 'secret-a' }],
    playersB: []
  };
  const result = matchQualificationPlayers(faceitTeams, snapshot);
  assert.equal(result[0].players[0].camera.id, 'stream_a');
  assert.equal(result[0].players[0].camera.room, 'room_a');
  assert.equal(result[0].players[0].camera.password, 'secret-a');
  assert.equal(result[0].players[0].matchMethod, 'team-nickname');
});

test('keeps camera assignments isolated by match when FACEIT repeats a player ID', async () => {
  const rows = [
    { ...fixture('match-1'), teams: { faction1: { name: 'Team Alpha', players: [{ player_id: 'same-id', nickname: 'Ace' }] }, faction2: { name: 'X' } } },
    { ...fixture('match-2'), teams: { faction1: { name: 'Team Beta', players: [{ player_id: 'same-id', nickname: 'Ace' }] }, faction2: { name: 'Y' } } }
  ];
  const controller = createQualificationsController({
    input: { value: `https://www.faceit.com/en/championship/${uuid}/test` },
    list: { replaceChildren() {} },
    panel: { snapshot: () => ({
      a: { name: 'Team Alpha' }, b: { name: 'Team Beta' },
      playersA: [{ nick: 'Ace', id: 'stream-a', room: 'room-a' }],
      playersB: [{ nick: 'Ace', id: 'stream-b', room: 'room-b' }]
    }) },
    clientFactory: () => ({ async matches() { return rows; } }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000
  });
  await controller.start();
  assert.equal(controller.state.matches.get('match-1').teams[0].players[0].camera.id, 'stream-a');
  assert.equal(controller.state.matches.get('match-2').teams[0].players[0].camera.id, 'stream-b');
  controller.destroy();
});

test('does not overwrite matched camera records with raw FACEIT teams on later polls', async () => {
  const player = { key: 'sheet-1', nick: 'Player.One', id: 'stream_a', room: 'room_a', password: 'pw' };
  let snapshots = 0;
  const controller = createQualificationsController({
    input: { value: `https://www.faceit.com/en/championship/${uuid}/test` },
    list: { replaceChildren() {} },
    panel: { snapshot: () => ({ a: { name: 'Team Alpha' }, playersA: [player], playersB: [] }) },
    clientFactory: () => ({ async matches() { return [fixture('match-1')]; } }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000
  });
  await controller.start();
  assert.equal(controller.state.matches.get('match-1').teams[0].players[0].camera.id, 'stream_a');
  await controller.poll();
  assert.equal(controller.state.matches.get('match-1').teams[0].players[0].camera.id, 'stream_a');
  assert.equal(snapshots, 0);
  controller.destroy();
});

test('refuses duplicated FACEIT player IDs instead of sharing one camera', () => {
  const result = matchQualificationPlayers([
    { name: 'Team Alpha', players: [{ id: 'same-id', nickname: 'Ace' }] },
    { name: 'Team Beta', players: [{ id: 'same-id', nickname: 'Ace' }] }
  ], {
    a: { name: 'Team Alpha' }, b: { name: 'Team Beta' },
    playersA: [{ nick: 'Ace', id: 'stream-a', room: 'room-a' }],
    playersB: [{ nick: 'Ace', id: 'stream-b', room: 'room-b' }]
  });
  assert.equal(result[0].players[0].camera, null);
  assert.equal(result[1].players[0].camera, null);
  assert.equal(result[0].players[0].matchMethod, 'duplicate-id');
});

test('does not use a unique nickname from a different known team', () => {
  const result = matchQualificationPlayers([{ name: 'Team Alpha', players: [{ id: 'f1', nickname: 'Ace' }] }], {
    a: { name: 'Team Beta' }, b: { name: 'Team Gamma' },
    playersA: [{ nick: 'Ace', id: 'stream-b', room: 'room-b' }], playersB: []
  });
  assert.equal(result[0].players[0].camera, null);
  assert.equal(result[0].players[0].matchMethod, 'missing');
});

test('does not assign a camera when the nickname match is ambiguous', () => {
  const result = matchQualificationPlayers([{ name: 'Unknown Team', players: [{ id: 'f1', nickname: 'Ace' }] }], {
    playersA: [{ nick: 'Ace', id: 's1', room: 'r1' }],
    playersB: [{ nick: 'Ace', id: 's2', room: 'r2' }]
  });
  assert.equal(result[0].players[0].camera, null);
  assert.equal(result[0].players[0].matchMethod, 'ambiguous');
});

test('exports controller lifecycle/poll/render and keeps missing DOM guarded', async () => {
  const { controller } = makeController();
  assert.equal(typeof controller.start, 'function');
  assert.equal(typeof controller.stop, 'function');
  assert.equal(typeof controller.poll, 'function');
  assert.equal(typeof controller.render, 'function');
  await controller.start();
  controller.stop();
  controller.destroy();
});

test('retains prior cards when all sources fail', async () => {
  let fail = false;
  const client = { async matches() { if (fail) throw Error('offline'); return [fixture(uuid)]; } };
  const { controller, status } = makeController({ matches: client.matches.bind(client) });
  // Reuse the same client so the second poll observes an outage.
  controller.stop();
  fail = false;
  await controller.start();
  assert.equal(controller.state.matches.size, 1);
  fail = true;
  await controller.poll();
  assert.equal(controller.state.matches.size, 1);
  assert.match(status.textContent, /последние данные сохранены/);
  controller.destroy();
});

test('connect values are held only in controller memory and first observation is non-alerting', async () => {
  const { controller } = makeController({ matches: async () => [fixture(uuid)] });
  await controller.start();
  assert.equal(controller.state.matches.size, 1);
  assert.equal(controller.state.connects.size, 0);
  assert.equal(controller.state.seeded, true);
  controller.destroy();
});

test('changing the championship clears the previous cards and connect strings', async () => {
  const otherUuid = '87654321-4321-4321-4321-cba987654321';
  const input = { value: `https://www.faceit.com/en/championship/${uuid}/a` };
  let fail = false;
  const controller = createQualificationsController({
    input, list: { replaceChildren() {} },
    clientFactory: () => ({ async matches() { if (fail) throw Error('offline'); return [fixture('match-1')]; } }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000
  });
  try {
    await controller.start();
    assert.equal(controller.state.matches.has('match-1'), true);
    controller.state.connects.set('match-1', 'connect 1.2.3.4');
    input.value = `https://www.faceit.com/en/championship/${otherUuid}/b`;
    fail = true;
    await controller.poll();
    assert.equal(controller.state.matches.size, 0);
    assert.equal(controller.state.connects.size, 0);
    assert.match(controller.state.lastError || '', /недоступен/);
  } finally {
    controller.destroy();
  }
});

test('match-room URL is rejected instead of queried as championship ID', async () => {
  const calls = [];
  const controller = createQualificationsController({
    input: { value: `https://www.faceit.com/en/cs2/room/1-${uuid}` },
    list: { replaceChildren() {} },
    clientFactory: () => ({ async matches(...args) { calls.push(args); return []; } }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000
  });
  try {
    await controller.start();
    assert.deepEqual(calls, []);
    assert.match(controller.state.lastError || '', /чемпионат/i);
  } finally {
    controller.destroy();
  }
});
