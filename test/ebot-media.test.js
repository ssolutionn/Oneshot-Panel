import test from 'node:test';
import assert from 'node:assert/strict';

// server/ebot-media.js пишет параллельный агент: пока файла нет, тесты
// пропускаются (try-import, как в test/ebot-admin.test.js), а не падают.
let ebotExportKinds = null;
let ebotExportUrl = null;
let ebotExport = null;
let ebotDemoUrl = null;
let ebotDemo = null;
let MAX_EXPORT_BYTES = null;
try {
  ({
    ebotExportKinds, ebotExportUrl, ebotExport, ebotDemoUrl, ebotDemo,
    MAX_EXPORT_BYTES
  } = await import('../server/ebot-media.js'));
} catch { /* server/ebot-media.js ещё не создан */ }
const skip = ebotExport ? false : 'server/ebot-media.js ещё не создан';

const BASE = 'http://ebot.test/';

// ---------- мок-fetch (fetchImpl передаётся в модуль, глобальный не трогаем) ----------

function mockFetch(routes) {
  const calls = [];
  const fn = (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url: target, method, init });
    const path = new URL(target).pathname;
    for (const r of routes) {
      if (r.method !== method || path !== r.path) continue;
      return new Response(r.text ?? '', { status: r.status || 200, headers: r.headers || {} });
    }
    return new Response('', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

// Стрим-ответ без авто-декодирования текста: как настоящий eBot, тело
// идёт через response.body, счётчик байт проверяется честно.
function streamResponse(chunks, { status = 200, headers = {} } = {}) {
  const encoder = new TextEncoder();
  const source = (async function* () {
    for (const chunk of chunks) {
      yield typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    }
  })();
  return new Response(source, { status, headers });
}

// ---------- белый список экспортов ----------

test('белый список экспортов: только реально публичные действия, без Toornament', { skip }, () => {
  const kinds = ebotExportKinds();
  assert.deepEqual(kinds, ['players', 'rounds', 'kills', 'estats']);
  // Toornament-экспорт не отдаёт данные — его в списке нет.
  assert.ok(!kinds.includes('toornament'));
  // Свежий массив: мутировавший его вызывающий не портит белый список.
  kinds.push('evil');
  assert.ok(!ebotExportKinds().includes('evil'));
});

// ---------- сборка URL ----------

test('ebotExportUrl: точные маршруты eBot, matchId — только цифры', { skip }, () => {
  assert.equal(ebotExportUrl(BASE, 46, 'players'), 'http://ebot.test/matchs/exportPlayers/46');
  assert.equal(ebotExportUrl(BASE, '46', 'rounds'), 'http://ebot.test/matchs/exportRounds/46');
  assert.equal(ebotExportUrl(BASE, 46, 'kills'), 'http://ebot.test/matchs/exportKills/46');
  assert.equal(ebotExportUrl(BASE, 46, 'estats'), 'http://ebot.test/matchs/exportEstats/46');
  // matchId — строкой или числом, результат один.
  // 0 формально цифры — как /^\d{1,9}$/ в ebot.mjs, валиден.
  for (const bad of ['abc', '../view', '1;2', '1?', '', null, undefined, '046.1', 1234567890]) {
    assert.throws(() => ebotExportUrl(BASE, bad, 'players'), /номер.*матча/i, String(bad));
  }
});

test('ebotExportUrl: посторонний kind отвергается до любого URL', { skip }, () => {
  // kind в URL не попадает никогда: белый список решает, а не фильтрация.
  for (const bad of ['../../', 'view', 'demo', 'export', 'toornament', 'PLAYERS', '', null, undefined, {}]) {
    assert.throws(() => ebotExportUrl(BASE, 46, bad), /вид.*экспорта/i, String(bad));
  }
});

test('ebotExportUrl: мусорный адрес eBot отвергается', { skip }, () => {
  for (const bad of ['javascript:alert(1)', 'http://user:pass@ebot.test/', 'http://ebot.test/?x=1', 'not a url', '', null]) {
    assert.throws(() => ebotExportUrl(bad, 46, 'players'), /адрес.*ebot/i, String(bad));
  }
});

test('ebotDemoUrl: маршрут демки ждёт id КАРТЫ, только цифры', { skip }, () => {
  assert.equal(ebotDemoUrl(BASE, 7), 'http://ebot.test/matchs/demo/7');
  assert.equal(ebotDemoUrl(BASE, '107'), 'http://ebot.test/matchs/demo/107');
  for (const bad of ['abc', '../demo', '1;2', '', null, undefined, '7.1']) {
    assert.throws(() => ebotDemoUrl(BASE, bad), /номер.*карты/i, String(bad));
  }
  for (const bad of ['javascript:alert(1)', 'http://u:p@ebot.test/', '', null]) {
    assert.throws(() => ebotDemoUrl(bad, 7), /адрес.*ebot/i, String(bad));
  }
});

// ---------- ebotExport: успешные ответы ----------

test('ebotExport: GET с редиректом follow и текстом, возвращает text/contentType', { skip }, async () => {
  const fetchMock = mockFetch([
    // CSV с живого формата экспорта; content-type текстовый.
    { method: 'GET', path: '/matchs/exportPlayers/46',
      text: 'userName,steamId,kill,death\r\nsowalio,7656119,16,16\r\n',
      headers: { 'content-type': 'text/csv; charset=utf-8' } }
  ]);
  const { text, contentType } = await ebotExport({
    targetHref: BASE, matchId: '46', kind: 'players', fetchImpl: fetchMock
  });
  assert.match(text, /^userName,steamId/);
  assert.match(contentType, /^text\/csv/);
  // GET, редиректы по инструкции follow, один запрос.
  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].method, 'GET');
  assert.equal(fetchMock.calls[0].url, 'http://ebot.test/matchs/exportPlayers/46');
  assert.equal(fetchMock.calls[0].init.redirect, 'follow');
});

