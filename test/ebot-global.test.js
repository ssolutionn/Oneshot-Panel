import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseArchivePage, collectTournament, topPlayers, mapSummary
} from '../ebot-global.js';
import { parseStatsPage } from '../ebot-stats-parse.js';

// Реальная фикстура живого eBot: GET http://37.230.228.105/matchs/archived,
// разметка списка (таблица + навбар поиска, без скриптов <head>), ~21 КБ.
// Проверено против PHP-шаблона eBot-CSGO-Web matchsArchivedSuccess.php:
// макет совпадает со сборкой на 37.230.228.105 (3.4 - CS2).
const ARCHIVED = readFileSync(new URL('./fixtures/ebot/archived.html', import.meta.url), 'utf8');
const VIEW = readFileSync(new URL('./fixtures/ebot/stats-view.html', import.meta.url), 'utf8');
// Две копии страницы матча с другими никами/командами/числами: оригинал
// stats-view.html не трогаем (его проверяет test/ebot.test.js).
const VIEW_B = readFileSync(new URL('./fixtures/ebot/stats-view-b.html', import.meta.url), 'utf8');
const VIEW_C = readFileSync(new URL('./fixtures/ebot/stats-view-c.html', import.meta.url), 'utf8');

// ---------- parseArchivePage ----------

test('archive: real fixture parses rows with id, teams, score and map', () => {
  const matches = parseArchivePage(ARCHIVED);
  assert.equal(matches.length, 12);
  assert.deepEqual(matches[0], {
    id: '47', teamA: 'PRIVATE', teamB: 'Nuclear TigeRES',
    scoreA: 13, scoreB: 11, map: 'de_anubis'
  });
  // Третья строка архива: ведущий ноль в счёте 07 - 13.
  assert.deepEqual(matches[2], {
    id: '43', teamA: 'PCIFIC', teamB: 'Omega',
    scoreA: 7, scoreB: 13, map: 'de_cache'
  });
  // Апостроф из &#039; остаётся текстом, не HTML.
  assert.equal(matches[11].teamB, "burmalda'vlg");
  // Ссылка на матч — /matchs/view/:id: id — только цифры из div#score-N.
  assert.ok(matches.every(m => /^\d+$/.test(m.id)));
});

test('archive: layout differs from the current-matches list, both tolerated', () => {
  // Строка архива: Season и Status между картой и кнопками, флаги внутри
  // ячеек команд — parseArchivePage берёт команды соседями счёта, как
  // parseEbotMatches, но статус/сезон не путаются под map.
  const row = ARCHIVED.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g).find(r => /id="score-47"/.test(r));
  const parsed = parseArchivePage('<table>' + row + '</table>');
  assert.equal(parsed[0].map, 'de_anubis');
  assert.equal(parsed[0].teamA, 'PRIVATE');
  // Строка без div#score-N — не матч (заголовок, пагинация, фильтры).
  assert.deepEqual(parseArchivePage('<tr><td>#ID</td><td>Team 1</td></tr>'), []);
  assert.deepEqual(parseArchivePage(''), []);
  // Отсутствующая карта остаётся пустой строкой, матч не теряется.
  const noMap = row.replace(/de_anubis/, '');
  assert.equal(parseArchivePage('<table>' + noMap + '</table>')[0].map, '');
});

// ---------- collectTournament ----------

// Три матча: у двоих копии страницы статистики (Omega/Delta, другие ники
// и числа), у третьего — оригинальный Alpha/Bravo. Один матч падает.
const MATCHES = [
  { id: '48', teamA: 'Omega', teamB: 'Delta', scoreA: 13, scoreB: 9, map: 'de_mirage' },
  { id: '47', teamA: 'Omega', teamB: 'Delta', scoreA: 16, scoreB: 14, map: 'de_dust2' },
  { id: '46', teamA: 'Alpha', teamB: 'Bravo', scoreA: 16, scoreB: 14, map: 'de_dust2' }
];
const pages = { 48: VIEW_C, 47: VIEW_B, 46: VIEW };
const fetchOk = id => pages[id];

