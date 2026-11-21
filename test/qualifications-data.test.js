import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeQualificationMatch, safeQualificationUrl, mergeQualificationMatches,
  qualificationEvents, validateQualificationConnect, validateQualificationId
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
  for (const value of ['javascript:alert(1)', 'http://faceit.com/x', 'https://faceit.com.attacker.test/x', ''])
    assert.equal(safeQualificationUrl(value), '');
});

test('caps normalized lists at 32 and preserves prior cards through partial failures', () => {
  const source = Array.from({ length: 40 }, (_, i) => match(`m${i}`));
  const bounded = source.slice(0, 32);
  const previous = mergeQualificationMatches(new Map(), [{ status: 'fulfilled', value: [match('healthy')] }]);
  const next = mergeQualificationMatches(previous, [
    { status: 'fulfilled', value: bounded }, { status: 'rejected', reason: Error('offline') }
  ]);
  assert.equal(next.size, 32);
  assert.equal(next.has('healthy'), true);
  assert.equal(next.has('m30'), true);
  assert.equal(next.has('m31'), false);
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
