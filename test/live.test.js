import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFaceitUrl, summarizeMatch, matchEvents, mapsPlayed, eventText,
  nextStart, fillTemplate, DEFAULT_TEMPLATES, FaceitClient, mapScores, mapName, parseFaceitTargets
} from '../faceit.js';
import faceitProxy from '../netlify/functions/faceit.mjs';
import { onRequest as cloudflareFaceit } from '../functions/api/faceit.js';
import { newBridgeCode, normalizeCode, bridgeSecrets, seal, unseal, bridgeUrl, watchUrl } from '../vdo.js';

const CHAMP = '8f2a5c1e-1234-4abc-9def-0123456789ab';
const raw = (over = {}) => ({
  match_id: '1-aaaa', status: 'ONGOING', best_of: 3,
  faceit_url: 'https://www.faceit.com/{lang}/cs2/room/1-aaaa',
  teams: { faction1: { name: 'Rune Eaters' }, faction2: { name: 'PCIFIC' } },
  results: { score: { faction1: 0, faction2: 0 } },
  voting: { map: { pick: ['de_mirage', 'de_nuke', 'de_ancient'] } },
  ...over
});

test('FACEIT links: tournament, matchroom or a bare id', () => {
  assert.deepEqual(parseFaceitUrl(`https://www.faceit.com/ru/championship/${CHAMP}/CyberClash%20Season%202`),
    { kind: 'championship', id: CHAMP });
  assert.deepEqual(parseFaceitUrl(`https://www.faceit.com/en/cs2/championship/${CHAMP.toUpperCase()}/x`),
    { kind: 'championship', id: CHAMP });
  assert.deepEqual(parseFaceitUrl(CHAMP), { kind: 'championship', id: CHAMP });
  assert.deepEqual(parseFaceitUrl(`https://www.faceit.com/ru/cs2/room/1-${CHAMP}`),
    { kind: 'match', id: `1-${CHAMP}` });
  assert.equal(parseFaceitUrl('https://www.faceit.com/ru/players/someone'), null);
});

test('Lobby field: a tournament, match rooms or both', () => {
  const room = `1-${CHAMP}`, other = '1-11111111-2222-4333-8444-555555555555';
  assert.deepEqual(parseFaceitTargets(`https://www.faceit.com/ru/championship/${CHAMP}/CyberClash%20Season%202%20%7C%20Upgrade%20vs%20Lavked/matches`),
    { champ: CHAMP, rooms: [] });
  assert.deepEqual(parseFaceitTargets(`https://www.faceit.com/ru/cs2/room/${room}  https://www.faceit.com/ru/cs2/room/${other}/scoreboard`),
    { champ: '', rooms: [room, other] });
  assert.deepEqual(parseFaceitTargets(` ${room.toUpperCase()} `), { champ: '', rooms: [room] });
  assert.deepEqual(parseFaceitTargets(CHAMP), { champ: CHAMP, rooms: [] });
  assert.equal(parseFaceitTargets('https://www.faceit.com/ru/players/someone'), null);
});