test('ebotExport: symfony renderText (text/html) с JSON тоже принимается', { skip }, async () => {
  const fetchMock = mockFetch([
    { method: 'GET', path: '/matchs/exportRounds/46',
      text: '{"1":{"roundId":1,"winType":"normal"}}',
      headers: { 'content-type': 'text/html; charset=UTF-8' } }
  ]);
  const { text, contentType } = await ebotExport({
    targetHref: BASE, matchId: 46, kind: 'rounds', fetchImpl: fetchMock
  });
  assert.equal(JSON.parse(text)['1'].roundId, 1);
  assert.match(contentType, /^text\/html/);
});

// ---------- ebotExport: ошибки ----------

test('ebotExport: не-200 — русская ошибка без тела eBot (живая сборка отвечает 500)', { skip }, async () => {
  const fetchMock = mockFetch([
    { method: 'GET', path: '/matchs/exportKills/46', status: 500, text: 'PHP fatal', headers: { 'content-type': 'text/html' } },
    { method: 'GET', path: '/matchs/exportEstats/46', status: 404, text: '', headers: { 'content-type': 'text/html' } }
  ]);
  await assert.rejects(
    () => ebotExport({ targetHref: BASE, matchId: '46', kind: 'kills', fetchImpl: fetchMock }),
    /HTTP 500/);
  await assert.rejects(
    () => ebotExport({ targetHref: BASE, matchId: '46', kind: 'estats', fetchImpl: fetchMock }),
    /HTTP 404/);
});

test('ebotExport: сеть отказала — русская ошибка', { skip }, async () => {
  const fail = () => Promise.reject(new Error('timeout'));
  await assert.rejects(
    () => ebotExport({ targetHref: BASE, matchId: '46', kind: 'players', fetchImpl: fail }),
    /eBot не ответил/);
});

test('ebotExport: бинарный ответ (демка) не проходит как экспорт', { skip }, async () => {
  const fetchMock = mockFetch([
    { method: 'GET', path: '/matchs/exportPlayers/46',
      text: 'PK\x03\x04binary', headers: { 'content-type': 'application/octet-stream' } }
  ]);
  await assert.rejects(
    () => ebotExport({ targetHref: BASE, matchId: '46', kind: 'players', fetchImpl: fetchMock }),
    /текстовом виде/);
});

// ---------- ebotExport: лимит 10 МБ ----------

