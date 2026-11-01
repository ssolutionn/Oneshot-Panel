import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLogLine, createMuteEngine } from '../server/ts-mute.js';

const A = '"nick1<2><[U:1:111]><CT>"';
const B = '"nick2<3><[U:1:222]><TERRORIST>"';
const L = (text, at = '10/20/2026 - 18:31:05') => `L ${at}: ${text}`;
const HTTP = (text) => `10/20/2026 - 18:31:05.123 - ${text}`;

const engine = (log = []) => createMuteEngine({
  onMute: () => log.push('M'),
  onUnmute: () => log.push('U'),
  onNote: (text) => log.push(text),
});

test('parseLogLine: раунды, матч, рестарты и Game_Commencing', () => {
  assert.deepEqual(parseLogLine(L('World triggered "Round_Start"')), { type: 'round_start' });
  assert.deepEqual(parseLogLine(HTTP('World triggered "Round_End"')), { type: 'round_end' });
  assert.deepEqual(parseLogLine(L('World triggered "Match_Start" on "de_mirage"')), { type: 'match_start' });
  assert.deepEqual(parseLogLine(L('World triggered "Game_Commencing"')), { type: 'game_commencing' });
  assert.deepEqual(parseLogLine(L('World triggered "Restart_Round_5_End"')), { type: 'restart' });
});

test('parseLogLine: килл как в cs2-log.js и Kill.php', () => {
  // Полная строка eBot: имена, координаты, оружие, хедшот/прострел.
  const kill = parseLogLine(L(`${A} [-1234 567 128] killed ${B} [100 200 300] with "ak47" (headshot penetrated)`));
  assert.deepEqual(kill, { type: 'kill', killer: 'nick1', victim: 'nick2', weapon: 'ak47' });
  // HTTP-формат без «L ».
  const http = parseLogLine(HTTP(`${A} [1 2 3] killed ${B} [4 5 6] with "awp"`));
  assert.equal(http.type, 'kill');
  assert.equal(http.weapon, 'awp');
  // Имя с < и > внутри: хвост читается с конца.
  assert.equal(parseLogLine(L(`"<x><y><3><[U:1:5]><CT>" [0 0 0] killed ${B} [1 2 3] with "deagle"`)).killer, '<x><y>');
});

test('parseLogLine: закладка бомбы как в BombPlanting.php', () => {
  assert.deepEqual(parseLogLine(L(`${B} triggered "Planted_The_Bomb"`)), { type: 'bomb_planted', player: 'nick2' });
  // Другие бомбовые действия движку не нужны.
  assert.equal(parseLogLine(L(`${B} triggered "Defused_The_Bomb"`)), null);
  assert.equal(parseLogLine(L(`${B} triggered "Got_The_Bomb"`)), null);
});

test('parseLogLine: say-строки и мусор дают null', () => {
  assert.equal(parseLogLine(L(`${A} say "gg wp \\"quoted\\""`)), null);
  assert.equal(parseLogLine(L(`${B} say_team "rush b"`)), null);
  // Набитый в чат «килл» — не килл.
  assert.equal(parseLogLine(L(`${A} say "x<1><[U:1:1]><CT> [0 0 0] killed ${B} [0 0 0] with \"ak47\""`)), null);
  for (const garbage of ['', '   ', 'garbage', 'L x', L('server_cvar: "mp_freezetime" "15"'), L('"unterminated killed'), 'World triggered "Whatever"'])
    assert.equal(parseLogLine(garbage), null, garbage);
  // Килл без хвоста <id><steam><team> у игрока — не килл (как в cs2-log.js).
  assert.equal(parseLogLine(L('"nick1" [1 2 3] killed "nick2" [4 5 6] with "ak47"')), null);
});

