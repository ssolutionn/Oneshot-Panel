import test from 'node:test';
import assert from 'node:assert/strict';
import { createEbotLive, ebotPhase } from '../server/ebot-live.js';

// Живой поток eBot: поверх настоящей socketioSession из server/ebot-admin.js,
// поэтому мокаем только fetchImpl, который изображает websocket-сервер eBot
// (рукопожатие, ack POST, GET-поллинги с пачками событий через \x1e).
// Часы — поддельные с быстрым ходом: паузы реконнекта 5–30 «секунд»
// пролетают за миллисекунды, тест не висит.

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJhZG1pbiI6dHJ1ZX0.sig';
const PLAIN = { 'content-type': 'text/plain' };

// Часы, шагающие вперёд на step при каждом вызове: nextEvent досчитывает
// свои 15 «с» таймаута за десяток вызовов, пауза реконнекта — за пару тиков.
function fakeNow(step = 1000) {
  let t = 100_000;
  return () => (t += step);
}

// Ждём условия по реальному времени (события приезжают асинхронно).
async function until(cond, label = '', ms = 2000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('не дождались: ' + label);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Мок eBot websocket-сервера. На каждое соединение — свой сценарий GET-поллингов:
// массив строк-пачек engine.io; { error: true } — сетевой отказ; исчерпан — тишина «ok».
function mockEbot({ scripts = [] } = {}) {
  const calls = [];
  let handshakes = 0;
  let jwtCalls = 0;
  const pollIdx = new Map();
  // Асинхронный с реальной микрозадержкой: синхронный мок замыкал цикл
  // поллинга на микрозадачах — таймеры until() не получали управления (OOM).
  const fn = async (url, init = {}) => {
    await new Promise((r) => setTimeout(r, 2));
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const body = String(init.body || '');
    calls.push({ url: target, method, body });
    if (method === 'GET' && !target.includes('sid=')) {
      handshakes++;
      pollIdx.set(handshakes, 0);
      return new Response('0{"sid":"S' + handshakes + '","pingInterval":25000,"pingTimeout":60000}', { headers: PLAIN });
    }
    if (method === 'POST') return new Response('ok', { headers: PLAIN });
    // GET-поллинг текущего соединения: следующий шаг сценария.
    // Шаг — строка-пачка, { body, delay } (пауза перед ответом) или { error }.
    const idx = pollIdx.get(handshakes) || 0;
    const script = scripts[handshakes - 1] || [];
    if (idx >= script.length) return new Response('ok', { headers: PLAIN });
    pollIdx.set(handshakes, idx + 1);
    const step = script[idx];
    if (step && step.error) throw new Error('network down');
    if (step && step.delay) await new Promise((r) => setTimeout(r, step.delay));
    return new Response(typeof step === 'string' ? step : step.body, { headers: PLAIN });
  };
  fn.calls = calls;
  fn.handshakes = () => handshakes;
  fn.getJwt = async () => { jwtCalls++; return JWT; };
  fn.jwtCalls = () => jwtCalls;
  return fn;
}

// Пачка: события engine.io склеены \x1e.
const packet = (name, payload) => '42' + JSON.stringify([name, payload]);
const matchs = (obj) => packet('matchsHandler', JSON.stringify(obj));

// ---------- ebotPhase: все тексты статуса eBot ----------

test('ebotPhase: известные тексты → фазы, номера раундов разбираются', () => {
  assert.equal(ebotPhase('Not started'), 'not-started');
  assert.equal(ebotPhase('Starting'), 'starting');
  assert.equal(ebotPhase('Warmup Knife'), 'warmup');
  assert.equal(ebotPhase('Knife Round'), 'knife');
  assert.equal(ebotPhase('Waiting choose team - Knife Round'), 'waiting');
  assert.equal(ebotPhase('Warmup first side'), 'warmup');
  assert.equal(ebotPhase('First side - #5'), 'live');
  assert.equal(ebotPhase('Warmup second side'), 'warmup');
  assert.equal(ebotPhase('Second side - #12'), 'live');
  assert.equal(ebotPhase('Warmup first side OverTime'), 'warmup');
  assert.equal(ebotPhase('First side OverTime - #2'), 'live');
  assert.equal(ebotPhase('Warmup second side OverTime'), 'warmup');
  assert.equal(ebotPhase('Second side OverTime - #3'), 'live');
  assert.equal(ebotPhase('Finished'), 'finished');
  // Номера не захардкожены: любой номер и овертайм разбираются.
  assert.equal(ebotPhase('First side - #1'), 'live');
  assert.equal(ebotPhase('Second side OverTime - #30'), 'live');
});

test('ebotPhase: неизвестный текст и мусор → null', () => {
  assert.equal(ebotPhase('Что-то новое'), null);
  assert.equal(ebotPhase('First side - #'), null);
  assert.equal(ebotPhase('First side'), null);
  assert.equal(ebotPhase(''), null);
  assert.equal(ebotPhase(null), null);
  assert.equal(ebotPhase(undefined), null);
  assert.equal(ebotPhase(123), null);
});

// ---------- нормализация событий ----------

test('identify: start шлёт matchs и livemap с номером матча', async () => {
  const ebot = mockEbot();
  const live = createEbotLive({
    getJwt: ebot.getJwt, baseWsUrl: 'http://ebot.test', matchId: '42',
    fetchImpl: ebot, now: fakeNow(), log: () => {},
  });
  try {
    await live.start();
  } finally {
    live.stop();
    await live.done();
  }
  const bodies = ebot.calls.filter(c => c.method === 'POST').map(c => c.body);
  assert.ok(bodies.includes('42["identify",{"type":"matchs"}]'), JSON.stringify(bodies));
  assert.ok(bodies.includes('42["identify",{"type":"livemap","match_id":42}]'), JSON.stringify(bodies));
});

test('нормализация: score/status/paused/stop/teams/map из строк-payload, kill/newRound из объектов', async () => {
  const ebot = mockEbot({ scripts: [[
    // payload строкой-JSON, как их рассылает redis-путь eBot
    matchs({ message: 'score', scoreA: 6, scoreB: 3, id: 42 }) + '\x1e' +
      matchs({ message: 'status', content: 'First side - #5', id: 42 }) + '\x1e' +
      matchs({ message: 'status', content: 'is_paused', id: 42 }) + '\x1e' +
      matchs({ message: 'button', content: 'stop', id: 42 }) + '\x1e' +
      matchs({ message: 'teams', teamA: 'ct', teamB: 't', id: 42 }) + '\x1e' +
      matchs({ message: 'currentMap', mapname: 'de_mirage', id: 42 }) + '\x1e' +
      // payload уже объектом, как POST-путь eBot
      packet('livemapHandler', {
        type: 'kill', id: 42, killer: 'Nick', killerPosX: 1234, killerPosY: 567,
        weapon: 'ak47', killed: 'Nick2', killedPosX: 100, killedPosY: 200, headshot: true,
      }) + '\x1e' +
      packet('livemapHandler', {
        type: 'newRound', id: 42, message: 'newRound', round: 7, status: 'First side - #7',
      }),
    // мусор: не-JSON строка, null-payload, чужой обработчик, незнакомое message,
    // score без чисел, kill без id — всё молча пропускается
    '42["matchsHandler","это не JSON"]\x1e' +
      '42["matchsHandler",null]\x1e' +
      '42["unknownHandler",{"message":"score","id":42}]\x1e' +
      matchs({ message: '???', id: 42 }) + '\x1e' +
      matchs({ message: 'score', scoreA: 'x', scoreB: 3, id: 42 }) + '\x1e' +
      packet('livemapHandler', { type: 'kill', killer: 'X' }) + '\x1e' +
      matchs({ message: 'streamerReady', id: 42 }),
  ]] });
  const events = [];
  const live = createEbotLive({
    getJwt: ebot.getJwt, baseWsUrl: 'http://ebot.test', matchId: 42,
    fetchImpl: ebot, now: fakeNow(), log: () => {},
  });
  // Сломавшийся подписчик не должен ронять поток — рядом ставим бросающий.
  live.subscribe(() => { throw new Error('подписчик сломался'); });
  live.subscribe((ev) => events.push(ev));
  await live.start();
  try {
    await until(() => events.length >= 8, '8 событий, есть ' + events.length);
  } finally {
    live.stop();
    await live.done();
  }

  assert.deepEqual(events.find(e => e.type === 'score'), { type: 'score', matchId: 42, scoreA: 6, scoreB: 3 });
  assert.deepEqual(events.find(e => e.type === 'status'), { type: 'status', matchId: 42, text: 'First side - #5', phase: 'live' });
  assert.deepEqual(events.find(e => e.type === 'paused'), { type: 'paused', matchId: 42, paused: true });
  assert.deepEqual(events.find(e => e.type === 'stop'), { type: 'stop', matchId: 42 });
  assert.deepEqual(events.find(e => e.type === 'teams'), { type: 'teams', matchId: 42, teamA: 'ct', teamB: 't' });
  assert.deepEqual(events.find(e => e.type === 'map'), { type: 'map', matchId: 42, name: 'de_mirage' });
  // posX/posY — числами, headshot — булевым
  assert.deepEqual(events.find(e => e.type === 'kill'), {
    type: 'kill', matchId: 42, killer: 'Nick', killerPosX: 1234, killerPosY: 567,
    weapon: 'ak47', killed: 'Nick2', killedPosX: 100, killedPosY: 200, headshot: true,
  });
  assert.deepEqual(events.find(e => e.type === 'newRound'), {
    type: 'newRound', matchId: 42, round: 7, status: 'First side - #7', phase: 'live',
  });
  // Мусор не породил ни одного лишнего события.
  assert.equal(events.length, 8, JSON.stringify(events));
});

test('is_unpaused → paused:false; Waiting choose team → фаза waiting', async () => {
  const ebot = mockEbot({ scripts: [[
    matchs({ message: 'status', content: 'is_unpaused', id: 42 }) + '\x1e' +
      matchs({ message: 'status', content: 'Waiting choose team - Knife Round', id: 42 }),
  ]] });
  const events = [];
  const live = createEbotLive({
    getJwt: ebot.getJwt, baseWsUrl: 'http://ebot.test',
    fetchImpl: ebot, now: fakeNow(), log: () => {},
  });
  live.subscribe((ev) => events.push(ev));
  await live.start();
  try {
    await until(() => events.length >= 2, 'снятие паузы и статус');
  } finally {
    live.stop();
    await live.done();
  }
  assert.deepEqual(events.find(e => e.type === 'paused'), { type: 'paused', matchId: 42, paused: false });
  assert.deepEqual(events.find(e => e.type === 'status'),
    { type: 'status', matchId: 42, text: 'Waiting choose team - Knife Round', phase: 'waiting' });
});

// ---------- реконнект и stop ----------

test('обрыв polling-а: переподключение с новым JWT, события продолжаются', async () => {
  const logs = [];
  const ebot = mockEbot({ scripts: [
    // соединение 1: одно событие, затем сетевой отказ GET-поллинга
    [matchs({ message: 'score', scoreA: 1, scoreB: 0, id: 42 }), { error: true }],
    // соединение 2: событие приезжает снова
    [matchs({ message: 'score', scoreA: 2, scoreB: 0, id: 42 })],
  ] });
  const events = [];
  const live = createEbotLive({
    getJwt: ebot.getJwt, baseWsUrl: 'http://ebot.test', matchId: 42,
    fetchImpl: ebot, now: fakeNow(), log: (m) => logs.push(String(m)),
  });
  live.subscribe((ev) => events.push(ev));
  await live.start();
  try {
    await until(() => events.length >= 2, 'событие после реконнекта');
  } finally {
    live.stop();
    await live.done();
  }
  // Два соединения — два рукопожатия и два JWT (перед каждым подключением).
  assert.equal(ebot.handshakes(), 2, 'рукопожатий ' + ebot.handshakes());
  assert.equal(ebot.jwtCalls(), 2, 'getJwt вызовов ' + ebot.jwtCalls());
  assert.deepEqual(events.map(e => e.scoreA), [1, 2]);
  // Обрыв и пауза реконнекта описаны в логе по-русски.
  assert.ok(logs.some((m) => /потеряно/.test(m)), JSON.stringify(logs));
  assert.ok(logs.some((m) => /5 с/.test(m)), JSON.stringify(logs));
});

test('stop() завершает цикл: done() резолвится, новых соединений и JWT нет', async () => {
  const ebot = mockEbot({ scripts: [[
    matchs({ message: 'status', content: 'Starting', id: 42 }),
  ]] });
  const events = [];
  const live = createEbotLive({
    getJwt: ebot.getJwt, baseWsUrl: 'http://ebot.test', matchId: 42,
    fetchImpl: ebot, now: fakeNow(), log: () => {},
  });
  live.subscribe((ev) => events.push(ev));
  await live.start();
  try {
    await until(() => events.length >= 1, 'первое событие');
  } finally {
    live.stop();
  }
  // Повторный стоп безопасен.
  live.stop();
  // Цикл завершается быстро, а не висит в поллинге.
  await Promise.race([
    live.done(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('done() не завершился')), 1000)),
  ]);
  const jwtBefore = ebot.jwtCalls();
  const hsBefore = ebot.handshakes();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ebot.jwtCalls(), jwtBefore, 'getJwt после stop');
  assert.equal(ebot.handshakes(), hsBefore, 'рукопожатий после stop');
});

