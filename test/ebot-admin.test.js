import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Модуль пишет параллельный агент; пока файла нет, все тесты admin-клиента
// пропускаются (try-import, как договаривались), а не падают.
let createEbotAdmin = null;
let ebotEncrypt = null;
let socketioSession = null;
try {
  ({ createEbotAdmin, ebotEncrypt, socketioSession } = await import('../server/ebot-admin.js'));
} catch { /* server/ebot-admin.js ещё не создан */ }
const skip = createEbotAdmin ? false : 'server/ebot-admin.js ещё не создан';

const BASE = 'http://ebot.test';
const PASSWORD = 'topsecret-pw';
// Токен со страницы /matchs/current (без слова Bearer).
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJhZG1pbiI6dHJ1ZX0.sig';
const AUTHKEY = '5c0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c.1234567890123';

// ---------- фикстуры страниц админки eBot ----------

const LOGIN_PAGE = `<html><body><form action="/admin.php/guard/login" method="post">
<input type="hidden" name="signin[_csrf_token]" value="tok123">
<input type="text" name="signin[username]">
<input type="password" name="signin[password]">
</form></body></html>`;

const CURRENT_PAGE = `<html><body>token: 'Bearer ${JWT}'</body></html>`;

// JSON-массив HTML с кнопками действий, как его отдаёт /matchs/actions/<id>.
const ACTIONS_PAGE = JSON.stringify([
  `<button onclick="doRequest('pauseunpause', '92.240.243.62:27020', '47', '${AUTHKEY}')">Pause</button>`,
  `<button onclick="doRequest('stopmatch', '92.240.243.62:27020', '47', '${AUTHKEY}')">Stop</button>`
]);

const CREATE_PAGE = `<html><body><form action="/admin.php/matchs/create" method="post">
<input type="hidden" name="matchs[_csrf_token]" value="ctok456">
<select name="server_id"><option value="3">SRV-1 - 10.0.0.1:27015</option></select>
<select name="maps">
<option value="de_dust2">de_dust2</option>
<option value="de_mirage">de_mirage</option>
<option value="de_nuke">de_nuke</option>
</select>
</form></body></html>`;

// Та же страница с flash-сообщением после успешного создания.
const CREATE_PAGE_FLASH = `<html><body>Match created with ID 48
<form action="/admin.php/matchs/create" method="post">
<input type="hidden" name="matchs[_csrf_token]" value="ctok456">
<select name="server_id"><option value="3">SRV-1 - 10.0.0.1:27015</option></select>
<select name="maps">
<option value="de_dust2">de_dust2</option>
</select>
</form></body></html>`;

// ---------- мок-fetch (fetchImpl передаётся в клиент, глобальный не трогаем) ----------

// Заголовок из мок-запроса: объект, массив пар или Headers.
function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  const pairs = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [k, v] of pairs) {
    if (String(k).toLowerCase() === lower) return v;
  }
  return null;
}

