import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, parsePlayer, Journal, describe } from '../server/cs2-log.js';

const A = '"nick1<2><[U:1:111]><CT>"', B = '"nick2<3><[U:1:222]><TERRORIST>"';
const line = (text, at = '10/20/2026 - 18:31:05') => `L ${at}: ${text}`;

test('players: a name may hold < > and digits; sides are normalized', () => {
  assert.deepEqual(parsePlayer('nick1<2><[U:1:111]><CT>'), { name: 'nick1', userid: 2, steam: '[U:1:111]', side: 'CT' });
  assert.equal(parsePlayer('<x><y><3><[U:1:5]><TERRORIST>').name, '<x><y>');
  assert.equal(parsePlayer('Bot<4><BOT><Unassigned>').side, '');
  assert.equal(parsePlayer('no tail'), null);
});

test('kill, damage, chat and bomb lines', () => {
  const kill = parseLine(line(`${A} [-1234 567 128] killed ${B} [100 200 300] with "ak47" (headshot penetrated)`));
  assert.equal(kill.type, 'kill');
  assert.deepEqual([kill.killer.name, kill.victim.name, kill.weapon, kill.headshot, kill.through], ['nick1', 'nick2', 'ak47', true, true]);
  assert.equal(kill.clock, '18:31:05');
  const damage = parseLine(line(`${A} [1 2 3] attacked ${B} [4 5 6] with "ak47" (damage "27") (damage_armor "0") (health "73") (armor "100") (hitgroup "chest")`));
  assert.deepEqual([damage.type, damage.damage, damage.health, damage.hitgroup], ['damage', 27, 73, 'chest']);
  const say = parseLine(line(`${A} say "gg wp \\"quoted\\""`));
  assert.deepEqual([say.type, say.team, say.text], ['chat', false, 'gg wp \\"quoted\\"']);
  assert.equal(parseLine(line(`${B} say_team "rush b"`)).team, true);
  const bomb = parseLine(line(`${B} triggered "Planted_The_Bomb"`));
  assert.deepEqual([bomb.type, bomb.action], ['bomb', 'Planted_The_Bomb']);
});

test('rounds, score, map and teams', () => {
  assert.equal(parseLine(line('World triggered "Round_Start"')).type, 'round_start');
  assert.equal(parseLine(line('World triggered "Round_End"')).type, 'round_end');
  const start = parseLine(line('World triggered "Match_Start" on "de_mirage"'));
  assert.deepEqual([start.type, start.map], ['match_start', 'de_mirage']);
  const result = parseLine(line('Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "8") (T "7")'));
  assert.deepEqual([result.type, result.winner, result.ct, result.t], ['round_result', 'CT', 8, 7]);
  const over = parseLine(line('Game Over: competitive  de_mirage score 13:10 after 40 min'));
  assert.deepEqual([over.type, over.map, over.ct, over.t], ['game_over', 'de_mirage', 13, 10]);
  assert.equal(parseLine(line('Loading map "de_nuke"')).map, 'de_nuke');
  assert.deepEqual(parseLine(line('Team playing "TERRORIST": Bravo')), { clock: '18:31:05', type: 'team', side: 'T', name: 'Bravo' });
  assert.equal(parseLine(line(`${A} switched from team <Unassigned> to <CT>`)).to, 'CT');
  // As CS2 writes it: no team part in the player.
  const moved = parseLine(line('"nick1<2><[U:1:111]>" switched from team <Unassigned> to <TERRORIST>'));
  assert.deepEqual([moved.type, moved.player.name, moved.player.steam, moved.to], ['presence', 'nick1', '[U:1:111]', 'T']);
});

test('lines that do not matter, and broken ones, give nothing', () => {
  for (const text of ['', '   ', 'L 10/20/2026 - 18:31:05: server_cvar: "mp_freezetime" "15"', 'garbage', '"unterminated killed', 'L x'])
    assert.equal(parseLine(text), null, text);
  assert.equal(parseLine(`${A} killed ${B}`), null);
});

