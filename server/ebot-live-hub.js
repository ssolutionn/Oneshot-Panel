// Живой матч eBot для локальной панели (server.js): один поток событий на
// весь сервер (createEbotLive из server/ebot-live.js) — счёт, статус, пауза,
// килы и раунды, — раздача браузерам как SSE (GET /api/ebot-live). Здесь же
// движок мьюта тренера TeamSpeak (server/ts-mute.js + server/teamspeak.js):
// те же события плюс строки CS2-лога из консольного хаба решают, когда
// тренер замьючен. Секреты eBot/TS в модуль не приходят: admin-клиент уже
// готов, TS-клиент собирает вызывающий из env.
import { createEbotLive } from './ebot-live.js';

// Браузеров на один живой поток хватает с запасом: панель одна, вкладок
// несколько; свыше — отказ без заголовков (соединение закрывается сразу).
const MAX_CLIENTS = 10;
import { createMuteEngine, parseLogLine } from './ts-mute.js';

// Живой поток матча: событие одному — событие всем. Переподключение eBot
// переживается молча (createEbotLive сам реконнектится с новым JWT).
class LiveSession {
  #live;
  #clients = new Set();
  #history = [];          // последние события для переподключения браузера
  #log;
  #now;
  #engine = null;         // движок мьюта, если TS включён
  #stopped = false;

  constructor({ getJwt, baseWsUrl, matchId, admin, fetchImpl, now = Date.now, log = () => {} }) {
    this.#log = log;
    this.#now = now;
    this.matchId = matchId;
    this.#live = createEbotLive({ getJwt, baseWsUrl, matchId, fetchImpl, now, log });
    this.#live.subscribe(ev => this.#onEvent(ev));
    this.admin = admin;
  }

