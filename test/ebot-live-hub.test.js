import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createLiveHub } from '../server/ebot-live-hub.js';
import { createMuteEngine, parseLogLine } from '../server/ts-mute.js';

// Хаб живого потока (server/ebot-live-hub.js): события eBot уходят
// подписчикам SSE с replay-буфером, движок мьюта питается статусами,
// килами и строками лога, POST start/stop валидирует матч и same-origin.
// eBot-поток мокаем через fetchImpl (паттерн ebot-live.test.js: мок
// websocket-сервера engine.io).

function fakeNow() {
  let t = 0;
  return () => t += 1000;
}

async function until(cond, label = '', ms = 2000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('не дождались: ' + label);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Мок eBot websocket: рукопожатие + пачки событий по поллингам.
function mockEbot({ scripts = [] } = {}) {
  let handshakes = 0;
  const pollIdx = new Map();
  const fn = async (url, init = {}) => {
    await new Promise((r) => setTimeout(r, 2));
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'GET' && !target.includes('sid=')) {
      handshakes++;
      pollIdx.set(handshakes, 0);
      return new Response('0{"sid":"S' + handshakes + '","pingInterval":25000}', { headers: { 'content-type': 'text/plain' } });
    }
    if (method === 'POST') return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    const idx = pollIdx.get(handshakes) || 0;
    const script = scripts[handshakes - 1] || [];
    if (idx >= script.length) return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    pollIdx.set(handshakes, idx + 1);
    return new Response(script[idx], { headers: { 'content-type': 'text/plain' } });
  };
  fn.getJwt = async () => 'jwt-token';
  return fn;
}

const packet = (name, payload) => '42' + JSON.stringify([name, payload]);
const matchs = (obj) => packet('matchsHandler', JSON.stringify(obj));

function fakeRes() {
  const res = new Readable({ read() {} });
  res.chunks = [];
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
  res.end = (chunk) => { if (chunk) res.chunks.push(String(chunk)); res.ended = true; res.emit('close'); };
  return res;
}

const fakeReq = (url, headers = {}) => ({
  url, method: 'GET', headers,
  on: () => {}, once: () => {}, resume: () => {},
});

function sseData(res) {
  const out = [];
  for (const block of res.chunks.join('').split('\n\n')) {
    if (!block || block.startsWith(':')) continue;
    const data = (block.match(/^data: (.+)$/m) || [])[1];
    if (data !== undefined) out.push(JSON.parse(data));
  }
  return out;
}

function postReq(body, headers = {}) {
  const req = {
    url: '/api/ebot-live', method: 'POST', headers,
    on(name, fn) {
      if (name === 'data') fn(Buffer.from(body));
      if (name === 'end') fn();
      return req;
    },
    once() { return req; },
    resume() { return req; },
  };
  return req;
}

const makeHub = (ebot, extra = {}) => createLiveHub({
  getJwt: ebot.getJwt, baseWsUrl: 'http://ebot.test',
  fetchImpl: ebot, now: fakeNow(), log: () => {},
  ...extra,
});

test('live hub: события eBot идут в SSE с hello и replay-буфером', async () => {
  const ebot = mockEbot({ scripts: [[
    matchs({ message: 'score', scoreA: 6, scoreB: 3, id: 42 }),
    matchs({ message: 'status', content: 'First side - #7', id: 42 }),
  ]] });
  const hub = makeHub(ebot);
  try {
    await hub.start(42);
    const res1 = fakeRes();
    assert.equal(hub.sseHandler(fakeReq('/api/ebot-live'), res1), true);
    await until(() => res1.chunks.length >= 3, 'события первому клиенту');
    // Второй клиент получает replay тех же событий после hello.
    const res2 = fakeRes();
    hub.sseHandler(fakeReq('/api/ebot-live'), res2);
    const first = sseData(res1);
    assert.deepEqual(first[0], { type: 'hello', matchId: '42' });
    assert.ok(first.some(e => e.type === 'score' && e.scoreA === 6));
    const second = sseData(res2);
    assert.deepEqual(second[0], { type: 'hello', matchId: '42' });
    assert.ok(second.some(e => e.type === 'score' && e.scoreA === 6));
    assert.ok(second.some(e => e.type === 'status' && e.phase === 'live'));
  } finally {
    hub.stop();
  }
});

test('live hub: без открытого потока SSE отвечает 404', async () => {
  const ebot = mockEbot();
  const hub = makeHub(ebot);
  const res = fakeRes();
  assert.equal(hub.sseHandler(fakeReq('/api/ebot-live'), res), true);
  assert.equal(res.status, 404);
  assert.equal(hub.sessionCount(), 0);
});