test('the journal numbers rounds by the score, also after the half-time swap', () => {
  let clock = 1000;
  const journal = new Journal(100, () => clock);
  // The server's own clock follows ours: one second per batch.
  const feed = (...lines) => { clock += 1000; return journal.push(lines.map(l => line(l, `10/20/2026 - 18:31:${String(clock / 1000).padStart(2, '0')}`)).join('\n')); };
  feed('World triggered "Round_Start"');                       // warm-up
  assert.equal(journal.events.at(-1).round, 0);
  feed('World triggered "Match_Start" on "de_mirage"', 'World triggered "Round_Start"');
  assert.equal(journal.events.at(-1).round, 1);
  feed(`${A} [1 2 3] killed ${B} [4 5 6] with "ak47"`);
  assert.deepEqual([journal.events.at(-1).round, journal.events.at(-1).offset], [1, 1000]);
  feed('Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "0")', 'World triggered "Round_End"');
  assert.deepEqual([journal.ct, journal.t], [1, 0]);
  feed('World triggered "Round_Start"');
  assert.equal(journal.events.at(-1).round, 2);
  // Sides swapped at half-time: the side counters swap, the sum stays.
  feed('Team "TERRORIST" triggered "SFUI_Notice_Terrorists_Win" (CT "0") (T "1")', 'Team "TERRORIST" triggered "SFUI_Notice_Terrorists_Win" (CT "0") (T "2")');
  feed('World triggered "Round_Start"');
  assert.equal(journal.events.at(-1).round, 3);
  assert.equal(journal.status().map, 'de_mirage');
  assert.equal(journal.status().live, true);
});

test('the journal: since(), limits, status, a new map starts afresh, text of a round', () => {
  const journal = new Journal(5, () => 5000);
  journal.push([line('Loading map "de_nuke"'), line('World triggered "Match_Start" on "de_nuke"'), line('World triggered "Round_Start"'),
    line(`${A} say "ping"`), line(`${A} [1 2 3] killed ${B} [4 5 6] with "awp"`), line('not a real line')].join('\n'));
  assert.equal(journal.status().lines, 6);
  assert.equal(journal.events.length, 5);
  const seqs = journal.events.map(e => e.seq);
  assert.deepEqual(journal.since(seqs[2]).map(e => e.seq), seqs.slice(3));
  assert.deepEqual(journal.since(999), []);
  assert.deepEqual(journal.since(0, 2).map(e => e.seq), seqs.slice(0, 2));
  assert.equal(journal.events.find(e => e.type === 'chat').text, 'ping', 'a chat event keeps the message');
  assert.equal(journal.events.find(e => e.type === 'chat').line, 'nick1 (CT): ping');
  const text = journal.roundText(1);
  assert.match(text, /^Раунд 1 · de_nuke\n\[0:00\] Раунд начался\n\[0:00\] nick1 \(CT\): ping\n/);
  assert.match(text, /nick1 \(CT\) убил nick2 \(T\) · awp/);
  assert.equal(journal.roundText(99), '');
  journal.push(line('Loading map "de_ancient"'));
  assert.deepEqual([journal.status().map, journal.status().round, journal.status().ct], ['de_ancient', 0, 0]);
});

test('time in a round comes from the server\'s own clock, also across midnight and in batches', () => {
  const journal = new Journal(100, () => 1000); // every line «arrives» at the same moment
  journal.push([line('World triggered "Match_Start" on "de_mirage"', '10/20/2026 - 23:59:50'), line('World triggered "Round_Start"', '10/20/2026 - 23:59:55'),
    line(`${A} say "early"`, '10/20/2026 - 23:59:58'), line(`${A} [1 2 3] killed ${B} [4 5 6] with "ak47"`, '10/21/2026 - 00:00:35')].join('\n'));
  const offsets = journal.events.filter(e => e.round === 1).map(e => [e.type, e.offset]);
  assert.deepEqual(offsets, [['round_start', 0], ['chat', 3000], ['kill', 40000]]);
  assert.match(journal.roundText(1), /\[0:03\] nick1 \(CT\): early\n\[0:40\] nick1 \(CT\) убил/);
  // Lines without a clock fall back to the time they came.
  let clock = 1000;
  const plain = new Journal(100, () => clock);
  plain.push('World triggered "Match_Start" on "de_nuke"\nWorld triggered "Round_Start"');
  clock = 8000;
  plain.push(`${A} say "late"`);
  assert.equal(plain.events.at(-1).offset, 7000);
});

