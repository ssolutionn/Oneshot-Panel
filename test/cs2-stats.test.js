import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../server/cs2-log.js';
import { steamId64, playerKey, summarize, playerStats, roundStats, toCsv, toNdjson, lastGame } from '../server/cs2-stats.js';

const A = '"nick1<2><[U:1:111]><CT>"', B = '"nick2<3><[U:1:222]><TERRORIST>"';
const C = '"nick3<4><[U:1:333]><CT>"';
const line = (text, at = '10/20/2026 - 18:31:05') => `L ${at}: ${text}`;

// A short game through the real journal, so the stats are counted from the same
// events the referee sees, not from a hand-made array that could drift.
function play(script) {
  const journal = new Journal(1000, () => 1000);
  let seconds = 5;
  for (const text of script) {
    seconds += 1;
    journal.push(line(text, `10/20/2026 - 18:31:${String(seconds).padStart(2, '0')}`));
  }
  return journal;
}
const MATCH = [
  'Loading map "de_mirage"',
  'World triggered "Match_Start" on "de_mirage"',
  'Team playing "CT": Alpha',
  'Team playing "TERRORIST": Bravo'
];

test('SteamID3 → SteamID64 exactly, including digits past 2^53', () => {
  assert.equal(steamId64('[U:1:111]'), '76561197960265839');
  assert.equal(steamId64('[U:1:1]'), '76561197960265729');
  // A real account's low bits are large enough that float arithmetic would
  // round them away: the sum must keep every digit. Number arithmetic here
  // gives 76561199194833620, BigInt gives the exact …618.
  assert.equal(steamId64('[U:1:1234567890]'), '76561199194833618');
  assert.notEqual(steamId64('[U:1:1234567890]'), String(76561197960265728 + 1234567890), 'not the rounded float');
  assert.equal(steamId64('BOT'), '');
  assert.equal(steamId64(''), '');
  assert.equal(steamId64(undefined), '');
});

test('a player is their SteamID when the log gives one, and their name for a bot', () => {
  assert.equal(playerKey({ name: 'nick1', steam: '[U:1:111]' }), '[U:1:111]');
  assert.equal(playerKey({ name: 'Bot', steam: 'BOT' }), 'Bot\u0000BOT');
  assert.equal(playerKey({ name: 'Bot', steam: 'BOT' }), playerKey({ name: 'Bot', steam: 'BOT' }), 'stable');
  assert.equal(playerKey({ name: '', steam: '[U:1:1]' }), '');
  assert.equal(playerKey(null), '');
});

test('kills, damage, headshots and ADR are counted per player', () => {
  const journal = play([
    ...MATCH,
    'World triggered "Round_Start"',
    `${A} [1 2 3] attacked ${B} [4 5 6] with "ak47" (damage "30") (damage_armor "0") (health "70") (armor "100") (hitgroup "chest")`,
    `${A} [1 2 3] attacked ${B} [4 5 6] with "ak47" (damage "70") (damage_armor "0") (health "0") (armor "100") (hitgroup "head")`,
    `${A} [1 2 3] killed ${B} [4 5 6] with "ak47" (headshot)`,
    'Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "0")',
    'World triggered "Round_End"'
  ]);
  const stats = playerStats(journal.events);
  const first = stats.find(p => p.name === 'nick1');
  assert.deepEqual([first.kills, first.deaths, first.headshots, first.headshotRate], [1, 0, 1, 100]);
  assert.deepEqual([first.damage, first.adr], [100, 100]);
  assert.equal(first.steamid64, '76561197960265839');
  assert.equal(first.team, 'Alpha', 'the team of the side they played');
  const victim = stats.find(p => p.name === 'nick2');
  assert.deepEqual([victim.kills, victim.deaths, victim.damageTaken, victim.team], [0, 1, 100, 'Bravo']);
});

test('an assist goes to whoever hurt the victim most that round, not to a teammate', () => {
  const journal = play([
    ...MATCH,
    'World triggered "Round_Start"',
    `${A} [1 2 3] attacked ${B} [4 5 6] with "ak47" (damage "60") (health "40") (hitgroup "chest")`,
    `${C} [7 8 9] attacked ${B} [4 5 6] with "mp9" (damage "20") (health "20") (hitgroup "arm")`,
    `${C} [7 8 9] killed ${B} [4 5 6] with "mp9"`,
    'Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "0")'
  ]);
  const stats = playerStats(journal.events);
  assert.equal(stats.find(p => p.name === 'nick1').assists, 1, 'the one who did more damage');
  assert.equal(stats.find(p => p.name === 'nick3').assists, 0, 'the killer does not assist themselves');
});

