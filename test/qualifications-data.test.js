import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeQualificationMatch, safeQualificationUrl, mergeQualificationMatches,
  qualificationEvents, validateQualificationConnect, validateQualificationId, qualificationIdCollisions,
  qualificationVdo, vdoSafeName,
  qualificationPushLink, qualificationRoomLink, qualificationTeamText, qualificationMatchText,
  sortQualificationMatches, qualificationDirectorLink, filterQualificationMatches
} from '../qualifications-data.js';

const match = (id, status = 'ONGOING') => ({ match_id: id, status, teams: {
  faction1: { name: '<img src=x>', players: [{ player_id: 'p1', nickname: '<b>A</b>' }] },
  faction2: { name: 'B' }
}, results: { score: { faction1: 1, faction2: 0 } },
faceit_url: 'https://www.faceit.com/en/cs2/room/1-test' });

test('normalizes an available roster as text and reports absent roster as empty', () => {
  const full = normalizeQualificationMatch(match('m1'));
  assert.equal(full.match.id, 'm1');
  assert.equal(full.teams[0].name, '<img src=x>');
  assert.deepEqual(full.teams[0].players, [{ id: 'p1', nickname: '<b>A</b>' }]);
  assert.deepEqual(normalizeQualificationMatch({ match_id: 'm2', teams: {} }).teams, []);
});

test('accepts only HTTPS FACEIT URLs', () => {
  assert.equal(safeQualificationUrl('https://www.faceit.com/en/room/x'), 'https://www.faceit.com/en/room/x');
  for (const value of ['javascript:alert(1)', 'http://faceit.com/x', 'https://faceit.com.attacker.test/x', 'https://evil.faceit.com/x', ''])
    assert.equal(safeQualificationUrl(value), '');
  // faceit.js builds room links with {lang}; they must survive sanitizing.
  assert.equal(safeQualificationUrl('https://www.faceit.com/{lang}/cs2/room/x'), 'https://www.faceit.com/ru/cs2/room/x');
});

test('caps normalized lists at 32, preferring fresh matches over retained ones', () => {
  const source = Array.from({ length: 40 }, (_, i) => match(`m${i}`));
  const bounded = source.slice(0, 32);
  const previous = mergeQualificationMatches(new Map(), [{ status: 'fulfilled', value: [match('healthy')] }]);
  const next = mergeQualificationMatches(previous, [
    { status: 'fulfilled', value: bounded }, { status: 'rejected', reason: Error('offline') }
  ]);
  assert.equal(next.size, 32);
  assert.equal(next.has('m31'), true);
  assert.equal(next.has('healthy'), false);
  assert.equal(next.has('m32'), false);
});

test('reports only status and score transitions for the same match', () => {
  const before = { id: 'm', status: 'SCHEDULED', score: [0, 0] };
  assert.deepEqual(qualificationEvents(null, before), []);
  assert.deepEqual(qualificationEvents(before, { ...before }), []);
  assert.deepEqual(qualificationEvents(before, { ...before, status: 'ONGOING', score: [1, 0] }), [
    { type: 'status', id: 'm', from: 'SCHEDULED', to: 'ONGOING' },
    { type: 'score', id: 'm', score: [1, 0] }
  ]);
  assert.deepEqual(qualificationEvents(before, { ...before, id: 'other' }), []);
});

test('validates connect input and generated stream IDs without accepting controls', () => {
  assert.equal(validateQualificationConnect('connect 127.0.0.1:27015'), 'connect 127.0.0.1:27015');
  for (const value of ['', 'connect\nsecret', 'x'.repeat(257)]) assert.equal(validateQualificationConnect(value), '');
  assert.equal(validateQualificationId('match_player_1'), 'match_player_1');
  for (const value of ['../player', 'x'.repeat(65), '']) assert.equal(validateQualificationId(value), '');
});

