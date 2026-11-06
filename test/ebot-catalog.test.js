import test from 'node:test';
import assert from 'node:assert/strict';

// Каталог eBot поверх админ-клиента. Транспорт подменяем фейком
// admin.page (контракт из server/ebot-admin.js): сетевой слой уже
// покрыт test/ebot-admin.test.js, здесь — только парсеры и склейка
// страниц.

let createEbotCatalog = null;
let parseServersPage = null;
let parseSeasonsPage = null;
let parseTeamsPage = null;
try {
  ({ createEbotCatalog, parseServersPage, parseSeasonsPage, parseTeamsPage } =
    await import('../server/ebot-catalog.js'));
} catch { /* модуль ещё не создан — тесты пропускаются */ }
const skip = createEbotCatalog ? false : 'server/ebot-catalog.js ещё не создан';

// Мок админ-клиента: routes = [{ path, status, text }], все GET.
function mockAdmin(routes) {
  const calls = [];
  const admin = {
    async page(pathOrUrl) {
      const path = new URL(String(pathOrUrl), 'http://ebot.test').pathname;
      calls.push(path);
      const r = routes.find(r => r.path === path);
      if (!r) return new Response('', { status: 404 });
      return new Response(r.text ?? '', { status: r.status || 200, headers: { 'content-type': 'text/html' } });
    },
  };
  admin.calls = calls;
  return admin;
}

// ---------- фикстуры (макет шаблонов ebot backend) ----------

const SERVERS_PAGE = `<html><body><h3>Server Management</h3><hr/>
<table class="table table-striped">
<thead><tr>
<th>#ID</th><th>IP Adress</th><th>Name</th><th>used?</th><th>Action</th>
</tr></thead>
<tbody>
<tr>
<td width="30">3</td><td width="200">10.0.0.1:27015</td><td>SRV &amp; #1</td>
<td width="100"><img src="/images/icons/flag_green.png"/> in use</td>
<td width="100"></td>
</tr>
<tr>
<td width="30">4</td><td width="200">37.230.228.105:27020</td><td>LAN Main</td>
<td width="100"><img src="/images/icons/flag_red.png"/> not used</td>
<td width="100"><a href="/admin.php/servers/delete/4"><button class="btn btn-danger">Delete</button></a></td>
</tr>
</tbody>
</table></body></html>`;

const SEASONS_PAGE = `<html><body><h3>Seasons Management</h3><hr/>
<table class="table table-striped">
<thead><tr>
<th>#ID</th><th>Name</th><th>Start</th><th>End</th><th>Link</th><th></th>
</tr></thead>
<tbody>
<tr>
<td width="30">1</td><td width="250">CyberClash 2026 &amp; Winter</td>
<td width="50">01.11.2026</td><td width="50">30.11.2026</td>
<td><a href="https://cyberclash.example/season" target="_blank">https://cyberclash.example/season</a></td>
<td><img src="/images/icons/flag_green.png"/></td>
<td width="230"><a href="/admin.php/seasons/deactivate/1"><button class="btn">De/Activate</button></a></td>
</tr>
<tr>
<td width="30">2</td><td width="250">Old Season</td>
<td width="50">01.01.2026</td><td width="50">30.06.2026</td>
<td></td>
<td><img src="/images/icons/flag_red.png"/></td>
<td width="230"><a href="/admin.php/seasons/deactivate/2"><button class="btn">De/Activate</button></a></td>
</tr>
</tbody>
</table></body></html>`;

const teamsPageHtml = (ids) => `<html><body><h3>Team Managment</h3><hr/>
<table class="table table-striped">
<thead><tr>
<th>#ID</th><th></th><th>Name</th><th>Shorthandle</th><th>Team Link</th>
</tr></thead>
<tbody>
${ids.map(([id, name, cc, tag, link]) => `<tr>
<td width="30" style="vertical-align:middle;">${id}</td>
<td width="20" style="vertical-align:middle;"><i class="flag flag-${cc}"></i></td>
<td width="250" style="vertical-align:middle;">${name}</td>
<td width="200" style="vertical-align:middle;">${tag}</td>
<td width="200" style="vertical-align:middle;">${link ? `<a href="${link}" target="_blank">Link</a>` : ''}</td>
</tr>`).join('\n')}
</tbody>
</table></body></html>`;

