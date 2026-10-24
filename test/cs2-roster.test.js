import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../server/cs2-log.js';
import { learnFrom, steamidOf, mergeWithCatalog, prune, emptyRoster, RosterStore, KEEP_DAYS } from '../server/cs2-roster.js';

const A = '"nick1<2><[U:1:111]><CT>"', B = '"nick2<3><[U:1:222]><TERRORIST>"';
const line = (text, at = '10/20/2026 - 18:31:05') => `L ${at}: ${text}`;

const feed = script => {
  const journal = new Journal(1000, () => 1000);
  journal.push(script.map(text => line(text)).join('\n'));
  return journal.events;
};

test('the roster learns a SteamID from any event that carries a player', () => {
  const roster = emptyRoster();
  learnFrom(feed([
    `${A} say "ready?"`,
    `${A} [1 2 3] killed ${B} [4 5 6] with "ak47"`,
    `${B} triggered "Planted_The_Bomb"`
  ]), roster);
  const players = Object.values(roster.players);
  assert.equal(players.length, 2);
  const first = roster.players['[U:1:111]'];
  assert.equal(first.steamid64, '76561197960265839');
  assert.deepEqual(first.names, ['nick1']);
  assert.equal(first.name, 'nick1');
  assert.equal(first.side, 'CT');
  // The nick index points at the same SteamID.
  assert.equal(Object.keys(roster.byNick).length, 2);
});

test('bots and nameless players are not learned: the log gives nothing to keep', () => {
  const roster = emptyRoster();
  learnFrom(feed(['"Bot<4><BOT><CT>" [1 2 3] killed "nick2<3><[U:1:222]><TERRORIST>" [4 5 6] with "ak47"']), roster);
  assert.deepEqual(Object.keys(roster.players), ['[U:1:222]']);
});

test('a rename keeps both names and the newest as name, without losing the SteamID', () => {
  const roster = emptyRoster();
  learnFrom(feed([`${A} say "a"`]), roster);
  learnFrom(feed(['"n1ck<2><[U:1:111]><CT>" say "b"']), roster);
  const player = roster.players['[U:1:111]'];
  assert.equal(player.name, 'n1ck');
  assert.deepEqual(player.names.sort(), ['n1ck', 'nick1']);
  // Both nicks lead to the same SteamID.
  assert.equal(steamidOf(roster, 'nick1'), '76561197960265839');
  assert.equal(steamidOf(roster, 'N1CK'), '76561197960265839', 'the panel matches by personKey, not by case');
});

test('one nick behind two SteamIDs is a conflict: recorded, newest wins', () => {
  const roster = emptyRoster();
  learnFrom(feed([`${A} say "a"`]), roster, 1000);
  learnFrom(feed(['"nick1<7><[U:1:999]><T>" say "b"']), roster, 2000);
  const entry = roster.byNick['nick1'];
  assert.equal(entry.steam, '[U:1:999]', 'the one seen most recently');
  assert.equal(entry.previous, '[U:1:111]');
  assert.equal(entry.conflicts, 1);
  assert.equal(steamidOf(roster, 'nick1'), '76561197960266727');
});

test('mergeWithCatalog: catalog rows keep their own SteamID, log-only players are listed too', () => {
  const roster = emptyRoster();
  learnFrom(feed([`${A} say "a"`, `${B} say "b"`, '"standin<9><[U:1:999]><T>" say "c"']), roster);
  const rows = mergeWithCatalog(roster, [
    { team: 'Alpha', nick: 'nick1', file: 'nick1.webp', hltv: 'https://www.hltv.org/player/1/nick1', role: '1' },
    { team: 'Alpha', nick: 'unknown', steamid64: '76561197960265729' }
  ], {});
  const nick1 = rows.find(row => row.nick === 'nick1');
  assert.deepEqual([nick1.steamid64, nick1.source, nick1.file, nick1.role], ['76561197960265839', 'log', 'nick1.webp', '1'],
    'a catalog nick gets its SteamID from the log');
  const unknown = rows.find(row => row.nick === 'unknown');
  assert.deepEqual([unknown.steamid64, unknown.source], ['76561197960265729', 'catalog'], 'the catalog wins');
  const standin = rows.find(row => row.nick === 'standin');
  assert.deepEqual([standin.steamid64, standin.source], ['76561197960266727', 'log'], 'a log-only player is not dropped');
  // Hostile names stay data.
  const evilRoster = emptyRoster();
  learnFrom(feed(['"<img src=x><8><[U:1:888]><CT>" say "x"']), evilRoster);
  assert.equal(mergeWithCatalog(evilRoster, [], {})[0].nick, '<img src=x>');
});

test('prune drops old entries and their nick index, keeps fresh ones', () => {
  const roster = emptyRoster();
  const now = 1_800_000_000_000;
  learnFrom(feed([`${A} say "a"`]), roster, now);
  learnFrom(feed(['"old<8><[U:1:888]><CT>" say "x"']), roster, now - (KEEP_DAYS + 10) * 86400000);
  const dropped = prune(roster, now);
  assert.equal(dropped, 1);
  assert.ok(roster.players['[U:1:111]']);
  assert.ok(!roster.players['[U:1:888]']);
  assert.ok(!roster.byNick.old, 'the nick index does not point into the void');
  assert.equal(steamidOf(roster, 'nick1'), '76561197960265839');
});

test('RosterStore: written through on learn, read back after reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2roster-'));
  try {
    const store = new RosterStore({ dir, now: () => 1000 });
    store.push(feed([`${A} say "a"`]));
    assert.equal(store.size(), 1);
    const again = new RosterStore({ dir, now: () => 1000 });
    assert.equal(steamidOf(again.load(), 'nick1'), '76561197960265839', 'survives a restart');
    // A push that learns nothing does not rewrite the file.
    const before = fs.statSync(path.join(dir, 'roster.json')).mtimeMs;
    store.push([]);
    assert.equal(fs.statSync(path.join(dir, 'roster.json')).mtimeMs, before);
    // A broken file starts empty instead of crashing the panel.
    fs.writeFileSync(path.join(dir, 'roster.json'), '{broken');
    const broken = new RosterStore({ dir, now: () => 1000 });
    assert.equal(broken.size(), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