test('live hub: строки лога консоли кормят движок мьюта через хаб', async () => {
  // Поток задаёт фазы движку (status-события); строки лога консоли —
  // движения раунда. Честный сценарий: live-фаза → freeze → килл (мьют).
  const ebot = mockEbot({ scripts: [[
    matchs({ message: 'status', content: 'First side - #1', id: 42 }),
  ]] });
  const calls = [];
  const engine = createMuteEngine({
    onMute: () => calls.push('mute'),
    onUnmute: () => calls.push('unmute'),
    onNote: () => {},
  });
  const hub = makeHub(ebot);
  try {
    await hub.start(42, engine);
    const res = fakeRes();
    hub.sseHandler(fakeReq('/api/ebot-live'), res);
    // Ждём live-фазу в SSE: движок узнаёт фазу из status-событий, а киллы
    // без известной фазы не мьютят (безопасная сторона).
    await until(() => sseData(res).some(e => e.type === 'status' && e.phase === 'live'), 'фаза live пришла');
    // Консольные строки: Round_Start (freeze) и килл — килл в live мьютит.
    hub.feedLogLine('World triggered "Round_Start"');
    hub.feedLogLine('"Nick<2><[U:1:5]><CT>" [-1070 1271 -108] killed "Foe<3><[U:1:9]><TERRORIST>" [892 1188 -63] with "ak47"');
    await until(() => calls.includes('mute'), 'килл из лога замьютил');
    // Новый freeze (следующий раунд) размьючивает.
    const before = calls.lastIndexOf('mute');
    hub.feedLogLine('World triggered "Round_Start"');
    await until(() => calls.lastIndexOf('unmute') > before, 'freeze из лога размьютил');
    // Мусорная строка движка не трогает.
    const beforeJunk = calls.length;
    hub.feedLogLine('some garbage line');
    hub.feedLogLine('"Nick" say "I killed Foe with ak47"');
    assert.equal(calls.length, beforeJunk, 'мусор и say-подделка не кормят движок');
  } finally {
    hub.stop();
  }
});

test('live hub: POST start валидирует матч, stop закрывает, смену матча переживает', async () => {
  const ebot = mockEbot({ scripts: [[
    matchs({ message: 'score', scoreA: 1, scoreB: 0, id: 7 }),
  ]] });
  const hub = makeHub(ebot);
  const res = fakeRes();
  const bad = await hub.postHandler(postReq(JSON.stringify({ action: 'start', matchId: 'abc' }), { 'sec-fetch-site': 'same-origin' }), res);
  assert.equal(bad, true);
  assert.equal(res.status, 400);
  const res2 = fakeRes();
  const ok = await hub.postHandler(postReq(JSON.stringify({ action: 'start', matchId: 7, coaches: ['Тренер Раз', ''] }), { 'sec-fetch-site': 'same-origin' }), res2);
  assert.equal(ok, true);
  assert.equal(res2.status, 200);
  // Чужой origin не пускает.
  const res3 = fakeRes();
  await hub.postHandler(postReq(JSON.stringify({ action: 'stop' }), { 'sec-fetch-site': 'cross-site' }), res3);
  assert.equal(res3.status, 403);
  const res4 = fakeRes();
  await hub.postHandler(postReq(JSON.stringify({ action: 'stop' }), { 'sec-fetch-site': 'same-origin' }), res4);
  assert.equal(res4.status, 200);
  assert.equal(hub.sessionCount(), 0);
});

test('live hub: повторный start закрывает прежний поток, клиенты получают stop', async () => {
  const ebot = mockEbot({ scripts: [[
    matchs({ message: 'status', content: 'Starting', id: 1 }),
  ], [
    matchs({ message: 'status', content: 'Starting', id: 2 }),
  ]] });
  const hub = makeHub(ebot);
  try {
    await hub.start(1);
    const res = fakeRes();
    hub.sseHandler(fakeReq('/api/ebot-live'), res);
    await until(() => res.chunks.length >= 2, 'первое событие');
    await hub.start(2);
    const events = sseData(res);
    assert.ok(events.some(e => e.type === 'stop'));
    assert.equal(hub.sessionCount(), 1);
    assert.equal(String(hub.session.matchId), '2');
  } finally {
    hub.stop();
  }
});

test('parseLogLine: Round_Start и килл распознаются для кормления движка', () => {
  assert.equal(parseLogLine('World triggered "Round_Start"')?.type, 'round_start');
  assert.equal(parseLogLine('World triggered "Round_End"')?.type, 'round_end');
  const kill = parseLogLine('"Nick<2><[U:1:5]><CT>" [-1070 1271 -108] killed "Foe<3><[U:1:9]><TERRORIST>" [892 1188 -63] with "ak47"');
  assert.equal(kill?.type, 'kill');
  assert.equal(parseLogLine('garbage'), null);
});

