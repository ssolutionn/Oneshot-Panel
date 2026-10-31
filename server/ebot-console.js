// Консоль матча eBot для локальной панели (server.js): живые логи CS2, чат и
// RCON одного матча, через server/ebot-admin.js (matchConsole/sendRcon).
// Node-хаб держит по одной консоль-сессии на запрос браузера и раздаёт её
// как SSE (GET /api/ebot-console?stream=<id>): события log/chat/rcon/stop
// текстом, всё из eBot в браузер уходит только текстом. Запись — POST
// {action:'send', id, command} (RCON-команда целиком; «say "..."» для чата
// формирует вызывающий), закрытие — POST {action:'stop', id}.
// Секреты eBot сюда не приходят: хаб получает готовый admin-клиент.
import { randomBytes } from 'node:crypto';

export const CONSOLE_ID_RE = /^[A-Za-z0-9_-]{10,32}$/;
// RCON-команда/текст чата: только печатные ASCII (0x20–0x7E) без кавычек,
// точки с запятой и обратной косой черты — текст уезжает в RCON-строку
// eBot как есть, экранированию там доверия нет (в PHP-ядре скажем addslashes
// есть только у say). Жёстче ALLOWED_ARGUMENT в ebot-admin.mjs.
const COMMAND_RE = /^[ -!#-\x39<-Z\x5e-~]{1,200}$/;
const MAX_SESSIONS = 20;

// Разбор строки лога CS2 на сообщение чата — как сам eBot
// (openRconSuccess.php): nick, сторона (CT/TERRORIST), текст. say_team
// сюда не попадает (eBot различает только say).
export function parseChatLine(line) {
  const m = String(line || '').match(/^.+"(.+)<\d+><.+><(\w+)>"\ssay\s"(.+)"$/);
  if (!m) return null;
  return { nick: m[1], side: m[2], text: m[3] };
}

const escapeSse = (text) =>
  String(text ?? '').replace(/[\r\n]/g, ' ').slice(0, 4000);

// Одна консоль-сессия: подписки SSE-клиентов + события eBot. Ниже «клиент» —
// всегда браузер через sseHandler; source — Node-стрим ответа.
class ConsoleSession {
  constructor(id, { matchId, admin, log = () => {}, now = Date.now, sseIdLength = 12 } = {}) {
    this.id = id;
    this.matchId = matchId;
    this.admin = admin;
    this.log = log;
    this.#now = now;
    this.#sseIdLength = sseIdLength;
    this.#clients = new Set();
    this.#rcon = null;
    this.#stopped = false;
    this.#idleSince = now();
  }
  #now;
  #clients;
  #rcon;
  #stopped;
  #sseIdLength;
  #idleSince;
  // Буфер на СЕССИЮ (не на хаб): реплей чужого матча — утечка логов/чата
  // одного матча в консоль другого. 100 строк на поток, консоль не сервер.
  #history = { log: [], chat: [], rcon: [] };

  // Подписать браузер: отдаёт уже случившееся (краткий буфер логов/чата,
  // чтобы переподключение SSE не теряло контекст) и живые события дальше.
  addClient(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive'
    });
    // Первое событие — id сессии и матча, чтобы клиент показал, за кем следит.
    res.write(`event: hello\ndata: ${JSON.stringify({ id: this.id, matchId: this.matchId })}\n\n`);
    for (const line of this.#history.log) res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
    for (const line of this.#history.chat) res.write(`event: chat\ndata: ${JSON.stringify(line)}\n\n`);
    for (const line of this.#history.rcon) res.write(`event: rcon\ndata: ${JSON.stringify(line)}\n\n`);
    const client = { res, sse: this.#nextId(), alive: true };
    this.#clients.add(client);
    res.on('close', () => {
      client.alive = false;
      this.#clients.delete(client);
      if (!this.#clients.size) this.#idleSince = this.#now();
    });
    // Comment-keepalive каждые 20 с: прокси не рвут пустое соединение.
    const timer = setInterval(() => {
      if (client.alive) res.write(': ping\n\n');
      else clearInterval(timer);
    }, 20_000);
    timer.unref?.();
    return client;
  }

  #write = (event, payload) => {
    for (const client of this.#clients) {
      try {
        client.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch { /* закрытый клиент уберётся по 'close' */ }
    }
  };

  // Соединяемся к eBot и пересылаем события. Ошибка уходит всем клиентом
  // событием stop и завершает сессию.
  async start() {
    try {
      this.#rcon = await this.admin.matchConsole(this.matchId, {
        onLog: (line) => {
          this.log('log ' + this.id + ' ' + line);
          this.#emit('log', { line });
          const chat = parseChatLine(line);
          if (chat) this.#emit('chat', chat);
        },
        onRcon: (content) => {
          this.#emit('rcon', { content });
        },
        // onChat не используем: строка лога уже ушла в 'log', парс чата
        // делаем сами (parseChatLine) — единый источник событий.
        onChat: () => {},
      });
    } catch (error) {
      this.stop('eBot не открыл консоль матча');
      this.log('start-fail ' + this.id + ' ' + String(error.message || ''));
      throw error;
    }
    return this;
  }

  #emit(event, payload) {
    if (this.#stopped) return;
    this.#write(event, payload);
    // Bound-история: последние 100 строк на поток, больше панели не нужно.
    { // буфер сессии всегда есть
      const key = event === 'chat' ? 'chat' : event === 'rcon' ? 'rcon' : 'log';
      this.#history[key].push(payload);
      if (this.#history[key].length > 100) this.#history[key].shift();
    }
  }

  // Отправить команду (RCON-команда целиком, включая say): eBot отвечает в
  // rconHandler, ответ придёт через matchConsole и уйдёт клиентам.
  async send(command) {
    if (this.#stopped) throw Object.assign(new Error('Консоль матча закрыта.'), { status: 409 });
    if (!COMMAND_RE.test(String(command))) {
      throw Object.assign(new Error('Команда RCON нечитаема.'), { status: 400 });
    }
    const result = await this.admin.sendRcon(this.matchId, command);
    return { accepted: Boolean(result.accepted), reply: result.reply || '' };
  }

  stop(reason = '') {
    this.#stopped = true;
    try { this.#rcon?.stop(); } catch { /* already */ }
    for (const client of this.#clients) {
      try {
        client.res.write(`event: stop\ndata: ${JSON.stringify({ reason: escapeSse(reason) })}\n\n`);
        client.res.end();
      } catch { /* already closed */ }
      client.alive = false;
    }
    this.#clients.clear();
    this.log('stop ' + this.id + (reason ? ' ' + reason : ''));
  }

  get clientCount() { return this.#clients.size; }
  get stopped() { return this.#stopped; }
  // Для reaper'а хаба: когда сессия осталась без клиентов.
  get idleSince() { return this.#idleSince; }

  #nextId() {
    return randomBytes(Math.ceil(this.#sseIdLength / 2)).toString('hex').slice(0, this.#sseIdLength);
  }
}

// Хаб консолей: создаёт сессии, ищет по id, раздаёт SSE.
export function createConsoleHub({ admin, log = () => {}, now = Date.now } = {}) {
  if (!admin || typeof admin.matchConsole !== 'function' || typeof admin.sendRcon !== 'function') {
    throw new Error('Нужен eBot-админ с matchConsole и sendRcon.');
  }
  const sessions = new Map();
  const makeId = () => randomBytes(8).toString('base64url');

  const closeAll = () => { for (const s of sessions.values()) s.stop('shutdown'); sessions.clear(); };

  // Reaper: закрытая вкладка не шлёт POST stop — сессия без клиентов
  // продолжает поллить eBot. Через 2 минуты тишины закрываем сами.
  const reaper = setInterval(() => {
    const nowTime = Date.now();
    for (const s of sessions.values()) {
      if (!s.stopped && s.clientCount === 0 && nowTime - s.idleSince > 120_000) {
        sessions.delete(s.id);
        s.stop('timeout');
        log(`console ${s.id} закрыта по таймауту без клиентов`);
      }
    }
  }, 30_000);
  reaper.unref?.();

  return {
    // Создать сессию для матча. Отдаёт {id}. Совпадающий матч — отдельная
    // сессия (не делим подписки между вкладками).
    async start(matchId) {
      const id = String(matchId);
      if (!/^\d{1,9}$/.test(id)) throw Object.assign(new Error('Номер матча обязателен.'), { status: 400 });
      if (sessions.size >= MAX_SESSIONS) {
        // Самая старая закрытая сессия уходит; если все живые — отказ.
        const done = [...sessions.values()].find(s => s.stopped || s.clientCount === 0);
        if (done) { sessions.delete(done.id); done.stop('replaced'); }
        else throw Object.assign(new Error('Слишком много открытых консолей.'), { status: 429 });
      }
      const session = new ConsoleSession(makeId(), { matchId: id, admin, log, now });
      sessions.set(session.id, session);
      try {
        await session.start();
      } catch (error) {
        sessions.delete(session.id);
        throw Object.assign(new Error('eBot не открыл консоль матча'), { status: 502, cause: error });
      }
      return { id: session.id, matchId: id };
    },

    send(sessionId, command) {
      const session = sessions.get(String(sessionId || ''));
      if (!session || session.stopped) {
        return Promise.reject(Object.assign(new Error('Консоль матча не найдена.'), { status: 404 }));
      }
      return session.send(command);
    },

    stop(sessionId) {
      const session = sessions.get(String(sessionId || ''));
      if (!session) return false;
      session.stop('closed by operator');
      sessions.delete(session.id);
      return true;
    },

    sseCount: () => {
      let n = 0;
      for (const s of sessions.values()) n += s.clientCount;
      return n;
    },
    sessionCount: () => sessions.size,
    closeAll,

    // GET-обработчик: /api/ebot-console?stream=<id> — SSE-поток сессии.
    sseHandler(req, res) {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
      if (url.pathname !== '/api/ebot-console') return false;
      const id = url.searchParams.get('stream') || '';
      if (!CONSOLE_ID_RE.test(id)) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not-found', message: 'Консоль матча не найдена.' }));
        return true;
      }
      const session = sessions.get(id);
      if (!session || session.stopped) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not-found', message: 'Консоль матча не найдена.' }));
        return true;
      }
      session.addClient(res);
      return true;
    },

    // POST-обработчик для /api/ebot-console: start/send/stop. Читает JSON,
    // same-origin — как /api/cs2-say (панель локальная, авторизации нет).
    async postHandler(req, res) {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
      if (url.pathname !== '/api/ebot-console') return false;
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return true;
      }
      const site = req.headers['sec-fetch-site'];
      const sameOrigin = site ? site === 'same-origin'
        : req.headers.origin === `http://${req.headers.host}`;
      if (!sameOrigin) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not-allowed', message: 'Консоль eBot доступна только панели.' }));
        return true;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req, 4096));
      } catch (error) {
        // Слишком большое тело — 413, а не невнятное 400.
        const tooBig = error && error.status === 413;
        res.writeHead(tooBig ? 413 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: tooBig ? 'size' : 'request',
          message: tooBig ? 'Запрос консоли слишком большой.' : 'Ожидается JSON-запрос.' }));
        return true;
      }
      try {
        if (body.action === 'start') {
          const made = await this.start(body.matchId);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(made));
          return true;
        }
        if (body.action === 'send') {
          if (!CONSOLE_ID_RE.test(String(body.id || ''))) {
            throw Object.assign(new Error('Консоль матча не найдена.'), { status: 404 });
          }
          const result = await this.send(body.id, String(body.command || ''));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(result));
          return true;
        }
        if (body.action === 'stop') {
          if (!CONSOLE_ID_RE.test(String(body.id || ''))) {
            throw Object.assign(new Error('Консоль матча не найдена.'), { status: 404 });
          }
          this.stop(body.id);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ stopped: true }));
          return true;
        }
        throw Object.assign(new Error('Неизвестное действие.'), { status: 400 });
      } catch (error) {
        const status = Number(error.status) || 502;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'ebot-console', message: String(error.message || 'eBot не ответил.') }));
        return true;
      }
    },
  };
}

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
