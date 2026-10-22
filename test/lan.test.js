import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  lanConfig, eventProfile, parseLanRoster, lanSeatId, seatTeam, lanSeatLinks, LAN_SEATS,
  lanTeams, lanSchedule, lanId, newLanPrefix, LAN_LIMITS,
  defaultLineup, validateMatch, selectedPlayers, buildObs, observerText, directorUrl
} from '../core.js';

const template = JSON.parse(fs.readFileSync(new URL('../assets/obs-template.json', import.meta.url), 'utf8'));
const LAN = lanConfig({ on: true, prefix: 'k7qz', password: '', text: '' });
const ROSTER = `Team Alpha: nick1, nick2, nick3, nick4, nick5, sub1
# comment lines are ignored
Bravo: b1, b2, b3, b4, b5`;

test('LAN config: needs a short lowercase prefix to switch on', () => {
  assert.deepEqual(lanConfig({ on: true, prefix: 'k7qz', password: ' pw ', teams: [] }),
    { on: true, prefix: 'k7qz', password: 'pw', teams: [], matches: [], event: { name: '', accent: '', deep: '', black: '' } });
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

test('event profile: a name and three hex colours, nothing else gets through', () => {
  assert.deepEqual(eventProfile({ name: '  Winter\nLAN  ', accent: '#FF0066', deep: '#102030', black: 'red' }),
    { name: 'Winter LAN', accent: '#ff0066', deep: '#102030', black: '' });
  assert.deepEqual(eventProfile({ name: 'x'.repeat(100), accent: 'url(javascript:1)', deep: '#12345', black: '#1234567' }),
    { name: 'x'.repeat(60), accent: '', deep: '', black: '' });
  assert.deepEqual(eventProfile(null), { name: '', accent: '', deep: '', black: '' });
  assert.deepEqual(eventProfile({ name: 5, accent: 7 }), { name: '', accent: '', deep: '', black: '' });
  assert.equal(lanConfig({ on: true, prefix: 'ab', event: { name: 'Cup' } }).event.name, 'Cup');
});

test('event teams: ids stay, names and nicks are cleaned, broken entries dropped', () => {
  const lan = lanConfig({ on: true, prefix: 'k7qz', teams: [
    { id: 't1', name: '  Alpha\nTeam ', players: [{ id: 'p1', nick: ' a1 ' }, { id: 'p1', nick: 'dup id' }, { id: 'BAD', nick: 'x' }, { id: 'p2', nick: 5 }] },
    { id: 't1', name: 'same id' }, { id: '../x', name: 'bad id' }, 'junk', null,
    { id: 't2', name: 'x'.repeat(80), players: Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, nick: `n${i}` })) }
  ] });
  assert.deepEqual(lan.teams.map(t => t.id), ['t1', 't2']);
  assert.equal(lan.teams[0].name, 'Alpha Team');
  assert.deepEqual(lan.teams[0].players, [{ id: 'p1', nick: 'a1' }, { id: 'p2', nick: '' }]);
  assert.equal(lan.teams[1].name.length, 60);
  assert.equal(lan.teams[1].players.length, LAN_LIMITS.players);
  // The panel's teams: an empty nick is not ready yet; keys are ids, so a rename keeps lineups.
  const [alpha, beta] = lanTeams(lan);
  assert.deepEqual(alpha.players.map(p => [p.nick, p.key, p.playerId]), [['a1', '["lan","t1","p1"]', 'p1']]);
  assert.equal(alpha.teamId, 't1');
  assert.deepEqual(beta.players.slice(4, 6).map(p => p.role), ['Основной', 'Запасной']);
  const renamed = lanTeams(lanConfig({ ...lan, teams: [{ ...lan.teams[0], name: 'Renamed' }] }));
  assert.equal(renamed[0].players[0].key, alpha.players[0].key);
});