test('движок мьюта игнорирует события чужих матчей', async () => {
  const ebot = mockEbot({ scripts: [[
    matchs({ message: 'status', content: 'First side - #1', id: 42 }) + '\x1e' +
      // Чужой матч: пауза и стоп не должны тронуть движок матча 42.
      matchs({ message: 'status', content: 'is_paused', id: 99 }) + '\x1e' +
      matchs({ message: 'button', content: 'stop', id: 99 }),
  ]] });
  const calls = [];
  const engine = createMuteEngine({
    onMute: () => calls.push('mute'),
    onUnmute: () => calls.push('unmute'),
    onNote: () => {},
  });
  const hub = makeHub(ebot);
  try {
    await hub.start(42, engine);
    const res = fakeRes();
    hub.sseHandler(fakeReq('/api/ebot-live'), res);
    await until(() => sseData(res).some(e => e.type === 'status' && e.phase === 'live'), 'фаза live пришла');
    // Кормим свои строки: чужая пауза не должна была сломать мьют.
    hub.feedLogLine('World triggered "Round_Start"');
    hub.feedLogLine('"Nick<2><[U:1:5]><CT>" [-1070 1271 -108] killed "Foe<3><[U:1:9]><TERRORIST>" [892 1188 -63] with "ak47"');
    await until(() => calls.includes('mute'), 'килл замьютил несмотря на чужую паузу');
  } finally {
    hub.stop();
  }
});

test('stop() хаба шлёт движку finished — мьют снимается при закрытии', async () => {
  const ebot = mockEbot({ scripts: [[
    matchs({ message: 'status', content: 'First side - #1', id: 42 }),
  ]] });
  const calls = [];
  const engine = createMuteEngine({
    onMute: () => calls.push('mute'),
    onUnmute: () => calls.push('unmute'),
    onNote: () => {},
  });
  const hub = makeHub(ebot);
  await hub.start(42, engine);
  const res = fakeRes();
  hub.sseHandler(fakeReq('/api/ebot-live'), res);
  await until(() => sseData(res).some(e => e.type === 'status' && e.phase === 'live'), 'фаза live');
  hub.feedLogLine('World triggered "Round_Start"');
  hub.feedLogLine('"Nick<2><[U:1:5]><CT>" [-1070 1271 -108] killed "Foe<3><[U:1:9]><TERRORIST>" [892 1188 -63] with "ak47"');
  await until(() => calls.includes('mute'), 'килл замьютил');
  // Закрытие потока оператором — мьют обязан сняться без событий eBot.
  hub.stop();
  await until(() => calls.lastIndexOf('unmute') > calls.lastIndexOf('mute'), 'stop снял мьют');
});

test('attachMute сбрасывает движок: новый матч стартует с чистого состояния', async () => {
  const ebot = mockEbot({ scripts: [[
    matchs({ message: 'status', content: 'First side - #1', id: 1 }),
  ], [
    // Второй матч — тот же текст статуса: без reset подавился бы.
    matchs({ message: 'status', content: 'First side - #1', id: 2 }),
  ]] });
  const calls = [];
  const engine = createMuteEngine({
    onMute: () => calls.push('mute'),
    onUnmute: () => calls.push('unmute'),
    onNote: () => {},
  });
  const hub = makeHub(ebot);
  try {
    await hub.start(1, engine);
    const res = fakeRes();
    hub.sseHandler(fakeReq('/api/ebot-live'), res);
    await until(() => sseData(res).some(e => e.type === 'status' && e.phase === 'live'), 'фаза матча 1');
    // Пауза в первом матче зависла (is_unpaused не пришёл).
    engine.feed({ type: 'paused', paused: true });
    // Смена матча: reset обязан снять зависшую паузу.
    await hub.start(2, engine);
    const res2 = fakeRes();
    hub.sseHandler(fakeReq('/api/ebot-live'), res2);
    await until(() => sseData(res2).some(e => e.type === 'status' && e.phase === 'live'), 'фаза матча 2');
    // Килл во втором матче должен мьютить: зависшая пауза снята.
    hub.feedLogLine('World triggered "Round_Start"');
    hub.feedLogLine('"Nick<2><[U:1:5]><CT>" [-1070 1271 -108] killed "Foe<3><[U:1:9]><TERRORIST>" [892 1188 -63] with "ak47"');
    await until(() => calls.includes('mute'), 'килл нового матча мьютит после reset');
  } finally {
    hub.stop();
  }
});