test('collect: player totals per nick, rating averaged over matches with the field', async () => {
  const stats = await collectTournament(MATCHES, fetchOk);
  assert.deepEqual(stats.failed, []);
  assert.equal(stats.matches.played, 3);
  // malik: 12+16 kills (два матча Omega), zorte: 17+20.
  const byNick = new Map(stats.players.map(p => [p.nick, p]));
  const malik = byNick.get('malik');
  assert.equal(malik.kill, 12 + 16);
  assert.equal(malik.death, 16 + 16);
  assert.equal(malik.assist, 3 + 3);
  assert.equal(malik.matches, 2);
  assert.equal(malik.team, 'Omega');
  assert.equal(malik.diff, (12 + 16) - (16 + 16));
  // rating = среднее K/D Rate по матчам с полем: (1 + 1) / 2.
  assert.equal(malik.rating, 1);
  const zorte = byNick.get('zorte');
  assert.equal(zorte.kill, 37);
  assert.equal(zorte.rating, 0.89);
  // Игрок Alpha/Bravo из оригинальной фикстуры посчитан отдельно.
  assert.equal(byNick.get('sowalio').matches, 1);
  assert.equal(byNick.get('sowalio').team, 'Alpha');
});

test('collect: maps get matches, wins/losses per team, winrate', async () => {
  const stats = await collectTournament(MATCHES, fetchOk);
  const byMap = new Map(mapSummary(stats).map(m => [m.map, m]));
  const dust = byMap.get('de_dust2');
  assert.equal(dust.matches, 2);
  // Оба de_dust2 выиграны счётом A: команды — из заголовков страниц.
  const omega = dust.teams.find(t => t.team === 'Omega');
  const alpha = dust.teams.find(t => t.team === 'Alpha');
  assert.deepEqual({ wins: omega.wins, losses: omega.losses, winrate: omega.winrate },
    { wins: 1, losses: 0, winrate: 1 });
  assert.deepEqual({ wins: alpha.wins, losses: alpha.losses, winrate: alpha.winrate },
    { wins: 1, losses: 0, winrate: 1 });
  // Проигравшие — поражением: Delta проиграла один de_dust2 (48 был на
  // mirage), Bravo тоже один.
  const delta = dust.teams.find(t => t.team === 'Delta');
  assert.deepEqual({ wins: delta.wins, losses: delta.losses }, { wins: 0, losses: 1 });
  assert.equal(delta.winrate, 0);
  const bravo = dust.teams.find(t => t.team === 'Bravo');
  assert.deepEqual({ wins: bravo.wins, losses: bravo.losses, winrate: bravo.winrate },
    { wins: 0, losses: 1, winrate: 0 });
  const mirage = byMap.get('de_mirage');
  assert.equal(mirage.matches, 1);
});

test('collect: totals — played matches and summed rounds', async () => {
  const stats = await collectTournament(MATCHES, fetchOk);
  // 13+9 + 16+14 + 16+14 = 82.
  assert.deepEqual(stats.matches, { played: 3, totalRounds: 82 });
});

test('collect: a failing match lands in failed, the rest are counted', async () => {
  const seen = [];
  const fetchMatch = async id => {
    seen.push(id);
    if (id === '47') throw new Error('timeout');
    return pages[id];
  };
  const stats = await collectTournament(MATCHES, fetchMatch);
  assert.deepEqual(stats.failed, ['47']);
  assert.equal(stats.matches.played, 2);
  // Отказавший матч не попал ни в игроков, ни в карты.
  const byNick = new Map(stats.players.map(p => [p.nick, p]));
  assert.equal(byNick.get('zorte').matches, 1);
  // dust2 остался с одним матчем (46), mirage — цел.
  const dust = mapSummary(stats).find(m => m.map === 'de_dust2');
  assert.equal(dust.matches, 1);
  assert.equal(mapSummary(stats).find(m => m.map === 'de_mirage').matches, 1);
  assert.equal(stats.matches.totalRounds, 13 + 9 + 16 + 14);
  // Каждый матч спрашивали ровно один раз.
  assert.deepEqual(seen, ['48', '47', '46']);
  // Все упали — пустая сводка, не исключение.
  const all = await collectTournament(MATCHES, () => { throw new Error('down'); });
  assert.deepEqual(all, { players: [], maps: [], matches: { played: 0, totalRounds: 0 }, failed: ['48', '47', '46'] });
  // Отклонённый промис и не-строка — тоже отказ, не падение.
  const rejected = await collectTournament([{ id: '48' }], () => Promise.reject(new Error('x')));
  assert.deepEqual(rejected.failed, ['48']);
  const notString = await collectTournament([{ id: '48' }], () => ({ page: VIEW_C }));
  assert.deepEqual(notString.failed, ['48']);
});

