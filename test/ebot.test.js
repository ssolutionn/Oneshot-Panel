import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEbotMatches, isLive, ebotEvents, ebotStatusLine, EBOT_PROXY
} from '../ebot.js';
import { proxyEbot, ebotTarget } from '../netlify/functions/ebot.mjs';
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

test('a bad EBOT_URL fails closed', async () => {
  const reply = await proxyEbot(new Request('http://localhost/api/ebot'), 'javascript:alert(1)');
  assert.equal(reply.status, 500);
  assert.equal((await reply.json()).error, 'config');
});

test('Cloudflare wrapper passes the secret through, Netlify default serves no secret', async () => {
  assert.equal(typeof cloudflareEbot, 'function');
  assert.equal(EBOT_PROXY, '/api/ebot');
});