const TEAMS_PAGE_1 = teamsPageHtml([
  [5, 'Alpha &amp; Five', 'ru', 'A5', ''],
  [6, 'Bravo', 'kz', 'BRV', 'https://bravo.example/team'],
]);
const TEAMS_PAGE_2 = teamsPageHtml([[7, 'Charlie', 'de', 'CH', '']]);
const TEAMS_EMPTY = teamsPageHtml([]);

const makeCatalog = (routes) => createEbotCatalog({ admin: mockAdmin(routes) });

// ---------- servers ----------

test('servers(): парсинг таблицы по заголовкам, ip/port/used', { skip }, async () => {
  const catalog = makeCatalog([{ path: '/admin.php/servers', text: SERVERS_PAGE }]);
  const servers = await catalog.servers();
  assert.deepEqual(servers, [
    { id: 3, hostname: 'SRV & #1', ip: '10.0.0.1', port: '27015', used: true },
    { id: 4, hostname: 'LAN Main', ip: '37.230.228.105', port: '27020', used: false },
  ]);
  // Данные текстом, без HTML и без двойного декодирования сущностей.
  assert.ok(!JSON.stringify(servers).includes('&amp;'));
  assert.ok(!JSON.stringify(servers).includes('<'));
});

test('servers(): колонки в другом порядке тоже разбираются', { skip }, () => {
  const html = `<table><thead><tr><th>Name</th><th>IP Adress</th><th>used?</th><th>#ID</th></tr></thead>
<tbody><tr><td>Swap</td><td>1.2.3.4:27015</td><td>not used</td><td>9</td></tr></tbody></table>`;
  const servers = parseServersPage(html);
  assert.deepEqual(servers, [{ id: 9, hostname: 'Swap', ip: '1.2.3.4', port: '27015', used: false }]);
});

test('servers(): пустая страница без таблицы серверов → []', { skip }, async () => {
  const catalog = makeCatalog([{ path: '/admin.php/servers', text: '<html><h3>Server Management</h3><hr/></html>' }]);
  assert.deepEqual(await catalog.servers(), []);
  // Пустая строка-заглушка «No Servers registered.» не становится сервером.
  const placeholder = `<table><thead><tr><th>#ID</th><th>IP Adress</th><th>Name</th><th>used?</th><th>Action</th></tr></thead>
<tbody><tr><td colspan="5">No Servers registered.</td></tr></tbody></table>`;
  assert.deepEqual(parseServersPage(placeholder), []);
});

test('servers(): не-200 → русская ошибка с кодом', { skip }, async () => {
  const catalog = makeCatalog([{ path: '/admin.php/servers', status: 500, text: 'boom' }]);
  await assert.rejects(catalog.servers(), (err) => {
    assert.match(err.message, /сервер/i);
    assert.ok(err.message.includes('500'), 'код в сообщении: ' + err.message);
    return true;
  });
});

// ---------- seasons ----------

test('seasons(): id/name/active/link, текст без HTML', { skip }, async () => {
  const catalog = makeCatalog([{ path: '/admin.php/seasons', text: SEASONS_PAGE }]);
  const seasons = await catalog.seasons();
  assert.deepEqual(seasons, [
    {
      id: 1, name: 'CyberClash 2026 & Winter', active: true,
      start: '01.11.2026', end: '30.11.2026', link: 'https://cyberclash.example/season',
    },
    {
      id: 2, name: 'Old Season', active: false,
      start: '01.01.2026', end: '30.06.2026', link: '',
    },
  ]);
});

test('seasons(): пустая страница → []', { skip }, async () => {
  const catalog = makeCatalog([{ path: '/admin.php/seasons', text: '<html>нет таблиц</html>' }]);
  assert.deepEqual(await catalog.seasons(), []);
});

