import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMatchRow, statusClass, validateCreateForm, teamRowText } from '../ebot-admin-core.js';

test('formatMatchRow: строка матча со всеми полями', () => {
  const cells = formatMatchRow({ id: '42', teamA: 'Alpha', teamB: 'Beta', scoreA: 13, scoreB: 9, map: 'de_mirage', status: 'Live' });
  assert.deepEqual(cells, { id: '42', teamA: 'Alpha', teamB: 'Beta', score: '13 : 9', map: 'de_mirage', status: 'Live' });
});

test('formatMatchRow: пустые поля eBot не ломают строку', () => {
  const cells = formatMatchRow({ id: 7, teamA: 'A', teamB: 'B', scoreA: 0, scoreB: 0 });
  assert.equal(cells.map, '');
  assert.equal(cells.status, '—');
  assert.equal(cells.score, '0 : 0');
  assert.equal(cells.id, '7');
});

test('statusClass: живой, завершённый, не стартованный, остановленный', () => {
  assert.equal(statusClass('Live'), 'is-live');
  assert.equal(statusClass('Warming up'), 'is-live');
  assert.equal(statusClass('Finished 13-9'), 'is-done');
  assert.equal(statusClass('Archived'), 'is-done');
  assert.equal(statusClass('Not started'), 'is-pending');
  assert.equal(statusClass('Stop'), 'is-stopped');
  assert.equal(statusClass('Canceled'), 'is-stopped');
  assert.equal(statusClass(''), 'is-live'); // пустой статус eBot — считаем живым, не подсвечивая особого
});

test('validateCreateForm: обе команды обязательны и различны, карта обязательна', () => {
  assert.equal(validateCreateForm({ teamA: 'A', teamB: 'B', map: 'de_nuke', mapsCount: '3' }), '');
  assert.match(validateCreateForm({ teamA: '', teamB: 'B', map: 'de_nuke', mapsCount: '3' }), /команду A/);
  assert.match(validateCreateForm({ teamA: 'A', teamB: '', map: 'de_nuke', mapsCount: '3' }), /команду B/);
  assert.match(validateCreateForm({ teamA: 'A', teamB: 'a', map: 'de_nuke', mapsCount: '3' }), /разными/i);
  assert.match(validateCreateForm({ teamA: 'A', teamB: 'B', map: '', mapsCount: '3' }), /карт/i);
  assert.match(validateCreateForm({ teamA: 'A', teamB: 'B', map: 'de_nuke', mapsCount: '2' }), /количество карт/i);
});

test('teamRowText: название и состав никами', () => {
  assert.deepEqual(teamRowText({ name: 'Alpha', players: ['nik1', 'nik2'] }), { name: 'Alpha', players: 'nik1, nik2' });
  assert.deepEqual(teamRowText({ name: 'Beta', players: [] }), { name: 'Beta', players: '—' });
  assert.deepEqual(teamRowText({}), { name: '', players: '—' });
});