test('ebotExport: тело длиннее лимита — русская ошибка, читается стримом', { skip }, async () => {
  // ~10.5 МБ двумя кусками: стрим-ответ, как настоящий eBot. Сверх лимита
  // модуль обязан остановить чтение сам — качаться дальше хвост не должен.
  const chunk = new Uint8Array(6 * 1024 * 1024);
  let cancelled = false;
  const source = (async function* () {
    yield chunk;
    yield chunk;
    // Хвост после лимита: если чтение отменят честно, сюда не дойдёт.
    yield new Uint8Array(1024);
    yield 'must-not-reach';
  })();
  const body = new ReadableStream({
    start(controller) {
      (async () => {
        try {
          for await (const piece of source) controller.enqueue(piece);
          controller.close();
        } catch { /* reader.cancel() обрывает генератор — это норма */ }
      })();
    },
    cancel() { cancelled = true; }
  });
  const response = new Response(body, {
    status: 200, headers: { 'content-type': 'text/csv' }
  });
  const fetchMock = () => Promise.resolve(response);
  await assert.rejects(
    () => ebotExport({ targetHref: BASE, matchId: '46', kind: 'players', fetchImpl: fetchMock }),
    /10 МБ/);
  // Сверх лимита чтение останавливается: стрим отменён, хвост не прочитан.
  assert.ok(cancelled, 'стрим должен быть отменён при превышении лимита');
});

test('ebotExport: тело в пределах лимита проходит целиком', { skip }, async () => {
  // Два куска по 4 МБ (8 МБ < 10 МБ): проверяем склейку стрима в текст.
  const part = 'a'.repeat(4 * 1024 * 1024);
  const fetchMock = () => Promise.resolve(
    streamResponse([part, part], { headers: { 'content-type': 'text/plain' } }));
  const { text } = await ebotExport({
    targetHref: BASE, matchId: '46', kind: 'players', fetchImpl: fetchMock
  });
  assert.equal(text.length, 8 * 1024 * 1024);
});

test('лимит экспорта — 10 МБ', { skip }, () => {
  assert.equal(MAX_EXPORT_BYTES, 10 * 1024 * 1024);
});

// ---------- ebotDemo ----------

test('ebotDemo: возвращает сам Response, тело не читается, GET с follow', { skip }, async () => {
  const fetchMock = mockFetch([
    { method: 'GET', path: '/matchs/demo/107', text: 'DEMO-BYTES',
      headers: { 'content-type': 'application/octet-stream' } }
  ]);
  const response = await ebotDemo({ targetHref: BASE, mapId: '107', fetchImpl: fetchMock });
  assert.ok(response instanceof Response);
  // Тело читает вызывающий, когда решит; модуль его не разбирал.
  assert.equal(await response.text(), 'DEMO-BYTES');
  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].method, 'GET');
  assert.equal(fetchMock.calls[0].url, 'http://ebot.test/matchs/demo/107');
  assert.equal(fetchMock.calls[0].init.redirect, 'follow');
});

test('ebotDemo: пустой 200 (демки нет) и 404 проходят как есть — статус решает интеграция', { skip }, async () => {
  const fetchMock = mockFetch([
    { method: 'GET', path: '/matchs/demo/7', text: '', status: 200, headers: { 'content-type': 'text/html' } },
    { method: 'GET', path: '/matchs/demo/999999', text: '', status: 404 }
  ]);
  assert.equal((await ebotDemo({ targetHref: BASE, mapId: 7, fetchImpl: fetchMock })).status, 200);
  assert.equal((await ebotDemo({ targetHref: BASE, mapId: '999999', fetchImpl: fetchMock })).status, 404);
});

test('ebotDemo: сеть отказала — русская ошибка; mapId и адрес проверяются до похода', { skip }, async () => {
  const fail = () => Promise.reject(new Error('down'));
  await assert.rejects(
    () => ebotDemo({ targetHref: BASE, mapId: '107', fetchImpl: fail }), /демку/);
  const mustNotFetch = () => { throw new Error('fetch не должен вызываться'); };
  await assert.rejects(
    () => ebotDemo({ targetHref: BASE, mapId: '../demo', fetchImpl: mustNotFetch }), /номер.*карты/i);
  await assert.rejects(
    () => ebotDemo({ targetHref: 'javascript:alert(1)', mapId: '107', fetchImpl: mustNotFetch }), /адрес.*ebot/i);
});
