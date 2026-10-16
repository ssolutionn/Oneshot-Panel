import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BOOKMAKERS, MANUAL, parseFeed, findMatch, sameTeam, teamKey, mskTime, isCyberClash, marketText } from '../bookmakers.js';
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
  assert.deepEqual(first.size, { count: 76, unit: 'исходов' });
  assert.deepEqual(first.markets, [
    { kind: 'handicap', name: 'Фора', line: '-5.5', odds: [1.9, 1.8] },
    { kind: 'total', name: 'Тотал', line: '52.5', odds: [1.83, 1.87] }
  ]);
  assert.equal(marketText(first.markets[0]), 'Ф1 -5.5 1.90 · Ф2 +5.5 1.80');
  assert.equal(marketText(first.markets[1]), 'ТБ 52.5 1.83 · ТМ 1.87');
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
  assert.deepEqual(events[0].size, { count: 8, unit: 'исходов' });
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
  assert.deepEqual(events[0].size, { count: 4, unit: 'рынков' }, 'the winner and «+3»');
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
  assert.deepEqual(events[0].markets, [
    { kind: 'handicap', name: 'Фора', line: '-1.5', odds: [2.4, 1.5] },
    { kind: 'total', name: 'Тотал', line: '2.5', odds: [2.03, 1.7] }
  ]);
  assert.deepEqual(events[0].size, { count: 12, unit: 'рынков' }, 'three shown and nine more');
  assert.equal(events[0].liveOffered, true);
  assert.deepEqual(parseFeed(book('betcity'), await fixture('betcity-live.json'), true), [], 'no CyberClash live then');
  assert.equal(parseFeed(book('betcity'), await fixture('betcity-line.json'), true)[1].url,
    'https://betcity.ru/ru/live/cybersport/960748/24617849');
});

test('Bettery and 24bet: the Fonbet platform on their own hosts and links', async () => {
  const bettery = parseFeed(book('bettery'), await fixture('bettery-line.json'), false);
  assert.deepEqual(bettery.map(e => [e.team1, e.team2, e.odds]), [
    ['Rune Eaters Esports', 'HyperSpirit', [1.45, 2.55]],
    ['PRIVATE', 'UPGRADE', [1.72, 2]]
  ]);
  assert.equal(bettery[0].url, 'https://bettery.ru/sports/esports/147516/69002206');
  assert.ok(book('bettery').feeds[0].urls.every(u => /^https:\/\/[a-z0-9-]+\.at58f5-resources\.ru\/.*scopeMarket=501&lineType=line&/.test(u)));
  const bet24 = parseFeed(book('bet24'), await fixture('24bet-line.json'), true);
  assert.deepEqual(bet24.map(e => [e.team1, e.team2, e.odds]), [
    ['Rune Eaters Esports', 'HyperSpirit', [1.45, 2.55]],
    ['PRIVATE', 'UPGRADE', [1.67, 2.07]]
  ]);
  assert.equal(bet24[1].url, 'https://24bet.ru/live/esports/147516/69002208');
  assert.match(book('bet24').feeds[1].urls[0], /tf39be-resources\.com\/.*scopeMarket=3000&lineType=live_line/);
});

test('Leon export: league «CyberClash Closed Qualifier», ISO kickoff, the match page from the feed', async () => {
  const events = parseFeed(book('leon'), await fixture('leon-esports.json'), false);
  assert.deepEqual(events.map(e => [e.team1, e.team2, e.odds]), [
    ['PRIVATE', 'UPGRADE', [1.7, 2.05]],
    ['Honved', 'Lavked', [2.15, 1.62]],
    ['Rune Eaters', 'HyperSpirit', [1.44, 2.6]]
  ]);
  assert.equal(events[2].start, Date.UTC(2026, 9, 16, 13, 0));
  assert.equal(events[0].id, '1970324853915091');
  assert.equal(events[0].url, 'https://leon.ru/bets/esports/cs2/cyberclash-closed-qualifier/1970324853915091-private-upgrade');
  assert.equal(findMatch(events, 'Lavked', 'Honvéd').odds[0], 1.62);
  const forged = JSON.stringify({ events: [{ league: 'CyberClash', team1: 'A1', team2: 'B1', matchUrl: 'javascript:alert(1)', markets: [] }] });
  assert.equal(parseFeed(book('leon'), forged, false)[0].url, 'https://leon.ru/bets/esports/cs2', 'only leon.ru links');
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
  const marketsEvent = [{ team1: 'Rune Eaters', team2: 'HyperSpirit', odds: [1.45, 2.55], markets: [
    { kind: 'handicap', name: 'Фора', line: '-1.5', odds: [2.4, 1.5] },
    { kind: 'total', name: 'Тотал', line: '2.5', odds: [2.03, 1.7] }] }];
  assert.deepEqual(findMatch(marketsEvent, 'HyperSpirit', 'Rune Eaters').markets, [
    { kind: 'handicap', name: 'Фора', line: '+1.5', odds: [1.5, 2.4] },
    { kind: 'total', name: 'Тотал', line: '2.5', odds: [2.03, 1.7] }
  ], 'the handicap turns with the teams, the total does not');
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
  const unknown = await bookmakersResponse(new Request('http://x/api/bookmakers?id=unknown-id'));
  assert.equal(unknown.status, 400);
  assert.equal(typeof onRequest, 'function');
});