test('event teams: nameless teams wait, a repeated name or nick is skipped and told', () => {
  const teams = lanTeams(lanConfig({ on: true, prefix: 'ab', teams: [
    { id: 'a', name: '', players: [{ id: 'a1', nick: 'x' }] },
    { id: 'b', name: 'Alpha', players: [{ id: 'b1', nick: 'one' }, { id: 'b2', nick: 'ONE' }] },
    { id: 'c', name: 'alpha', players: [] }
  ] }));
  assert.deepEqual(teams.map(t => t.name), ['Alpha']);
  assert.deepEqual(teams[0].players.map(p => p.nick), ['one']);
  assert.deepEqual(teams.skipped, ['Alpha: ник ONE повторяется', 'команда alpha уже есть']);
  // No teams yet (or all removed): an empty list, not stale teams kept on air.
  assert.deepEqual([...lanTeams(lanConfig({ on: true, prefix: 'ab' }))], []);
});

test('event teams: nicks and names that would share a card are told, not merged', () => {
  const teams = lanTeams(lanConfig({ on: true, prefix: 'ab', teams: [
    { id: 'a', name: 'Team A', players: [{ id: 'a1', nick: 'a.b' }, { id: 'a2', nick: 'ab' }, { id: 'a3', nick: '???' }, { id: 'a4', nick: 'Ник' }] },
    { id: 'b', name: 'TeamA', players: [{ id: 'b1', nick: 'x' }] },
    { id: 'c', name: '!!!', players: [{ id: 'c1', nick: 'y' }] }
  ] }));
  assert.deepEqual(teams.map(t => t.name), ['Team A']);
  assert.deepEqual(teams[0].players.map(p => p.nick), ['a.b', 'Ник']);
  assert.deepEqual(teams.skipped, ['Team A: ник ab повторяется', 'Team A: в нике ??? нужны буквы или цифры',
    'команда TeamA уже есть', 'команда !!!: в названии нужны буквы или цифры']);
});

test('the old text roster becomes teams once, with ids', () => {
  const lan = lanConfig({ on: true, prefix: 'k7qz', text: ROSTER });
  assert.deepEqual(lan.teams.map(t => [t.id, t.name, t.players.map(p => p.id).join(' ')]), [
    ['t1', 'Team Alpha', 't1p1 t1p2 t1p3 t1p4 t1p5 t1p6'], ['t2', 'Bravo', 't2p1 t2p2 t2p3 t2p4 t2p5']]);
  assert.equal('text' in lan, false);
  // Saved again as teams, the text is gone for good: teams win.
  assert.deepEqual(lanConfig({ ...lan, text: 'Other: x' }).teams.map(t => t.name), ['Team Alpha', 'Bravo']);
  assert.deepEqual(lanConfig({ on: true, prefix: 'ab', text: '# nothing' }).teams, []);
});

test('event matches: teams by id, a match waits for both teams, its format and time are checked', () => {
  const teams = [{ id: 't1', name: 'Alpha', players: [] }, { id: 't2', name: 'Bravo', players: [] }];
  const lan = lanConfig({ on: true, prefix: 'ab', teams, matches: [
    { id: 'm1', time: '12:00', stage: 'Полуфинал 1', a: 't1', b: 't2', format: 'BO1' },
    { id: 'm2', time: '25:00', stage: 'Финал', a: 't1', b: 't1', format: 'BO7' },
    { id: 'm3', a: 'gone', b: 't2' }, { id: 'm1', stage: 'same id' }, { id: 'B A D' }
  ] });
  assert.deepEqual(lan.matches, [
    { id: 'm1', time: '12:00', stage: 'Полуфинал 1', a: 't1', b: 't2', format: 'BO1' },
    { id: 'm2', time: '', stage: 'Финал', a: 't1', b: '', format: 'BO3' },
    { id: 'm3', time: '', stage: '', a: '', b: 't2', format: 'BO3' }]);
  assert.deepEqual(lanSchedule(lan), [{ date: '', time: '12:00', team1: 'Alpha', team2: 'Bravo', stage: 'Полуфинал 1',
    format: 'BO1', matchId: 'm1', key: '["lan-match","m1"]' }]);
});

test('new ids and prefixes: short, from the given bytes, never taken', () => {
  assert.match(lanId([1, 2, 3, 4, 5, 6]), /^x[a-z2-9]{6}$/);
  const id = lanId([1, 2, 3, 4, 5, 6]);
  assert.notEqual(lanId([1, 2, 3, 4, 5, 6], [id]), id);
  assert.match(newLanPrefix([200, 3, 9, 17]), /^[a-z2-9]{4}$/);
  assert.equal(lanConfig({ on: true, prefix: newLanPrefix([0, 0]) }).on, true);
});
