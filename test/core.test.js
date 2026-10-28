import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  decodeGviz, parseTeams, parseSchedule, scheduleDay, defaultLineup, observerText,
  selectedPlayers, validateMatch, playerText, viewUrl, pushUrl, directorUrl,
  safeFilename, buildObs, cardUrl, personKey, DEFAULT_CARD_BASE, MAP_POOL, VETO_RULES,
  validateVeto, appendVeto, vetoText, photoMatches, playerPhoto, teamLogo, cameraViewUrl
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

test('Skip duplicate IDs and missing rooms (reported), reject an empty roster', () => {
  const rows = makeRows();
  const all = parseTeams(makeRows()).flatMap(t => t.players).length;
  rows[7][0] = rows[0][0];
  const dup = parseTeams(rows);
  assert.equal(dup.flatMap(t => t.players).length, all - 1, 'other rows still load');
  assert.match(dup.skipped.join(), /повтор ID/);
  const missing = makeRows();
  missing[0][5] = '';
  const noRoom = parseTeams(missing);
  assert.match(noRoom.skipped.join(), /не указана комната/);
  assert.equal(noRoom.flatMap(t => t.players).length, all - 1);
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
  // A row inserted above keeps the key, so the veto survives a refresh.
  const row = ['', '16:00', 'A', 'B', 'B'];
  const [before] = parseSchedule([row]);
  const after = parseSchedule([['Матчи 14 октября'], ['', '13:00', 'C', 'D', 'A'], row]);
  assert.equal(after.find(m => m.team1 === 'A').key, before.key);
  const twice = parseSchedule([row, row]);
  assert.notEqual(twice[0].key, twice[1].key);
});

test('gviz column labels come back as the first row', () => {
  const response = labels => 'google.visualization.Query.setResponse(' + JSON.stringify({
    status: 'ok', table: {
      cols: labels.map(label => ({ label })),
      rows: [{ c: [{ v: 'Opening Match A2' }, { v: [13, 0, 0, 0], f: '13:00' }] }]
    }
  }) + ');';
  assert.deepEqual(decodeGviz(response(['Stage', 'MSK (GMT +3)'])),
    [['Stage', 'MSK (GMT +3)'], ['Opening Match A2', '13:00']]);
  assert.deepEqual(decodeGviz(response(['', ''])), [['Opening Match A2', '13:00']]);
});

test('Organizer schedule: dated rows, roster names, stages from both sheets', () => {
  const header = ['Match #', 'Stage', 'Date', 'GMT', 'CET (GMT+1)',
    'CEST (GMT +2)', 'MSK (GMT +3)', 'Stream', '', 'Team 1', 'Score', '', '', 'Team 2'];
  const row = (n, stage, date, msk, t1, t2) =>
    [n, stage, date, '', '', '', msk, 'A', '', t1, '', 'vs', '', t2];
  const schedule = parseSchedule([
    header,
    row('1', 'Opening Match A1', 'October 14', '13:00', 'Nuclear TigeRES', 'LPH'),
    row('9', 'Opening Match D2', 'October 15', '22:00', 'PRIVATE (ex-RUBY)', 'Honvéd'),
    row('10', 'Losers Match A3', 'October 16', '13:00', '', ''),
    ['Match #', 'Stage', 'Date', 'CET', 'MSK', 'Stream', '', 'Team 1', '', '', '', 'Team 2'],
    ['1', 'Quarterfinal 1', 'October 29', '9:00', '10:00', 'A', '', 'Omega', '', '', '', 'LPH'],
    ['8', 'Grand Final', 'October 31', '15:00', '16:00', 'A', '', 'Omega', '', '', '', 'LPH']
  ]);
  assert.deepEqual(schedule.map(m => [m.date, m.time, m.team1, m.team2, m.stage]), [
    ['14.10', '13:00', 'Nuclear TigeRES', 'LPH', 'Группа A'],
    ['15.10', '22:00', 'PRIVATE', 'Honvéd', 'Группа D'],
    ['29.10', '10:00', 'Omega', 'LPH', 'Четвертьфинал 1'],
    ['31.10', '16:00', 'Omega', 'LPH', 'Гранд-финал']
  ]);
  assert.equal(schedule[1].group, 'D');
  assert.equal(new Set(schedule.map(m => m.key)).size, 4);
  assert.equal(scheduleDay([header]), '');
});

