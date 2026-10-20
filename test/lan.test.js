import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  lanConfig, parseLanRoster, lanSeatId, seatTeam, lanSeatLinks, LAN_SEATS,
  defaultLineup, validateMatch, selectedPlayers, buildObs, observerText, directorUrl
} from '../core.js';

const template = JSON.parse(fs.readFileSync(new URL('../assets/obs-template.json', import.meta.url), 'utf8'));
const LAN = lanConfig({ on: true, prefix: 'k7qz', password: '', text: '' });
const ROSTER = `Team Alpha: nick1, nick2, nick3, nick4, nick5, sub1
# comment lines are ignored
Bravo: b1, b2, b3, b4, b5`;

test('LAN config: needs a short lowercase prefix to switch on', () => {
  assert.deepEqual(lanConfig({ on: true, prefix: 'k7qz', password: ' pw ', text: 'x' }),
    { on: true, prefix: 'k7qz', password: 'pw', text: 'x' });
  for (const prefix of ['', 'K7QZ', 'a', 'has space', 'x'.repeat(13), 'a-b'])
    assert.equal(lanConfig({ on: true, prefix }).on, false, prefix);
  assert.equal(lanConfig(null).on, false);
  assert.equal(lanConfig({ on: 'yes', prefix: 'ab' }).on, false);
});

test('LAN roster: one team per line, first five play, the rest are subs', () => {
  const teams = parseLanRoster(ROSTER);
  assert.deepEqual(teams.map(t => t.name), ['Team Alpha', 'Bravo']);
  assert.deepEqual(teams[0].players.map(p => [p.nick, p.role]), [
    ['nick1', 'Основной'], ['nick2', 'Основной'], ['nick3', 'Основной'], ['nick4', 'Основной'],
    ['nick5', 'Основной'], ['sub1', 'Запасной']]);
  assert.deepEqual(defaultLineup(teams[0]), teams[0].players.slice(0, 5).map(p => p.key));
  assert.equal(new Set(teams.flatMap(t => t.players.map(p => p.key))).size, 11);
  assert.deepEqual(teams.skipped, []);
});

test('LAN roster: bad lines are reported, not fatal; no teams at all is an error', () => {
  const teams = parseLanRoster('Alpha: a, b, A\nno colon here\n: x\nalpha: c\nBravo: d');
  assert.deepEqual(teams.map(t => t.name), ['Alpha', 'Bravo']);
  assert.deepEqual(teams[0].players.map(p => p.nick), ['a', 'b']);
  assert.equal(teams.skipped.length, 4);
  assert.throws(() => parseLanRoster('\n# nothing\n'), /ЛАН/);
});

test('LAN seats: fixed stream per seat, the team keeps no streams of its own', () => {
  assert.equal(lanSeatId('k7qz', 'a', 0), 'k7qza1');
  assert.equal(lanSeatId('k7qz', 'b', 4), 'k7qzb5');
  const [alpha, bravo] = parseLanRoster(ROSTER);
  const keysA = defaultLineup(alpha), keysB = defaultLineup(bravo);
  assert.equal(validateMatch(alpha, bravo, keysA, keysB), 'У игрока не указан ID потока или room.');
  // Swap two players: the stream stays with the seat, the name moves.
  const swapped = [keysA[1], keysA[0], ...keysA.slice(2)];
  const a = seatTeam(alpha, 'a', swapped, LAN), b = seatTeam(bravo, 'b', keysB, LAN);
  assert.equal(validateMatch(a, b, swapped, keysB), '');
  const seated = selectedPlayers(a, swapped);
  assert.deepEqual(seated.map(p => [p.seat, p.nick, p.id, p.room]), [
    ['A1', 'nick2', 'k7qza1', 'k7qz'], ['A2', 'nick1', 'k7qza2', 'k7qz'], ['A3', 'nick3', 'k7qza3', 'k7qz'],
    ['A4', 'nick4', 'k7qza4', 'k7qz'], ['A5', 'nick5', 'k7qza5', 'k7qz']]);
  assert.equal(a.players.find(p => p.nick === 'sub1').id, '');
  assert.equal(directorUrl(a), 'https://vdo.ninja/?director=k7qz');
});

test('LAN seats: the same team can sit on either side of the stage', () => {
  const [alpha] = parseLanRoster(ROSTER);
  const keys = defaultLineup(alpha);
  assert.equal(selectedPlayers(seatTeam(alpha, 'b', keys, LAN), keys)[0].id, 'k7qzb1');
});

test('LAN seats: OBS collection and observer text follow the seating', () => {
  const [alpha, bravo] = parseLanRoster(ROSTER);
  const keysA = defaultLineup(alpha), keysB = defaultLineup(bravo);
  const a = seatTeam(alpha, 'a', keysA, LAN), b = seatTeam(bravo, 'b', keysB, LAN);
  const obs = buildObs(template, a, b, keysA, keysB, () => crypto.randomUUID());
  const cams = obs.sources.filter(s => /^CAM /.test(s.name)).sort((x, y) => x.name.localeCompare(y.name));
  assert.equal(cams.length, 10);
  assert.equal(cams[0].name, 'CAM 01 | Team Alpha | nick1');
  assert.match(cams[0].settings.url, /[?&]view=k7qza1&/);
  assert.equal(cams[9].name, 'CAM 10 | Bravo | b5');
  assert.match(cams[9].settings.url, /[?&]view=k7qzb5&solo=1&room=k7qz&/);
  assert.match(observerText(a, b, selectedPlayers(a, keysA), selectedPlayers(b, keysB)), /^1\. Team Alpha — nick1$/m);
});

test('LAN seat links: ten links to type on the PCs, password included when set', () => {
  const links = lanSeatLinks(LAN);
  assert.equal(links.length, 2 * LAN_SEATS);
  assert.deepEqual(links.map(l => l.seat), ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5']);
  assert.equal(links[0].push, 'https://vdo.ninja/?room=k7qz&broadcast&do&push=k7qza1');
  const locked = lanSeatLinks(lanConfig({ on: true, prefix: 'k7qz', password: 'p w' }));
  assert.equal(locked[9].push, 'https://vdo.ninja/?room=k7qz&password=p%20w&broadcast&do&push=k7qzb5');
});