test('Map and match ends are found between two polls', () => {
  const start = summarizeMatch(raw());
  assert.equal(start.url, 'https://www.faceit.com/ru/cs2/room/1-aaaa');
  assert.deepEqual(start.teams, ['Rune Eaters', 'PCIFIC']);
  assert.equal(mapsPlayed(start), 0);
  const map1 = summarizeMatch(raw({
    results: { score: { faction1: 1, faction2: 0 } },
    detailed_results: [{ winner: 'faction1' }]
  }));
  const events = matchEvents(start, map1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'map');
  assert.equal(eventText(events[0]),
    'Карта 1 (Mirage) закончилась — карту взяли Rune Eaters. Счёт: Rune Eaters 1:0 PCIFIC');
  assert.deepEqual(matchEvents(map1, map1), []);
  // The last map ends the series: one "match" event, no extra "map" event.
  const done = summarizeMatch(raw({
    status: 'FINISHED', finished_at: 1760556420,
    results: { winner: 'faction1', score: { faction1: 2, faction2: 1 } },
    detailed_results: [{ winner: 'faction1' }, { winner: 'faction2' }, { winner: 'faction1' }]
  }));
  const final = matchEvents(map1, done);
  assert.deepEqual(final.map(e => e.type), ['match']);
  assert.equal(eventText(final[0]), 'Матч закончился: Rune Eaters 2:1 PCIFIC');
  assert.equal(done.winner, 0);
  // First sight of a match never fires: no alerts for matches that ended
  // before the panel was opened.
  assert.deepEqual(matchEvents(null, done), []);
  const ready = summarizeMatch(raw({ status: 'SCHEDULED' }));
  assert.deepEqual(matchEvents(ready, summarizeMatch(raw({ status: 'READY' }))).map(e => e.type), ['start']);
  assert.deepEqual(matchEvents(summarizeMatch(raw()), summarizeMatch(raw({ status: 'CANCELLED' })))
    .map(e => e.type), ['cancelled']);
  // FACEIT's PAUSED status, if it shows up, is a pause alert.
  const paused = summarizeMatch(raw({ status: 'PAUSED' }));
  assert.deepEqual(matchEvents(summarizeMatch(raw()), paused).map(e => e.type), ['paused']);
  assert.deepEqual(matchEvents(paused, summarizeMatch(raw())).map(e => e.type), ['resumed']);
  // An ongoing BO1 has no results yet.
  const bo1 = summarizeMatch(raw({ results: null, detailed_results: null, best_of: 1 }));
  assert.deepEqual([bo1.score, bo1.maps, mapsPlayed(bo1)], [[0, 0], [], 0]);
});

test('Map names and per-map scores from FACEIT', () => {
  assert.equal(mapName('de_dust2'), 'Dust2');
  assert.equal(mapName('de_mirage', [{ guid: 'de_mirage', name: 'Mirage' }]), 'Mirage');
  const stats = { rounds: [
    { round_stats: { Map: 'de_mirage', Score: '4 / 13' }, teams: [
      { team_stats: { Team: 'PCIFIC', 'Final Score': '4' } },
      { team_stats: { Team: 'Rune Eaters', 'Final Score': '13' } }] },
    { round_stats: { Map: 'de_nuke', Score: '13 / 9' }, teams: [] }
  ] };
  assert.deepEqual(mapScores(stats, ['Rune Eaters', 'PCIFIC']), ['Mirage 13:4', 'Nuke 13:9']);
  assert.deepEqual(mapScores(null, ['A', 'B']), []);
});

test('Player messages: thanks and "Next xx:MM" ten minutes after the end', () => {
  const end = new Date(2026, 9, 15, 23, 57).getTime();
  assert.equal(nextStart(end), 'xx:07');
  assert.equal(nextStart(end, 15), 'xx:12');
  assert.equal(fillTemplate(DEFAULT_TEMPLATES.next, { time: 'xx:07', team1: 'Rune Eaters', team2: 'PCIFIC' }),
    'Next xx:07\n\n@Rune Eaters @PCIFIC\n\nWait for command');
  assert.equal(fillTemplate('{team1} {unknown}', { team1: 'A' }), 'A {unknown}');
});