test('Schedule day comes from the sheet title, not from match rows', () => {
  assert.equal(scheduleDay([[''], ['Матчи 14 октября 2026'], ['№', 'Начало МСК']]), '14.10');
  assert.equal(scheduleDay([['Матчи 3 мая'], ['1', '13:00', 'A', 'B']]), '03.05');
  assert.equal(scheduleDay([['Матчи 15.10']]), '15.10');
  assert.equal(scheduleDay([['Расписание из таблицы организатора, столбец MSK (GMT +3).']]), '');
  assert.equal(scheduleDay([['', '13:00', 'Team 4 марта', 'B']]), '');
  assert.equal(scheduleDay([]), '');
  assert.equal(scheduleDay([['Расписание: 1 матч в день']]), '');
});

// Stream IDs in these rows have a dash: VDO.Ninja publishes them with "_" (vdoId).
test('Player output has bold nickname and separate PUSH URL', () => {
  const [a, , ka] = fixture();
  const text = playerText(a, selectedPlayers(a, ka));
  assert.ok(text.startsWith('## HYPERSPIRIT\n'));
  assert.ok(text.includes('**Ciocardau** https://vdo.ninja/?room=hyperspirit&broadcast&do&push=stream0_0'));
  assert.equal((text.match(/https:\/\/vdo\.ninja\//g) || []).length, 5);
  assert.ok(!text.includes('[**'));
  assert.ok(!text.includes('director='));
});

test('Room password from column L goes into every link of that team only', () => {
  const rows = makeRows().map(r => [...r, '', '', r[1] === 'HYPERSPIRIT' ? 'k3y 7&x' : '']);
  const [a, b] = parseTeams(rows);
  assert.equal(a.password, 'k3y 7&x');
  const [p] = selectedPlayers(a, defaultLineup(a));
  assert.equal(pushUrl(p), 'https://vdo.ninja/?room=hyperspirit&password=k3y%207%26x&broadcast&do&push=stream0_0');
  assert.equal(viewUrl(p), 'https://vdo.ninja/?view=stream0_0&solo=1&room=hyperspirit&password=k3y%207%26x&codec=h264&cleanoutput&transparent');
  assert.equal(directorUrl(a), 'https://vdo.ninja/?director=hyperspirit&password=k3y%207%26x');
  assert.ok(playerText(a, selectedPlayers(a, defaultLineup(a))).includes('**Ciocardau** https://vdo.ninja/?room=hyperspirit&password=k3y%207%26x&broadcast&do&push=stream0_0'));
  // A team without a password keeps the old links.
  const [q] = selectedPlayers(b, defaultLineup(b));
  assert.equal(pushUrl(q), 'https://vdo.ninja/?room=team-b&broadcast&do&push=stream1_0');
  assert.equal(directorUrl(b), 'https://vdo.ninja/?director=team-b');
});

test('Observer text is the slot order only, without links', () => {
  const [a, b, ka, kb] = fixture();
  const text = observerText(a, b, selectedPlayers(a, ka), selectedPlayers(b, kb));
  assert.ok(!/https?:|vdo\.ninja/.test(text));
  const lines = text.split('\n').filter(l => /^\d+\. /.test(l));
  assert.equal(lines.length, 10);
  assert.equal(lines[0], '1. HYPERSPIRIT — Ciocardau');
  assert.equal(lines[5], '6. 6yuBoJlbl — Player1-0');
  assert.ok(text.startsWith('HYPERSPIRIT — 6yuBoJlbl\n\n'));
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
    '18-00_Групповой-этап_6yuBoJlbl_vs_HYPERSPIRIT.json'
  );
  assert.equal(
    safeFilename('Nuclear  TigeRES', 'LPH', '13:00', 'Группа A'),
    '13-00_Группа-A_Nuclear-TigeRES_vs_LPH.json'
  );
  const name = safeFilename('../Команда:А', 'B/C', '00:05', 'Финал*');
  assert.ok(!/[<>:"/\\|?*\s]/.test(name));
  assert.equal(name, '00-05_Финал_Команда-А_vs_B-C.json');
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
    const item = scene.settings.items.find(it => it.name.startsWith('CAM '));
    const browser = byId.get(item.source_uuid);
    refs.add(item.source_uuid);
    assert.equal(browser.settings.url, cameraViewUrl(players[i]));
    assert.equal(browser.settings.width, 1320);
    assert.equal(browser.settings.height, 1008);
    assert.equal(item.rot, 0);
    assert.deepEqual(item.pos, { x: 300, y: 36 });
    assert.deepEqual(item.bounds, { x: 1320, y: 1008 });
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

test('buildObs: camera URLs follow vdoOptions — LAN tuning on, defaults off', () => {
  const args = fixture();
  const urls = (options) => buildObs(template, ...args, uuidFn(), options)
    .sources.filter(s => s.name.startsWith('CAM '))
    .map(s => s.settings.url);
  assert.equal(urls({}).length, 10);
  // LAN mode: codec, bitrate, fps and lowlatency go into every camera URL.
  const lan = urls({ vdoOptions: { enabled: true, codec: 'vp9', bitrate: 6000, fps: 60, lowLatency: false } });
  for (const url of lan) {
    assert.match(url, /&codec=vp9&/);
    assert.match(url, /&bitrate=6000&fps=60(?:&|$)/);
    assert.ok(!url.includes('lowlatency'), 'lowLatency: false must drop the flag');
    assert.match(url, /&cleanoutput&transparent&cover/);
  }
  // Online mode: enabled flag missing/false — no bitrate/fps/lowlatency in the URL.
  for (const options of [{}, { vdoOptions: {} }, { vdoOptions: { enabled: false, codec: 'vp9', bitrate: 6000, fps: 60 } }]) {
    for (const url of urls(options)) {
      // codec still follows the option even when disabled (same as obs.js);
      // the tuning parameters are what the enabled flag gates.
      for (const tuned of ['bitrate=', 'fps=', 'lowlatency']) {
        assert.ok(!url.includes(tuned), `default export must not carry ${tuned}`);
      }
      assert.match(url, /&cleanoutput&transparent&cover/);
    }
  }
  // Without any vdoOptions the URLs fall back to the h264 default.
  for (const url of urls({})) assert.match(url, /&codec=h264(?:&|$)/);
});

test('OBS omits all player cards by default and when disabled', () => {
  const args = fixture(), original = JSON.stringify(template);
  for (const options of [undefined, { includeCards: false }]) {
    const result = buildObs(template, ...args, uuidFn(), options);
    assert.equal(JSON.stringify(template), original);
    assert.equal(result.sources.filter(s => s.name.startsWith('CAM ')).length, 10);
    assert.equal(result.sources.filter(s => s.name.startsWith('CARD ')).length, 0);
    assert.ok(!result.sources.some(s => s.settings?.url?.includes('/card.html')));
    const byId = new Map(result.sources.map(s => [s.uuid, s]));
    for (let i = 1; i <= 10; i++) {
      const scene = result.sources.find(s => s.name === `Игрок ${i}`);
      const cameras = scene.settings.items.filter(it => it.name.startsWith('CAM '));
      assert.equal(cameras.length, 1);
      assert.ok(!scene.settings.items.some(it => it.name.startsWith('CARD ')));
      assert.equal(byId.get(cameras[0].source_uuid).settings.width, 1320);
      assert.equal(byId.get(cameras[0].source_uuid).settings.height, 1008);
      for (const item of scene.settings.items) assert.ok(byId.has(item.source_uuid));
    }
    assert.ok(result.sources.some(s => s.name === 'Матрица'));
  }
});

test('Player card sits under each camera and opens the card page', () => {
  const args = fixture();
  const players = [
    ...selectedPlayers(args[0], args[2]).map(p => ({ ...p, team: args[0].name })),
    ...selectedPlayers(args[1], args[3]).map(p => ({ ...p, team: args[1].name }))
  ];
  const result = buildObs(template, ...args, uuidFn(),
    { cardBase: 'https://panel.example', includeCards: true });
  const byId = new Map(result.sources.map(s => [s.uuid, s]));
  for (let i = 0; i < 10; i++) {
    const slot = String(i + 1).padStart(2, '0');
    const scene = result.sources.find(s => s.name === `Игрок ${i + 1}`);
    const names = scene.settings.items.map(it => it.name);
    const card = names.indexOf(`CARD ${slot} | ${players[i].team} | ${players[i].nick}`);
    const camera = names.indexOf(`CAM ${slot} | ${players[i].team} | ${players[i].nick}`);
    // OBS lists scene items bottom to top: the card is drawn right under the camera.
    assert.equal(card, camera - 1);
    const item = scene.settings.items[card];
    const source = byId.get(item.source_uuid);
    assert.equal(source.id, 'browser_source');
    assert.equal(source.name, item.name);
    assert.equal(item.visible, true);
    // Full HD over the whole scene: with no webcam nothing of the scene shows past it.
    assert.deepEqual(item.bounds, { x: 1920, y: 1080 });
    assert.deepEqual(item.pos, { x: 0, y: 0 });
    assert.equal(new Set(scene.settings.items.map(it => it.id)).size, names.length);
    assert.deepEqual(source.settings, {
      url: cardUrl(players[i], 'https://panel.example'), width: 1920, height: 1080
    });
    const url = new URL(source.settings.url);
    assert.equal(url.origin + url.pathname, 'https://panel.example/card.html');
    assert.equal(url.searchParams.get('team'), players[i].team);
    assert.equal(url.searchParams.get('nick'), players[i].nick);
    assert.ok(new URL(byId.get(scene.settings.items[camera].source_uuid).settings.url)
      .searchParams.has('transparent'));
  }
  const fallback = buildObs(template, ...args, uuidFn(), { includeCards: true });
  assert.ok(fallback.sources.some(s =>
    s.settings?.url?.startsWith(`${DEFAULT_CARD_BASE}/card.html?`)));
  assert.equal(personKey(' Nuclear  TigeRES '), personKey('nuclear-tigeres'));
  assert.equal(personKey('zs0lt1-'), 'zs0lt1');
  assert.notEqual(personKey('es0r7'), personKey('esor'));
  assert.equal(new URL(cardUrl({ team: 'A&B', nick: 'x#1' })).searchParams.get('nick'), 'x#1');
});

test('Player photo list points at HLTV bodyshots and files that exist', () => {
  const dir = new URL('../assets/players/', import.meta.url);
  const { players } = JSON.parse(fs.readFileSync(new URL('players.json', dir), 'utf8'));
  assert.ok(players.length > 0);
  const seen = new Set();
  for (const p of players) {
    assert.ok(p.team && p.nick, JSON.stringify(p));
    const key = `${personKey(p.team)}/${personKey(p.nick)}`;
    assert.ok(!seen.has(key), key);
    seen.add(key);
    assert.match(p.hltv, /^https:\/\/www\.hltv\.org\/(player|coach)\/\d+\//);
    if (p.photo) {
      assert.match(p.photo, /^https:\/\/img-cdn\.hltv\.org\/playerbodyshot\//);
    }
    if (p.file) {
      assert.ok(p.photo, `${p.nick}: a file without a photo URL`);
      assert.match(p.file, /^[\w.-]+\.(png|jpe?g|webp)$/);
      assert.ok(fs.existsSync(new URL(p.file, dir)), p.file);
    }
  }
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

test('Card photo and logo: same identity rules as card.html', () => {
  const players = [
    { team: 'Nuclear TigeRES', nick: 'flouzer', file: 'flouzer-1.png' },
    { team: 'Honvéd', nick: 'es0r7', aliases: ['esor'], file: 'esor-2.jpg' },
    { team: 'Lavked', nick: 'senka', file: null },
    { team: 'Other', nick: 'senka', file: 'senka-3.png' },
    { team: 'Twins', nick: 'dup', file: 'dup-a.png' },
    { team: 'Twins', nick: 'DUP', file: 'dup-b.png' },
    { team: 'Bad', nick: 'up', file: '../core.js' },
    { team: 'Bad', nick: 'svg', file: 'x.svg' },
    { team: 'Bad', nick: 'dir', file: 'a/b.png' },
    null, 'junk'
  ];
  // Case, spaces and the HLTV alias do not matter.
  assert.equal(playerPhoto(players, 'nuclear tigeres', 'FLOUZER'), 'flouzer-1.png');
  assert.equal(playerPhoto(players, 'Honvéd', 'esor'), 'esor-2.jpg');
  // A namesake in another team never stands in for a missing photo.
  assert.equal(playerPhoto(players, 'Lavked', 'senka'), '');
  assert.equal(playerPhoto(players, 'Lavked', 'flouzer'), '');
  // Without a team any single match counts; two matches are ambiguous.
  assert.equal(playerPhoto(players, '', 'flouzer'), 'flouzer-1.png');
  assert.equal(playerPhoto(players, '', 'senka'), '');
  assert.equal(photoMatches(players, 'Twins', 'dup').length, 2);
  assert.equal(playerPhoto(players, 'Twins', 'dup'), '');
  // File names never leave assets/players.
  for (const nick of ['up', 'svg', 'dir']) assert.equal(playerPhoto(players, 'Bad', nick), '');
  assert.equal(playerPhoto(players, 'Nuclear TigeRES', ''), '');
  assert.equal(playerPhoto(null, 'A', 'b'), '');
  assert.deepEqual(photoMatches({ players }, 'A', 'b'), []);

  const logos = { 'Nuclear TigeRES': 'nuclear.png', Evil: '../evil.png', Svg: 'x.svg' };
  assert.equal(teamLogo(logos, 'nuclear-tigeres'), 'nuclear.png');
  assert.equal(teamLogo(logos, 'Evil'), '');
  assert.equal(teamLogo(logos, 'Svg'), '');
  assert.equal(teamLogo(logos, 'Nobody'), '');
  assert.equal(teamLogo(null, 'Nuclear TigeRES'), '');
});

test('Invalid template fails rather than exporting broken JSON', () => {
  assert.throws(() => buildObs({}, ...fixture()), /шаблон/);
  const broken = structuredClone(template);
  broken.sources = broken.sources.filter(s => s.name !== 'Игрок 6');
  assert.throws(() => buildObs(broken, ...fixture()), /игрока 6/);
  const noMatrix = structuredClone(template);
  noMatrix.sources = noMatrix.sources.filter(s => s.name !== 'Матрица');
  assert.throws(() => buildObs(noMatrix, ...fixture()), /Матрица/);
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

test('newStreamId: nick letters plus a random tail VDO.Ninja keeps as is', async () => {
  const { newStreamId } = await import('../core.js');
  const fixed = n => new Uint8Array(n).fill(1);
  assert.equal(newStreamId('zs0lt1-', fixed), 'zs0lt1_bbbbbb');
  assert.equal(newStreamId('Q-Q', fixed), 'QQ_bbbbbb');
  assert.equal(newStreamId('Honvéd ñ', fixed), 'Honvedn_bbbbbb');
  assert.equal(newStreamId('', fixed), 'cam_bbbbbb');
  assert.match(newStreamId('synyx'), /^synyx_[a-z2-9]{6}$/);
  assert.notEqual(newStreamId('synyx'), newStreamId('synyx'));
});

test('vdoId: the stream ID as VDO.Ninja keeps it, links and status use it', async () => {
  const { vdoId, parseTeams, pushUrl, viewUrl, applyStreamIds } = await import('../core.js');
  assert.equal(vdoId('Q-Q'), 'Q_Q');
  assert.equal(vdoId(' d1maje '), 'd1maje');
  assert.equal(vdoId('a.b  c--d'), 'a_b_c_d');
  assert.equal(vdoId('x'.repeat(80)).length, 64);
  const teams = parseTeams([['1', 'HYPERSPIRIT', '2', 'Q-Q', 'Q-Q', 'hyperspirit', '', '', 'Основной']]);
  const [player] = teams[0].players;
  assert.equal(player.id, 'Q_Q');
  assert.match(pushUrl(player), /&push=Q_Q$/);
  assert.match(viewUrl(player), /\?view=Q_Q&/);
  // ✎: the player joined with an old link (q_q): OBS and the status follow it.
  const manual = applyStreamIds(teams, { [player.key]: { id: 'q_q', was: 'Q_Q', manual: true } });
  assert.equal(manual.teams[0].players[0].id, 'q_q');
  assert.equal(manual.teams[0].players[0].manualId, true);
  assert.equal(manual.teams[0].players[0].sheetId, 'Q_Q');
  assert.deepEqual(manual.saved, { [player.key]: { id: 'q_q', was: 'Q_Q', manual: true } });
});

test('vdoPushId: PUSH from a URL or a bare ID, query strings rejected', async () => {
  const { vdoPushId } = await import('../core.js');
  // A full link where push is not the last parameter.
  assert.equal(vdoPushId('https://vdo.ninja/?push=Q-Q&broadcast&do'), 'Q_Q');
  assert.equal(vdoPushId('https://vdo.ninja/?room=room&password=pw&push=d1maje&novideo'), 'd1maje');
  // A bare PUSH ID pasted as-is.
  assert.equal(vdoPushId('Q-Q'), 'Q_Q');
  assert.equal(vdoPushId(' synyx '), 'synyx');
  // A URL without push has no ID to take.
  assert.equal(vdoPushId('https://vdo.ninja/?room=room&view=Q_Q'), '');
  // A query string alone is not a URL: no guessing an ID out of it.
  assert.equal(vdoPushId('?push=Q_Q'), '');
  assert.equal(vdoPushId('push=Q_Q&do'), '');
  assert.equal(vdoPushId('https://vdo.ninja/?push='), '');
});

test('applyStreamIds: a new ID holds until the sheet changes, then the sheet wins', async () => {
  const { applyStreamIds, viewUrl, pushUrl } = await import('../core.js');
  const teams = [{ name: 'UPGRADE', room: 'upgrade', players: [
    { key: 'UPGRADE|1', nick: 'synyx', id: 'synyx', room: 'upgrade' },
    { key: 'UPGRADE|2', nick: 'SquEzxc', id: 'SquEzxc', room: 'upgrade' }
  ] }];
  const saved = { 'UPGRADE|1': { id: 'synyx_k7q2ab', was: 'synyx' }, 'Gone|1': { id: 'x_aaaaaa', was: 'x' } };
  const { teams: out, saved: kept } = applyStreamIds(teams, saved);
  assert.equal(out[0].players[0].id, 'synyx_k7q2ab');
  assert.equal(out[0].players[0].sheetId, 'synyx');
  assert.equal(out[0].players[1].id, 'SquEzxc');
  assert.deepEqual(kept, { 'UPGRADE|1': { id: 'synyx_k7q2ab', was: 'synyx' } });
  assert.equal(teams[0].players[0].id, 'synyx', 'input untouched');
  assert.match(pushUrl(out[0].players[0]), /&push=synyx_k7q2ab$/);
  assert.match(viewUrl(out[0].players[0]), /\?view=synyx_k7q2ab&/);
  // Someone wrote the new ID into the sheet: entry no longer needed.
  const written = [{ ...teams[0], players: [{ ...teams[0].players[0], id: 'synyx_k7q2ab' }] }];
  assert.deepEqual(applyStreamIds(written, kept).saved, {});
  assert.equal(applyStreamIds(written, kept).teams[0].players[0].sheetId, undefined);
  // Junk in storage is ignored.
  assert.deepEqual(applyStreamIds(teams, { 'UPGRADE|1': { id: '<x>', was: 'synyx' } }).saved, {});
  assert.deepEqual(applyStreamIds(teams, null).saved, {});
});

test('parseSchedule: group stage and playoffs tabs read together', async () => {
  const { parseSchedule } = await import('../core.js');
  const group = [
    ['Match #', 'Stage', 'Date', 'GMT', 'CET', 'CEST', 'MSK (GMT +3)', 'Stream', '', 'Team 1', 'Score', '', '', 'Team 2'],
    ['12', 'Wiiners Match C4', 'October 16', '16:00', '17:00', '18:00', '19:00', 'A', '', 'PRIVATE (ex-RUBY)', '', 'vs', '', 'UPGRADE']
  ];
  const playoffs = [
    ['Match #', 'Stage', 'Date', 'CET', 'MSK', 'Stream', '', 'Team 1', 'Score', '', '', 'Team 2'],
    ['1', 'Quarterfinal 1', 'October 29', '9:00', '10:00', 'A', '', 'Lavked', '', '', '', 'Honvéd'],
    ['2', 'Quarterfinal 2', 'October 29', '11:00', '12:00', 'A']
  ];
  const matches = parseSchedule([...group, ...playoffs]);
  assert.deepEqual(matches.map(m => [m.date, m.time, m.team1, m.team2, m.stage]), [
    ['16.10', '19:00', 'PRIVATE', 'UPGRADE', 'Группа C'],
    ['29.10', '10:00', 'Lavked', 'Honvéd', 'Четвертьфинал 1']
  ]);
});

test('playoffs sheet as published: Team 2 past column N, a renamed team found under its roster name', async () => {
  const { parseSchedule, rosterMatch } = await import('../core.js');
  // «Schedule (Playoffs)» has an extra ALA column, so Team 2 sits in column O.
  const rows = [
    ['Match #', 'Stage', 'Date', 'GMT', 'CET (GMT+1)', 'CEST (GMT +2)', 'MSK (GMT +3)', 'ALA (GMT+5)', 'Stream', '', 'Team 1', 'Score', '', '', 'Team 2'],
    ['2', 'Quarterfinal 2', 'October 29', '10:00', '11:00', '12:00', '13:00', '15:00', 'A', '', 'PCIFIC', '2', '', '0', 'Aces (ex-Black Phoenix)'],
    ['3', 'Quarterfinal 3', 'October 29', '13:00', '14:00', '15:00', '16:00', '18:00', 'A', '', 'Fire Flux', '', '', '', 'PRIVATE (ex-RUBY)'],
    ['5', 'Semifinal 1', 'October 30', '12:00', '13:00', '14:00', '15:00', '17:00', 'A']
  ];
  const names = ['PCIFIC', 'Black Phoenix', 'Fire Flux', 'PRIVATE'];
  const matches = parseSchedule(rows).map(m => rosterMatch(m, names));
  assert.deepEqual(matches.map(m => [m.date, m.time, m.team1, m.team2, m.stage]), [
    ['29.10', '13:00', 'PCIFIC', 'Black Phoenix', 'Четвертьфинал 2'],
    ['29.10', '16:00', 'Fire Flux', 'PRIVATE', 'Четвертьфинал 3']
  ]);
  // Neither name in the rosters: the match is not offered.
  assert.equal(rosterMatch(parseSchedule(rows)[0], ['PCIFIC']), null);
});

test('teamHltv: the team page from hltv.json, names as in teamLogo, only hltv.org team pages', async () => {
  const { teamHltv } = await import('../core.js');
  const pages = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../assets/teams/hltv.json', import.meta.url), 'utf8'));
  assert.equal(teamHltv(pages, 'Honved'), 'https://www.hltv.org/team/11110/honvd');
  assert.equal(teamHltv(pages, 'hyperspirit'), 'https://www.hltv.org/team/13012/hyperspirit');
  assert.equal(teamHltv(pages, 'Unknown Five'), '');
  assert.equal(teamHltv({ Evil: 'javascript:alert(1)' }, 'Evil'), '');
  assert.equal(teamHltv({ Evil: 'https://hltv.org.evil.com/team/1/x' }, 'Evil'), '');
  assert.equal(teamHltv(null, 'UPGRADE'), '');
  for (const url of Object.values(pages)) assert.match(url, /^https:\/\/www\.hltv\.org\/team\/\d+\/[a-z0-9-]+$/);
});
