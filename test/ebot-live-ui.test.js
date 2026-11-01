import test from 'node:test';
import assert from 'node:assert/strict';
import { newKillFeed, killFeedText, applyScore, statusFlag } from '../ebot-live-ui.js';

// Чистые функции живого блока eBot (без DOM): лента киллов, её тексты,
// запись счёта в модель и флаг статуса карточки. DOM-часть initEbotLive
// браузерная, тестами не покрывается — как ebot-ui.js.

test('kill feed: push keeps the tail at the limit, items() is a copy', () => {
  const feed = newKillFeed(3);
  for (let i = 0; i < 5; i++) feed.push({ killer: 'a' + i, killed: 'b' + i });
  let items = feed.items();
  assert.equal(items.length, 3);
  assert.equal(items[0].killer, 'a2');
  assert.equal(items[2].killer, 'a4');
  items.push({ killer: 'внешний' });
  assert.equal(feed.items().length, 3);

  // Лимит 1 — вырожденный, но не ломается; лимит 0 — пустая лента.
  const one = newKillFeed(1);
  one.push({ killer: 'x' });
  one.push({ killer: 'y' });
  assert.deepEqual(one.items().map(e => e.killer), ['y']);
  const zero = newKillFeed(0);
  zero.push({ killer: 'x' });
  assert.deepEqual(zero.items(), []);
});

test('kill feed text: Nick ▸ weapon ▸ Nick2, (HS) only with a headshot', () => {
  const base = { killer: 'Nick', weapon: 'ak47', killed: 'Nick2' };
  assert.equal(killFeedText(base), 'Nick ▸ ak47 ▸ Nick2');
  assert.equal(killFeedText({ ...base, headshot: true }), 'Nick ▸ ak47 ▸ Nick2 (HS)');
  assert.equal(killFeedText({ ...base, headshot: false }), 'Nick ▸ ak47 ▸ Nick2');
  assert.equal(killFeedText({ ...base, headshot: 1 }), 'Nick ▸ ak47 ▸ Nick2 (HS)');
});

test('kill feed text: empty and missing fields do not break the line', () => {
  assert.equal(killFeedText({ killer: 'Nick', killed: 'Nick2' }), 'Nick ▸ Nick2');
  assert.equal(killFeedText({ killer: undefined, weapon: 'awp', killed: 'Nick2' }), 'awp ▸ Nick2');
  assert.equal(killFeedText({ killer: 'Nick', weapon: '', killed: null }), 'Nick');
  // Всё пустое — пустая строка, а не одинокий «(HS)» или « ▸ ».
  assert.equal(killFeedText({}), '');
  assert.equal(killFeedText({ headshot: true }), '');
  assert.equal(killFeedText(undefined), '');
  assert.equal(killFeedText(null), '');
  assert.equal(killFeedText('строка'), '');
  // HS сохраняется и у неполной строки — есть кого показать.
  assert.equal(killFeedText({ killer: 'Nick', killed: '', headshot: true }), 'Nick (HS)');
});

test('applyScore: model fields are numbers, junk leaves the old score', () => {
  const match = { id: '46', teamA: 'A', teamB: 'B', scoreA: 10, scoreB: 8, status: 'Live' };
  applyScore(match, '12', 9);
  assert.deepEqual([match.scoreA, match.scoreB], [12, 9]);
  applyScore(match, 13, 11);
  assert.deepEqual([match.scoreA, match.scoreB], [13, 11]);

  // Мусорное значение одного поля не трогает его и не трогает соседнее.
  applyScore(match, 'мусор', 12);
  assert.deepEqual([match.scoreA, match.scoreB], [13, 12]);
  applyScore(match, 14, {});
  assert.deepEqual([match.scoreA, match.scoreB], [14, 12]);
  // Строка с числом — приводится, пустая/NaN — нет.
  applyScore(match, '15', '');
  assert.deepEqual([match.scoreA, match.scoreB], [15, 12]);
  // Чужие поля модели не задеваются.
  assert.deepEqual([match.id, match.teamA, match.teamB, match.status], ['46', 'A', 'B', 'Live']);

  // Null-safe: без матча ничего не падает.
  assert.equal(applyScore(null, 1, 2), null);
});

test('statusFlag: running statuses are live, terminal ones finished', () => {
  assert.equal(statusFlag('First side - #4', false), 'live');
  assert.equal(statusFlag('Second half', undefined), 'live');
  assert.equal(statusFlag('live', false), 'live');
  assert.equal(statusFlag('Warmup', false), 'warmup');
  assert.equal(statusFlag('Warmup - #2', false), 'warmup');
  assert.equal(statusFlag('Разминка', false), 'warmup');
  assert.equal(statusFlag('Finished', false), 'finished');
  assert.equal(statusFlag('Archived', false), 'finished');
  assert.equal(statusFlag('Stopped by admin', false), 'finished');
  assert.equal(statusFlag('canceled', false), 'finished');
  // Пустой текст без паузы — не статус, класс не ставим.
  assert.equal(statusFlag('', false), null);
  assert.equal(statusFlag(undefined, false), null);
});

test('statusFlag: pause wins over live and warmup, terminal wins over pause', () => {
  // Пауза поверх live.
  assert.equal(statusFlag('First side - #4', true), 'paused');
  assert.equal(statusFlag('live', true), 'paused');
  // Пауза поверх warmup.
  assert.equal(statusFlag('Warmup', true), 'paused');
  // Пауза, пришедшая текстом статуса (is_paused у eBot), — без события.
  assert.equal(statusFlag('First side (is_paused)', false), 'paused');
  assert.equal(statusFlag('Матч на паузе', false), 'paused');
  // Терминальные статусы сильнее паузы: завершённый матч не «на паузе».
  assert.equal(statusFlag('Finished', true), 'finished');
  assert.equal(statusFlag('Stop', true), 'finished');
});

test('statusFlag: not-started match is not live until play begins', () => {
  assert.equal(statusFlag('Not started', false), null);
  assert.equal(statusFlag('not-started', false), null);
  assert.equal(statusFlag('Starting', false), null);
  assert.equal(statusFlag('Waiting', false), null);
  // Пауза у не-стартованного матча осмысленна (стартуют по готовности).
  assert.equal(statusFlag('Not started', true), 'paused');
  // Фазы канала приходят тем же текстом, warmup — исключение из «не live».
  assert.equal(statusFlag('knife', false), 'live');
});
