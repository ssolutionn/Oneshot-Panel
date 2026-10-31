import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEbotMatches, isLive, ebotEvents, ebotStatusLine, EBOT_PROXY
} from '../ebot.js';
import { proxyEbot, ebotTarget, __ttlScale } from '../netlify/functions/ebot.mjs';

// TTL кэшей страницы списка/вьюхи масштабируем в тестах: соседние проверки
// подменяют fetch и не должны получать кэшированную чужой мок-страницу,
// а проверка самого кэша не должна ждать настоящие 7 секунд.
__ttlScale.ms = 0;
import { onRequest as cloudflareEbot } from '../functions/api/ebot.js';

// The two list layouts eBot-CSGO-Web serves: the home page (flag cells
// around the names) and /matchs/current (without them).
const HOME_ROW = `
<tr>
  <td width="20" style="padding-left: 10px;"><span style="float:left">#46</span></td>
  <td width="16"><i class='flag flag-'></i></td>
  <td width="125"><span style="float:left"><font color="red">PRIVATE</font></span></td>
  <td width="50"><div class="score" id="score-46"><font color="green">16</font> - <font color="red">14</font></div></td>
  <td width="125"><span style="text-align:right; float:right;"><font color="blue">Nuclear TigeRES</font></span></td>
  <td width="16"><i class='flag flag-'></i></td>
  <td width="50">de_dust2</td>
  <td width="50"></td>
  <td width="50"></td>
  <td><div class="status status-46">Finished</div></td>
  <td width="60">Show</td>
</tr>`;
const CURRENT_ROW = `
<tr>
  <td width="20" style="padding-left: 10px;"><span style="float:left">#47</span></td>
  <td width="200">PRIVATE</td>
  <td width="50"><div class="score" id="score-47">00 - 03</div></td>
  <td width="125">Nuclear TigeRES</td>
  <td width="50">de_anubis</td>
  <td width="50"></td>
  <td><div class="status status-47">First side - #4</div></td>
  <td width="60">Show</td>
</tr>`;
const page = (rows) => `<html><body><table class="table">${rows}</table></body></html>`;

test('eBot home rows: names beside the score, map, status, score digits', () => {
  const matches = parseEbotMatches(page(HOME_ROW));
  assert.equal(matches.length, 1);
  assert.deepEqual(
    { id: matches[0].id, teamA: matches[0].teamA, teamB: matches[0].teamB, map: matches[0].map,
      scoreA: matches[0].scoreA, scoreB: matches[0].scoreB, status: matches[0].status },
    { id: '46', teamA: 'PRIVATE', teamB: 'Nuclear TigeRES', map: 'de_dust2',
      scoreA: 16, scoreB: 14, status: 'Finished' });
});

test('eBot current rows: the layout without flag cells parses the same way', () => {
  const matches = parseEbotMatches(page(CURRENT_ROW));
  assert.equal(matches.length, 1);
  assert.deepEqual(
    { id: matches[0].id, teamA: matches[0].teamA, teamB: matches[0].teamB, map: matches[0].map,
      scoreA: matches[0].scoreA, scoreB: matches[0].scoreB, status: matches[0].status },
    { id: '47', teamA: 'PRIVATE', teamB: 'Nuclear TigeRES', map: 'de_anubis',
      scoreA: 0, scoreB: 3, status: 'First side - #4' });
});

test('rows without a score div are not matches', () => {
  assert.deepEqual(parseEbotMatches(page('<tr><td>header</td></tr>')), []);
  assert.deepEqual(parseEbotMatches(''), []);
});

test('a running match is live, finished and stopped ones are not', () => {
  const match = parseEbotMatches(page(CURRENT_ROW))[0];
  assert.equal(isLive(match), true);
  assert.equal(isLive({ ...match, status: 'Finished' }), false);
  assert.equal(isLive({ ...match, status: 'Stopped by admin' }), false);
});

