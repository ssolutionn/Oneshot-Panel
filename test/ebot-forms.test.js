import test from 'node:test';
import assert from 'node:assert/strict';

// Формы eBot: мок-fetch с фикстурами страниц админки. Секреты в тестах —
// фиктивные, как и в ebot-admin.test.js.

const BASE = 'http://ebot.test';
const USER = 'admin';
const PASSWORD = 'topsecret-pw';

const HTML = { 'content-type': 'text/html' };

const LOGIN_PAGE = `<html><body><form action="/admin.php/guard/login" method="post">
<input type="hidden" name="signin[_csrf_token]" value="tok123">
<input type="text" name="signin[username]">
<input type="password" name="signin[password]">
</form></body></html>`;

// Полная форма матча со всеми полями MatchsForm (порядок блока важен для
// привязки error_list к последнему полю).
const MATCH_CREATE_PAGE = `<html><body><form action="/admin.php/matchs/create" method="post">
<input type="hidden" name="matchs[id]" value="">
<input type="hidden" name="matchs[_csrf_token]" value="ctok456">
<div class="control-group"><label class="control-label">Season</label><div class="controls">
<select name="matchs[season_id]"><option value=""></option><option value="2">ESL Winter</option></select></div></div>
<div class="control-group"><label class="control-label">Team A</label><div class="controls">
<select name="matchs[team_a]"><option value=""></option><option value="5">Old Team</option></select>
<input type="text" name="matchs[team_a_name]" placeholder="Team Name">
<select name="matchs[team_a_flag]"><option value="EU">EU</option><option value="RU">RU</option></select></div></div>
<div class="control-group"><label class="control-label">Team B</label><div class="controls">
<select name="matchs[team_b]"><option value=""></option><option value="5">Old Team</option></select>
<input type="text" name="matchs[team_b_name]" placeholder="Team Name">
<select name="matchs[team_b_flag]"><option value="EU">EU</option><option value="RU">RU</option></select></div></div>
<div class="control-group"><label class="control-label">Max Rounds (MR)</label><div class="controls">
<select name="matchs[max_round]"><option value="15">MR15</option><option value="12">MR12</option></select></div></div>
<div class="control-group"><label class="control-label">Rules</label><div class="controls">
<input type="text" name="matchs[rules]" value="esl5on5"></div></div>
<div class="control-group"><label class="control-label">Password</label><div class="controls">
<input type="text" name="matchs[config_password]" value="wackel"></div></div>
<div class="control-group"><label class="control-label">Knife Round</label><div class="controls">
<input type="checkbox" name="matchs[config_knife_round]" checked="checked"></div></div>
<div class="control-group"><label class="control-label">OverTime</label><div class="controls">
<input type="checkbox" name="matchs[config_ot]"></div></div>
<div class="control-group"><label class="control-label">Play all Rounds</label><div class="controls">
<input type="checkbox" name="matchs[config_full_score]"></div></div>
<div class="control-group"><label class="control-label">Overtime: Startmoney</label><div class="controls">
<input type="text" name="matchs[overtime_startmoney]" value="10000"></div></div>
<div class="control-group"><label class="control-label">Overtime: Max Rounds</label><div class="controls">
<select name="matchs[overtime_max_round]"><option value="5">MR5</option><option value="3">MR3</option></select></div></div>
<div class="control-group"><label class="control-label">Streamer Ready</label><div class="controls">
<input type="checkbox" name="matchs[config_streamer]"></div></div>
<div class="control-group"><label class="control-label">BO1</label><div class="controls">
<select name="matchs[map_selection_mode]"><option value="normal">BO1</option><option value="bo3_modeb">BO3</option></select></div></div>
<div class="control-group"><label class="control-label">Map</label><div class="controls">
<select name="maps"><option value="de_dust2">de_dust2</option><option value="de_mirage">de_mirage</option></select></div></div>
<div class="control-group"><label class="control-label">Server</label><div class="controls">
<select name="server_id"><option value="3">SRV-1 - 10.0.0.1:27015</option></select></div></div>
<div class="control-group"><label class="control-label">First Side</label><div class="controls">
<select name="side"><option value="ct">ct</option><option value="t">t</option><option value="random">random</option></select></div></div>
</form></body></html>`;