test('friendly fire is kept apart: it is not ADR, and it does not make an assist', () => {
  const journal = play([
    ...MATCH,
    'World triggered "Round_Start"',
    `${A} [1 2 3] attacked ${C} [7 8 9] with "ak47" (damage "50") (health "50") (hitgroup "chest")`,
    `${A} [1 2 3] killed ${C} [7 8 9] with "ak47"`,
    'Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "0")'
  ]);
  const shooter = playerStats(journal.events).find(p => p.name === 'nick1');
  assert.deepEqual([shooter.friendlyDamage, shooter.damage, shooter.assists], [50, 0, 0]);
  const victim = playerStats(journal.events).find(p => p.name === 'nick3');
  assert.equal(victim.damageTaken, 0, 'friendly damage is not counted as damage taken');
});

test('the first kill of a round is an entry frag; the second is not', () => {
  const journal = play([
    ...MATCH,
    'World triggered "Round_Start"',
    `${A} [1 2 3] killed ${B} [4 5 6] with "awp"`,
    `${A} [1 2 3] killed ${B} [4 5 6] with "awp"`,
    'Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "0")'
  ]);
  const killer = playerStats(journal.events).find(p => p.name === 'nick1');
  assert.deepEqual([killer.kills, killer.firstKills], [2, 1]);
  assert.equal(playerStats(journal.events).find(p => p.name === 'nick2').firstDeaths, 1);
});

test('rounds keep their winner, reason and the bomb: a planted bomb means «bomb», not «elimination»', () => {
  const journal = play([
    ...MATCH,
    'World triggered "Round_Start"',
    `${B} triggered "Planted_The_Bomb"`,
    `${B} [4 5 6] killed ${A} [1 2 3] with "ak47"`,
    'Team "TERRORIST" triggered "SFUI_Notice_Target_Bombed" (CT "0") (T "1")',
    'World triggered "Round_End"',
    'World triggered "Round_Start"',
    `${B} triggered "Planted_The_Bomb"`,
    `${A} triggered "Defused_The_Bomb"`,
    'Team "CT" triggered "SFUI_Notice_Bomb_Defused" (CT "1") (T "1")',
    'World triggered "Round_End"',
    'World triggered "Round_Start"',
    `${A} [1 2 3] killed ${B} [4 5 6] with "awp"`,
    'Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "2") (T "1")',
    'World triggered "Round_End"'
  ]);
  const rounds = roundStats(journal.events);
  assert.equal(rounds.length, 3);
  assert.deepEqual(rounds.map(r => r.reasonCode), ['bomb', 'defuse', 'elimination']);
  assert.deepEqual(rounds.map(r => r.winner), ['T', 'CT', 'CT']);
  assert.deepEqual(rounds.map(r => r.winnerTeam), ['Bravo', 'Alpha', 'Alpha']);
  assert.deepEqual(rounds.map(r => r.planted), [true, true, false]);
  assert.deepEqual(rounds.map(r => r.defused), [false, true, false]);
  assert.equal(rounds[0].kills.length, 1);
  assert.equal(rounds[0].kills[0].victim, 'nick1');
  assert.match(rounds[0].reasonText, /бомба взорвалась/);
});

test('a half-time swap moves the team name with its side, not against it', () => {
  const journal = play([
    ...MATCH,
    'World triggered "Round_Start"',
    `${A} [1 2 3] killed ${B} [4 5 6] with "ak47"`,
    'Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "0")',
    'World triggered "Round_End"',
    // After the swap Alpha plays T: the log's own team lines say so.
    'Team playing "TERRORIST": Alpha',
    'Team playing "CT": Bravo',
    'World triggered "Round_Start"',
    '"nick1<2><[U:1:111]><TERRORIST>" [1 2 3] killed "nick2<3><[U:1:222]><CT>" [4 5 6] with "ak47"',
    'Team "TERRORIST" triggered "SFUI_Notice_Terrorists_Win" (CT "1") (T "1")',
    'World triggered "Round_End"'
  ]);
  const rounds = roundStats(journal.events);
  assert.deepEqual(rounds.map(r => r.winnerTeam), ['Alpha', 'Alpha'], 'both rounds belong to Alpha');
  const summary = summarize(journal.events, journal.status());
  assert.equal(summary.teams.find(t => t.name === 'Alpha').roundsWon, 2);
});