test('Bookmaker endpoint coalesces concurrent reads, caches public data and rejects writes', async () => {
  const source = await fixture('fonbet-line.json');
  let calls = 0;
  const fake = async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(source, {status:200});
  };
  const url = 'https://panel.example/api/bookmakers?id=fonbet';
  const replies = await Promise.all(Array.from({length:8}, () =>
    bookmakersResponse(new Request(url), fake)));
  assert.equal(calls, 2, 'only line and live, even with eight simultaneous readers');
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await reply.json()).events.length, 2);
  }
  await bookmakersResponse(new Request(url), fake);
  assert.equal(calls, 2, 'a short shared cache avoids repeated upstream requests');
  for (const method of ['POST','PUT','PATCH','DELETE','OPTIONS']) {
    const reply = await bookmakersResponse(new Request(url, {method}), fake);
    assert.equal(reply.status, 405);
    assert.equal(reply.headers.get('allow'), 'GET');
  }
  assert.equal(calls, 2);
});


test('Maintenance pages and changed schemas are unavailable, never an empty tournament', async () => {
  for (const id of ['fonbet','pari','olimp','betcity']) {
    assert.throws(() => parseFeed(book(id), '{"status":"maintenance"}', false), /формат линии/);
  }
  assert.throws(() => parseFeed(book('marathon'), '<html>Maintenance</html>', false), /формат линии/);
  assert.deepEqual(parseFeed(book('fonbet'), '{"events":[]}', false), []);
  const fake = async () => new Response('{"status":"maintenance"}', {status:200});
  const {body} = await checkBookmaker('fonbet', fake, NOW);
  assert.equal(body.ok, false);
  assert.deepEqual(body.events, []);
  assert.equal(body.errors.length, 2);
});

test('default server reader keeps the global fetch receiver for Workers', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = function () {
    assert.equal(this, globalThis);
    return Promise.resolve(new Response(JSON.stringify({events: []})));
  };
  try { assert.equal((await checkBookmaker('fonbet')).body.ok, true); }
  finally { globalThis.fetch = original; }
});

test('public line errors do not reflect raw upstream JSON into the panel', async () => {
  const {body}=await checkBookmaker('fonbet',async()=>new Response('<html>private-upstream-detail</html>'));
  assert.equal(body.ok,false);
  assert.ok(body.errors.every(e=>!e.includes('private-upstream-detail')));
});
test('declared oversized line responses are rejected without reading the body', async () => {
  const {body}=await checkBookmaker('leon',async()=>new Response('not read',{
    headers:{'content-length':String(17*1024*1024)}
  }));
  assert.equal(body.ok,false);
  assert.match(body.errors.join(),/слишком большой/);
});

test('all 16 requested bookmakers remain visible exactly once, including unsupported sources', () => {
  const expected=['fonbet','pari','bettery','bet24','olimp','marathon','betcity','leon','winline',
    'ligastavok','betboom','melbet','baltbet','zenit','betm','sportbet'].sort();
  assert.deepEqual([...BOOKMAKERS,...MANUAL].map(b=>b.id).sort(),expected);
  assert.ok(MANUAL.every(b=>typeof b.reason==='string' && b.reason.length>10));
});