test('FACEIT client sends the key and explains errors', async () => {
  const calls = [];
  const fake = status => async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization });
    return { ok: status === 200, status, json: async () => ({ items: [{ match_id: 'x' }] }) };
  };
  const items = await new FaceitClient(' key ', fake(200)).matches(CHAMP, 'ongoing');
  assert.deepEqual(items, [{ match_id: 'x' }]);
  assert.equal(calls[0].auth, 'Bearer key');
  assert.equal(calls[0].url,
    `https://open.faceit.com/data/v4/championships/${CHAMP}/matches?type=ongoing&offset=0&limit=20`);
  await assert.rejects(new FaceitClient('k', fake(401)).match('1-a'), /API-ключ/);
  await assert.rejects(new FaceitClient('k', fake(404)).match('1-a'), /не нашёл/);
  await assert.rejects(new FaceitClient('', fake(200)).match('1-a'), /Нужен API-ключ/);
  // FACEIT's own explanation reaches the admin.
  const explained = async () => ({ ok: false, status: 400, json: async () => ({ errors: [{ message: 'championship is not started' }] }) });
  await assert.rejects(new FaceitClient('k', explained).match('1-a'), /ошибкой 400: championship is not started \[1-a\]/);
  // Refused for this site (400/401/403): retried once through the proxy.
  const tried = [];
  const refusedDirect = async url => {
    tried.push(url);
    return url.startsWith('https://open.faceit.com') ?
      { ok: false, status: 400, text: async () => '' } :
      { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ items: [{ match_id: 'p' }] }) };
  };
  assert.deepEqual(await new FaceitClient('k', refusedDirect, { proxy: 'https://panel.example/api/faceit' }).matches(CHAMP, 'ongoing'),
    [{ match_id: 'p' }]);
  assert.equal(tried.length, 2);
  const bothRefuse = async () => ({ ok: false, status: 400, headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }), text: async () => 'Bad Request' });
  await assert.rejects(new FaceitClient('k', bothRefuse, { proxy: 'https://panel.example/api/faceit' }).matches(CHAMP, 'past'),
    /ошибкой 400: Bad Request \[matches past, через прокси\]/);
  // Without a key in the panel, requests go to the site's proxy without one.
  const proxied = [];
  const viaProxy = async (url, options) => {
    proxied.push({ url, auth: options.headers.Authorization });
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ items: [] }) };
  };
  await new FaceitClient('', viaProxy, { proxy: 'https://panel.example/api/faceit' }).matches(CHAMP, 'ongoing');
  assert.ok(proxied[0].url.startsWith('https://panel.example/api/faceit?path='));
  assert.equal(proxied[0].auth, undefined);
  const noSiteKey = async () => ({ ok: false, status: 401, headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ error: 'no-key' }) });
  await assert.rejects(new FaceitClient('', noSiteKey, { proxy: 'https://panel.example/api/faceit' }).match('1-a'), /FACEIT_API_KEY/);
  // Blocked by CORS (fetch throws): the same request goes through the proxy.
  const seen = [];
  const blocked = async url => {
    seen.push(url);
    if (url.startsWith('https://open.faceit.com')) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ items: [] }) };
  };
  const client = new FaceitClient('k', blocked, { proxy: 'https://panel.example/api/faceit' });
  await client.matches(CHAMP, 'past', 10);
  await client.match('1-b');
  assert.equal(seen[1], `https://panel.example/api/faceit?path=%2Fchampionships%2F${CHAMP}%2Fmatches&type=past&offset=0&limit=10`);
  assert.equal(seen.length, 3);
  assert.ok(seen[2].startsWith('https://panel.example/api/faceit?path=%2Fmatches%2F1-b'));
  await assert.rejects(new FaceitClient('k', blocked).match('1-a'), /не отвечает/);
});

