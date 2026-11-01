// Движок мьюта тренера в TeamSpeak по событиям матча eBot (CS2).
// Чистая логика: без сети, без DOM. Интеграция (server/ebot-live.js)
// скармливает сюда события живого потока eBot и строки CS2-лога,
// движок выдаёт решения mute/unmute: onMute/onUnmute — только при смене
// состояния (идемпотентно), onNote — в журнал по каждому решению.
import { parsePlayer } from './cs2-log.js';

// «L 10/20/2026 - 18:31:05: …» (файл лога) или «10/20/2026 - 18:31:05.123 - …»
// (logaddress_add_http) — префикс времени движку не нужен, срезаем как в cs2-log.js.
const stripTime = (line) => {
  const m = /^(?:L )?\d\d\/\d\d\/\d{4} - \d\d:\d\d:\d\d(?:\.\d+)?(?:: | - )/.exec(line);
  return m ? line.slice(m[0].length) : line.replace(/^L /, '');
};

// Строка CS2-лога → событие для движка, или null, если строка движку не нужна.
export function parseLogLine(raw) {
  const line = String(raw ?? '').replace(/[\r\n\0]+/g, '').trim();
  if (!line) return null;
  const rest = stripTime(line);
  // Чат раньше прочих паттернов: набитый игроком в say «… killed …» —
  // текст сообщения, он не должен проходить за килл (как в cs2-log.js).
  if (/^".*?<\d+><[^>]*><[^>]*>" (say|say_team) "/.test(rest)) return null;
  let m;
  // Килл: паттерн cs2-log.js, хвост <id><steam><team> обязателен,
  // как у eBot (Kill.php) — без него строка не килл.
  if ((m = /^"(.+?)" \[[^\]]*\] killed "(.+?)" \[[^\]]*\] with "([^"]*)"(.*)$/.exec(rest))) {
    const killer = parsePlayer(m[1]);
    const victim = parsePlayer(m[2]);
    if (killer && victim) return { type: 'kill', killer: killer.name, victim: victim.name, weapon: m[3] };
  }
  // Закладка бомбы: паттерн eBot BombPlanting.php (хвост игрока обязателен).
  if ((m = /^"(.+?)" triggered "Planted_The_Bomb"/.exec(rest))) {
    const player = parsePlayer(m[1]);
    if (player) return { type: 'bomb_planted', player: player.name };
  }
  // Мировые события раундов и матча.
  if ((m = /^World triggered "([^"]+)"/.exec(rest))) {
    const known = {
      Round_Start: 'round_start',
      Round_End: 'round_end',
      Match_Start: 'match_start',
      Game_Commencing: 'game_commencing',
    }[m[1]];
    if (known) return { type: known };
    if (m[1].startsWith('Restart_Round_')) return { type: 'restart' };
  }
  return null;
}

// Фазы матча eBot: в live мьют решают события раунда, в остальных тренер размьючен.
const NOT_LIVE = {
  warmup: 'разминка',
  knife: 'ножевой раунд',
  waiting: 'ожидание выбора команд',
  'not-started': 'матч не начался',
  starting: 'матч стартует',
  finished: 'матч закончен',
};

// {onMute, onUnmute, onNote} → движок с feed/state/reset.
export function createMuteEngine({ onMute = () => {}, onUnmute = () => {}, onNote = () => {} } = {}) {
  let muted = false;     // решение правил («состояние до паузы»)
  let actual = false;    // что применено сейчас: пауза всегда размьючивает
  let paused = false;
  let phase = null;      // фаза eBot; null — неизвестна (kill без live-фазы не мьютит)
  let roundSeen = false; // был Round_Start в этой фазе (Round_End без раунда не мьютит)
  let lastKey = null;    // ключ прошлого события: двойное подряд — молча

  // Применяем решение (пауза всегда = размьют). onMute/onUnmute — только при
  // смене; noteAlways — граничное событие (раунд/фаза/пауза), оно в журнале
  // и без смены состояния.
  const transition = (reason, noteAlways) => {
    const target = paused ? false : muted;
    const changed = target !== actual;
    if (changed) {
      actual = target;
      if (actual) onMute(); else onUnmute();
    }
    if (noteAlways || changed) onNote(`Тренер ${actual ? 'замьючен' : 'размьючен'}: ${reason}`);
  };

  return {
    feed(event) {
      if (!event || typeof event !== 'object') return; // null и мусор — молча
      const key = JSON.stringify(event);
      if (key === lastKey) return; // двойное событие подряд — молча
      lastKey = key;
      switch (event.type) {
        case 'round_start':
          // Freeze-time: тренеру можно говорить — в любой фазе,
          // раунд ножей тоже начинается с freeze.
          muted = false;
          roundSeen = true;
          transition('freeze-time', true);
          break;
        case 'kill':
        case 'bomb_planted':
          // Раунд пошёл живым — но только в live-фазе и не на паузе:
          // килл в warmup/ножах/после матча или во время паузы
          // раундом не считается.
          if (phase === 'live' && !paused) {
            muted = true;
            transition(event.type === 'kill' ? 'раунд живой' : 'бомба заложена, раунд живой', false);
          }
          break;
        case 'round_end':
          // До следующего freeze — тишина, но только если раунд
          // действительно был: End без Start (хвосты лога) не мьютит.
          if (phase === 'live' && roundSeen) {
            muted = true;
            transition('раунд закончен', true);
          }
          break;
        case 'match_start':
          // Матч пошёл всерьёз; до первого Round_Start — размьючен, безопаснее.
          phase = 'live';
          roundSeen = false;
          muted = false;
          transition('матч начался, ждём freeze-time', true);
          break;
        case 'game_commencing':
          // Новая игра: дальше разминка и Match_Start.
          phase = 'warmup';
          roundSeen = false;
          muted = false;
          transition('новая игра (Game_Commencing)', true);
          break;
        case 'restart':
          // Рестарт раунда возвращает freeze-состояние; фазу не трогаем —
          // рестарт бывает и посреди live-матча.
          muted = false;
          roundSeen = true;
          transition('рестарт раунда', true);
          break;
        case 'phase': {
          const p = event.phase;
          if (p !== 'live' && !(p in NOT_LIVE)) return; // неизвестная фаза — молча
          if (p === phase) return; // тот же статус повторно (опрос eBot) — молча
          phase = p;
          roundSeen = false;
          muted = false;
          transition(p === 'live' ? 'live-фаза матча, ждём freeze-time' : NOT_LIVE[p], true);
          break;
        }
        case 'paused':
          if (typeof event.paused !== 'boolean') return;
          if (event.paused === paused) return; // то же состояние паузы повторно — молча
          paused = event.paused;
          transition(paused ? 'техническая пауза'
            : muted ? 'пауза снята, раунд живой' : 'пауза снята, freeze-time', true);
          break;
        default: // неизвестный тип — молча
      }
    },
    state() { return actual ? 'muted' : 'unmuted'; },
    reset() {
      muted = false;
      actual = false;
      paused = false;
      phase = null;
      roundSeen = false;
      lastKey = null;
    },
  };
}