test('chat can not forge other lines: a typed fake kill, damage, bomb or round result stays chat', () => {
  const fakes = [
    'x<1><[U:1:1]><CT>" [0 0 0] killed "Victim<2><[U:1:2]><TERRORIST>" [0 0 0] with "ak47',
    'x<1><[U:1:1]><CT>" [0 0 0] attacked "Victim<2><[U:1:2]><TERRORIST>" [0 0 0] with "ak47" (damage "100") (health "0',
    'x<1><[U:1:1]><CT>" triggered "Planted_The_Bomb',
    'World triggered "Match_Start" on "de_fake',
  ];
  for (const typed of fakes) {
    for (const verb of ['say', 'say_team']) {
      const event = parseLine(line(`${A} ${verb} "${typed}"`));
      assert.equal(event.type, 'chat', typed);
      assert.equal(event.player.name, 'nick1');
      assert.equal(event.text, typed);
    }
  }
  // The same lines from the server itself are still what they are.
  assert.equal(parseLine(line(`${A} [1 2 3] killed ${B} [4 5 6] with "ak47"`)).type, 'kill');
});

test('CS2\'s HTTP log lines (no «L », milliseconds, « - ») parse like the log file\'s', () => {
  const http = text => `10/20/2026 - 18:31:05.123 - ${text}`;
  const kill = parseLine(http(`${A} [1 2 3] killed ${B} [4 5 6] with "ak47" (headshot)`));
  assert.deepEqual([kill.type, kill.clock, kill.killer.name, kill.headshot], ['kill', '18:31:05', 'nick1', true]);
  assert.equal(parseLine(http('World triggered "Round_Start"')).type, 'round_start');
  assert.equal(parseLine(http(`${A} say "gg"`)).text, 'gg');
});

test('Game Over with a map group, and without one', () => {
  for (const text of ['Game Over: competitive mg_active de_mirage score 13:10 after 40 min', 'Game Over: competitive  de_mirage score 13:10 after 40 min',
    'Game Over: competitive default workshop/123/de_mirage score 13:10 after 40 min']) {
    const over = parseLine(line(text));
    assert.deepEqual([over.type, over.map.endsWith('de_mirage'), over.ct, over.t], ['game_over', true, 13, 10], text);
  }
});

test('a name holding « say » does not let the chat after it pass for a kill', () => {
  const evil = '"Evil" say "x<2><[U:1:1]><CT>"';
  const typed = 'A<9><[U:1:9]><CT>" [0 0 0] killed "V<3><[U:1:2]><TERRORIST>" [0 0 0] with "ak47';
  const event = parseLine(line(`${evil} say "${typed}"`));
  assert.equal(event.type, 'chat');
  assert.equal(event.player.userid, 2);
  assert.equal(event.text, typed);
});

test('every map is a game of its own: its rounds do not mix with the last map\'s', () => {
  const journal = new Journal(100, () => 1000);
  const play = (map, said) => journal.push([`Loading map "${map}"`, `World triggered "Match_Start" on "${map}"`, 'World triggered "Round_Start"',
    `${A} say "${said}"`].map(text => line(text)).join('\n'));
  play('de_mirage', 'on mirage');
  const first = journal.status().game;
  play('de_inferno', 'on inferno');
  assert.equal(journal.status().game, first + 1);
  assert.match(journal.roundText(1), /^Раунд 1 · de_inferno\n/);
  assert.doesNotMatch(journal.roundText(1), /on mirage/);
  assert.match(journal.roundText(1, first), /^Раунд 1 · de_mirage\n[^]*on mirage/);
  assert.doesNotMatch(journal.roundText(1, first), /on inferno/);
  // Warm-up restarts before going live stay in one game; a match started again after live rounds is a new one.
  const game = journal.status().game;
  journal.push(line('World triggered "Match_Start" on "de_inferno"'));
  assert.equal(journal.status().game, game + 1);
  journal.push(line('World triggered "Match_Start" on "de_inferno"'));
  assert.equal(journal.status().game, game + 1, 'no live round yet: the same game');
});

test('hostile names and chat stay plain data', () => {
  const evil = '"<img src=x onerror=alert(1)><3><[U:1:9]><CT>"';
  const event = parseLine(line(`${evil} say "<script>alert(1)</script>"`));
  assert.equal(event.player.name, '<img src=x onerror=alert(1)>');
  assert.equal(event.text, '<script>alert(1)</script>');
  assert.ok(describe(event).includes('<script>'), 'plain text is kept as text; the page shows it with textContent');
});