  get clientCount() { return this.#clients.size; }
  get started() { return Boolean(this.#startPromise); }
  #startPromise = null;

  // Мьют-движок подключает вызывающий (server.js): onMute/onUnmute уходят
  // в TeamSpeak, onNote — в журнал. Отдельно от конструктора, потому что
  // движок зависит от env TS_*, которых тут нет.
  attachMute(engine) {
    this.#engine = engine;
    // Новый матч = чистый движок: состояние прошлого матча (мьют,
    // зависшая пауза, та же live-фаза с подавлением) не должно течь
    // в новый (находка аудита правил).
    if (typeof engine.reset === 'function') {
      try { engine.reset(); } catch { /* движок не обязан */ }
    }
  }

  async start() {
    if (!this.#startPromise) {
      this.#startPromise = this.#live.start().catch(error => {
        this.#startPromise = null; // неудача не кэшируется: следующий вызов повторит
        throw error;
      });
    }
    return this.#startPromise;
  }

  #onEvent(ev) {
    if (this.#stopped) return;
    this.#history.push(ev);
    if (this.#history.length > 200) this.#history.shift();
    if (this.#engine) {
      try {
        // Комната matchs несёт события ВСЕХ матчей eBot: движок мьюта
        // слушает только свой матч — чужие is_paused/stop сбивали бы
        // фазу (находка аудита правил).
        if (ev.matchId !== undefined && String(ev.matchId) !== String(this.matchId)) {
          // SSE-клиентам событие уже ушло (он фильтрует сам), движку — нет.
        } else {
          // Статусы → фазы движка; килы двигают «раунд живой» только в live.
          if (ev.type === 'status' && ev.phase) this.#engine.feed({ type: 'phase', phase: ev.phase });
          if (ev.type === 'paused') this.#engine.feed({ type: 'paused', paused: ev.paused });
          if (ev.type === 'kill') this.#engine.feed({ type: 'kill' });
          if (ev.type === 'stop') this.#engine.feed({ type: 'phase', phase: 'finished' });
          if (ev.type === 'newRound') this.#engine.feed({ type: 'round_start' });
        }
      } catch { /* сломанный движок не роняет поток */ }
    }
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const client of this.#clients) {
      try { client.res.write(line); } catch { /* 'close' уберёт */ }
    }
  }

  // Строка CS2-лога (из консольного хаба): движения раунда решают мьют,
  // в браузер они не идут — консоль уже стримит их своим клиентам.
  feedLogLine(line) {
    if (!this.#engine || this.#stopped) return;
    const ev = parseLogLine(line);
    if (ev) this.#engine.feed(ev);
  }

  addClient(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', matchId: this.matchId })}\n\n`);
    for (const ev of this.#history) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const client = { res, alive: true };
    this.#clients.add(client);
    // Кап на браузеры: анонимные вкладки не копят висячие SSE-соединения
    // (публичные данные, но keepalive каждые 20 с — трафик и сокеты).
    if (this.#clients.size > MAX_CLIENTS) {
      this.#clients.delete(client);
      res.end();
      return client;
    }
    res.on('close', () => {
      client.alive = false;
      this.#clients.delete(client);
    });
    const timer = setInterval(() => {
      if (client.alive) res.write(': ping\n\n');
      else clearInterval(timer);
    }, 20_000);
    timer.unref?.();
    return client;
  }

  stop(reason = '') {
    this.#stopped = true;
    try { this.#live.stop(); } catch { /* already */ }
    // Закрытие потока (оператором или сменой матча) обязано снять мьют:
    // событий больше не будет, «finished» движку шлём сами (находка
    // аудита: без этого тренер оставался замьючен навсегда).
    if (this.#engine) {
      try { this.#engine.feed({ type: 'phase', phase: 'finished' }); } catch { /* уже */ }
    }
    for (const client of this.#clients) {
      try {
        // matchId обязателен: клиент фильтрует по нему каждое сообщение, и
        // stop без id молча отбрасывался — чужая вкладка замирала навсегда
        // при смене/закрытии матча (находка контракта-ревью).
        client.res.write(`data: ${JSON.stringify({ type: 'stop', reason: String(reason || ''), matchId: this.matchId })}\n\n`);
        client.res.end();
      } catch { /* closed */ }
      client.alive = false;
    }
    this.#clients.clear();
    this.#log('live-stream закрыт' + (reason ? ': ' + reason : ''));
  }
}

// Хаб: одна живая сессия (один лайв-матч — решение владельца), её открывает
// панель POST /api/ebot-live {action:'start', matchId}; браузеры берут
// GET ?stream (id не нужен: поток общий). Переключение матча — stop+start.
export function createLiveHub({ getJwt, baseWsUrl, admin, fetchImpl, now = Date.now, log = () => {} } = {}) {
  if (typeof getJwt !== 'function' || !baseWsUrl) {
    throw new Error('Нужны getJwt и baseWsUrl для живого потока eBot.');
  }
  let session = null;


  return {
    async start(matchId, muteEngine = null) {
      const id = String(matchId || '');
      if (!/^\d{1,9}$/.test(id)) throw Object.assign(new Error('Номер матча обязателен.'), { status: 400 });
      // Один лайв-матч: прежний поток закрываем, подписчики переподключатся.
      if (session) { session.stop('сменён другой матч'); session = null; }
      const fresh = new LiveSession({ getJwt, baseWsUrl, matchId: id, admin, fetchImpl, now, log });
      if (muteEngine) fresh.attachMute(muteEngine);
      try {
        await fresh.start();
      } catch (error) {
        fresh.stop('start-fail');
        throw Object.assign(new Error('eBot не открыл живой поток матча'), { status: 502, cause: error });
      }
      session = fresh;
      return { matchId: id };
    },

    stop() {
      if (!session) return false;
      session.stop('закрыт оператором');
      session = null;
      return true;
    },

    // Строки лога от консольного хаба — в движок мьюта живого матча.
    feedLogLine: line => session?.feedLogLine(line),
    // Движок мьюта цепляется при start (env TS читает вызывающий).
    muteEngine: null,
    // Ники тренеров для TS-мьюта — задаёт server.js из env/панели.
    setCoaches: null,

    sseHandler(req, res) {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
      if (url.pathname !== '/api/ebot-live') return false;
      const current = session;
      if (!current) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not-found', message: 'Живой поток не открыт.' }));
        return true;
      }
      current.addClient(res);
      return true;
    },

    get session() { return session; },
    sessionCount: () => session ? 1 : 0,
    sseCount: () => session ? session.clientCount : 0,

    async postHandler(req, res) {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
      if (url.pathname !== '/api/ebot-live') return false;
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return true;
      }
      const site = req.headers['sec-fetch-site'];
      const sameOrigin = site ? site === 'same-origin'
        : req.headers.origin === `http://${requestHost(req)}`;
      if (!sameOrigin) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not-allowed', message: 'Живой поток доступен только панели.' }));
        return true;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req, 4096));
      } catch (error) {
        const tooBig = error && error.status === 413;
        res.writeHead(tooBig ? 413 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: tooBig ? 'size' : 'request',
          message: tooBig ? 'Запрос слишком большой.' : 'Ожидается JSON-запрос.' }));
        return true;
      }
      if (!body || typeof body !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'request', message: 'Ожидается JSON-запрос.' }));
        return true;
      }
      try {
        if (body.action === 'start') {
          // Ники тренеров (панель берёт из составов, role «Тренер»):
          // попадают в TS-мьют до первого события.
          if (typeof this.setCoaches === 'function' && Array.isArray(body.coaches)) {
            this.setCoaches(body.coaches.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim()));
          }
          const made = await this.start(body.matchId, this.muteEngine);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(made));
          return true;
        }
        if (body.action === 'stop') {
          this.stop();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ stopped: true }));
          return true;
        }
        throw Object.assign(new Error('Неизвестное действие.'), { status: 400 });
      } catch (error) {
        const status = Number(error.status) || 502;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'ebot-live', message: String(error.message || 'eBot не ответил.') }));
        return true;
      }
    },
  };
}

function requestHost(req) { return req.headers.host || ''; }

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('size'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
