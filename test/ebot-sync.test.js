import test from 'node:test';
import assert from 'node:assert/strict';
import { panelTeamToEbot, syncTeamToEbot, syncMatch } from '../server/ebot-sync.js';

const player = (nick, role) => ({ nick, role, key: nick });

const team = (name, players) => ({ name, players });

test('panelTeamToEbot разводит роли', () => {
  const ebot = panelTeamToEbot(team('Oneshot', [
    player('Nuclear', 'Основной'),
    player('Zebra', 'Основной'),
    player('Kvit', 'Основной'),
    player('Solo', 'Основной'),
    player('Dust', 'Основной'),
    player('Sub', 'Запасной'),
    player('Coach', 'Тренер'),
    player('Extra', 'Основной'), // шестой основной — за пределами пяти слотов
  ]));
  assert.equal(ebot.name, 'Oneshot');
  assert.deepEqual(ebot.players, [
    { nick: 'Nuclear' }, { nick: 'Zebra' }, { nick: 'Kvit' }, { nick: 'Solo' }, { nick: 'Dust' },
  ]);
  assert.deepEqual(ebot.substitutes, [{ nick: 'Sub' }]);
  assert.deepEqual(ebot.coaches, [{ nick: 'Coach' }]);
});

test('panelTeamToEbot: без названия — ошибка', () => {
  assert.throws(() => panelTeamToEbot(team('  ', [player('A', 'Основной')])),
    /названия/);
});

test('panelTeamToEbot: пустой ник — ошибка', () => {
  assert.throws(() => panelTeamToEbot(team('Oneshot', [
    player('A', 'Основной'), player('   ', 'Запасной'),
  ])), /пустой ник/);
});

test('panelTeamToEbot: дубли ников — ошибка', () => {
  assert.throws(() => panelTeamToEbot(team('Oneshot', [
    player('A', 'Основной'), player('a', 'Запасной'),
  ])), /повторяется/);
});

test('panelTeamToEbot: нет основных — ошибка', () => {
  assert.throws(() => panelTeamToEbot(team('Oneshot', [player('C', 'Тренер')])),
    /«Основной»/);
});

test('syncTeamToEbot: reuse по имени без регистра', () => {
  const result = syncTeamToEbot({
    panelTeam: team('ONESHOT', [player('A', 'Основной')]),
    ebotTeams: [{ id: 7, name: 'Oneshot' }],
  });
  assert.equal(result.action, 'reuse');
  assert.equal(result.id, 7);
});

test('syncTeamToEbot: create при новой команде', () => {
  const result = syncTeamToEbot({
    panelTeam: team('Oneshot', [player('A', 'Основной'), player('B', 'Основной')]),
    ebotTeams: [{ id: 1, name: 'Другие' }],
  });
  assert.equal(result.action, 'create');
  assert.deepEqual(result.fields, { name: 'Oneshot', players: ['A', 'B'] });
});

test('syncMatch: два reuse', () => {
  const actions = syncMatch({
    panelSnapshot: {
      a: team('Oneshot', [player('A', 'Основной')]),
      b: team('Ruby', [player('B', 'Основной')]),
    },
    ebotTeams: [{ id: 1, name: 'oneshot' }, { id: 2, name: 'RUBY' }],
  });
  assert.deepEqual(actions.map(a => [a.type, a.action, a.ebotId]), [
    ['team', 'reuse', 1], ['team', 'reuse', 2], ['match', undefined, undefined],
  ]);
  assert.deepEqual(actions[2].fields, { teamA: 'Oneshot', teamB: 'Ruby' });
});

test('syncMatch: один create', () => {
  const actions = syncMatch({
    panelSnapshot: {
      a: team('Oneshot', [player('A', 'Основной')]),
      b: team('New Team', [player('B', 'Основной')]),
    },
    ebotTeams: [{ id: 1, name: 'Oneshot' }],
  });
  assert.deepEqual(actions.map(a => [a.action, a.ebotId]), [
    ['reuse', 1], ['create', undefined], [undefined, undefined],
  ]);
  assert.equal(actions[1].fields.name, 'New Team');
});

test('syncMatch: обе команды создаются', () => {
  const actions = syncMatch({
    panelSnapshot: {
      a: team('One', [player('A', 'Основной')]),
      b: team('Two', [player('B', 'Основной')]),
    },
    ebotTeams: [],
  });
  assert.ok(actions.slice(0, 2).every(a => a.action === 'create'));
});

test('syncMatch: одна и та же команда — ошибка', () => {
  assert.throws(() => syncMatch({
    panelSnapshot: {
      a: team('Oneshot', [player('A', 'Основной')]),
      b: team('ONESHOT', [player('B', 'Основной')]),
    },
    ebotTeams: [],
  }), /одна и та же команда/);
});

test('syncMatch: снимок без команды — ошибка', () => {
  assert.throws(() => syncMatch({ panelSnapshot: { a: team('One', [player('A', 'Основной')]) }, ebotTeams: [] }),
    /две команды/);
});