// Форма команды: PlayersForm полей игроков не содержит — этого и ждём.
const TEAM_CREATE_PAGE = `<html><body><form action="/admin.php/teams/create" method="post">
<input type="hidden" name="teams[id]" value="">
<input type="hidden" name="teams[_csrf_token]" value="ttok789">
<div class="control-group"><label class="control-label">Name</label><div class="controls">
<input type="text" name="teams[name]" value=""></div></div>
<div class="control-group"><label class="control-label">Shorthandle</label><div class="controls">
<input type="text" name="teams[shorthandle]" value=""></div></div>
<div class="control-group"><label class="control-label">Flag</label><div class="controls">
<select name="teams[flag]"><option value=""></option><option value="EU">EU</option></select></div></div>
<div class="control-group"><label class="control-label">Link</label><div class="controls">
<input type="text" name="teams[link]" value=""></div></div>
<select name="seasons_list[]" multiple="multiple"><option value="2">ESL Winter</option></select>
</form></body></html>`;

const TEAM_EDIT_PAGE = TEAM_CREATE_PAGE
  .replace('name="teams[id]" value=""', 'name="teams[id]" value="17"')
  .replace('name="teams[_csrf_token]" value="ttok789"', 'name="teams[_csrf_token]" value="etok17"')
  .replace('name="teams[name]" value=""', 'name="teams[name]" value="Old Name"');

// Форма с ошибками symfony: 200, error_list после поля rules.
const MATCH_ERROR_PAGE = MATCH_CREATE_PAGE.replace(
  '<div class="control-group"><label class="control-label">Max Rounds (MR)</label>',
  '<ul class="error_list"><li>Required.</li></ul>' +
  '<div class="control-group"><label class="control-label">Max Rounds (MR)</label>'
);

// ---------- мок-fetch ----------