test('Baltbet complete public cyber list: CyberClash, winner and first-map prices', async () => {
  const raw=JSON.parse(await fixture('baltbet-line.json'));
  raw.leagues.push({...raw.leagues[0],title:'Counter-Strike. CCT'});
  raw.leagues.push({...raw.leagues[0],title:'Dota 2. CyberClash'});
  const events=parseFeed(book('baltbet'),raw,false);
  assert.equal(events.length,1);
  const [e]=events;
  assert.deepEqual([e.team1,e.team2,e.odds],['Private','UPGRADE',[1.51,2.23]]);
  assert.equal(e.start,Date.UTC(2026,9,16,16));
  assert.equal(e.url,'https://baltbet.ru/cybersport/counter-strike/east-europe/cyberclash/qualifier/private-upgrade-id-31699523');
  assert.deepEqual(e.markets,[{kind:'other',name:'1-я карта',line:'',odds:[1.61,2.05]}]);
  assert.deepEqual(e.size,{count:13,unit:'доп. коэффициентов'});
  const out=await checkBookmaker('baltbet',async(url,init)=>{
    assert.equal(url,'https://events.baltbet.ru/api/prematch/sport/25/events?offset=all');
    assert.equal(init.headers.bb_appSource,'UniRu');
    return new Response(JSON.stringify(raw));
  });
  assert.equal(out.body.ok,true);
  assert.equal(out.body.coverage,'prematch');
  assert.throws(()=>parseFeed(book('baltbet'),'{"error":"maintenance"}',false),/формат линии/);
  assert.deepEqual(parseFeed(book('baltbet'),{sportId:25,superMarkets:raw.superMarkets,leagues:[]},false),[]);
});

test('Sportbet native full CS2 tables verify absence in prematch and live', async () => {
  const fixtureBody=await fixture('sportbet-native-schema.json');
  assert.deepEqual(parseFeed(book('sportbet'),await fixture('sportbet-cs2-line.json'),false),[]);
  assert.deepEqual(parseFeed(book('sportbet'),await fixture('sportbet-cs2-live.json'),true),[]);
  assert.throws(()=>parseFeed(book('sportbet'),fixtureBody,false),/формат линии/,'a response for the wrong sport never proves absence');
  assert.throws(()=>parseFeed(book('sportbet'),'{"status":"error","data":{"sports":[]},"statusCode":500}',false),/формат линии/);
  const asked=[];
  const {body}=await checkBookmaker('sportbet',async url=>{
    asked.push(url);
    return new Response(await fixture(url.includes('status=live')?'sportbet-cs2-live.json':'sportbet-cs2-line.json'));
  });
  assert.equal(body.ok,true);
  assert.equal(body.coverage,'line-and-live');
  assert.equal(asked.length,2);
  assert.ok(asked.every(u=>u.startsWith('https://bthm-server.sportbet.ru/events.table?')&&u.endsWith('sport=esport-counter-strike')));
});
test('Sportbet parser routes a synthetic CS2 tournament using the verified native event schema', async () => {
  // Representative real Dota payload; only sport/tournament labels below are synthetic.
  // No production CyberClash prices are claimed by this test.
  const raw=JSON.parse(await fixture('sportbet-native-schema.json'));
  const sport=raw.data.sports[0], tournament=sport.tournaments[0];
  sport.slug='esport-counter-strike';tournament.name='CyberClash';
  const events=parseFeed(book('sportbet'),raw,false);
  assert.equal(events.length,2);
  assert.deepEqual(events[0].odds,[1.08,7.4]);
  assert.equal(events[0].team1,'Team Lynx');
  assert.equal(events[0].start,1792159200000);
  tournament.events[0].markets[0].outcomes[0].active=false;
  assert.equal(parseFeed(book('sportbet'),raw,false)[0].odds[0],null,'inactive prices are never presented as available');
  tournament.events[0].status='finished';
  assert.equal(parseFeed(book('sportbet'),raw,true).length,1,'finished games do not stay in the live table');
});

test('external non-finite timestamps cannot break browser date rendering', async () => {
  const raw=JSON.parse(await fixture('fonbet-line.json'));
  raw.events.forEach(e=>{e.startTimeTimestamp=1e300;});
  assert.ok(parseFeed(book('fonbet'),raw,false).every(e=>e.start===null));
});
