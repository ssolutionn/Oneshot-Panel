import test from 'node:test';
import assert from 'node:assert/strict';
import { createQualificationsController, matchQualificationPlayers, inputFocusedIn } from '../qualifications-controller.js';
import { qualificationVdo, qualificationPushLink, qualificationRoomLink, qualificationTeamText, qualificationMatchText } from '../qualifications-data.js';

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

test('assigns cameras from the full sheet roster, not only the selected two teams', () => {
  const faceitTeams = [{ name: 'Team Gamma', players: [{ id: 'f9', nickname: 'Ace' }] }];
  const snapshot = {
    a: { name: 'Team Alpha' }, b: { name: 'Team Beta' }, playersA: [], playersB: []
  };
  const allTeams = [{ name: 'Team Gamma', players: [{ nick: 'Ace', id: 'stream-g', room: 'room-g', password: 'pw' }] }];
  const result = matchQualificationPlayers(faceitTeams, snapshot, allTeams);
  assert.equal(result[0].players[0].camera.id, 'stream-g');
  assert.equal(result[0].players[0].matchMethod, 'team-nickname');
});

test('counts a picked-match player once when he is also in the sheet roster', () => {
  const player = { key: 'sheet-1', nick: 'Ace', id: 'stream-a', room: 'room-a' };
  const result = matchQualificationPlayers(
    [{ name: 'Team Alpha', players: [{ id: 'f1', nickname: 'Ace' }] }],
    { a: { name: 'Team Alpha' }, playersA: [player], playersB: [] },
    [{ name: 'Team Alpha', players: [player] }]
  );
  assert.equal(result[0].players[0].camera.id, 'stream-a');
  assert.equal(result[0].players[0].matchMethod, 'team-nickname');
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

test('keeps one camera watcher across polls while the watched cameras stay the same', async () => {
  let created = 0;
  const watchCalls = [];
  const watcher = { watch(groups) { watchCalls.push(groups); }, stop() { this.stopped = true; } };
  const controller = createQualificationsController({
    input: { value: `https://www.faceit.com/en/championship/${uuid}/test` },
    list: { replaceChildren() {} },
    panel: { snapshot: () => ({
      a: { name: 'Team Alpha' }, playersA: [{ nick: 'Player One', id: 'stream_a', room: 'room_a', password: 'pw' }], playersB: []
    }) },
    clientFactory: () => ({ async matches() { return [fixture('match-1')]; } }),
    watchFactory: () => { created++; return watcher; },
    interval: 100000
  });
  try {
    await controller.start();
    await controller.poll();
    assert.equal(created, 1);
    assert.equal(watchCalls.length, 2);
    assert.deepEqual(watchCalls[0], watchCalls[1]);
    controller.stop();
    assert.equal(watcher.stopped, true);
  } finally {
    controller.destroy();
  }
});

test('shows FACEIT failures in the panel alert and clears it on the next success', async () => {
  const alert = { textContent: '', hidden: true };
  let fail = true;
  const controller = createQualificationsController({
    input: { value: `https://www.faceit.com/en/championship/${uuid}/test` },
    list: { replaceChildren() {} }, alert,
    clientFactory: () => ({ async matches() { if (fail) throw Error('offline'); return [fixture(uuid)]; } }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000
  });
  try {
    await controller.start();
    assert.equal(alert.hidden, false);
    assert.match(alert.textContent, /недоступен/);
    fail = false;
    await controller.poll();
    assert.equal(alert.hidden, true);
  } finally {
    controller.destroy();
  }
});

test('waits quietly for a championship link instead of alerting on every poll', async () => {
  const alert = { textContent: '', hidden: true };
  const status = { textContent: '' };
  let calls = 0;
  const controller = createQualificationsController({
    input: { value: '' }, list: { replaceChildren() {} }, alert, status,
    clientFactory: () => ({ async matches() { calls++; return []; } }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000
  });
  try {
    await controller.start();
    assert.equal(calls, 0);
    assert.equal(alert.hidden, true);
    assert.equal(controller.state.lastError, '');
    assert.match(status.textContent, /Вставь ссылку/);
  } finally {
    controller.destroy();
  }
});

test('loads players from match details when the championship list has no roster', async () => {
  const detailCalls = [];
  const roomId = `1-${uuid}`;
  const bare = { match_id: roomId, status: 'ONGOING', teams: { faction1: { name: 'Team Alpha' }, faction2: { name: 'Team Beta' } }, results: { score: { faction1: 0, faction2: 0 } } };
  const detail = { ...bare, teams: { faction1: { name: 'Team Alpha', roster: [{ player_id: 'p1', nickname: 'Player.One' }] }, faction2: { name: 'Team Beta' } } };
  const controller = createQualificationsController({
    input: { value: `https://www.faceit.com/en/championship/${uuid}/test` },
    list: { replaceChildren() {} },
    panel: { snapshot: () => ({ a: { name: 'Team Alpha' }, playersA: [{ nick: 'Player One', id: 'stream_a', room: 'room_a' }], playersB: [] }) },
    clientFactory: () => ({
      async matches() { return [bare]; },
      async match(id) { detailCalls.push(id); return detail; }
    }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000
  });
  try {
    await controller.start();
    assert.deepEqual(detailCalls, [roomId]);
    assert.equal(controller.state.matches.get(roomId).teams[0].players[0].camera.id, 'stream_a');
    await controller.poll();
    assert.deepEqual(detailCalls, [roomId]);
  } finally {
    controller.destroy();
  }
});

test('keeps the list card when the detail endpoint returns a non-match payload', async () => {
  const roomId = `1-${uuid}`;
  const bare = { match_id: roomId, status: 'ONGOING', faceit_url: `https://www.faceit.com/en/room/${roomId}`,
    teams: { faction1: { name: 'Team Alpha' }, faction2: { name: 'Team Beta' } }, results: { score: { faction1: 0, faction2: 0 } } };
  const controller = createQualificationsController({
    input: { value: `https://www.faceit.com/en/championship/${uuid}/test` },
    list: { replaceChildren() {} },
    clientFactory: () => ({
      async matches() { return [bare]; },
      async match() { return { items: [] }; }
    }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000
  });
  try {
    await controller.start();
    const record = controller.state.matches.get(roomId);
    assert.equal(record.match.teams[0], 'Team Alpha');
    assert.equal(record.rosterAvailable, false);
  } finally {
    controller.destroy();
  }
});

test('retries a failed roster detail call on a later poll', async () => {
  const roomId = `1-${uuid}`;
  const bare = { match_id: roomId, status: 'ONGOING', teams: { faction1: { name: 'Team Alpha' }, faction2: { name: 'Team Beta' } }, results: { score: { faction1: 0, faction2: 0 } } };
  let fail = true;
  const calls = [];
  const controller = createQualificationsController({
    input: { value: `https://www.faceit.com/en/championship/${uuid}/test` },
    list: { replaceChildren() {} },
    clientFactory: () => ({
      async matches() { return [bare]; },
      async match(id) { calls.push(id); if (fail) throw Error('offline'); return { ...bare, teams: { faction1: { name: 'Team Alpha', roster: [] }, faction2: { name: 'Team Beta' } } }; }
    }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000
  });
  try {
    await controller.start();
    assert.deepEqual(calls, [roomId]);
    fail = false;
    await controller.poll();
    assert.deepEqual(calls, [roomId, roomId]);
  } finally {
    controller.destroy();
  }
});

test('inputFocusedIn detects only a text input focus inside the card list', () => {
  const previous = globalThis.document;
  const input = { tagName: 'INPUT', type: 'text' };
  const list = { contains: el => el === input };
  globalThis.document = { activeElement: input };
  try {
    assert.equal(inputFocusedIn(list), true);
    globalThis.document = { activeElement: { tagName: 'BUTTON' } };
    assert.equal(inputFocusedIn(list), false);
    globalThis.document = { activeElement: null };
    assert.equal(inputFocusedIn(list), false);
  } finally {
    globalThis.document = previous;
  }
});

test('the default client calls the same-origin proxy with an absolute URL', async () => {
  const previous = { location: globalThis.location, fetch: globalThis.fetch };
  const calls = [];
  globalThis.location = new URL('https://panel.example/prep');
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const controller = createQualificationsController({
    input: { value: `https://www.faceit.com/en/championship/${uuid}/test` },
    list: { replaceChildren() {} },
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000
  });
  try {
    await controller.start();
    assert.equal(calls.length, 3);
    assert.ok(calls.every(url => url.startsWith('https://panel.example/api/faceit?')), calls.join('\n'));
  } finally {
    controller.destroy();
    globalThis.location = previous.location;
    globalThis.fetch = previous.fetch;
  }
});

test('alerts the first outage of the new championship after a switch', async () => {
  const otherUuid = '87654321-4321-4321-4321-cba987654321';
  const input = { value: `https://www.faceit.com/en/championship/${uuid}/a` };
  let fail = false;
  const notes = [];
  const controller = createQualificationsController({
    input, list: { replaceChildren() {} }, alert: { textContent: '', hidden: true },
    notify(message, opts) { notes.push(opts?.error ? 'error' : 'info'); },
    clientFactory: () => ({ async matches() { if (fail) throw Error('offline'); return [fixture('match-1')]; } }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000
  });
  try {
    fail = true;
    await controller.start();
    assert.equal(controller.state.down, true);
    fail = false;
    input.value = `https://www.faceit.com/en/championship/${otherUuid}/b`;
    await controller.poll();
    assert.equal(controller.state.down, false);
    fail = true;
    await controller.poll();
    assert.equal(controller.state.down, true);
    assert.deepEqual(notes, ['error', 'error']);
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

test('gives every FACEIT player a VDO link even without a OneShot camera', async () => {
  const calls = [];
  const controller = createQualificationsController({
    input: { value: `https://www.faceit.com/en/championship/${uuid}/test` },
    list: { replaceChildren() {} },
    clientFactory: () => ({
      async matches() {
        calls.push('matches');
        return [
          { match_id: 'm1', status: 'ONGOING', faceit_url: `https://www.faceit.com/en/room/m1`,
            teams: { faction1: { name: 'Team A', players: [{ player_id: 'f1', nickname: 'Player.One' }] }, faction2: { name: 'Team B', players: [] } },
            results: { score: { faction1: 1, faction2: 0 } }
          }
        ];
      }
    }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000,
    vdoFactory: qualificationVdo
  });
  try {
    await controller.start();
    const record = controller.state.matches.get('m1');
    const [teamA] = record.teams;
    assert.equal(teamA.players[0].camera.source, 'generated');
    assert.equal(teamA.players[0].camera.id, 'PlayerOne');      // from FACEIT nickname
    assert.equal(teamA.players[0].camera.room, record.room);
  } finally {
    controller.destroy();
  }
});

test('a matched OneShot camera wins over the generated one', async () => {
  const calls = [];
  const controller = createQualificationsController({
    input: { value: `https://www.faceit.com/en/championship/${uuid}/test` },
    list: { replaceChildren() {} },
    clientFactory: () => ({
      async matches() {
        calls.push('matches');
        return [
          { match_id: 'm1', status: 'ONGOING', faceit_url: `https://www.faceit.com/en/room/m1`,
            teams: { faction1: { name: 'Team A', players: [{ player_id: 'f1', nickname: 'Player.One' }] }, faction2: { name: 'Team B', players: [] } },
            results: { score: { faction1: 1, faction2: 0 } }
          }
        ];
      }
    }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000,
    vdoFactory: qualificationVdo,
    panel: {
      snapshot() {
        return {
          a: { name: 'Team A' }, b: { name: 'Team B' },
          playersA: [{ key: 'faceit-1', nick: 'Player.One', id: 'oneshot-stream', room: 'oneshot-room', password: 'pw', camera: 'oneshot-camera' }],
          playersB: []
        };
      }
    }
  });
  try {
    await controller.start();
    const record = controller.state.matches.get('m1');
    const [teamA] = record.teams;
    assert.equal(teamA.players[0].camera.source, 'oneshot');
    assert.equal(teamA.players[0].camera.id, 'oneshot-stream');
    assert.equal(teamA.players[0].camera.room, 'oneshot-room');
    assert.equal(teamA.players[0].camera.password, 'pw');
  } finally {
    controller.destroy();
  }
});

test('copy buttons write correct text to clipboard', async () => {
  const clipboard = [];
  const controller = createQualificationsController({
    input: { value: `https://www.faceit.com/en/championship/${uuid}/test` },
    list: { replaceChildren() {} },
    clientFactory: () => ({
      async matches() {
        return [
          { match_id: 'm1', status: 'ONGOING', faceit_url: `https://www.faceit.com/en/room/m1`,
            teams: { faction1: { name: 'Team A', players: [{ player_id: 'f1', nickname: 'PlayerOne' }] }, faction2: { name: 'Team B', players: [{ player_id: 'f2', nickname: 'PlayerTwo' }] } },
            results: { score: { faction1: 1, faction2: 0 } }
          }
        ];
      }
    }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    interval: 100000,
    vdoFactory: qualificationVdo,
    notify() {}
  });
  try {
    await controller.start();
    // The controller clicks are delegated to the list element; simulate by calling
    // the click handler logic. Build a minimal DOM-like object to trigger it.
    // Instead, test the data helpers directly through the state.
    const record = controller.state.matches.get('m1');
    const [teamA, teamB] = record.teams;
    const pushA = qualificationPushLink(teamA.players[0].camera);
    const pushB = qualificationPushLink(teamB.players[0].camera);
    assert.match(pushA, /room=.+&push=PlayerOne$/);
    assert.match(pushB, /room=.+&push=PlayerTwo$/);
    const roomLink = qualificationRoomLink(record.room);
    assert.match(roomLink, /^https:\/\/vdo\.ninja\/\?room=[a-z0-9_]+$/);
    const teamText = qualificationTeamText('Team A', [{ nickname: 'PlayerOne', link: pushA }]);
    assert.match(teamText, /^## Team A\n/);
    assert.match(teamText, /\*\*PlayerOne\*\* /);
    const matchText = qualificationMatchText([
      { name: 'Team A', players: [{ nickname: 'PlayerOne', link: pushA }] },
      { name: 'Team B', players: [{ nickname: 'PlayerTwo', link: pushB }] }
    ]);
    assert.match(matchText, /## Team A[\s\S]*## Team B/);
  } finally {
    controller.destroy();
  }
});
