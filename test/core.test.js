import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  decodeGviz, parseTeams, parseSchedule, defaultLineup,
  selectedPlayers, validateMatch, playerText, viewUrl, pushUrl,
  safeFilename, buildObs, MAP_POOL, VETO_RULES,
  validateVeto, appendVeto, vetoText
} from '../core.js';

const makeRows = () => ['HYPERSPIRIT', '6yuBoJlbl'].flatMap((team, t) =>
  Array.from({ length: 7 }, (_, i) => [
    `${t}-${i}`, team, String(i + 1),
    t === 0 && i === 0 ? 'Ciocardau' : `Player${t}-${i}`,
    `stream${t}-${i}`, t === 0 ? 'hyperspirit' : 'team-b',
    '', '', i < 5 ? 'Основной' : i === 5 ? 'Запасной' : 'Тренер'
  ]));
const fixture = () => {
  const [a, b] = parseTeams(makeRows());
  return [a, b, defaultLineup(a), defaultLineup(b)];
};
const template = JSON.parse(fs.readFileSync(
  new URL('../assets/obs-template.json', import.meta.url), 'utf8'));
const uuidFn = () => {
  let i = 0;
  return () => `new-uuid-${++i}`;
};

test('Google response: formatted cells, blanks and errors', () => {
  assert.deepEqual(decodeGviz(
    '/O_o/google.visualization.Query.setResponse({"status":"ok","table":{"rows":[{"c":[{"v":123,"f":"01:23"},null,{"v":"nick"}]}]}});'
  ), [['01:23', '', 'nick']]);
  assert.throws(() => decodeGviz('<html>Sign in</html>'), /доступ/);
  assert.throws(() => decodeGviz('{"status":"error"}'), /не разрешил/);
});

test('Roster keeps order, substitutes and coaches', () => {
  const [a] = parseTeams([['ID', 'команда'], ...makeRows()]);
  assert.equal(a.name, 'HYPERSPIRIT');
  assert.deepEqual(defaultLineup(a), ['0-0', '0-1', '0-2', '0-3', '0-4']);
  assert.equal(a.players[5].role, 'Запасной');
  assert.equal(a.players[6].role, 'Тренер');
});

test('Reject duplicate IDs, missing rooms and empty roster', () => {
  const rows = makeRows();
  rows[7][0] = rows[0][0];
  assert.throws(() => parseTeams(rows), /Повтор ID/);
  const missing = makeRows();
  missing[0][5] = '';
  assert.throws(() => parseTeams(missing), /комната/);
  assert.throws(() => parseTeams([]), /не найден состав/);
});

test('Match validation rejects invalid lineups', () => {
  const [a, b, ka, kb] = fixture();
  assert.equal(validateMatch(a, b, ka, kb), '');
  assert.match(validateMatch(a, a, ka, ka), /разные команды/);
  assert.match(validateMatch(a, b, ka.slice(1), kb), /пять/);
  assert.match(validateMatch(a, b, ['0-0', ...ka.slice(0, 4)], kb), /несколько/);
  b.players[0].id = a.players[0].id;
  assert.match(validateMatch(a, b, ka, kb), /свой ID/);
});

test('Schedule identifies repeat matchups and validates time', () => {
  const schedule = parseSchedule([
    ['', '9:05', 'A', 'B', 'Группа A'],
    ['', '21:30', 'A', 'B', 'Финал'],
    ['', '25:30', 'A', 'B'], ['', '9:99', 'A', 'B']
  ]);
  assert.equal(schedule.length, 2);
  assert.equal(schedule[0].time, '09:05');
  assert.notEqual(schedule[0].key, schedule[1].key);
  assert.equal(schedule[1].stage, 'Финал');
});