test('score and status changes become journal notes, new matches announce themselves', () => {
  const start = parseEbotMatches(page(CURRENT_ROW));
  const moved = [{ ...start[0], scoreA: 7, scoreB: 5, status: 'Second side' }];
  let events = ebotEvents(start, moved);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'score');
  assert.equal(events[0].text, 'eBot: PRIVATE 7:5 Nuclear TigeRES');

  events = ebotEvents(start, [{ ...start[0], status: 'Second side' }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'status');
  assert.match(events[0].text, /First side - #4 → Second side/);

  events = ebotEvents([], start);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'start');

  const finished = [{ ...start[0], scoreA: 13, scoreB: 9, status: 'Finished' }];
  events = ebotEvents(start, finished);
  assert.equal(events[0].type, 'match');
  assert.match(events[0].text, /матч завершён, победа PRIVATE/);
});

test('status line counts running and finished matches', () => {
  const matches = parseEbotMatches(page(HOME_ROW + CURRENT_ROW));
  assert.match(ebotStatusLine(matches, 0), /идут 1 · завершено 1/);
  assert.match(ebotStatusLine(matches, Date.UTC(2026, 0, 2, 10, 30)), /обновлено/);
});

// ---------- proxy ----------

test('the proxy target is a fixed http(s) host, no injection from the request', async () => {
  assert.equal(ebotTarget('').href, 'http://37.230.228.105/');
  assert.equal(ebotTarget('http://10.0.0.5:80/ebot/').href, 'http://10.0.0.5/ebot/');
  assert.equal(ebotTarget('javascript:alert(1)'), null);
  assert.equal(ebotTarget('http://user:pass@evil.example/'), null);
  assert.equal(ebotTarget('http://evil.example/?next=http://x'), null);
});

test('the proxy answers only a plain GET of its own path', async () => {
  for (const bad of [
    new Request('http://localhost/api/ebot', { method: 'POST' }),
    new Request('http://localhost/api/ebot?host=http://evil.example/')
  ]) {
    const reply = await proxyEbot(bad, '');
    assert.equal(reply.status, 400);
    const body = await reply.json();
    assert.equal(body.error, 'not-allowed');
  }
});