test('полный матч: warmup → knife → live → раунды → пауза → finished', () => {
  const log = [];
  const e = engine(log);
  assert.equal(e.state(), 'unmuted');
  // warmup: тренер размьючен, килл не мьютит.
  e.feed({ type: 'phase', phase: 'warmup' });
  assert.equal(e.state(), 'unmuted');
  e.feed({ type: 'kill' });
  assert.equal(e.state(), 'unmuted');
  // knife — тоже размьючен.
  e.feed({ type: 'phase', phase: 'knife' });
  assert.equal(e.state(), 'unmuted');
  // live: до первого Round_Start — размьючен (безопаснее).
  e.feed({ type: 'phase', phase: 'live' });
  assert.equal(e.state(), 'unmuted');
  e.feed({ type: 'round_start' });
  assert.equal(e.state(), 'unmuted');
  assert.ok(log.includes('Тренер размьючен: freeze-time'));
  // Первый килл — раунд живой.
  e.feed({ type: 'kill' });
  assert.equal(e.state(), 'muted');
  assert.ok(log.includes('Тренер замьючен: раунд живой'));
  // Round_End — мьют до следующего freeze.
  e.feed({ type: 'round_end' });
  assert.equal(e.state(), 'muted');
  assert.ok(log.includes('Тренер замьючен: раунд закончен'));
  // Новый раунд — freeze.
  e.feed({ type: 'round_start' });
  assert.equal(e.state(), 'unmuted');
  // Килл переводит в live, потом тех. пауза во время живого раунда — размьют.
  e.feed({ type: 'kill' });
  e.feed({ type: 'paused', paused: true });
  assert.equal(e.state(), 'unmuted');
  assert.ok(log.includes('Тренер размьючен: техническая пауза'));
  // Килл на паузе НЕ мьютит.
  e.feed({ type: 'kill' });
  assert.equal(e.state(), 'unmuted');
  // Анпауз: раунд был живым — мьют.
  e.feed({ type: 'paused', paused: false });
  assert.equal(e.state(), 'muted');
  assert.ok(log.includes('Тренер замьючен: пауза снята, раунд живой'));
  // Round_End ещё на мьюте — идемпотентно.
  e.feed({ type: 'round_end' });
  assert.equal(e.state(), 'muted');
  // Следующий freeze — размьют.
  e.feed({ type: 'round_start' });
  assert.equal(e.state(), 'unmuted');
  // Конец матча — размьючен; киллы после — игнор.
  e.feed({ type: 'phase', phase: 'finished' });
  assert.equal(e.state(), 'unmuted');
  e.feed({ type: 'kill' });
  assert.equal(e.state(), 'unmuted');
  // Матч не начался — киллы тоже игнор.
  e.feed({ type: 'phase', phase: 'not-started' });
  e.feed({ type: 'kill' });
  assert.equal(e.state(), 'unmuted');
  // Порядок: колбэк M/U — только при смене, решение — в журнал всегда.
  assert.deepEqual(log, [
    'Тренер размьючен: разминка',
    'Тренер размьючен: ножевой раунд',
    'Тренер размьючен: live-фаза матча, ждём freeze-time',
    'Тренер размьючен: freeze-time',
    'M', 'Тренер замьючен: раунд живой',
    'Тренер замьючен: раунд закончен',
    'U', 'Тренер размьючен: freeze-time',
    'M', 'Тренер замьючен: раунд живой',
    'U', 'Тренер размьючен: техническая пауза',
    'M', 'Тренер замьючен: пауза снята, раунд живой',
    'Тренер замьючен: раунд закончен',
    'U', 'Тренер размьючен: freeze-time',
    'Тренер размьючен: матч закончен',
    'Тренер размьючен: матч не начался',
  ]);
});

test('пауза в freeze: анпауз оставляет unmuted, без лишних колбэков', () => {
  let mutes = 0, unmutes = 0;
  const log = [];
  const e = createMuteEngine({ onMute: () => mutes++, onUnmute: () => unmutes++, onNote: (t) => log.push(t) });
  e.feed({ type: 'phase', phase: 'live' });
  e.feed({ type: 'round_start' });
  e.feed({ type: 'paused', paused: true });
  assert.equal(e.state(), 'unmuted');
  e.feed({ type: 'paused', paused: false });
  assert.equal(e.state(), 'unmuted');
  assert.equal(mutes + unmutes, 0, 'состояние не менялось — колбэков нет');
  assert.ok(log.includes('Тренер размьючен: freeze-time'));
  assert.ok(log.includes('Тренер размьючен: техническая пауза'));
  assert.ok(log.includes('Тренер размьючен: пауза снята, freeze-time'));
});

test('пауза в живом раунде размьючивает и возвращает мьют после анпауза', () => {
  const e = engine();
  e.feed({ type: 'phase', phase: 'live' });
  e.feed({ type: 'round_start' });
  e.feed({ type: 'bomb_planted' });
  assert.equal(e.state(), 'muted');
  e.feed({ type: 'paused', paused: true });
  assert.equal(e.state(), 'unmuted');
  e.feed({ type: 'paused', paused: false });
  assert.equal(e.state(), 'muted');
});

test('kill без известной live-фазы eBot сам по себе не мьютит', () => {
  // «Особый случай»: мьют только в live-фазе. Если статусы eBot не пришли
  // вовсе (phase null), килл тоже игнорируется — безопаснее размьючен.
  const e = engine();
  e.feed({ type: 'round_start' });
  e.feed({ type: 'kill' });
  assert.equal(e.state(), 'unmuted');
});

test('Round_End без начатого раунда не мьютит (хвосты лога)', () => {
  const e = engine();
  e.feed({ type: 'phase', phase: 'live' });
  e.feed({ type: 'round_end' });
  assert.equal(e.state(), 'unmuted');
});