test('seasons(): не-200 → русская ошибка', { skip }, async () => {
  const catalog = makeCatalog([{ path: '/admin.php/seasons', status: 503, text: '' }]);
  await assert.rejects(catalog.seasons(), (err) => {
    assert.match(err.message, /сезон/i);
    assert.ok(err.message.includes('503'), 'код в сообщении: ' + err.message);
    return true;
  });
});

// ---------- teams ----------

test('teams(): одна страница — id/name/country/shorthandle/link', { skip }, async () => {
  const catalog = makeCatalog([
    { path: '/admin.php/teams/index/1', text: TEAMS_PAGE_1 },
    { path: '/admin.php/teams/index/2', text: TEAMS_EMPTY },
  ]);
  const teams = await catalog.teams();
  assert.deepEqual(teams, [
    { id: 5, name: 'Alpha & Five', shorthandle: 'A5', country: 'RU', link: '' },
    { id: 6, name: 'Bravo', shorthandle: 'BRV', country: 'KZ', link: 'https://bravo.example/team' },
  ]);
});

test('teams(): несколько страниц склеиваются по порядку', { skip }, async () => {
  const catalog = makeCatalog([
    { path: '/admin.php/teams/index/1', text: TEAMS_PAGE_1 },
    { path: '/admin.php/teams/index/2', text: TEAMS_PAGE_2 },
    { path: '/admin.php/teams/index/3', text: TEAMS_EMPTY },
  ]);
  const teams = await catalog.teams();
  assert.deepEqual(teams.map(t => t.id), [5, 6, 7]);
  assert.equal(teams[2].country, 'DE');
});

test('teams(): страница без колонки Shorthandle — поле пустое, не ошибка', { skip }, () => {
  const html = `<table><thead><tr><th>#ID</th><th></th><th>Name</th><th>Team Link</th></tr></thead>
<tbody><tr><td>8</td><td><i class="flag flag-fr"></i></td><td>Delta</td><td></td></tr></tbody></table>`;
  const teams = parseTeamsPage(html);
  assert.deepEqual(teams, [{ id: 8, name: 'Delta', shorthandle: '', country: 'FR', link: '' }]);
});

test('teams(): пустая первая страница → []', { skip }, async () => {
  const catalog = makeCatalog([{ path: '/admin.php/teams/index/1', text: TEAMS_EMPTY }]);
  assert.deepEqual(await catalog.teams(), []);
});

test('teams(): сервер повторяет первую страницу — цикл не крутится', { skip }, async () => {
  const catalog = makeCatalog([
    { path: '/admin.php/teams/index/1', text: TEAMS_PAGE_1 },
    { path: '/admin.php/teams/index/2', text: TEAMS_PAGE_1 },
  ]);
  const teams = await catalog.teams();
  assert.deepEqual(teams.map(t => t.id), [5, 6]);
});

// ---------- контракты ----------

test('createEbotCatalog: без admin.page — понятная русская ошибка', { skip }, () => {
  assert.throws(() => createEbotCatalog({ admin: {} }), (err) => {
    assert.match(err.message, /page/);
    assert.match(err.message, /админ/i);
    return true;
  });
  assert.throws(() => createEbotCatalog({}), /админ/i);
});

test('все данные — текст: в ответах нет HTML-тегов', { skip }, async () => {
  const catalog = makeCatalog([
    { path: '/admin.php/servers', text: SERVERS_PAGE },
    { path: '/admin.php/seasons', text: SEASONS_PAGE },
    { path: '/admin.php/teams/index/1', text: TEAMS_PAGE_1 },
    { path: '/admin.php/teams/index/2', text: TEAMS_EMPTY },
  ]);
  for (const list of [await catalog.servers(), await catalog.seasons(), await catalog.teams()]) {
    for (const item of list) {
      for (const value of Object.values(item)) {
        assert.ok(!/<[a-z!/]/i.test(String(value)), 'HTML в поле: ' + JSON.stringify(item));
      }
    }
  }
});