test('the summary is a picture a graphic can draw: teams, score, sides, totals', () => {
  const journal = play([
    ...MATCH,
    'World triggered "Round_Start"',
    `${A} [1 2 3] killed ${B} [4 5 6] with "ak47" (headshot)`,
    'Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "0")',
    'World triggered "Round_End"',
    'World triggered "Round_Start"',
    `${B} [4 5 6] killed ${C} [7 8 9] with "awp"`,
    'Team "TERRORIST" triggered "SFUI_Notice_Terrorists_Win" (CT "1") (T "1")',
    'World triggered "Round_End"'
  ]);
  const summary = summarize(journal.events, journal.status());
  assert.deepEqual([summary.version, summary.map], [1, 'de_mirage']);
  assert.deepEqual(summary.score, { ct: 1, t: 1 }, 'the server\'s own score by side');
  assert.deepEqual(summary.sides, { CT: 'Alpha', T: 'Bravo' });
  assert.deepEqual(summary.teams.map(t => [t.name, t.score]).sort(), [['Alpha', 1], ['Bravo', 1]]);
  assert.equal(summary.totals.rounds, 2);
  assert.equal(summary.totals.kills, 2);
  assert.equal(summary.players.length, 3);
  assert.ok(summary.players.every(p => p.steamid64 && /^7656119\d{10}$/.test(p.steamid64)));
  assert.equal(typeof summary.generatedAt, 'number');
});

test('stats of an earlier game are not mixed into the current one', () => {
  const journal = play([
    ...MATCH,
    'World triggered "Round_Start"',
    `${A} [1 2 3] killed ${B} [4 5 6] with "ak47"`,
    'Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "0")',
    'Loading map "de_inferno"',
    'World triggered "Match_Start" on "de_inferno"',
    'World triggered "Round_Start"',
    `${B} [4 5 6] killed ${A} [1 2 3] with "awp"`,
    'Team "TERRORIST" triggered "SFUI_Notice_Terrorists_Win" (CT "0") (T "1")'
  ]);
  const games = journal.status().game;
  assert.equal(playerStats(journal.events).find(p => p.name === 'nick2').kills, 1, 'the current game');
  assert.equal(playerStats(journal.events, games - 1).find(p => p.name === 'nick2').kills, 0, 'the map before');
  assert.equal(summarize(journal.events, journal.status()).map, 'de_inferno');
  assert.equal(summarize(journal.events, journal.status(), { game: games - 1 }).map, 'de_mirage');
});

test('CSV is a spreadsheet a Russian Excel opens by a double click', () => {
  const journal = play([...MATCH, 'World triggered "Round_Start"',
    `${A} [1 2 3] killed ${B} [4 5 6] with "ak47"`, 'Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "0")']);
  const csv = toCsv(playerStats(journal.events));
  assert.match(csv, /^Ник;SteamID64;Команда;/);
  assert.match(csv, /nick1;76561197960265839;Alpha;CT;1;0;/);
  assert.ok(csv.includes('\r\n'), 'CRLF, so Excel keeps the rows apart');
  assert.ok(!csv.startsWith('﻿'), 'the BOM is added by the route, not by the builder');
});

test('a name with a semicolon or a quote cannot break a CSV cell', () => {
  const csv = toCsv([{ name: 'a;b"c', steamid64: '1', team: 'x', side: 'CT', kills: 1, deaths: 0, assists: 0,
    headshots: 0, headshotRate: 0, damage: 0, adr: 0, firstKills: 0, firstDeaths: 0, plants: 0, defuses: 0,
    roundsSurvived: 0, rounds: 1, kd: 1 }]);
  const row = csv.split('\r\n')[1];
  assert.ok(row.startsWith('"a;b""c";'), 'quoted, and the quote inside doubled');
  assert.equal(row.split(';').length, 19, 'still 18 fields after the quoted one');
});

test('NDJSON is one JSON value per line, and empty when there is nothing', () => {
  const journal = play([...MATCH, 'World triggered "Round_Start"', `${A} say "hi"`]);
  const events = journal.events;
  const text = toNdjson(events);
  assert.equal(text.split('\n').filter(Boolean).length, events.length);
  for (const row of text.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(row));
  assert.equal(toNdjson([]), '');
});

test('an empty journal summarizes into zeros instead of throwing', () => {
  const summary = summarize([], {});
  assert.deepEqual([summary.map, summary.score, summary.teams.length, summary.players.length], ['', { ct: 0, t: 0 }, 0, 0]);
  assert.equal(toCsv([]).split('\r\n').length, 2, 'the header and an empty last line');
  assert.equal(lastGame([]), 0);
});