test('the proxy fetches the match list page and returns it as JSON', async () => {
  let asked = '';
  const fetchImpl = (url, init) => {
    asked = url;
    return Promise.resolve(new Response(page(HOME_ROW), { status: 200 }));
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const reply = await proxyEbot(new Request('http://localhost/api/ebot'), '');
    assert.equal(reply.status, 200);
    assert.equal(String(asked), 'http://37.230.228.105/matchs/current');
    const body = await reply.json();
    assert.deepEqual(parseEbotMatches(body.page).map(m => m.teamA), ['PRIVATE']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an upstream failure or closed list is a plain 502, no page leak', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response('', { status: 302, headers: { location: '/login' } }));
  try {
    const redirect = await proxyEbot(new Request('http://localhost/api/ebot'), '');
    assert.equal(redirect.status, 502);
    assert.equal((await redirect.json()).error, 'upstream');
    globalThis.fetch = () => Promise.reject(new Error('timeout'));
    const down = await proxyEbot(new Request('http://localhost/api/ebot'), '');
    assert.equal(down.status, 502);
    assert.equal((await down.json()).error, 'upstream');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the page cache serves a second hit without a new upstream fetch', async () => {
  // Внутри теста TTL реальный (7 с): проверяем кэш как в проде. Снаружи
  // (для соседних тестов) он обнулён, чтобы этот кэш на них не влиял.
  const originalScale = __ttlScale.ms;
  __ttlScale.ms = 1;
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetches++;
    return Promise.resolve(new Response(page(HOME_ROW), { status: 200 }));
  };
  try {
    // Свои EBOT_URL (и свой ключ кэша): страница, закэшированная
    // предыдущими тестами под дефолтным адресом, не должна попадать сюда.
    const envUrl = 'http://10.0.0.7:80/';
    const first = await proxyEbot(new Request('http://localhost/api/ebot'), envUrl);
    assert.equal(first.status, 200);
    assert.equal(fetches, 1);
    const second = await proxyEbot(new Request('http://localhost/api/ebot'), envUrl);
    assert.equal(second.status, 200);
    // Второй подряд запрос не ходит в eBot: страница моложе 7 с.
    assert.equal(fetches, 1);
    const body = await second.json();
    assert.deepEqual(parseEbotMatches(body.page).map(m => m.teamA), ['PRIVATE']);
  } finally {
    globalThis.fetch = originalFetch;
    __ttlScale.ms = originalScale;
  }
});

test('a bad EBOT_URL fails closed', async () => {
  const reply = await proxyEbot(new Request('http://localhost/api/ebot'), 'javascript:alert(1)');
  assert.equal(reply.status, 500);
  assert.equal((await reply.json()).error, 'config');
});

test('Cloudflare wrapper passes the secret through, Netlify default serves no secret', async () => {
  assert.equal(typeof cloudflareEbot, 'function');
  assert.equal(EBOT_PROXY, '/api/ebot');
});

// ---------- статистика матча и хитмапа (ebot-stats-parse.js) ----------

import { parseStatsPage, parseTeams, parseHeatmap, heatmapParams, HEATMAP_TYPES } from '../ebot-stats-parse.js';
import { readFileSync } from 'node:fs';

// Синтетический аналог страницы /matchs/view: та же таблица
// tablePlayers (заголовки и структура ячеек — с живого eBot), без
// полумегабайтного окружения.
const VIEW = readFileSync(new URL('./fixtures/ebot/stats-view.html', import.meta.url), 'utf8');

test('stats page: players by header names, team totals row dropped', () => {
  const { players, teams } = parseStatsPage(VIEW);
  assert.deepEqual(teams, ['Alpha', 'Bravo']);
  assert.equal(players.length, 2);
  assert.deepEqual(players[0], {
    team: 'Alpha', nick: 'sowalio', kill: 16, assist: 3, death: 16, kd: 1,
    points: 16, hs: 10, hsRate: '62.5%', defuse: 0, bombe: 0, tk: 0, fk: 0,
    ptClutch: 0, clutch1: 0, multi1: 8, clutch2: 0, multi2: 2, clutch3: 0,
    multi3: 0, clutch4: 0, multi4: 0, clutch5: 0, multi5: 0
  });
  // Колонки по именам, не по позиции: у Bravo Death = 19, не 3.
  assert.equal(players[1].death, 19);
  assert.equal(players[1].nick, '1eeR');
});

test('stats page: HTML in a nick stays text, unknown page is empty', () => {
  const poisoned = VIEW.replace('>sowalio<', '>&lt;img src=x onerror=alert(1)&gt;<');
  assert.equal(parseStatsPage(poisoned).players[0].nick, '<img src=x onerror=alert(1)>');
  const empty = parseStatsPage('<html><body>нет таблицы</body></html>');
  assert.deepEqual(empty, { players: [], teams: ['', ''] });
});

test('teams heading: Match #N - A vs B, extra words kept out', () => {
  assert.deepEqual(parseTeams('<h4>Match #46 - Alpha vs Bravo</h4>'), ['Alpha', 'Bravo']);
  assert.deepEqual(parseTeams('<h4>Alpha vs Bravo</h4>'), ['Alpha', 'Bravo']);
  assert.deepEqual(parseTeams('<h4>без команд</h4>'), ['', '']);
});

test('heatmap params: jQuery-style arrays, validation up front', () => {
  assert.equal(heatmapParams({ type: 'kill', sides: 'all' }), 'type=kill&sides=all');
  assert.equal(
    heatmapParams({ type: 'kill', sides: 'ct', rounds: [1, 2], players: ['sowalio'] }),
    'type=kill&sides=ct&rounds%5B%5D=1&rounds%5B%5D=2&players%5B%5D=sowalio');
  assert.throws(() => heatmapParams({ type: 'evil' }), /тип/);
  assert.throws(() => heatmapParams({ type: 'kill', sides: 'both' }), /Сторона/);
  assert.throws(() => heatmapParams({ type: 'kill', rounds: ['x'] }), /раунд/i);
  assert.throws(() => heatmapParams({ type: 'kill', players: ['evil nick'] }), /игрок/i);
  assert.ok(HEATMAP_TYPES.every(([value]) => /^[a-z]+$/.test(value)));
});

test('heatmap reply: valid points only, junk ignored', () => {
  const points = parseHeatmap({ points: [{ x: 390, y: 277 }, { x: -1, y: 5 }, 'junk', { x: 'a' }, null] });
  assert.deepEqual(points, [{ x: 390, y: 277 }]);
  assert.deepEqual(parseHeatmap('{}'), []);
  assert.deepEqual(parseHeatmap('not json'), []);
  assert.deepEqual(parseHeatmap(null), []);
});

// ---------- прокси: страница матча и хитмапа ----------

const VIEW_PAGE = '<html><body><h4>Match #46 - PRIVATE vs Nuclear TigeRES</h4></body></html>';

test('view: the proxy fetches /matchs/view/<id> and returns the page, id digits only', async () => {
  let asked = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    asked = String(url);
    return Promise.resolve(new Response(VIEW_PAGE, { status: 200 }));
  };
  try {
    const reply = await proxyEbot(new Request('http://localhost/api/ebot?view=46'), '');
    assert.equal(reply.status, 200);
    assert.equal(asked, 'http://37.230.228.105/matchs/view/46');
    assert.equal((await reply.json()).page, VIEW_PAGE);
    for (const bad of ['?view=abc', '?view=1;2', '?view=46&extra=1', '?view=..']) {
      const refused = await proxyEbot(new Request('http://localhost/api/ebot' + bad), '');
      assert.equal(refused.status, 400, bad);
    }
    const wrongMethod = await proxyEbot(new Request('http://localhost/api/ebot?view=46', { method: 'POST', body: 'x' }), '');
    assert.equal(wrongMethod.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('heatmap POST: only whitelisted fields reach eBot, rebuilt verbatim', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (url, init) => {
    seen.push({ url: String(url), method: init.method, body: init.body });
    return Promise.resolve(new Response('{"type":"heatmap","points":[{"x":1,"y":2}]}', { status: 200 }));
  };
  try {
    const reply = await proxyEbot(new Request('http://localhost/api/ebot?heatmap=46', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'type=kill&sides=all&rounds[]=1&rounds[]=2&players[]=sowalio'
    }), '');
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { type: 'heatmap', points: [{ x: 1, y: 2 }] });
    assert.equal(seen[0].url, 'http://37.230.228.105/matchs/heatmap/46');
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].body, 'type=kill&sides=all&rounds%5B%5D=1&rounds%5B%5D=2&players%5B%5D=sowalio');

    // Отказ до похода в eBot: чужой type, чужое поле, чужой matchId.
    globalThis.fetch = () => { throw new Error('must not be called'); };
    for (const body of [
      'type=evil&sides=all',
      'type=kill&sides=both',
      'type=kill&sides=all&rounds[]=x',
      'type=kill&sides=all&players[]=a b',
      'type=kill&sides=all&evil=1',
      'sides=all'
    ]) {
      const refused = await proxyEbot(new Request('http://localhost/api/ebot?heatmap=46', {
        method: 'POST', body
      }), '');
      assert.equal(refused.status, 400, body);
    }
    const refusedId = await proxyEbot(new Request('http://localhost/api/ebot?heatmap=abc', {
      method: 'POST', body: 'type=kill'
    }), '');
    assert.equal(refusedId.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('heatmap upstream failures are plain 502s', async () => {
  const originalFetch = globalThis.fetch;
  const form = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'type=kill&sides=all' };
  try {
    globalThis.fetch = () => Promise.resolve(new Response('', { status: 302, headers: { location: '/login' } }));
    let reply = await proxyEbot(new Request('http://localhost/api/ebot?heatmap=46', form), '');
    assert.equal(reply.status, 502);
    globalThis.fetch = () => Promise.resolve(new Response('not json'));
    reply = await proxyEbot(new Request('http://localhost/api/ebot?heatmap=46', form), '');
    assert.equal(reply.status, 502);
    globalThis.fetch = () => Promise.reject(new Error('down'));
    reply = await proxyEbot(new Request('http://localhost/api/ebot?heatmap=46', form), '');
    assert.equal(reply.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('heatmap types: the short forms eBot rejects are not offered', () => {
  // Живой eBot молча возвращает 0 точек на «he»/«flash»/«smoke» —
  // форма панели должна слать полные значения select самой eBot.
  const values = HEATMAP_TYPES.map(([value]) => value);
  assert.ok(values.includes('hegrenade'));
  assert.ok(values.includes('flashbang'));
  assert.ok(values.includes('smokegrenade'));
  assert.ok(!values.includes('he'));
  assert.ok(!values.includes('flash'));
  assert.ok(!values.includes('smoke'));
});
