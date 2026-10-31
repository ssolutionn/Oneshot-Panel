import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createConsoleHub, parseChatLine } from '../server/ebot-console.js';

// Консоль матча eBot: хаб server/ebot-console.js раздаёт события eBot в SSE,
// send валидирует команды, stop закрывает поток. admin мокаем — как договаривались
// (реальный matchConsole поверх socketioSession покрыт тестом admin-клиента).

// Поддельный ответ Node: копим writeHead/write, отдаём текст по end().
function fakeRes() {
  const res = new Readable({ read() {} });
  res.chunks = [];
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
  res.end = (chunk) => { if (chunk) res.chunks.push(String(chunk)); res.ended = true; res.emit('close'); };
  return res;
}

// Читаем SSE-поток как текст: {event, data} по строкам «event:»/«data:».
function sseMessages(res) {
  const out = [];
  for (const block of res.chunks.join('').split('\n\n')) {
    if (!block || block.startsWith(':')) continue;
    const event = (block.match(/^event: (.+)$/m) || [])[1];
    const data = (block.match(/^data: (.+)$/m) || [])[1];
    if (event) out.push({ event, data: data === undefined ? null : JSON.parse(data) });
  }
  return out;
}

// Поддельный GET-запрос.
const fakeReq = (url, headers = {}) => ({
  url, method: 'GET', headers,
  on: () => {}, once: () => {}, resume: () => {},
});

// POST-запрос с JSON-телом: готовый стрим-объект с on('data'/'end').
const postReq = (body, headers = {}) => {
  const req = {
    url: '/api/ebot-console', method: 'POST', headers,
    on(name, fn) {
      if (name === 'data') fn(Buffer.from(body));
      if (name === 'end') fn();
      return req;
    },
    once() { return req; },
    resume() { return req; },
  };
  return req;
};

// Поддельный admin: подписки матча и RCON по требованию.
function fakeAdmin() {
  const admin = {
    consoles: [], stops: [], rcon: [],
    matchConsole(matchId, callbacks) {
      admin.consoles.push({ matchId, callbacks });
      return { stop: () => { admin.stops.push(matchId); }, done: () => Promise.resolve() };
    },
    async sendRcon(matchId, command) {
      admin.rcon.push({ matchId, command });
      return { accepted: true, reply: 'answer:' + command };
    },
    fireLog: (line) => { for (const c of admin.consoles) c.callbacks.onLog(line); },
    fireRcon: (content) => { for (const c of admin.consoles) c.callbacks.onRcon(content); },
  };
  return admin;
}

test('parseChatLine: строка say из лога CS2 → {nick, side, text}', () => {
  const line = 'L 10/31/2026 - 01:23:45.123: "Nick<2><STEAM_1:0:123><CT>" say "hello"';
  const chat = parseChatLine(line);
  assert.deepEqual(chat, { nick: 'Nick', side: 'CT', text: 'hello' });
  // TERRORIST тоже разбирается; say_team — нет (как у самого eBot).
  assert.deepEqual(parseChatLine('L 10/31/2026 - 01:23:45.123: "Bob<3><STEAM_1:0:9><TERRORIST>" say "gg wp"'),
    { nick: 'Bob', side: 'TERRORIST', text: 'gg wp' });
  assert.equal(parseChatLine('L 10/31/2026 - 01:23:45.123: "Bob<3><STEAM_1:0:9><TERRORIST>" say_team "secret"'), null);
  assert.equal(parseChatLine('L 10/31/2026 - 01:23:45.123: "Nick" killed "Bob" with "ak47"'), null);
  assert.equal(parseChatLine(''), null);
});

test('createConsoleHub требует admin с matchConsole и sendRcon', () => {
  assert.throws(() => createConsoleHub({ admin: {} }), /matchConsole/);
  assert.throws(() => createConsoleHub({ admin: { matchConsole: () => {} } }), /sendRcon/);
});

test('start открывает консоль, события лога и чата уходят в SSE-клиента', async () => {
  const admin = fakeAdmin();
  const hub = createConsoleHub({ admin });
  const made = await hub.start(47);
  assert.equal(made.matchId, '47');
  assert.match(made.id, /^[A-Za-z0-9_-]{10,32}$/);

  const res = fakeRes();
  assert.ok(hub.sseHandler(fakeReq(`/api/ebot-console?stream=${made.id}`), res));
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);

  // Событие лога: в SSE уходит event log, а строка say — ещё и chat.
  admin.fireLog('L 10/31/2026 - 01:23:45.123: "Nick<2><STEAM_1:0:123><CT>" say "hello"');
  admin.fireLog('L 10/31/2026 - 01:23:46.000: "Nick" killed "Bob" with "ak47"');
  admin.fireRcon('hostname answer');
  const messages = sseMessages(res);
  assert.ok(messages.some(m => m.event === 'hello' && m.data.matchId === '47'), JSON.stringify(messages));
  const logs = messages.filter(m => m.event === 'log');
  assert.equal(logs.length, 2, JSON.stringify(messages));
  assert.ok(logs[0].data.line.includes('" say "hello"'));
  const chats = messages.filter(m => m.event === 'chat');
  assert.equal(chats.length, 1);
  assert.deepEqual(chats[0].data, { nick: 'Nick', side: 'CT', text: 'hello' });
  const rcons = messages.filter(m => m.event === 'rcon');
  assert.equal(rcons.length, 1);
  assert.equal(rcons[0].data.content, 'hostname answer');

  hub.stop(made.id);
  // stop уведомляет eBot и закрывает поток клиента.
  assert.deepEqual(admin.stops, ['47']);
  const stopped = sseMessages(res).filter(m => m.event === 'stop');
  assert.equal(stopped.length, 1);
  assert.ok(res.ended);
});

