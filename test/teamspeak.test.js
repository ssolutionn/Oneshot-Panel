import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tsEscape, tsUnescape, parseRows, parseParams, parseErrorLine, createTeamspeak } from '../server/teamspeak.js';

// ---- экранирование ----
test('escape/unescape: пробел, слэш, бекслэш ходят туда-обратно', () => {
  for (const raw of ['Foo Bar', 'a/b', 'back\\slash', 'Foo Bar/b\\c', '', 'просто'])
    assert.equal(tsUnescape(tsEscape(raw)), raw, raw);
  assert.equal(tsEscape('Foo Bar'), 'Foo\\sBar');
  assert.equal(tsEscape('a/b'), 'a\\pb');
  assert.equal(tsEscape('back\\slash'), 'back\\\\slash');
  assert.equal(tsUnescape('Foo\\sBar'), 'Foo Bar');
  assert.equal(tsUnescape('a\\pb'), 'a/b');
  assert.equal(tsUnescape('unknown\\q'), 'unknown\\q');
});

// ---- разбор строк протокола ----
test('parseRows/parseParams: параметры k=v, записи через |, толерантность', () => {
  assert.deepEqual(parseParams('clid=1 nickname=Foo\\sBar'), { clid: '1', nickname: 'Foo Bar' });
  assert.deepEqual(parseParams('buggy no=eq='), { no: 'eq=' });
  assert.deepEqual(parseRows(['clid=1 nickname=A|clid=2 nickname=B', '', 'clid=3']),
    [{ clid: '1', nickname: 'A' }, { clid: '2', nickname: 'B' }, { clid: '3' }]);
  assert.deepEqual(parseRows([]), []);
  assert.deepEqual(parseErrorLine('error id=0 msg=ok'), { id: 0, msg: 'ok' });
  assert.deepEqual(parseErrorLine('error id=2561 msg=duplicate client\\sin\\sgroup'), { id: 2561, msg: 'duplicate client in group' });
});

// ---- фальшивый TeamSpeak ----
const WELCOME = 'TS3\nWelcome to the TeamSpeak 3 ServerQuery interface\ntype "help" for a list of commands.\n';

// Мок: на каждую команду — ответ (строка тела + итоговый error), либо функция.
// replies: Map «имя команды → { body, error: {id, msg}, silent, fn }».
function fakeTs({ welcome = true, loginError = null, replies = new Map(), chunked = false } = {}) {
  const received = [];
  const server = net.createServer(socket => {
    const write = text => {
      if (chunked) { socket.write(text.slice(0, 8)); setTimeout(() => socket.write(text.slice(8)), 15); }
      else socket.write(text);
    };
    if (welcome) write(WELCOME);
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        received.push(line);
        const name = line.split(' ')[0];
        if (name === 'login' && loginError) { write(`error id=${loginError.id} msg=${tsEscape(loginError.msg)}\n`); continue; }
        const r = replies.get(name) || {};
        if (r.silent) continue; // таймаут: молчим
        if (typeof r.fn === 'function') { r.fn(line, write); continue; }
        const id = r.error ? r.error.id : 0, msg = r.error ? tsEscape(r.error.msg) : 'ok';
        write((r.body ? r.body + '\n' : '') + `error id=${id} msg=${msg}\n`);
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server, received, port: server.address().port })));
}

const base = { host: '127.0.0.1', login: 'qc', password: 'pa ss/word' };
const opts = { connectTimeoutMs: 500, commandTimeoutMs: 400, netImpl: net };