function mockFetch(routes) {
  const calls = [];
  // Маршруты одноразовые и идут по порядку: после 302 создания второй GET
  // /matchs/create должен отдать страницу с flash, а не ту же форму.
  const pending = [...routes];
  const fn = (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url: target, method, headers: init.headers, body: init.body });
    const path = new URL(target).pathname;
    const idx = pending.findIndex(r => r.method === method && path === r.path);
    if (idx >= 0) {
      const r = pending.splice(idx, 1)[0];
      return new Response(r.text ?? '', { status: r.status || 200, headers: r.headers || {} });
    }
    return new Response('', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

const loginRoutes = () => [
  { method: 'GET', path: '/admin.php/guard/login', text: LOGIN_PAGE, headers: HTML },
  { method: 'POST', path: '/admin.php/guard/login', status: 302,
    headers: { location: '/admin.php/', 'set-cookie': 'symfony=abc123; path=/' } },
];

// Успех матча: 302 на /matchs/create, там flash с ID. GET create в моке
// маршрутов один и тот же (с CSRF), второй GET после редиректа — flash.
function matchCreateRoutes({ flash = true, error = false } = {}) {
  return [
    ...loginRoutes(),
    { method: 'GET', path: '/admin.php/matchs/create',
      text: error ? MATCH_ERROR_PAGE : MATCH_CREATE_PAGE, headers: HTML },
    { method: 'POST', path: '/admin.php/matchs/create', status: 302,
      headers: { location: '/admin.php/matchs/create' } },
    ...(flash ? [{
      method: 'GET', path: '/admin.php/matchs/create',
      text: '<html><body>Match created with ID 48' + MATCH_CREATE_PAGE + '</body></html>',
      headers: HTML,
    }] : []),
  ];
}

const teamRoutes = ({ edit = false } = {}) => [
  ...loginRoutes(),
  { method: 'GET', path: '/admin.php/teams/create', text: TEAM_CREATE_PAGE, headers: HTML },
  ...(edit ? [{ method: 'GET', path: '/admin.php/teams/edit/17', text: TEAM_EDIT_PAGE, headers: HTML }] : []),
  { method: 'POST', path: '/admin.php/teams/create', status: 302,
    headers: { location: '/admin.php/teams/create' } },
  ...(edit ? [{ method: 'POST', path: '/admin.php/teams/edit/17', status: 302,
    headers: { location: '/admin.php/teams/index' } }] : []),
];

// Тело POST-запроса мока как объект «ключ → список значений».
function postBody(call) {
  const out = {};
  for (const pair of String(call.body || '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent(pair.slice(0, eq));
    const v = decodeURIComponent(pair.slice(eq + 1));
    (out[k] = out[k] || []).push(v);
  }
  return out;
}

// ---------- тесты ----------

test('matchFormFields отдаёт полный список полей формы матча', async () => {
  const { createEbotForms } = await import('../server/ebot-forms.js');
  const fetchMock = mockFetch(matchCreateRoutes({ flash: false }));
  const forms = createEbotForms({ baseUrl: BASE, user: USER, password: PASSWORD, fetchImpl: fetchMock });
  const fields = await forms.matchFormFields();
  const names = fields.map(f => f.name);
  // Полный набор MatchsForm + внеформенные maps/server_id/side.
  for (const expected of [
    'matchs[season_id]', 'matchs[team_a]', 'matchs[team_a_name]', 'matchs[team_a_flag]',
    'matchs[max_round]', 'matchs[rules]', 'matchs[config_password]',
    'matchs[config_knife_round]', 'matchs[config_ot]', 'matchs[overtime_startmoney]',
    'matchs[overtime_max_round]', 'matchs[config_streamer]', 'matchs[map_selection_mode]',
    'maps', 'server_id', 'side',
  ]) assert.ok(names.includes(expected), 'нет поля ' + expected);
  const rules = fields.find(f => f.name === 'matchs[rules]');
  assert.equal(rules.required, true);
  assert.equal(rules.type, 'text');
  assert.ok(/Rules/i.test(rules.label), 'label: ' + rules.label);
  const mapsField = fields.find(f => f.name === 'maps');
  assert.equal(mapsField.required, true);
  // Скрытые поля тоже в списке — они обязательны для POST.
  assert.ok(names.includes('matchs[_csrf_token]'));
});

test('createMatch: 302 → created, полный набор полей и id из flash', async () => {
  const { createEbotForms } = await import('../server/ebot-forms.js');
  const fetchMock = mockFetch(matchCreateRoutes());
  const forms = createEbotForms({ baseUrl: BASE, user: USER, password: PASSWORD, fetchImpl: fetchMock });
  const result = await forms.createMatch({
    teamA: 'Команда А', teamB: 'Команда Б', map: 'de_dust2', serverId: 3,
    seasonId: 2, overtime: true, overtimeStartmoney: 10000, overtimeMaxRound: 5,
    streamerReady: true, playAllRounds: true,
  });
  assert.equal(result.created, true);
  assert.equal(String(result.id), '48');
  const post = fetchMock.calls.find(c => c.method === 'POST' && c.url.includes('/matchs/create'));
  assert.ok(post, 'POST create не найден');
  const body = postBody(post);
  assert.equal(body['matchs[team_a_name]'][0], 'Команда А');
  assert.equal(body['matchs[team_b_name]'][0], 'Команда Б');
  assert.equal(body['matchs[season_id]'][0], '2');
  assert.equal(body['matchs[overtime_startmoney]'][0], '10000');
  assert.equal(body['matchs[overtime_max_round]'][0], '5');
  assert.equal(body['matchs[config_ot]'][0], '1');
  assert.equal(body['matchs[config_streamer]'][0], '1');
  assert.equal(body['matchs[config_full_score]'][0], '1');
  assert.equal(body['matchs[config_knife_round]'][0], '1');
  assert.equal(body['matchs[_csrf_token]'][0], 'ctok456');
  assert.equal(body['maps'][0], 'de_dust2');
  assert.equal(body['server_id'][0], '3');
  assert.equal(body['side'][0], 'random');
  assert.ok(String(post.body).includes('matchs%5Bteam_a_name%5D='), 'тело должно быть urlencoded');
});

test('createMatch: непроверенные чекбоксы не попадают в POST', async () => {
  const { createEbotForms } = await import('../server/ebot-forms.js');
  const fetchMock = mockFetch(matchCreateRoutes({ flash: false }));
  const forms = createEbotForms({ baseUrl: BASE, user: USER, password: PASSWORD, fetchImpl: fetchMock });
  await forms.createMatch({ teamA: 'A', teamB: 'B', map: 'de_mirage', serverId: 3, knifeRound: false });
  const post = fetchMock.calls.find(c => c.method === 'POST' && c.url.includes('/matchs/create'));
  const body = postBody(post);
  assert.ok(!('matchs[config_knife_round]' in body), 'ножи должны отсутствовать');
  assert.ok(!('matchs[config_ot]' in body), 'овертайм должен отсутствовать');
  assert.ok(!('matchs[config_streamer]' in body));
});

test('createMatch: 200 с error_list → русская ошибка с label поля', async () => {
  const { createEbotForms } = await import('../server/ebot-forms.js');
  // Ошибка error_list стоит после правила (rules) — ошибка привяжется к «Max Rounds (MR)»
  // только если блок идёт после поля; наша фикстура ставит error_list перед
  // следующим полем, привязка к последнему встреченному полю — rules.
  const fetchMock = mockFetch([
    ...loginRoutes(),
    { method: 'GET', path: '/admin.php/matchs/create', text: MATCH_CREATE_PAGE, headers: HTML },
    { method: 'POST', path: '/admin.php/matchs/create', text: MATCH_ERROR_PAGE, headers: HTML },
  ]);
  const forms = createEbotForms({ baseUrl: BASE, user: USER, password: PASSWORD, fetchImpl: fetchMock });
  await assert.rejects(forms.createMatch({ teamA: 'A', teamB: 'B', map: 'x', serverId: 3 }), (err) => {
    assert.ok(/eBot не создал матч/.test(err.message), err.message);
    assert.ok(/Required/.test(err.message), 'текст ошибки формы: ' + err.message);
    assert.ok(/«/.test(err.message), 'label поля в кавычках: ' + err.message);
    return true;
  });
});

test('createMatch: белое поле не из формы не уходит в POST', async () => {
  const { createEbotForms } = await import('../server/ebot-forms.js');
  const fetchMock = mockFetch(matchCreateRoutes({ flash: false }));
  const forms = createEbotForms({ baseUrl: BASE, user: USER, password: PASSWORD, fetchImpl: fetchMock });
  // players — поле НЕ формы матча: панель держит составы у себя.
  const result = await forms.createMatch({
    teamA: 'A', teamB: 'B', map: 'de_dust2', serverId: 3,
    players: [{ nick: 'hacker', steamid: 'STEAM_1:0:1' }],
    completelyUnknownField: 'x',
  });
  assert.equal(result.created, true);
  const post = fetchMock.calls.find(c => c.method === 'POST' && c.url.includes('/matchs/create'));
  const text = String(post.body);
  assert.ok(!text.includes('players'), 'игроки не должны уходить в форму матча');
  assert.ok(!text.includes('completelyUnknownField'), 'чужое поле не должно уходить');
  assert.ok(!text.includes('steamid'));
});

test('createTeam: POST только поля TeamsForm, players проверены, не отправлены', async () => {
  const { createEbotForms } = await import('../server/ebot-forms.js');
  const fetchMock = mockFetch(teamRoutes());
  const forms = createEbotForms({ baseUrl: BASE, user: USER, password: PASSWORD, fetchImpl: fetchMock });
  const result = await forms.createTeam({
    name: 'Новые',
    shorthandle: 'NEW',
    flag: 'EU',
    seasons: [2],
    players: [{ nick: 'player1', steamid: 'STEAM_1:0:123' }, { nick: 'player2' }],
  });
  assert.equal(result.created, true);
  assert.equal(result.players.length, 2);
  const post = fetchMock.calls.find(c => c.method === 'POST' && c.url.includes('/teams/create'));
  const body = postBody(post);
  assert.equal(body['teams[name]'][0], 'Новые');
  assert.equal(body['teams[shorthandle]'][0], 'NEW');
  assert.equal(body['teams[flag]'][0], 'EU');
  assert.equal(body['teams[_csrf_token]'][0], 'ttok789');
  assert.deepEqual(body['seasons_list[]'], ['2']);
  const text = String(post.body);
  assert.ok(!text.includes('player1'), 'игроки не должны уходить в TeamsForm');
  assert.ok(!text.includes('steamid'));
});

test('createTeam без названия — русская ошибка до сети', async () => {
  const { createEbotForms } = await import('../server/ebot-forms.js');
  let fetched = 0;
  const fetchMock = (url, init = {}) => { fetched++; return Promise.resolve(new Response('', { status: 404 })); };
  const forms = createEbotForms({ baseUrl: BASE, user: USER, password: PASSWORD, fetchImpl: fetchMock });
  await assert.rejects(forms.createTeam({}), /Название команды обязательно/);
  assert.equal(fetched, 0, 'запросов быть не должно');
});

test('createTeam с битым игроком — русская ошибка', async () => {
  const { createEbotForms } = await import('../server/ebot-forms.js');
  const fetchMock = mockFetch(teamRoutes());
  const forms = createEbotForms({ baseUrl: BASE, user: USER, password: PASSWORD, fetchImpl: fetchMock });
  await assert.rejects(forms.createTeam({ name: 'X', players: [{ steamid: '1' }] }), /ник/);
});

test('editTeam: сохраняет форму редактирования, незаданные поля — из формы', async () => {
  const { createEbotForms } = await import('../server/ebot-forms.js');
  const fetchMock = mockFetch(teamRoutes({ edit: true }));
  const forms = createEbotForms({ baseUrl: BASE, user: USER, password: PASSWORD, fetchImpl: fetchMock });
  const result = await forms.editTeam(17, { name: 'Переименованная', flag: 'EU' });
  assert.equal(result.edited, true);
  assert.equal(result.id, '17');
  const post = fetchMock.calls.find(c => c.method === 'POST' && c.url.includes('/teams/edit/17'));
  const body = postBody(post);
  assert.equal(body['teams[name]'][0], 'Переименованная');
  assert.equal(body['teams[_csrf_token]'][0], 'etok17');
  assert.equal(body['teams[id]'][0], '17');
});

test('форма команды 200 с ошибкой — русская ошибка', async () => {
  const { createEbotForms } = await import('../server/ebot-forms.js');
  const bad = TEAM_CREATE_PAGE.replace('</form>',
    '<ul class="error_list"><li>Invalid.</li></ul></form>');
  const fetchMock = mockFetch([
    ...loginRoutes(),
    { method: 'GET', path: '/admin.php/teams/create', text: TEAM_CREATE_PAGE, headers: HTML },
    { method: 'POST', path: '/admin.php/teams/create', text: bad, headers: HTML },
  ]);
  const forms = createEbotForms({ baseUrl: BASE, user: USER, password: PASSWORD, fetchImpl: fetchMock });
  await assert.rejects(forms.createTeam({ name: 'X' }), (err) => {
    assert.ok(/eBot не создал команду/.test(err.message), err.message);
    assert.ok(/Invalid/.test(err.message));
    return true;
  });
});