test('collect: match without a map does not create a map row', async () => {
  const noMap = [{ id: '46', scoreA: 16, scoreB: 14 }];
  const stats = await collectTournament(noMap, () => VIEW);
  assert.deepEqual(mapSummary(stats), []);
  assert.equal(stats.matches.totalRounds, 30);
  // Матч без id пропускается молча (толерантность к дырам в списке).
  const withHole = await collectTournament([{ id: '46' }, { scoreA: 1 }], id => pages[id]);
  assert.deepEqual(withHole.failed, []);
  assert.equal(withHole.matches.played, 1);
});

test('collect: a tie score is not recorded as anyone\'s win', async () => {
  const tie = [{ id: '46', teamA: 'Alpha', teamB: 'Bravo', scoreA: 15, scoreB: 15, map: 'de_nuke' }];
  const stats = await collectTournament(tie, () => VIEW);
  const nuke = mapSummary(stats)[0];
  assert.equal(nuke.matches, 1);
  assert.deepEqual(nuke.teams, []);
});

// ---------- topPlayers / mapSummary ----------

test('topPlayers: K-D first, then kills, default limit 10', () => {
  const stats = { players: [
    { nick: 'a', diff: 5, kill: 10 },
    { nick: 'b', diff: 9, kill: 20 },
    { nick: 'c', diff: 9, kill: 25 },
    { nick: 'd', diff: -2, kill: 4 }
  ] };
  assert.deepEqual(topPlayers(stats).map(p => p.nick), ['c', 'b', 'a', 'd']);
  assert.deepEqual(topPlayers(stats, { limit: 2 }).map(p => p.nick), ['c', 'b']);
  assert.deepEqual(topPlayers(stats, { limit: 0 }).map(p => p.nick), []);
  // Тонкие объекты не ломают сортировку и не роняют вызов.
  assert.deepEqual(topPlayers({ players: [{ nick: 'x' }] }).map(p => p.nick), ['x']);
  assert.deepEqual(topPlayers({}), []);
});

test('mapSummary: rows from collect, copy for the UI', async () => {
  const stats = await collectTournament(MATCHES, fetchOk);
  const rows = mapSummary(stats);
  assert.ok(Array.isArray(rows) && rows.length === 2);
  assert.ok(rows.every(r => r.map && r.matches >= 1 && Array.isArray(r.teams)));
  // Копия: правки UI не ломают сводку.
  rows.pop();
  assert.equal(mapSummary(stats).length, 2);
});

// Данные из страниц — только текст (теги и entities срезаны парсером):
// UI рендерит их через textContent, но и сами строки чистые.
test('stats data is plain: no tags or entities leak from pages', async () => {
  const stats = await collectTournament(MATCHES, fetchOk);
  const strings = [
    ...stats.players.flatMap(p => [p.nick, p.team]),
    ...mapSummary(stats).flatMap(m => m.teams.flatMap(t => [t.team]))
  ];
  for (const value of strings) {
    assert.equal(typeof value, 'string');
    assert.doesNotMatch(value, /[<>]|&[a-z#0-9]+;/i, JSON.stringify(value));
  }
});

// Сверка контракта с ebot-stats-parse.js: то, что раскладывает
// collectTournament, действительно то, что даёт parseStatsPage.
test('collect feeds every fetched page through parseStatsPage', async () => {
  const asked = [];
  const fetchMatch = async id => {
    asked.push(id);
    return pages[id];
  };
  const stats = await collectTournament(MATCHES, fetchMatch);
  assert.deepEqual(asked, MATCHES.map(m => m.id));
  const direct = parseStatsPage(VIEW_C);
  const malik = stats.players.find(p => p.nick === 'malik');
  assert.equal(malik.kill, direct.players[0].kill + 16);
  assert.equal(stats.players.find(p => p.nick === '1eeR').team, 'Bravo');
});