test('muteClients: логин, use, clientlist с ником с пробелом, группа создалась', async () => {
  const replies = new Map([
    ['servergrouplist', { body: '' }],
    ['servergroupadd', { body: 'sgid=9' }],
    ['clientlist', { body: 'clid=4 cid=2 client_database_id=55 nickname=Foo\\sBar|clid=5 cid=2 client_database_id=56 nickname=tender' }],
    ['servergroupaddclient', {}],
  ]);
  for (const chunked of [false, true]) { // ответ и по кусочкам
    const ts = await fakeTs({ replies, chunked });
    try {
      const client = createTeamspeak({ ...base, ...opts, port: ts.port, usePort: 7777 });
      const result = await client.muteClients(['  foo bar  ', 'TENDER', 'ghost']);
      assert.deepEqual(result.muted, [{ nick: 'Foo Bar', clId: 4, dbId: 55 }, { nick: 'tender', clId: 5, dbId: 56 }]);
      assert.deepEqual(result.missed, ['ghost']);
      const names = ts.received.map(c => c.split(' ')[0]);
      assert.deepEqual(names, ['login', 'use', 'servergrouplist', 'servergroupadd', 'clientlist', 'servergroupaddclient', 'servergroupaddclient', 'quit']);
      assert.equal(ts.received[0], 'login qc pa\\sss\\pword');
      assert.equal(ts.received[1], 'use port=7777');
      assert.equal(ts.received[3], 'servergroupadd name=Oneshot\\sMuted');
      assert.equal(ts.received[5], 'servergroupaddclient sgid=9 cldbid=55');
      assert.equal(ts.received[6], 'servergroupaddclient sgid=9 cldbid=56');
    } finally { await new Promise(resolve => ts.server.close(resolve)); }
  }
});

test('unmuteClients: servergroupdelclient; дубликат id=2561 — не ошибка', async () => {
  const ts = await fakeTs({ replies: new Map([
    ['servergrouplist', { body: 'sgid=7 name=Oneshot\\sMuted type=1' }],
    ['clientlist', { body: 'clid=4 client_database_id=55 nickname=Foo\\sBar' }],
    // «уже не в группе» — duplicate, для нас молчаливый успех
    ['servergroupdelclient', { error: { id: 2561, msg: 'duplicate client in group' } }],
  ]) });
  try {
    const client = createTeamspeak({ ...base, ...opts, port: ts.port });
    const result = await client.unmuteClients(['foo bar']);
    assert.deepEqual(result.muted, [{ nick: 'Foo Bar', clId: 4, dbId: 55 }]);
    assert.deepEqual(result.missed, []);
    assert.equal(ts.received.find(c => c.startsWith('servergroupdelclient')), 'servergroupdelclient sgid=7 cldbid=55');
  } finally { await new Promise(resolve => ts.server.close(resolve)); }
});

test('muteClients с ником, которого нет → missed, группу не раздают', async () => {
  const ts = await fakeTs({ replies: new Map([
    ['servergrouplist', { body: 'sgid=7 name=Oneshot\\sMuted type=1' }],
    ['clientlist', { body: 'clid=4 client_database_id=55 nickname=Foo' }],
  ]) });
  try {
    const client = createTeamspeak({ ...base, ...opts, port: ts.port });
    const result = await client.muteClients(['bar']);
    assert.deepEqual(result.muted, []);
    assert.deepEqual(result.missed, ['bar']);
    assert.ok(!ts.received.some(c => c.startsWith('servergroupaddclient')), 'никого не добавляли');
  } finally { await new Promise(resolve => ts.server.close(resolve)); }
});

test('ensureMuteGroup: находит существующую по имени, затем кэш', async () => {
  const ts = await fakeTs({ replies: new Map([
    ['servergrouplist', { body: 'sgid=2 name=Normal type=1|sgid=7 name=Oneshot\\sMuted type=1|sgid=8 name=Server\\sAdmin type=0' }],
    ['servergroupadd', { body: 'sgid=1' }],
  ]) });
  const logged = [];
  try {
    const client = createTeamspeak({ ...base, ...opts, port: ts.port, log: c => logged.push(c) });
    assert.equal(await client.ensureMuteGroup(), 7);
    assert.equal(await client.ensureMuteGroup(), 7);
    assert.deepEqual(ts.received.filter(c => c.startsWith('servergroup')), ['servergrouplist'], 'кэш: второй вызов не ходит в TS');
    // лог — только имя команды, без пароля
    assert.ok(logged.includes('ts → login') && !logged.some(l => l.includes(base.password)));
  } finally { await new Promise(resolve => ts.server.close(resolve)); }
});

test('ensureMuteGroup: группы нет — создаёт и возвращает новый sgid', async () => {
  const ts = await fakeTs({ replies: new Map([
    ['servergrouplist', { body: 'sgid=2 name=Normal type=1' }],
    ['servergroupadd', { body: 'sgid=13' }],
  ]) });
  try {
    const client = createTeamspeak({ ...base, ...opts, port: ts.port });
    assert.equal(await client.ensureMuteGroup(), 13);
    assert.equal(ts.received.find(c => c.startsWith('servergroupadd')), 'servergroupadd name=Oneshot\\sMuted');
  } finally { await new Promise(resolve => ts.server.close(resolve)); }
});