test('setMatchId переподключается с новым identify livemap', async () => {
  const ebot = mockEbot({ scripts: [[
    matchs({ message: 'status', content: 'Starting', id: 42 }),
  ], [
    matchs({ message: 'score', scoreA: 3, scoreB: 1, id: 7 }),
  ]] });
  const events = [];
  const live = createEbotLive({
    getJwt: ebot.getJwt, baseWsUrl: 'http://ebot.test', matchId: 42,
    fetchImpl: ebot, now: fakeNow(), log: () => {},
  });
  live.subscribe((ev) => events.push(ev));
  await live.start();
  try {
    await until(() => events.length >= 1, 'событие первого матча');
    live.setMatchId(7);
    await until(() => events.length >= 2, 'событие матча 7 после смены');
  } finally {
    live.stop();
    await live.done();
  }
  const bodies = ebot.calls.filter(c => c.method === 'POST').map(c => c.body);
  assert.ok(bodies.includes('42["identify",{"type":"livemap","match_id":42}]'), JSON.stringify(bodies));
  assert.ok(bodies.includes('42["identify",{"type":"livemap","match_id":7}]'), JSON.stringify(bodies));
});

test('createEbotLive: без getJwt и с битым адресом — понятные ошибки', () => {
  assert.throws(() => createEbotLive({ baseWsUrl: 'http://ebot.test' }), /getJwt/);
  assert.throws(() => createEbotLive({ getJwt: async () => 'x', baseWsUrl: '___' }), /адрес/i);
});