test('does not keep stale matches absent from all successful lists', () => {
  const previous = new Map([
    ['old-1', { match: { id: 'old-1' }, teams: [], connect: null }],
    ['old-2', { match: { id: 'old-2' }, teams: [], connect: null }]
  ]);
  const settled = [
    { status: 'fulfilled', value: [{ match_id: 'new-1', status: 'ONGOING', faceit_url: 'https://www.faceit.com/en/room/new-1', teams: {}, results: { score: { faction1: 0, faction2: 0 } } }] },
    { status: 'fulfilled', value: [] },
    { status: 'fulfilled', value: [] }
  ];
  const merged = mergeQualificationMatches(previous, settled);
  assert.equal(merged.has('old-1'), false);
  assert.equal(merged.has('old-2'), false);
  assert.equal(merged.has('new-1'), true);
});

test('retains previous cards when any list type failed', () => {
  const previous = new Map([
    ['keep-1', { match: { id: 'keep-1' }, teams: [], connect: null }]
  ]);
  const settled = [
    { status: 'fulfilled', value: [{ match_id: 'new-1', status: 'ONGOING', faceit_url: 'https://www.faceit.com/en/room/new-1', teams: {}, results: { score: { faction1: 0, faction2: 0 } } }] },
    { status: 'rejected', reason: new Error('network') },
    { status: 'fulfilled', value: [] }
  ];
  const merged = mergeQualificationMatches(previous, settled);
  assert.equal(merged.has('keep-1'), true);
  assert.equal(merged.has('new-1'), true);
});

test('a raw match that happens to carry a match object is not mistaken for a normalized record', () => {
  // Regression: detection used to be `raw.match ? raw : normalize(raw)`, so any
  // future API field named `match` produced empty cards instead of data.
  const raw = { ...match('real-1'), match: { id: 'decoy' } };
  const merged = mergeQualificationMatches(new Map(), [{ status: 'fulfilled', value: [raw] }]);
  assert.equal(merged.has('real-1'), true);
  assert.equal(merged.has('decoy'), false);
  assert.deepEqual(merged.get('real-1').match.teams, ['<img src=x>', 'B']);
});

test('stream IDs read as FACEIT nicknames, one room per match', () => {
  const teams = [
    { name: 'Team Alpha', players: [{ nickname: 'Player.One' }, { nickname: 'Ace' }] },
    { name: 'Team Beta', players: [{ nickname: 'Ace' }] }
  ];
  const a = qualificationVdo('champ-1', '1-uuid-a', teams);
  assert.deepEqual(a, qualificationVdo('champ-1', '1-uuid-a', teams)); // reload keeps links
  assert.equal(a.players[0].id, 'PlayerOne');                          // nickname drives the ID
  assert.equal(a.players[1].id, 'Ace');
  assert.equal(a.players[2].id, 'Ace_2');            // same nick, one room: no collision
  for (const player of a.players) assert.match(player.id, /^[A-Za-z0-9_]{1,64}$/);
  assert.match(a.room, /^[a-z0-9_]{1,64}$/);
  assert.match(a.room, /teamalpha_teambeta/);        // the room says who plays
  assert.notEqual(a.room, qualificationVdo('champ-1', '1-uuid-b', teams).room);
});

test('Cyrillic, emoji and punctuation never break a VDO ID', () => {
  const v = qualificationVdo('c', 'm', [{ name: 'Команда «А»', players: [{ nickname: 'Игрок #7' }, { nickname: '💥boom' }] }]);
  for (const player of v.players) assert.match(player.id, /^[A-Za-z0-9_]{1,64}$/);
  assert.equal(v.players[0].id, 'player7');          // one Latin char is not a readable name
  assert.equal(v.players[1].id, 'boom');
});

test('vdoSafeName strips what VDO.Ninja strips and never returns empty', () => {
  assert.equal(vdoSafeName('Player.One'), 'PlayerOne');
  assert.equal(vdoSafeName('💥💥'), 'cam');
  assert.equal(vdoSafeName('x'.repeat(40)).length, 16);
});

test('qualificationPushLink matches core.pushUrl format', () => {
  assert.equal(qualificationPushLink({ id: 'Ace_abc', room: 'q123' }),
    'https://vdo.ninja/?room=q123&broadcast&do&push=Ace_abc');
  assert.equal(qualificationPushLink({ id: 'Ace_abc', room: 'q123', password: 'pw' }),
    'https://vdo.ninja/?room=q123&password=pw&broadcast&do&push=Ace_abc');
});

