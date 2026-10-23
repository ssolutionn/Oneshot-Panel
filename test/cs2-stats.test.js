import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../server/cs2-log.js';
import { steamId64, summarize, playerStats, roundStats, toCsv, toNdjson } from '../server/cs2-stats.js';

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

test('SteamID64 keeps every digit', () => {
  assert.equal(steamId64('[U:1:111]'), '76561197960265839');
  assert.equal(steamId64('BOT'), '');
});

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