test('FACEIT proxy forwards only lobby paths, with the caller\'s key', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), auth: options.headers.Authorization });
    return new Response('{"items":[]}', { status: 200 });
  };
  try {
    const ask = (query, key = 'Bearer k') =>
      faceitProxy(new Request(`https://panel.example/api/faceit?${query}`, { headers: { authorization: key } }));
    const ok = await ask(`path=/championships/${CHAMP}/matches&type=ongoing&limit=20&evil=1`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { items: [] });
    assert.deepEqual(calls[0], {
      url: `https://open.faceit.com/data/v4/championships/${CHAMP}/matches?type=ongoing&limit=20`, auth: 'Bearer k'
    });
    assert.equal((await ask(`path=/matches/1-${CHAMP}/stats`)).status, 200);
    for (const bad of ['path=/players/me', 'path=/championships/x', `path=/championships/${CHAMP}/../../players`]) {
      assert.equal((await ask(bad)).status, 400, bad);
    }
    const noKey = await ask(`path=/championships/${CHAMP}`, '');
    assert.equal(noKey.status, 401);
    assert.equal((await noKey.json()).error, 'no-key');
    assert.equal(calls.length, 2);
    // Cloudflare Pages runs the same proxy as a Pages Function.
    const cloudflare = await cloudflareFaceit({ request: new Request(
      `https://panel.example/api/faceit?path=/matches/1-${CHAMP}`, { headers: { authorization: 'Bearer k' } }) });
    assert.equal(cloudflare.status, 200);
    assert.deepEqual(calls[2], { url: `https://open.faceit.com/data/v4/matches/1-${CHAMP}`, auth: 'Bearer k' });
    assert.equal((await cloudflareFaceit({ request: new Request('https://panel.example/api/faceit?path=/players/me',
      { headers: { authorization: 'Bearer k' } }) })).status, 400);
    // The site's own key (hosting secret): used only without the caller's key,
    // only for this site's pages, and never echoed back.
    const site = (headers = {}) => cloudflareFaceit({ env: { FACEIT_API_KEY: 'site-key' },
      request: new Request(`https://panel.example/api/faceit?path=/championships/${CHAMP}`, { headers }) });
    const viaSite = await site({ 'sec-fetch-site': 'same-origin' });
    assert.equal(viaSite.status, 200);
    assert.equal(calls.at(-1).auth, 'Bearer site-key');
    assert.ok(!(await viaSite.text()).includes('site-key'));
    assert.equal((await site({ 'sec-fetch-site': 'cross-site' })).status, 403);
    await site({ authorization: 'Bearer mine', 'sec-fetch-site': 'same-origin' });
    assert.equal(calls.at(-1).auth, 'Bearer mine');
  } finally { globalThis.fetch = original; }
});

test('OBS dock link: codes, derived room and sealed messages', async () => {
  const code = newBridgeCode();
  assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal(normalizeCode(code.toLowerCase().replace(/-/g, ' ')), code);
  assert.equal(normalizeCode('short'), '');
  const one = await bridgeSecrets(code), two = await bridgeSecrets(code);
  assert.equal(one.stream, two.stream);
  assert.ok(!one.stream.includes(code.replace(/-/g, '')));
  const box = await seal(one.key, { type: 'apply', id: '1' });
  assert.deepEqual(await unseal(two.key, box), { type: 'apply', id: '1' });
  const other = await bridgeSecrets(newBridgeCode());
  assert.equal(await unseal(other.key, box), null);
  assert.equal(await unseal(one.key, { ...box, data: box.data.slice(4) }), null);
  await assert.rejects(bridgeSecrets('nope'), /код/);
  // The dock publishes, panels view: data-only pages in a room do not connect.
  const dock = new URL(bridgeUrl(one, 'dock')), panel = new URL(bridgeUrl(one, 'panel'));
  assert.equal(dock.origin, 'https://vdo.ninja');
  assert.equal(dock.searchParams.get('push'), one.stream);
  assert.equal(panel.searchParams.get('view'), one.stream);
  assert.equal(panel.searchParams.get('password'), one.password);
  assert.ok(dock.searchParams.has('dataonly') && panel.searchParams.has('dataonly'));
  assert.ok(!panel.searchParams.has('room') && !panel.searchParams.has('push'));
  const watch = new URL(watchUrl('team-room', ['a1', 'b2']));
  assert.equal(watch.searchParams.get('view'), 'a1,b2');
  assert.equal(watch.searchParams.get('room'), 'team-room');
  assert.ok(['scene', 'novideo', 'noaudio'].every(flag => watch.searchParams.has(flag)));
});