test('a game over sets the final score and marks the game finished', () => {
  const journal = play([...MATCH, 'World triggered "Round_Start"',
    'Game Over: competitive mg_active de_mirage score 13:10 after 40 min']);
  const summary = summarize(journal.events, journal.status());
  assert.deepEqual([summary.over, summary.score], [true, { ct: 13, t: 10 }]);
});

test('stats keep hostile names as plain data', () => {
  const evil = '"<img src=x onerror=alert(1)><5><[U:1:555]><TERRORIST>"';
  const journal = play([...MATCH, 'World triggered "Round_Start"',
    `${A} [1 2 3] killed ${evil} [4 5 6] with "ak47"`,
    'Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "0")']);
  const victim = playerStats(journal.events).find(p => p.deaths === 1);
  assert.equal(victim.name, '<img src=x onerror=alert(1)>', 'kept as text; the page shows it with textContent');
  assert.ok(toCsv([victim]).includes('<img src=x onerror=alert(1)>'), 'the name is in the CSV as it was');
  // A nick out of the game log must not become a formula in Excel: after the
  // CSV quote and the apostrophe guard, the first real character may not be
  // «=», «+» or «@».
  const row = (name) => toCsv([{ ...victim, name }]).split('\r\n')[1];
  for (const formula of ['=HYPERLINK("http://x")', '+1+1', '@SUM(1)', "=cmd|'/c calc'!A1"]) {
    const cell = row(formula);
    // The cell starts with the apostrophe guard (quoted or not, depending on
    // whether the text holds a «;» or a «"»), so Excel keeps it as text instead
    // of running it as a formula. The formula stays readable after the guard.
    assert.ok(cell.startsWith("'") || cell.startsWith("\"'"), `guarded with an apostrophe: ${formula}`);
  }
  assert.ok(row('-12').startsWith('-12'), 'a real negative number stays a number');
  assert.ok(row('7').startsWith('7'), 'a plain number stays a number');
  assert.equal(JSON.parse(toNdjson(journal.events.slice(-2)).split('\n')[0]).type, 'kill');
});

// Live rounds only, the server's reasons, capped damage, assists, teams by name.
// A journal fed line by line, one second apart (the server's own clock).
function journal(lines) {
  const j = new Journal(30000, () => 0);
  lines.forEach((text, i) => j.push(`L 10/20/2026 - 18:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}: ${text}`));
  return j.events;
}
const P = (name, id, side) => `"${name}<${id}><[U:1:${id}]><${side}>"`;
const hit = (a, b, damage, health) => `${a} [0 0 0] attacked ${b} [0 0 0] with "ak47" (damage "${damage}") (damage_armor "0") (health "${health}") (armor "0") (hitgroup "chest")`;
const kill = (a, b, extra = '') => `${a} [0 0 0] killed ${b} [0 0 0] with "ak47"${extra}`;
const win = (side, reason, ct, t) => `Team "${side}" triggered "SFUI_Notice_${reason}" (CT "${ct}") (T "${t}")`;

test('warm-up kills and damage are not stats; live rounds are', () => {
  const warm = [];
  for (let i = 0; i < 5; i++) warm.push(hit(P('a', 2, 'CT'), P('b', 3, 'TERRORIST'), 100, 0), kill(P('a', 2, 'CT'), P('b', 3, 'TERRORIST')));
  const events = journal(['Loading map "de_mirage"', ...warm, 'World triggered "Match_Start" on "de_mirage"',
    'World triggered "Round_Start"', hit(P('b', 3, 'TERRORIST'), P('a', 2, 'CT'), 100, 0), kill(P('b', 3, 'TERRORIST'), P('a', 2, 'CT')),
    win('TERRORIST', 'Terrorists_Win', 0, 1), 'World triggered "Round_End"']);
  const [b, a] = playerStats(events);
  assert.deepEqual([b.name, b.kills, b.damage, b.adr, b.firstKills], ['b', 1, 100, 100, 1]);
  assert.deepEqual([a.name, a.kills, a.deaths, a.damage, a.roundsSurvived], ['a', 0, 1, 0, 0]);
});