test('qualificationRoomLink opens the room of active streams', () => {
  assert.equal(qualificationRoomLink('q123'), 'https://vdo.ninja/?room=q123');
});

test('qualificationTeamText and qualificationMatchText format like playerText in core.js', () => {
  const text = qualificationTeamText('Team A', [{ nickname: 'Ace', link: 'https://vdo.ninja/?room=q1&push=x' }]);
  assert.match(text, /^## Team A\n/);
  assert.match(text, /\*\*Ace\*\* https:\/\/vdo\.ninja\/\?room=q1&push=x/);
  const both = qualificationMatchText([
    { name: 'Team A', players: [{ nickname: 'Ace', link: 'https://vdo.ninja/?room=q1&push=x' }] },
    { name: 'Team B', players: [{ nickname: 'Bee', link: 'https://vdo.ninja/?room=q1&push=y' }] }
  ]);
  assert.match(both, /## Team A[\s\S]*## Team B/);   // each block names its team
  assert.match(both, /\*\*Bee\*\* https:\/\/vdo\.ninja\/\?room=q1&push=y/);
});

test('reports duplicate stream IDs after sanitization', () => {
  assert.deepEqual(qualificationIdCollisions(['q_match_player', 'q_match_player', 'q_other']), ['q_match_player']);
});

test('sortQualificationMatches: live first, then upcoming by time, finished at the bottom', () => {
  const rec = (id, status, scheduledAt) => ({
    match: { id, status, live: status === 'ONGOING', done: status === 'FINISHED' || status === 'CANCELLED', scheduledAt },
    teams: []
  });
  const input = [
    rec('done1', 'FINISHED', 1000), rec('soon2', 'SCHEDULED', 2000),
    rec('live1', 'ONGOING', 0), rec('done2', 'CANCELLED', 500),
    rec('soon1', 'SCHEDULED', 1500), rec('live2', 'ONGOING', 0)
  ];
  const order = sortQualificationMatches(input).map(r => r.match.id);
  assert.deepEqual(order, ['live1', 'live2', 'soon1', 'soon2', 'done1', 'done2']); // finished: most recent first
});

test('qualificationDirectorLink opens the VDO director, not a plain room', () => {
  assert.equal(qualificationDirectorLink('teama_teamb_ab12cd'),
    'https://vdo.ninja/?director=teama_teamb_ab12cd');
  assert.ok(!qualificationDirectorLink('room').includes('room='));
});

test('filterQualificationMatches keeps only the requested status group', () => {
  const rec = (id, live, done) => ({ match: { id, live, done } });
  const records = [rec('l1', true, false), rec('s1', false, false), rec('d1', false, true)];
  assert.deepEqual(filterQualificationMatches(records, 'live').map(r => r.match.id), ['l1']);
  assert.deepEqual(filterQualificationMatches(records, 'soon').map(r => r.match.id), ['s1']);
  assert.deepEqual(filterQualificationMatches(records, 'done').map(r => r.match.id), ['d1']);
  assert.equal(filterQualificationMatches(records, 'all').length, 3);
});

test('mergeQualificationMatches keeps the first-seen team order across polls', () => {
  const raw = winner => ({ match_id: 'm1', status: 'ONGOING', best_of: 1, results: { score: { faction1: 0, faction2: 0 } }, teams: {
    faction1: { name: winner ? 'Beta' : 'Alpha', players: [] },
    faction2: { name: winner ? 'Alpha' : 'Beta', players: [] }
  } });
  const settled = [{ status: 'fulfilled', value: [raw(0)] }, { status: 'rejected', reason: new Error('x') }];
  const first = mergeQualificationMatches(new Map(), settled);
  const second = mergeQualificationMatches(first, [{ status: 'fulfilled', value: [raw(1)] }, { status: 'rejected', reason: new Error('x') }]);
  assert.equal(first.get('m1').match.teams[0], 'Alpha');
  assert.equal(second.get('m1').match.teams[0], 'Alpha'); // FACEIT swapped factions; we keep Alpha first
});