test('send валидирует команду и передаёт её sendRcon', async () => {
  const admin = fakeAdmin();
  const hub = createConsoleHub({ admin });
  const { id } = await hub.start(47);
  const result = await hub.send(id, 'status');
  assert.deepEqual(result, { accepted: true, reply: 'answer:status' });
  assert.deepEqual(admin.rcon, [{ matchId: '47', command: 'status' }]);

  // Кавычки, точки с запятой и переводы строк не проходят.
  await assert.rejects(hub.send(id, 'say "hello"'), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /нечитаем/i);
    return true;
  });
  await assert.rejects(hub.send(id, 'kick; quit'), /нечитаем/);
  await assert.rejects(hub.send(id, ''), /нечитаем/);
  // Чат формулируется как say — и проходит.
  await hub.send(id, 'say hello');
  assert.deepEqual(admin.rcon.map(r => r.command), ['status', 'say hello']);
});

test('stop закрывает SSE: событие stop, поток завершён, id больше не находится', async () => {
  const admin = fakeAdmin();
  const hub = createConsoleHub({ admin });
  const { id } = await hub.start(51);
  const res = fakeRes();
  hub.sseHandler(fakeReq(`/api/ebot-console?stream=${id}`), res);
  hub.stop(id);
  const messages = sseMessages(res);
  assert.equal(messages.filter(m => m.event === 'stop').length, 1);
  assert.ok(res.ended);
  // Повторная подписка на остановленную сессию — 404.
  const res2 = fakeRes();
  hub.sseHandler(fakeReq(`/api/ebot-console?stream=${id}`), res2);
  assert.equal(res2.status, 404);
  // send в остановленную сессию — 404.
  await assert.rejects(hub.send(id, 'status'), (err) => err.status === 404);
});

test('postHandler: POST роуты start/send/stop и same-origin', async () => {
  const admin = fakeAdmin();
  const hub = createConsoleHub({ admin });

  const res1 = fakeRes();
  assert.ok(await hub.postHandler(postReq(JSON.stringify({ action: 'start', matchId: '47' }),
    { 'sec-fetch-site': 'same-origin' }), res1));
  assert.equal(res1.status, 200);
  const { id } = JSON.parse(res1.chunks.join(''));

  const res2 = fakeRes();
  assert.ok(await hub.postHandler(postReq(JSON.stringify({ action: 'send', id, command: 'status' }),
    { 'sec-fetch-site': 'same-origin' }), res2));
  assert.equal(res2.status, 200);
  assert.equal(JSON.parse(res2.chunks.join('')).accepted, true);

  const res3 = fakeRes();
  assert.ok(await hub.postHandler(postReq(JSON.stringify({ action: 'stop', id }),
    { 'sec-fetch-site': 'same-origin' }), res3));
  assert.equal(res3.status, 200);

  // Чужой origin не обслуживается.
  const res5 = fakeRes();
  assert.ok(await hub.postHandler(postReq(JSON.stringify({ action: 'start', matchId: '47' }),
    { origin: 'https://evil.example' }), res5));
  assert.equal(res5.status, 403);

  // Плохой matchId.
  const res6 = fakeRes();
  assert.ok(await hub.postHandler(postReq(JSON.stringify({ action: 'start', matchId: 'abc' }),
    { 'sec-fetch-site': 'same-origin' }), res6));
  assert.equal(res6.status, 400);
});

test('sseHandler отдаёт 404 на чужой/пустой id и чужой путь', () => {
  const admin = fakeAdmin();
  const hub = createConsoleHub({ admin });
  const res = fakeRes();
  assert.ok(hub.sseHandler(fakeReq('/api/ebot-console?stream=short'), res));
  assert.equal(res.status, 404);
  const res2 = fakeRes();
  assert.equal(hub.sseHandler(fakeReq('/api/other'), res2), false);
  const res3 = fakeRes();
  assert.ok(hub.sseHandler(fakeReq('/api/ebot-console'), res3));
  assert.equal(res3.status, 404);
});