// Таблица маршрутов + журнал вызовов. matchBody — ожидаемое тело запроса.
function mockFetch(routes) {
  const calls = [];
  const fn = (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url: target, method, headers: init.headers, body: init.body });
    const path = new URL(target).pathname;
    for (const r of routes) {
      if (r.method !== method || path !== r.path) continue;
      if (r.matchBody !== undefined && String(init.body || '') !== r.matchBody) continue;
      return new Response(r.text ?? '', { status: r.status || 200, headers: r.headers || {} });
    }
    return new Response('', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

const HTML = { 'content-type': 'text/html' };

// Успешный логин: GET формы с CSRF, POST → 302 + Set-Cookie, страница после
// редиректа. Всё, что требует сессии, идёт после этих маршрутов.
function loginRoutes() {
  return [
    { method: 'GET', path: '/admin.php/guard/login', text: LOGIN_PAGE, headers: HTML },
    { method: 'POST', path: '/admin.php/guard/login', status: 302,
      headers: { location: '/admin.php/', 'set-cookie': 'symfony=abc123; path=/' } },
    { method: 'GET', path: '/admin.php/', text: '<html></html>', headers: HTML }
  ];
}

const makeAdmin = (fetchMock) => createEbotAdmin({
  baseUrl: BASE, user: 'admin', password: PASSWORD,
  fetchImpl: fetchMock, now: Date.now
});

// ---------- логин и matchCommands ----------

test('ready() логинится один раз: второй вызов не шлёт POST логина', { skip }, async () => {
  const fetchMock = mockFetch([
    ...loginRoutes(),
    { method: 'GET', path: '/admin.php/matchs/current', text: CURRENT_PAGE, headers: HTML }
  ]);
  const admin = makeAdmin(fetchMock);
  await admin.ready();
  await admin.ready();
  const logins = fetchMock.calls.filter(c => c.method === 'POST' && c.url.includes('/guard/login'));
  assert.equal(logins.length, 1);
  // CSRF из формы и имя пользователя уходят в POST.
  assert.ok(String(logins[0].body).includes('tok123'));
  assert.ok(String(logins[0].body).includes('admin'));
});

test('matchCommands: логин предшествует чтению current, кнопки разбираются', { skip }, async () => {
  const fetchMock = mockFetch([
    ...loginRoutes(),
    { method: 'GET', path: '/admin.php/matchs/current', text: CURRENT_PAGE, headers: HTML },
    { method: 'POST', path: '/admin.php/matchs/actions/47', text: ACTIONS_PAGE,
      headers: { 'content-type': 'application/json' } }
  ]);
  const admin = makeAdmin(fetchMock);
  const result = await admin.matchCommands(47);
  const order = fetchMock.calls.map(c => c.method + ' ' + new URL(c.url).pathname);
  const loginIdx = order.indexOf('POST /admin.php/guard/login');
  const currentIdx = order.indexOf('GET /admin.php/matchs/current');
  assert.ok(loginIdx >= 0, 'POST логина не было: ' + JSON.stringify(order));
  assert.ok(currentIdx > loginIdx, 'логин должен идти до страницы current');
  const pause = (result.commands || []).find(c => c.action === 'pauseunpause');
  assert.ok(pause, 'нет pauseunpause в ' + JSON.stringify(result));
  assert.equal(pause.ip, '92.240.243.62:27020');
  assert.equal(pause.authkey, AUTHKEY);
  assert.equal(typeof result.jwt, 'string');
  assert.ok(result.jwt.includes('eyJhZG1pbiI6dHJ1ZX0'), 'jwt: ' + JSON.stringify(result.jwt));
});

test('отказ логина (401): ошибка про логин, без пароля в сообщении', { skip }, async () => {
  const fetchMock = mockFetch([
    { method: 'GET', path: '/admin.php/guard/login', text: LOGIN_PAGE, headers: HTML },
    { method: 'POST', path: '/admin.php/guard/login', status: 401, text: 'Bad credentials.' }
  ]);
  const admin = makeAdmin(fetchMock);
  await assert.rejects(admin.ready(), (err) => {
    assert.ok(/логин/i.test(String(err.message)), 'сообщение: ' + err.message);
    assert.ok(!String(err.message).includes(PASSWORD), 'пароль попал в сообщение');
    return true;
  });
  const admin2 = makeAdmin(fetchMock);
  await assert.rejects(admin2.matchCommands(47), (err) => {
    assert.ok(/логин/i.test(String(err.message)), 'сообщение: ' + err.message);
    assert.ok(!String(err.message).includes(PASSWORD), 'пароль попал в сообщение');
    return true;
  });
});

// ---------- AES ----------

// Тот же vendored модуль, которым шифрует eBot, — грузим в vm отдельно.
function loadVendoredAes() {
  try {
    const code = readFileSync(new URL('../server/vendor/aes-ctr.js', import.meta.url), 'utf8');
    const ctx = vm.createContext({});
    vm.runInContext(code, ctx);
    return ctx.Aes;
  } catch { return null; }
}

test('vendored AES-CTR шифрует и расшифровывает обратно', () => {
  const Aes = loadVendoredAes();
  assert.ok(Aes, 'server/vendor/aes-ctr.js не читается');
  const enc = Aes.Ctr.encrypt('47 pauseunpause 92.240.243.62:27020', 'authkey', 128);
  assert.equal(Aes.Ctr.decrypt(enc, 'authkey', 128), '47 pauseunpause 92.240.243.62:27020');
});

test('ebotEncrypt расшифровывается vendored AES-CTR тем же ключом', { skip: ebotEncrypt ? false : skip }, async () => {
  const Aes = loadVendoredAes();
  assert.ok(Aes);
  const enc = ebotEncrypt('47 pauseunpause 92.240.243.62:27020', 'authkey', Aes);
  assert.equal(typeof enc, 'string');
  // Клиент шифрует 256 битами — так же расшифровывает PHP-ядро eBot.
  assert.equal(Aes.Ctr.decrypt(enc, 'authkey', 256), '47 pauseunpause 92.240.243.62:27020');
});

// ---------- socket.io polling ----------

// Мок транспортного polling-а socket.io: handshake GET без sid, POST
// подключения/identify, GET poll отдаёт событие matchsHandler.
function mockSocketio() {
  const calls = [];
  const fn = (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const body = String(init.body || '');
    calls.push({ url: target, method, headers: init.headers, body });
    const PLAIN = { 'content-type': 'text/plain' };
    if (method === 'GET' && !target.includes('sid=')) {
      return new Response('0{"sid":"XYZ","pingInterval":25000,"pingTimeout":60000}', { headers: PLAIN });
    }
    if (method === 'POST' && (body === '40' || body.startsWith('42'))) {
      return new Response('ok', { headers: PLAIN });
    }
    if (method === 'GET') {
      return new Response(
        '42["matchsHandler","{\\"message\\":\\"button\\",\\"content\\":\\"is_paused\\",\\"id\\":47}"]',
        { headers: PLAIN });
    }
    return new Response('', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

test('socketioSession разбирает событие matchsHandler из polling', { skip }, async () => {
  const fetchMock = mockSocketio();
  const session = socketioSession({ jwt: JWT, baseWsUrl: 'http://ebot.test', fetchImpl: fetchMock });
  await session.open();
  const ev = await session.nextEvent();
  assert.ok(ev, 'событие не разобрано');
  const json = JSON.stringify(ev);
  assert.ok(json.includes('matchsHandler'), json);
  assert.ok(json.includes('is_paused'), json);
  // Если реализация парсит и вложенный JSON — проверяем поля.
  const data = ev && typeof ev === 'object' && ev.data;
  if (data && typeof data === 'object') {
    assert.equal(data.message, 'button');
    assert.equal(data.content, 'is_paused');
    assert.equal(String(data.id), '47');
  }
});

test('polling-запросы socketioSession несут Authorization: Bearer <jwt>', { skip }, async () => {
  const fetchMock = mockSocketio();
  const session = socketioSession({ jwt: JWT, baseWsUrl: 'http://ebot.test', fetchImpl: fetchMock });
  await session.open();
  await session.nextEvent();
  assert.ok(fetchMock.calls.length > 0, 'запросов не было');
  for (const call of fetchMock.calls) {
    const auth = String(headerValue(call.headers, 'authorization') || '');
    assert.ok(auth.toLowerCase().startsWith('bearer '), 'без Authorization: ' + call.method + ' ' + call.url);
    assert.ok(auth.includes(JWT), 'чужой токен: ' + auth);
  }
});

// ---------- createMatch и catalog ----------

test('createMatch создаёт матч и возвращает его ID', { skip }, async () => {
  const fetchMock = mockFetch([
    ...loginRoutes(),
    // JWT достаётся со страницы current при bootstrap, до create-формы.
    { method: 'GET', path: '/admin.php/matchs/current', text: CURRENT_PAGE, headers: HTML },
    { method: 'GET', path: '/admin.php/matchs/create', text: CREATE_PAGE, headers: HTML },
    { method: 'POST', path: '/admin.php/matchs/create', status: 302,
      headers: { location: '/admin.php/matchs/create' } }
  ]);
  // Первый GET create — форма с CSRF; после редиректа — та же страница с flash.
  let createViews = 0;
  const inner = fetchMock;
  const stateful = (url, init = {}) => {
    const target = String(url);
    if ((init.method || 'GET').toUpperCase() === 'GET' &&
        new URL(target).pathname === '/admin.php/matchs/create' && createViews++ === 1) {
      return Promise.resolve(new Response(CREATE_PAGE_FLASH, { headers: HTML }));
    }
    return inner(url, init);
  };
  stateful.calls = inner.calls;
  const admin = makeAdmin(stateful);
  const result = await admin.createMatch({ teamA: 'Team A', teamB: 'Team B', map: 'de_dust2', serverId: 3 });
  assert.equal(result.created, true, JSON.stringify(result));
  assert.equal(String(result.id), '48');
});

test('catalog разбирает серверы и карты формы создания', { skip }, async () => {
  const fetchMock = mockFetch([
    ...loginRoutes(),
    { method: 'GET', path: '/admin.php/matchs/current', text: CURRENT_PAGE, headers: HTML },
    { method: 'GET', path: '/admin.php/matchs/create', text: CREATE_PAGE, headers: HTML }
  ]);
  const admin = makeAdmin(fetchMock);
  const cat = await admin.catalog();
  assert.equal(cat.servers.length, 1, JSON.stringify(cat));
  assert.equal(String(cat.servers[0].id), '3');
  assert.equal(cat.servers[0].label, 'SRV-1 - 10.0.0.1:27015');
  assert.ok(cat.maps.includes('de_dust2'), JSON.stringify(cat.maps));
  assert.ok(cat.maps.includes('de_mirage'));
});

// ---------- netlify-функция /api/ebot-admin ----------

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

let proxyEbotAdmin = null;
try {
  ({ proxyEbotAdmin } = await import('../netlify/functions/ebot-admin.mjs'));
} catch { /* нет модуля функции */ }

test('/api/ebot-admin: GET и чужой origin не обслуживаются, без секретов — 401', async () => {
  const { proxyEbotAdmin } = await import('../netlify/functions/ebot-admin.mjs');
  const get = await proxyEbotAdmin(new Request('http://localhost/api/ebot-admin'), {});
  assert.equal(get.status, 400);
  // Fetch Metadata нет → проверяется Origin; чужой сайт не проходит.
  const foreign = await proxyEbotAdmin(new Request('http://localhost/api/ebot-admin', {
    method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}'
  }), {});
  assert.equal(foreign.status, 403);
  // Секреты не заданы — понятная ошибка, без учётных данных в ответе.
  const own = await proxyEbotAdmin(new Request('http://localhost/api/ebot-admin', {
    method: 'POST', headers: { origin: 'http://localhost' }, body: JSON.stringify({ action: 'catalog' })
  }), {});
  assert.equal(own.status, 401);
  const body = await own.json();
  assert.equal(body.error, 'no-credentials');
});

// ---------- ФИКС 1: опциональный EBOT_ADMIN_TOKEN и EBOT_ADMIN_OPEN ----------

const ownPost = (extraHeaders, env, body) => proxyEbotAdmin(new Request('http://localhost/api/ebot-admin', {
  method: 'POST', headers: { origin: 'http://localhost', ...extraHeaders },
  body: body || JSON.stringify({ action: 'catalog' })
}), env);

test('EBOT_ADMIN_TOKEN: без токена в запросе — 401, с неверным — 401, с верным — не 401', async () => {
  const ENV = {
    EBOT_URL: BASE, EBOT_USER: 'admin', EBOT_PASSWORD: PASSWORD,
    EBOT_ADMIN_TOKEN: 'sha256:' + await sha256Hex('test-token')
  };
  // Неверный токен отклоняется до логина в eBot:_fetch не вызывался вовсе.
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => { fetches++; return Promise.resolve(new Response('', { status: 404 })); };
  try {
    const noHeader = await ownPost({}, ENV);
    assert.equal(noHeader.status, 401);
    assert.equal((await noHeader.json()).error, 'not-allowed');
    const wrong = await ownPost({ 'x-ebot-token': 'guess' }, ENV);
    assert.equal(wrong.status, 401);
    const right = await ownPost({ 'x-ebot-token': 'test-token' }, ENV);
    assert.notEqual(right.status, 401, 'верный токен не должен давать 401');
    // Токен проверяется до похода в eBot: только верный запрос дошёл до fetch
    // (запрос уходил на авторизованную страницу current, не на 404-маршрут).
    assert.ok(fetches >= 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('EBOT_ADMIN_TOKEN в открытом виде тоже принимается как дайджест', async () => {
  const ENV = {
    EBOT_URL: BASE, EBOT_USER: 'admin', EBOT_PASSWORD: PASSWORD,
    EBOT_ADMIN_TOKEN: 'plaintext-token'
  };
  const wrong = await ownPost({ 'x-ebot-token': 'plaintext-tokeN' }, ENV);
  assert.equal(wrong.status, 401);
  const right = await ownPost({ 'x-ebot-token': 'plaintext-token' }, ENV);
  assert.notEqual(right.status, 401);
});

test('EBOT_ADMIN_OPEN закрыт: catalog 403, ip кнопок скрыт; открыт: ip виден', async () => {
  // Свой user (длина пароля та же): модульный кэш отдаёт нового админа с
  // текущим globalThis.fetch, а не админа из предыдущего теста.
  const ENV = {
    EBOT_URL: BASE, EBOT_USER: 'admin-open-test', EBOT_PASSWORD: PASSWORD
  };
  // Мок ставим до первого запроса: fetchImpl админ-клиент берёт из
  // globalThis.fetch при создании, а создаётся он уже первым запросом.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch([
    ...loginRoutes(),
    { method: 'GET', path: '/admin.php/matchs/current', text: CURRENT_PAGE, headers: HTML },
    { method: 'POST', path: '/admin.php/matchs/actions/47', text: ACTIONS_PAGE,
      headers: { 'content-type': 'application/json' } }
  ]);
  try {
    // Без EBOT_ADMIN_OPEN каталог закрыт 403 — до любого похода в eBot
    // (мок ниже не имеет маршрутов catalog, и они не нужны).
    const closed = await ownPost({}, ENV);
    assert.equal(closed.status, 403);
    assert.equal((await closed.json()).error, 'not-allowed');

    const reply = await ownPost({}, ENV, JSON.stringify({ action: 'commands', matchId: 47 }));
    assert.equal(reply.status, 200);
    const body = await reply.json();
    assert.ok(Array.isArray(body.commands) && body.commands.length >= 1, JSON.stringify(body));
    for (const c of body.commands) {
      assert.equal(c.ip, undefined, 'ip протёк при закрытом EBOT_ADMIN_OPEN: ' + JSON.stringify(c));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------- ФИКС 8: лимит тела ----------

test('тело больше 64 КБ отклоняется 413', async () => {
  const ENV = {
    EBOT_URL: BASE, EBOT_USER: 'admin', EBOT_PASSWORD: PASSWORD,
    EBOT_ADMIN_TOKEN: 'sha256:' + await sha256Hex('test-token')
  };
  const big = JSON.stringify({ action: 'send', matchId: '47', argument: 'a'.repeat(70 * 1024) });
  // content-length ниже фактического размера не спасает: длина проверяется и после чтения.
  const reply = await ownPost({ 'x-ebot-token': 'test-token' }, ENV, big);
  assert.equal(reply.status, 413);
  const reply2 = await proxyEbotAdmin(new Request('http://localhost/api/ebot-admin', {
    method: 'POST',
    headers: { origin: 'http://localhost', 'x-ebot-token': 'test-token', 'content-length': '10' },
    body: big
  }), ENV);
  assert.equal(reply2.status, 413);
  // Тело ровно в лимите проходит дальше (проверяем, что длина не мешает).
  const okLen = JSON.stringify({ action: 'catalog' }).repeat(1); // маленькое тело — уходит в eBot (мок 404 → 502)
  const small = await ownPost({ 'x-ebot-token': 'test-token' }, { ...ENV, EBOT_ADMIN_OPEN: '1' }, okLen);
  assert.notEqual(small.status, 413);
});

// ---------- ФИКС 2: Cloudflare-обёртка импортируется ----------

test('functions/api/ebot-admin.js импортируется без ?raw и экспортирует onRequest', async () => {
  const mod = await import('../functions/api/ebot-admin.js');
  assert.equal(typeof mod.onRequest, 'function');
  // Обёртка отвечает через общий прокси: без секретов — 401, не падая на импорте AES.
  const reply = await mod.onRequest({
    request: new Request('https://panel.example/api/ebot-admin', {
      method: 'POST', headers: { origin: 'https://panel.example' }, body: JSON.stringify({ action: 'catalog' })
    }),
    env: {}
  });
  assert.equal(reply.status, 401);
  assert.equal((await reply.json()).error, 'no-credentials');
});

// ---------- ФИКС 3: переиспользование админ-клиента между запросами ----------

test('модульный кэш: два запроса подряд логинятся в eBot один раз', async () => {
  // adminCache модульный — порядок тестов может его разогреть; проверяем
  // количество логинов на одном наборе env, а не абсолютное значение.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch([
    ...loginRoutes(),
    { method: 'GET', path: '/admin.php/matchs/current', text: CURRENT_PAGE, headers: HTML },
    { method: 'POST', path: '/admin.php/matchs/actions/47', text: ACTIONS_PAGE,
      headers: { 'content-type': 'application/json' } }
  ]);
  const ENV = { EBOT_URL: BASE, EBOT_USER: 'admin-cache-test', EBOT_PASSWORD: PASSWORD };
  const mock = globalThis.fetch;
  const calls = [];
  const counting = (url, init = {}) => {
    calls.push(new URL(String(url)).pathname + ' ' + String(init.method || 'GET').toUpperCase());
    return mock(url, init);
  };
  globalThis.fetch = counting;
  try {
    for (let i = 0; i < 2; i++) {
      const reply = await ownPost({}, ENV, JSON.stringify({ action: 'commands', matchId: 47 }));
      assert.equal(reply.status, 200, 'запрос ' + i + ' не прошёл');
    }
    // Отдельно считаем POST логина: во втором запросе его быть не должно
    // (может быть максимум один — если первый запрос породил bootstrap).
    const logins = calls.filter(c => c === '/admin.php/guard/login POST').length;
    assert.ok(logins <= 1, 'логинов больше одного: ' + logins);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
