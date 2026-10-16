import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BOOKMAKERS, parseFeed, findMatch, sameTeam, teamKey, mskTime, isCyberClash } from '../bookmakers.js';
import { checkBookmaker, bookmakersResponse } from '../netlify/functions/bookmakers.mjs';
import { onRequest } from '../functions/api/bookmakers.js';

const fixture = name => readFile(new URL(`./fixtures/bookmakers/${name}`, import.meta.url), 'utf8');
const book = id => BOOKMAKERS.find(b => b.id === id);
// Real responses saved on 16.10.2026 ~09:43 UTC (trimmed).
const NOW = Date.UTC(2026, 9, 16, 9, 43);

test('Fonbet / PARI feed: CyberClash matches with 1/2 odds, maps and other tournaments dropped', async () => {
  const events = parseFeed(book('fonbet'), await fixture('fonbet-line.json'), false);
  assert.deepEqual(events.map(e => [e.team1, e.team2, e.odds]), [
    ['Rune Eaters Esports', 'HyperSpirit', [1.45, 2.55]],
    ['PRIVATE', 'UPGRADE', [1.72, 2]]
  ]);
  const [first] = events;
  assert.equal(first.start, Date.UTC(2026, 9, 16, 13, 0), '16:00 MSK');
  assert.equal(first.url, 'https://fon.bet/sports/esports/147516/69002206');
  assert.equal(first.live, false);
  assert.equal(parseFeed(book('pari'), await fixture('fonbet-line.json'), true)[0].url,
    'https://pari.ru/live/esports/147516/69002206');
});

test('OLIMPBET feed: competition «CS2. CyberClash», odds from П1/П2', async () => {
  const body = JSON.parse(await fixture('olimp-line.json')).response;
  const events = parseFeed(book('olimp'), body, false);
  assert.deepEqual(events.map(e => [e.team1, e.team2, e.odds]), [
    ['Rune Eaters', 'HyperSpirit', [1.44, 2.67]],
    ['Private', 'UPGRADE', [1.87, 1.87]],
    ['Honved Esport', 'Lavked', [2.2, 1.62]]
  ]);
  assert.equal(events[2].url, 'https://www.olimp.bet/line/kibersport-112/8354797/86083374');
  assert.equal(events[0].tournament, 'CS2. CyberClash');
  const live = JSON.parse(await fixture('olimp-live.json')).response;
  assert.deepEqual(parseFeed(book('olimp'), live, true), [], 'no CyberClash live at that time');
});

test('Marathonbet page: the CyberClash block only, Moscow times, 2-way prices', async () => {
  const events = parseFeed(book('marathon'), await fixture('marathon-cs2.html'), false, NOW);
  assert.deepEqual(events.map(e => [e.team1, e.team2, e.odds]), [
    ['Rune Eaters', 'HyperSpirit', [1.46, 2.54]],
    ['Private', 'UPGRADE', [1.77, 1.94]]
  ]);
  assert.equal(events[0].start, Date.UTC(2026, 9, 16, 13, 0));
  assert.match(events[0].tournament, /^CS 2\. CyberClash\. Закрытая квалификация/);
  assert.equal(events[0].url,
    'https://www.marathonbet.ru/su/betting/e-Sports/Counter-Strike+2/CyberClash/Closed+Qualification/Best+of+3+maps/Rune+Eaters+vs+HyperSpirit+-+32615134');
  assert.equal(mskTime('17 окт 22:00', NOW), Date.UTC(2026, 9, 17, 19, 0));
  assert.equal(mskTime('нет', NOW), null);
});

test('Betcity feed: championship «CS2. CIS Esports League CyberClash», Wm P1/P2, live without odds', async () => {
  const events = parseFeed(book('betcity'), await fixture('betcity-line.json'), false);
  assert.deepEqual(events.map(e => [e.team1, e.team2, e.odds]), [
    ['Rune Eaters Esports', 'HyperSpirit', [1.45, 2.55]],
    ['PRIVATE', 'UPGRADE', [1.85, 1.85]]
  ]);
  assert.equal(events[0].start, Date.UTC(2026, 9, 16, 12, 55), 'closes 5 minutes before 16:00 MSK');
  assert.equal(events[0].url, 'https://betcity.ru/ru/line/cybersport/960748/24617848');
  assert.ok(!events.some(e => e.team1 === 'BIG'), 'the «Private Club» tournament is not ours');
  assert.deepEqual(parseFeed(book('betcity'), await fixture('betcity-live.json'), true), [], 'no CyberClash live then');
  assert.equal(parseFeed(book('betcity'), await fixture('betcity-line.json'), true)[1].url,
    'https://betcity.ru/ru/live/cybersport/960748/24617849');
});

test('team names match across bookmakers, in either order', () => {
  assert.equal(teamKey('Honvéd'), 'honved');
  assert.ok(sameTeam('Lenovo Legion Honved', 'Honvéd'));
  assert.ok(sameTeam('Honved Esport', 'Honvéd'));
  assert.ok(sameTeam('Rune Eaters Esports', 'Rune Eaters'));
  assert.ok(sameTeam('HyperSpirit', 'HYPERSPIRIT'));
  assert.ok(!sameTeam('UPGRADE', 'Lavked'));
  assert.ok(!sameTeam('A', 'Aces'), 'too short to guess');
  const events = [{ team1: 'Honved Esport', team2: 'Lavked', odds: [2.2, 1.62] }];
  assert.deepEqual(findMatch(events, 'Lavked', 'Honvéd').odds, [1.62, 2.2]);
  assert.equal(findMatch(events, 'Lavked', 'UPGRADE'), null);
  assert.ok(isCyberClash('CS 2. CyberClash. Закрытая квалификация'));
  assert.ok(!isCyberClash('CS2. CCT Europe'));
});

test('checkBookmaker: tries mirrors, keeps a failing feed apart, never takes URLs from the request', async () => {
  const body = await fixture('fonbet-line.json');
  const asked = [];
  const fake = async url => {
    asked.push(url);
    if (url.includes('line54w')) throw new TypeError('fetch failed');
    if (url.includes('live_line')) return new Response('nope', { status: 503 });
    return new Response(body, { status: 200 });
  };
  const { status, body: out } = await checkBookmaker('fonbet', fake, NOW);
  assert.equal(status, 200);
  assert.equal(out.ok, true);
  assert.equal(out.events.length, 2);
  assert.match(out.errors.join(), /лайв: HTTP 503/);
  assert.ok(asked.some(u => u.includes('line55w')), 'second mirror used');
  assert.ok(asked.every(u => u.startsWith('https://line')), 'only fixed hosts');
  const bad = await bookmakersResponse(new Request('http://x/api/bookmakers?id=../evil'));
  assert.equal(bad.status, 400);
  const unknown = await bookmakersResponse(new Request('http://x/api/bookmakers?id=winline'));
  assert.equal(unknown.status, 400);
  assert.equal(typeof onRequest, 'function');
});