test('подписка отписывается: события после отписки не приходят', async () => {
  // Первая пачка в поллинге, вторая — в следующем, с задержкой: успеваем
  // отписаться до её доставки. До второго события nextEvent тихо вернёт null.
  const ebot = mockEbot({ scripts: [[
    matchs({ message: 'status', content: 'Starting', id: 42 }),
    { body: matchs({ message: 'status', content: 'First side - #1', id: 42 }), delay: 60 },
  ]] });
  const events = [];
  const live = createEbotLive({
    getJwt: ebot.getJwt, baseWsUrl: 'http://ebot.test',
    fetchImpl: ebot, now: fakeNow(), log: () => {},
  });
  try {
    const off = live.subscribe((ev) => events.push(ev));
    live.subscribe((ev) => events.push(ev)); // второй подписчик остаётся
    await live.start();
    await until(() => events.length >= 2, 'первое событие обоим');
    off();
    await until(() => events.length >= 3, 'второе событие оставшемуся');
    // Первое событие пришло обоим, второе — только оставшемуся.
    assert.equal(events.length, 3, JSON.stringify(events));
    assert.equal(events.filter(e => e.text === 'First side - #1').length, 1);
  } finally {
    // stop() обязателен даже при упавшем ассерте — иначе цикл живёт и тест висит
    live.stop();
    await live.done();
  }
});