test('ошибка логина id=520: русская ошибка, пароля в тексте нет, команды дальше не идут', async () => {
  const ts = await fakeTs({ loginError: { id: 520, msg: 'login failed' } });
  try {
    const client = createTeamspeak({ ...base, ...opts, port: ts.port });
    await assert.rejects(client.muteClients(['x']), error =>
      /TeamSpeak отклонил логин/.test(error.message) && !error.message.includes(base.password));
    assert.deepEqual(ts.received, ['login qc pa\\sss\\pword', 'quit']);
  } finally { await new Promise(resolve => ts.server.close(resolve)); }
});

test('ошибка команды id≠0: русская ошибка с id и msg', async () => {
  const ts = await fakeTs({ replies: new Map([
    ['servergrouplist', { error: { id: 1541, msg: 'command not found' } }],
  ]) });
  try {
    const client = createTeamspeak({ ...base, ...opts, port: ts.port });
    await assert.rejects(client.ensureMuteGroup(), /TeamSpeak отклонил команду servergrouplist.*id=1541.*command not found/);
  } finally { await new Promise(resolve => ts.server.close(resolve)); }
});

test('таймаут без ответа → русская ошибка «не ответил»', async () => {
  const ts = await fakeTs({ replies: new Map([
    ['servergrouplist', { body: 'sgid=7 name=Oneshot\\sMuted type=1' }],
    ['clientlist', { silent: true }], // сервер молчит на клиентlist
  ]) });
  try {
    const client = createTeamspeak({ ...base, ...opts, port: ts.port, commandTimeoutMs: 200 });
    await assert.rejects(client.muteClients(['x']), /TeamSpeak не ответил/);
  } finally { await new Promise(resolve => ts.server.close(resolve)); }
});

test('нет приветствия → русская ошибка, login не отправляется', async () => {
  const ts = await fakeTs({ welcome: false });
  try {
    const client = createTeamspeak({ ...base, ...opts, port: ts.port, connectTimeoutMs: 200 });
    await assert.rejects(client.ensureMuteGroup(), /TeamSpeak не ответил/);
    assert.deepEqual(ts.received, []);
  } finally { await new Promise(resolve => ts.server.close(resolve)); }
});

test('clientList: обёртка для «кто онлайн»', async () => {
  const ts = await fakeTs({ replies: new Map([
    ['clientlist', { body: 'clid=4 cid=2 client_database_id=55 nickname=Foo\\sBar|clid=5 cid=3 client_database_id=56 nickname=Bob' }],
  ]) });
  try {
    const client = createTeamspeak({ ...base, ...opts, port: ts.port });
    const list = await client.clientList();
    assert.deepEqual(list, [
      { clId: 4, cid: 2, nick: 'Foo Bar', dbId: 55 },
      { clId: 5, cid: 3, nick: 'Bob', dbId: 56 },
    ]);
  } finally { await new Promise(resolve => ts.server.close(resolve)); }
});

test('clientList: пропущенных полей не боится', async () => {
  const ts = await fakeTs({ replies: new Map([
    ['clientlist', { body: 'clid=4 nickname=Foo|clid=5 client_database_id=56' }],
  ]) });
  try {
    const client = createTeamspeak({ ...base, ...opts, port: ts.port });
    const list = await client.clientList();
    assert.deepEqual(list, [
      { clId: 4, cid: null, nick: 'Foo', dbId: null },
      { clId: 5, cid: null, nick: '', dbId: 56 },
    ]);
  } finally { await new Promise(resolve => ts.server.close(resolve)); }
});

test('без логина/пароля — русская ошибка настройки', async () => {
  const client = createTeamspeak({ host: '127.0.0.1', port: 1, netImpl: net });
  await assert.rejects(client.muteClients(['x']), /TS_QUERY_LOGIN/);
  const client2 = createTeamspeak({ host: '127.0.0.1', port: 1, login: 'a', netImpl: net });
  await assert.rejects(client2.muteClients(['x']), /TS_QUERY_PASSWORD/);
});

test('сервер недоступен (порт закрыт) → русская ошибка', async () => {
  const closed = net.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const client = createTeamspeak({ ...base, ...opts, port });
  await assert.rejects(client.muteClients(['x']), /TeamSpeak недоступен/);
});
