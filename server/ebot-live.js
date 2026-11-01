// Живой поток событий eBot: постоянная подписка на комнаты matchs и livemap
// админского socket.io (engine.io v4 polling) поверх транспорта из
// ebot-admin.js — его и импортируем, своего polling-а здесь нет. Только
// сервер: свежий JWT перед каждым (пере)соединением выдаёт вызывающий через
// getJwt; модуль секретов не хранит и никогда не логирует.

import { socketioSession } from './ebot-admin.js';

const POLL_MS = 15_000;           // тихий цикл nextEvent: молчание комнаты — не ошибка
const RECONNECT_BASE_MS = 5_000;  // пауза реконнекта растёт 5с→10с→20с→30с (потолок)
const RECONNECT_MAX_MS = 30_000;
const WAIT_TICK_MS = 25;          // реальный тик паузы: успевает увидеть stop() и подменённый now
const MAX_ATTEMPTS = 8;           // чтобы 2**attempt не рос бесконечно

// Классификация текста статуса eBot в фазу матча. Номера раундов и овертаймы
// разбираются шаблоном, весь текст не хардкодится; неизвестное — null.
export function ebotPhase(text) {
  const t = String(text ?? '').trim();
  if (t === 'Not started') return 'not-started';
  if (t === 'Starting') return 'starting';
  if (t === 'Finished') return 'finished';
  // «Stop» — матч остановлен оператором (кнопка «Стоп без RS» и др.):
  // для мьюта тренера это терминальное состояние, как Finished.
  if (t === 'Stop') return 'finished';
  if (t === 'Warmup Knife') return 'warmup'; // разминка перед ножевым раундом
  if (t === 'Knife Round') return 'knife';
  if (t === 'Waiting choose team - Knife Round') return 'waiting';
  if (/^Warmup (?:first|second) side(?: OverTime)?$/.test(t)) return 'warmup';
  if (/^(?:First|Second) side(?: OverTime)? - #\d+$/.test(t)) return 'live';
  return null;
}

// ---------- разбор событий ----------

// payload приезжает и строкой-JSON (путь redis), и уже объектом (POST /match);
// мусор любого вида молча превращается в null.
function parsePayload(payload) {
  if (typeof payload === 'string') {
    try {
      const v = JSON.parse(payload);
      return v !== null && typeof v === 'object' ? v : null;
    } catch { return null; }
  }
  if (payload !== null && typeof payload === 'object') return payload;
  return null;
}

// id матча: числа и числовые строки — числом, прочее как есть.
function toId(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

// координата/номер раунда: числа — числом, мусор и отсутствующее — null
// (ноль — валидная координата, подменять её нельзя).
function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Событие matchs-комнаты (там сразу все матчи eBot) в нормальный вид.
// Комната фильтруется только на стороне подписчика — у событий есть matchId.
function matchsEvent(data) {
  const matchId = toId(data.id);
  if (matchId === null) return null;
  switch (data.message) {
    case 'status': {
      const text = String(data.content ?? '').trim();
      if (!text) return null;
      // пауза приезжает как «статус» с особым содержимым
      if (text === 'is_paused' || text === 'is_unpaused') {
        return { type: 'paused', matchId, paused: text === 'is_paused' };
      }
      return { type: 'status', matchId, text, phase: ebotPhase(text) };
    }
    case 'button':
      // «Стоп» и «Стоп без RS» шлют один button:stop — оба снимают мьют.
      return data.content === 'stop' ? { type: 'stop', matchId } : null;
    case 'score': {
      const scoreA = toNum(data.scoreA);
      const scoreB = toNum(data.scoreB);
      if (scoreA === null || scoreB === null) return null;
      return { type: 'score', matchId, scoreA, scoreB };
    }
    case 'teams': {
      if (data.teamA === null || data.teamA === undefined ||
          data.teamB === null || data.teamB === undefined) return null;
      return { type: 'teams', matchId, teamA: String(data.teamA), teamB: String(data.teamB) };
    }
    case 'currentMap': {
      const name = String(data.mapname ?? '').trim();
      return name ? { type: 'map', matchId, name } : null;
    }
    default:
      // streamerReady и незнакомые сообщения наружу не пересылаем
      return null;
  }
}

// Событие livemap-комнаты (в неё попадает только наш матч) в нормальный вид.
function livemapEvent(data) {
  const matchId = toId(data.id);
  if (matchId === null) return null;
  if (data.type === 'kill') {
    return {
      type: 'kill', matchId,
      killer: String(data.killer ?? ''), killed: String(data.killed ?? ''),
      killerPosX: toNum(data.killerPosX), killerPosY: toNum(data.killerPosY),
      killedPosX: toNum(data.killedPosX), killedPosY: toNum(data.killedPosY),
      weapon: String(data.weapon ?? ''), headshot: data.headshot === true,
    };
  }
  if (data.type === 'newRound') {
    const status = String(data.status ?? '');
    return {
      type: 'newRound', matchId,
      round: toNum(data.round),
      status,
      phase: ebotPhase(status),
    };
  }
  return null;
}

function defer() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ---------- сам живой поток ----------

// createEbotLive({ getJwt, baseWsUrl, matchId, fetchImpl, now, log, pollMs }):
//   getJwt  — async () => свежий admin-JWT (с перелогином разбирается вызывавший);
//   matchId — подписка livemap-комнаты матча (null — только matchs);
//   start() — открывает сессию и identify, резолвится после первого успешного
//             соединения (неудачи уходят в реконнекты, обещание ждёт);
//   subscribe(fn) → отписка; stop() — закрыть поток (повторный безопасен);
//   setMatchId(id) — сменить матч (переподключение с новым identify);
//   done() — обещание цикла, полезно дождаться конца в тестах/при остановке.
export function createEbotLive(opts) {
  return new EbotLive(opts);
}

class EbotLive {
  #getJwt;
  #base;
  #matchId;
  #fetch;
  #now;
  #log;
  #pollMs;
  #subs = new Set();
  #loop = null;        // обещание цикла — никогда не reject-ит
  #first = null;       // первое успешное соединение, им резолвится start()
  #stopped = true;
  #io = null;
  #attempt = 0;
  #switchNow = false;  // setMatchId: переподключиться без паузы реконнекта
  #waitTimer = null;
  #waitResolve = null;

  constructor({
    getJwt, baseWsUrl, matchId = null,
    fetchImpl = globalThis.fetch, now = Date.now, log = () => {},
    pollMs = POLL_MS,
  }) {
    if (typeof getJwt !== 'function') throw new Error('getJwt обязателен для подписки eBot');
    try {
      this.#base = new URL(baseWsUrl);
    } catch {
      throw new Error('Адрес eBot задан неверно');
    }
    this.#getJwt = getJwt;
    this.#matchId = matchId === undefined ? null : matchId;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#log = log;
    this.#pollMs = pollMs;
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this.#subs.add(fn);
    return () => { this.#subs.delete(fn); };
  }

  // Смена матча: identify livemap уходит заново, для этого переподключаемся.
  // При одном лайв-матче равнозначно просто stop() + start(); здесь цикл и
  // подписчики остаются живыми — панель не замечает перезапуска.
  setMatchId(id) {
    this.#matchId = id === undefined ? null : id;
    if (!this.#stopped && this.#io) {
      this.#log('смена матча — переподключаем подписку eBot');
      this.#switchNow = true;
      const io = this.#io;
      this.#io = null;
      io.close(); // цикл увидит разрыв и переподключится уже с новым matchId
    }
  }

  async start() {
    if (this.#loop && !this.#stopped) return this.#first.promise;
    this.#stopped = false;
    this.#attempt = 0;
    this.#first = defer();
    this.#loop = this.#run();
    return this.#first.promise;
  }

  // Закрывает сокет и прекращает цикл; повторный вызов — пустая операция.
  stop() {
    if (this.#stopped && !this.#loop) return;
    this.#stopped = true;
    if (this.#waitTimer) { clearTimeout(this.#waitTimer); this.#waitTimer = null; }
    if (this.#waitResolve) {
      const resolve = this.#waitResolve;
      this.#waitResolve = null;
      resolve(); // ждущий паузу цикл просыпается и видит #stopped
    }
    if (this.#io) {
      const io = this.#io;
      this.#io = null;
      io.close();
    }
    // start() не должен висеть, если поток остановили до первого соединения
    this.#first?.resolve();
  }

  done() {
    return this.#loop || Promise.resolve();
  }

  // Пауза по «нашим» часам (в тестах now подменяется): реальный тик короткий
  // и unref — процесс пауза не держит, stop() замечается сразу.
  #wait(ms) {
    return new Promise((resolve) => {
      const deadline = this.#now() + ms;
      this.#waitResolve = resolve;
      const step = () => {
        if (this.#waitTimer) this.#waitTimer = null;
        if (this.#stopped || this.#now() >= deadline) {
          this.#waitResolve = null;
          resolve();
          return;
        }
        const t = setTimeout(step, WAIT_TICK_MS);
        t.unref?.();
        this.#waitTimer = t;
      };
      step();
    });
  }

  #run() {
    return (async () => {
      while (!this.#stopped) {
        let io = null;
        try {
          // JWT берём заново перед каждым (пере)соединением: перелогин — задача getJwt
          const jwt = await this.#getJwt();
          if (this.#stopped) break;
          io = socketioSession({
            jwt, baseWsUrl: this.#base, fetchImpl: this.#fetch, now: this.#now,
          });
          this.#io = io;
          await io.open();
          await io.emit('identify', { type: 'matchs' });
          if (this.#matchId !== null) {
            await io.emit('identify', { type: 'livemap', match_id: Number(this.#matchId) || this.#matchId });
          }
          this.#attempt = 0;
          this.#log('подписка на события eBot установлена');
          this.#first?.resolve();
          while (!this.#stopped) {
            // null по таймауту — просто следующий цикл, это не ошибка канала
            const ev = await io.nextEvent(this.#pollMs);
            if (ev) this.#dispatch(ev);
          }
        } catch (error) {
          // обрывы polling-а — нормальная жизнь: сообщение без подробностей,
          // чтобы чей-нибудь чужой текст ошибки не утащил секрет
          if (!this.#stopped) this.#log('соединение с eBot потеряно — переподключаемся');
        } finally {
          if (this.#io === io) this.#io = null;
          if (io) io.close();
        }
        if (this.#stopped) break;
        let delay;
        if (this.#switchNow) {
          this.#switchNow = false;
          delay = 0; // смена матча — не сбой, ждём минимум
        } else {
          delay = Math.min(RECONNECT_BASE_MS * 2 ** this.#attempt, RECONNECT_MAX_MS);
          if (this.#attempt < MAX_ATTEMPTS) this.#attempt++;
        }
        if (delay > 0) {
          this.#log('повторное подключение через ' + Math.round(delay / 1000) + ' с');
          await this.#wait(delay);
        }
      }
      this.#first?.resolve();
      this.#log('подписка на события eBot остановлена');
    })();
  }

  #dispatch(ev) {
    const data = parsePayload(ev.payload);
    if (!data) return; // мусорный payload пропускаем молча
    const out = ev.name === 'matchsHandler' ? matchsEvent(data)
      : ev.name === 'livemapHandler' ? livemapEvent(data)
      : null;
    if (!out) return;
    for (const fn of this.#subs) {
      try { fn(out); } catch { /* сломавшийся подписчик не роняет поток */ }
    }
  }
}