test('the round reason is the server\'s: a plant that ends in a wipe is not a bomb', () => {
  const T = P('t', 3, 'TERRORIST'), C = P('c', 2, 'CT');
  const events = journal(['World triggered "Match_Start" on "de_inferno"',
    'World triggered "Round_Start"', `${T} triggered "Planted_The_Bomb"`, kill(T, C), win('TERRORIST', 'Terrorists_Win', 0, 1), 'World triggered "Round_End"',
    'World triggered "Round_Start"', `${T} triggered "Planted_The_Bomb"`, win('TERRORIST', 'Target_Bombed', 0, 2), 'World triggered "Round_End"',
    'World triggered "Round_Start"', `${T} triggered "Planted_The_Bomb"`, `${C} triggered "Defused_The_Bomb"`, win('CT', 'Bomb_Defused', 1, 2), 'World triggered "Round_End"',
    'World triggered "Round_Start"', win('CT', 'Target_Saved', 2, 2), 'World triggered "Round_End"']);
  assert.deepEqual(roundStats(events).map(r => [r.round, r.winner, r.reasonCode, r.planted, r.exploded, r.defused]), [
    [1, 'T', 'elimination', true, false, false], [2, 'T', 'bomb', true, true, false],
    [3, 'CT', 'defuse', true, false, true], [4, 'CT', 'time', false, false, false]]);
});

test('damage stops at the health left; an assist needs more than 40 of it; a teamkill is no frag', () => {
  const A = P('awper', 2, 'CT'), M = P('mate', 4, 'CT'), V = P('victim', 3, 'TERRORIST'), W = P('other', 5, 'TERRORIST');
  const events = journal(['World triggered "Match_Start" on "de_nuke"', 'World triggered "Round_Start"',
    hit(M, V, 70, 30), hit(A, V, 115, 0), kill(A, V),          // mate 70 > 40: assist; the AWP took only 30
    hit(M, W, 20, 80), hit(A, W, 80, 0), kill(A, W),           // 20 is no assist
    kill(A, M), win('CT', 'CTs_Win', 1, 0), 'World triggered "Round_End"']);
  const by = Object.fromEntries(playerStats(events).map(p => [p.name, p]));
  assert.deepEqual([by.awper.kills, by.awper.damage, by.awper.firstKills], [2, 110, 1]);
  assert.deepEqual([by.mate.assists, by.mate.damage, by.mate.deaths], [1, 90, 1]);
  assert.equal(roundStats(events)[0].kills.filter(k => k.teamkill).length, 1);
});

test('teams come from the server\'s names and keep their rounds through the half-time swap', () => {
  const ct = P('anna', 2, 'CT'), t = P('boris', 3, 'TERRORIST');
  const ctAfter = P('anna', 2, 'TERRORIST'), tAfter = P('boris', 3, 'CT');
  const events = journal(['World triggered "Match_Start" on "de_ancient"',
    'Team playing "CT": Alpha', 'Team playing "TERRORIST": Bravo',
    'World triggered "Round_Start"', kill(ct, t), win('CT', 'CTs_Win', 1, 0), 'World triggered "Round_End"',
    'Team playing "CT": Bravo', 'Team playing "TERRORIST": Alpha',
    'World triggered "Round_Start"', kill(ctAfter, tAfter), win('TERRORIST', 'Terrorists_Win', 1, 1), 'World triggered "Round_End"',
    'World triggered "Round_Start"', kill(tAfter, ctAfter), win('CT', 'CTs_Win', 2, 1), 'World triggered "Round_End"']);
  const s = summarize(events);
  assert.deepEqual(s.teams.map(team => [team.name, team.roundsWon, team.players]), [['Alpha', 2, ['anna']], ['Bravo', 1, ['boris']]]);
  assert.deepEqual(s.score, { ct: 2, t: 1 });
  // Without names the sides would trade rounds at half-time: no teams then, only the server's score.
  const nameless = journal(['World triggered "Match_Start" on "de_ancient"', 'World triggered "Round_Start"', kill(ct, t), win('CT', 'CTs_Win', 1, 0), 'World triggered "Round_End"']);
  assert.deepEqual(summarize(nameless).teams, []);
});

test('CSV keeps a nick that looks like a formula as text, numbers stay numbers', () => {
  const csv = toCsv([{ name: '=HYPERLINK("x")', kills: 3, kd: -1, team: 'a;b' }]);
  const [, row] = csv.split('\r\n');
  assert.ok(row.startsWith(`"'=HYPERLINK(""x"")"`));
  assert.ok(row.includes(';"a;b";'));
  assert.ok(row.endsWith(';-1'));
  assert.ok(toCsv([{ name: "a,=cmd|' /C calc'!A0" }]).includes(`"a,=cmd|' /C calc'!A0"`));
  assert.equal(toNdjson([]), '');
  assert.equal(toNdjson([{ a: 1 }, { b: 2 }]), '{"a":1}\n{"b":2}\n');
});