test('идемпотентность: повторные события не зовут колбэки', () => {
  let mutes = 0, unmutes = 0;
  const e = createMuteEngine({ onMute: () => mutes++, onUnmute: () => unmutes++ });
  e.feed({ type: 'phase', phase: 'live' });
  e.feed({ type: 'round_start' });
  e.feed({ type: 'round_start' }); // повторный freeze — уже размьючен
  assert.equal(unmutes, 0);
  e.feed({ type: 'kill' });
  e.feed({ type: 'kill' }); // повторный килл — уже мьют
  e.feed({ type: 'bomb_planted' }); // бомба в живом раунде — уже мьют
  assert.equal(mutes, 1);
  e.feed({ type: 'paused', paused: true });
  assert.equal(unmutes, 1);
  e.feed({ type: 'paused', paused: true }); // двойная пауза
  assert.equal(unmutes, 1);
  e.feed({ type: 'paused', paused: false });
  assert.equal(mutes, 2);
  e.feed({ type: 'paused', paused: false }); // двойной анпауз
  assert.equal(mutes, 2);
});

test('мусор, null и неизвестные типы молча игнорируются', () => {
  const log = [];
  const e = engine(log);
  const before = e.state();
  e.feed(null);
  e.feed(undefined);
  e.feed({});
  e.feed('kill');
  e.feed(42);
  e.feed({ type: 'game_over' });
  e.feed({ type: 'phase', phase: 'nonsense' });
  e.feed({ type: 'paused', paused: 'yes' });
  e.feed({ type: 'kill', unexpected: true });
  assert.equal(e.state(), before);
  assert.deepEqual(log, []);
});

test('reset возвращает движок в исходное состояние', () => {
  const e = engine();
  e.feed({ type: 'phase', phase: 'live' });
  e.feed({ type: 'round_start' });
  e.feed({ type: 'kill' });
  assert.equal(e.state(), 'muted');
  e.reset();
  assert.equal(e.state(), 'unmuted');
  // После reset фаза потеряна: килл сам по себе не мьютит.
  e.feed({ type: 'kill' });
  assert.equal(e.state(), 'unmuted');
  e.feed({ type: 'phase', phase: 'live' });
  e.feed({ type: 'round_start' });
  e.feed({ type: 'kill' });
  assert.equal(e.state(), 'muted');
});

test('match_start включает правила live до первого freeze — размьют', () => {
  const e = engine();
  e.feed({ type: 'kill' }); // до match_start ничего не мьютит
  assert.equal(e.state(), 'unmuted');
  e.feed({ type: 'match_start' });
  assert.equal(e.state(), 'unmuted');
  e.feed({ type: 'round_end' }); // раунда ещё не было — не мьют
  assert.equal(e.state(), 'unmuted');
  e.feed({ type: 'round_start' });
  e.feed({ type: 'kill' });
  assert.equal(e.state(), 'muted');
});

test('движок в паре с parseLogLine: строки лога ведут полный сценарий', () => {
  const log = [];
  const e = engine(log);
  const feedLine = (l) => e.feed(parseLogLine(l));
  feedLine(L('World triggered "Game_Commencing"'));
  assert.equal(e.state(), 'unmuted');
  feedLine(L('World triggered "Match_Start" on "de_mirage"'));
  feedLine(L('World triggered "Round_Start"'));
  assert.equal(e.state(), 'unmuted');
  feedLine(L(`${A} [-1234 567 128] killed ${B} [100 200 300] with "ak47" (headshot penetrated)`));
  assert.equal(e.state(), 'muted');
  feedLine(L(`${B} say "gg"`)); // чат — мимо движка, состояние то же
  feedLine(L('Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "0")')); // движку не нужна
  feedLine(L('World triggered "Round_End"'));
  assert.equal(e.state(), 'muted');
  feedLine(L(`${B} triggered "Planted_The_Bomb"`)); // бомба после конца раунда — уже мьют, идемпотентно
  assert.equal(e.state(), 'muted');
  feedLine(L('World triggered "Round_Start"'));
  assert.equal(e.state(), 'unmuted');
  e.feed({ type: 'paused', paused: true });
  assert.equal(e.state(), 'unmuted');
  feedLine(L(`${A} [1 2 3] killed ${B} [4 5 6] with "deagle"`)); // килл на паузе — не мьют
  assert.equal(e.state(), 'unmuted');
  e.feed({ type: 'paused', paused: false });
  assert.equal(e.state(), 'unmuted', 'после анпауза freeze-time остаётся');
  feedLine(HTTP(`${A} [1 2 3] killed ${B} [4 5 6] with "awp"`)); // HTTP-формат
  assert.equal(e.state(), 'muted', 'первый килл после freeze — мьют');
  e.feed({ type: 'phase', phase: 'finished' });
  assert.equal(e.state(), 'unmuted');
});