test('Player output has bold nickname and separate PUSH URL', () => {
  const [a, , ka] = fixture();
  const text = playerText(a, selectedPlayers(a, ka));
  assert.ok(text.startsWith('## HYPERSPIRIT\n'));
  assert.ok(text.includes('**Ciocardau** https://vdo.ninja/?room=hyperspirit&broadcast&do&push=stream0-0'));
  assert.equal((text.match(/https:\/\/vdo\.ninja\//g) || []).length, 5);
  assert.ok(!text.includes('[**'));
  assert.ok(!text.includes('director='));
});

test('URL parameters and Markdown are escaped', () => {
  const p = {
    nick: 'x\n# title',
    id: 'id&push=other', room: 'r&director=x'
  };
  const url = new URL(pushUrl(p));
  assert.equal(url.searchParams.get('push'), p.id);
  assert.equal(url.searchParams.get('room'), p.room);
  assert.equal(url.searchParams.get('director'), null);
  assert.ok(!playerText({ name: 'team' }, [p]).includes('\n# title'));
});

test('Filename preserves Russian and validates metadata', () => {
  assert.equal(
    safeFilename('6yuBoJlbl', 'HYPERSPIRIT', '18:00', 'Групповой этап'),
    '18-00 _ Групповой этап _ 6yuBoJlbl vs HYPERSPIRIT.json'
  );
  const name = safeFilename('../Команда:А', 'B/C', '00:05', 'Финал*');
  assert.ok(!/[<>:"/\\|?*]/.test(name));
  assert.throws(() => safeFilename('A', 'B', '25:00', 'Final'), /время/);
  assert.throws(() => safeFilename('A', 'B', '18:00', ' '), /стадию/);
  assert.ok(new TextEncoder().encode(safeFilename(
    '😀'.repeat(100), 'Ж'.repeat(100), '12:00', 'Ю'.repeat(100)
  )).length <= 255);
});

test('OBS repairs cameras and remaps references without mutating template', () => {
  const args = fixture(), original = JSON.stringify(template);
  const result = buildObs(template, ...args, uuidFn());
  assert.equal(JSON.stringify(template), original);
  assert.deepEqual(result.resolution, { x: 1920, y: 1080 });
  const byId = new Map(result.sources.map(s => [s.uuid, s]));
  const refs = new Set();
  const players = [
    ...selectedPlayers(args[0], args[2]),
    ...selectedPlayers(args[1], args[3])
  ];
  for (let i = 0; i < 10; i++) {
    const scene = result.sources.find(s => s.name === `Игрок ${i + 1}`);
    const item = scene.settings.items.find(it =>
      byId.get(it.source_uuid)?.id === 'browser_source');
    const browser = byId.get(item.source_uuid);
    refs.add(item.source_uuid);
    assert.equal(browser.settings.url, viewUrl(players[i]));
    assert.equal(browser.settings.width, 1920);
    assert.equal(browser.settings.height, 1080);
    assert.equal(item.rot, 0);
    assert.deepEqual(item.pos, { x: 0, y: 0 });
    assert.deepEqual(item.bounds, { x: 1920, y: 1080 });
    assert.equal(item.bounds_type, 2);
    for (const key of ['crop_left', 'crop_right', 'crop_top', 'crop_bottom']) {
      assert.equal(item[key], 0);
    }
    for (const it of scene.settings.items) {
      assert.ok(byId.has(it.source_uuid));
      assert.equal(it.name, byId.get(it.source_uuid).name);
    }
  }
  assert.equal(refs.size, 10);
  assert.equal(new Set(result.sources.map(s => s.uuid)).size, result.sources.length);
  assert.ok(result.sources.every(s =>
    !template.sources.some(t => t.uuid === s.uuid)));
});

test('Matrix tiles fit canvas without overlap', () => {
  const result = buildObs(template, ...fixture(), uuidFn());
  const items = result.sources.find(s => s.name === 'Матрица').settings.items;
  for (const it of items) {
    assert.ok(it.pos.x >= 0 && it.pos.y >= 0);
    assert.ok(it.pos.x + it.bounds.x <= 1920);
    assert.ok(it.pos.y + it.bounds.y <= 1080);
  }
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const x = items[a], y = items[b];
      assert.ok(
        x.pos.x + x.bounds.x <= y.pos.x ||
        y.pos.x + y.bounds.x <= x.pos.x ||
        x.pos.y + x.bounds.y <= y.pos.y ||
        y.pos.y + y.bounds.y <= x.pos.y
      );
    }
  }
});

test('Shared camera sources become independent', () => {
  const shared = structuredClone(template);
  const byId = new Map(shared.sources.map(s => [s.uuid, s]));
  const s1 = shared.sources.find(s => s.name === 'Игрок 1');
  const s2 = shared.sources.find(s => s.name === 'Игрок 2');
  const i1 = s1.settings.items.find(it =>
    byId.get(it.source_uuid)?.id === 'browser_source');
  const i2 = s2.settings.items.find(it =>
    byId.get(it.source_uuid)?.id === 'browser_source');
  i2.source_uuid = i1.source_uuid;
  const result = buildObs(shared, ...fixture(), uuidFn());
  const cameras = result.sources.filter(s => s.name.startsWith('CAM '));
  assert.equal(new Set(cameras.map(s => s.settings.url)).size, 10);
});

test('Invalid template fails rather than exporting broken JSON', () => {
  assert.throws(() => buildObs({}, ...fixture()), /шаблон/);
  const broken = structuredClone(template);
  broken.sources = broken.sources.filter(s => s.name !== 'Игрок 6');
  assert.throws(() => buildObs(broken, ...fixture()), /игрока 6/);
});

test('BO3 matches exact requested HLTV text', () => {
  let actions = [];
  for (const map of ['Anubis', 'Nuke', 'Dust2', 'Cache', 'Inferno', 'Mirage']) {
    actions = appendVeto(actions, 'BO3', 0, map, 'CT');
  }
  assert.equal(vetoText(['6yuBoJlbl', 'HYPERSPIRIT'], actions),
    '6yuBoJlbl removed Anubis\nHYPERSPIRIT removed Nuke\n6yuBoJlbl pick Dust2 (HYPERSPIRIT CT)\nHYPERSPIRIT pick Cache (6yuBoJlbl CT)\n6yuBoJlbl removed Inferno\nHYPERSPIRIT removed Mirage\nAncient was left over');
});

for (const format of Object.keys(VETO_RULES)) {
  test(`${format}: turns, first team, completion and leftover`, () => {
    for (const first of [0, 1]) {
      let actions = [];
      for (const map of MAP_POOL.slice(0, 6)) {
        actions = appendVeto(actions, format, first, map, 'T');
      }
      assert.deepEqual(validateVeto(actions, format, first), ['Nuke']);
      assert.equal(vetoText(['A', 'B'], actions, format, first)
        .split('\n').length, 7);
      assert.equal(actions[0].team, first);
      assert.equal(actions[1].team, 1 - first);
      assert.throws(() =>
        appendVeto(actions, format, first, 'Nuke', 'CT'), /завершено/);
    }
  });
}

test('Veto rejects duplicates, bad formats, wrong turn and missing side', () => {
  const one = appendVeto([], 'BO3', 0, 'Anubis');
  assert.throws(() => appendVeto(one, 'BO3', 0, 'Anubis'), /уже выбрана/);
  const two = appendVeto(one, 'BO3', 0, 'Nuke');
  assert.throws(() => appendVeto(two, 'BO3', 0, 'Dust2'), /порядок/);
  assert.throws(() => validateVeto([], 'toString', 0), /Некорректное/);
  assert.throws(() => validateVeto([
    { map: 'Anubis', type: 'ban', team: 1 }
  ], 'BO3', 0), /порядок/);
  assert.throws(() => vetoText(['A', 'A'], []), /разные команды/);
});
