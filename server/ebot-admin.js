// Серверный клиент админки eBot (symfony 1.4 + socket.io v4, только polling).
// Запускается на стороне server.js / функций хостинга, никогда в браузере:
// логин-пароль, кука сессии, JWT и authkey приходят параметрами и не логируются.
// Верхний уровень модуля не тянет node:fs/node:vm и не ходит в сеть — они нужны
// только лениво в defaultLoadAes, чтобы файл можно было импортировать и на edge,
// передав свой loadAes/fetch.

const HTTP_TIMEOUT_MS = 10_000;
// eBot кладёт admin-JWT прямо в HTML авторизованных страниц (initSocketIo).
const JWT_RE = /token:\s*'Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)'/;
// Живой eBot (не XHR): на неверный логин и на протухшую сессию admin-роуты
// отвечают 200 с формой логина заново (не 401/302). Опознаём её по полю
// signin[username] или надписи «Username or E-Mail».
const LOGIN_FORM_RE = /signin\[username\]|Username or E-Mail/;
// Кнопки матча: eBot отдаёт JSON-массив HTML, команда зашита в doRequest(...).
const DO_REQUEST_RE = /doRequest\('([a-zA-Z]+)',\s*'([\d.]+:\d+)',\s*'(\d+)',\s*'([a-f0-9.]+)'\)/g;

// ---------- мелкие помощники без состояния ----------

function urlEncode(fields) {
  // Ручной, а не URLSearchParams: тело читается в тестах как есть.
  // undefined-поля пропускаем: eBot подставит свои значения (сервер —
  // записанный на матче, пароль — сгенерированный формой), а не literal
  // 'undefined' в POST-теле.
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&');
}

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Значение атрибута тега (кавычки одинарные или двойные).
function attrValue(tag, name) {
  const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i'));
  if (!m) return null;
  return m[2] !== undefined ? m[2] : m[3];
}

// Значение hidden-поля формы по name (порядок атрибутов в symfony плавает).
function inputValue(html, name) {
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    if (attrValue(m[0], 'name') === name) {
      const v = attrValue(m[0], 'value');
      return v === null ? '' : decodeEntities(v);
    }
  }
  return null;
}

// Опции <select name=...> — для каталога серверов и карт eBot.
function selectOptions(html, name) {
  const out = [];
  for (const block of html.match(/<select\b[^>]*>[\s\S]*?<\/select>/gi) || []) {
    const open = block.match(/^<select\b[^>]*>/i);
    if (!open || attrValue(open[0], 'name') !== name) continue;
    for (const o of block.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)) {
      out.push({ value: attrValue(o[0], 'value') ?? '', label: stripTags(o[1]) });
    }
  }
  return out;
}

function parseJsonOrRaw(s) {
  try { return JSON.parse(s); } catch { return s; }
}

function splitSetCookie(header) {
  // Запасной разбор, если Headers не умеет getSetCookie: режем по запятым
  // только перед «имя=», чтобы не порвать expires.
  if (!header) return [];
  return header.split(/,(?=[^;,]*=)/).map(s => s.trim()).filter(Boolean);
}

function absorbCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : splitSetCookie(res.headers.get('set-cookie'));
  for (const line of list) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(jar) {
  return [...jar].map(([k, v]) => k + '=' + v).join('; ');
}

// Адрес socket.io производим из baseUrl (тот же хост, порт 12360, http);
// переопределяется снаружи параметром socketUrl — внутри не угадываем.
export function ebotSocketUrl(baseUrl) {
  const u = new URL(baseUrl);
  return 'http://' + u.hostname + ':12360';
}

// ---------- AES (vendored aes-ctr.js в vm-песочнице) ----------

let aesCache = null;

// node:модули импортируем лениво: файл должен открываться и там, где их нет.
export async function defaultLoadAes() {
  if (aesCache) return aesCache;
  const [{ readFile }, vm] = await Promise.all([import('node:fs/promises'), import('node:vm')]);
  const src = await readFile(new URL('./vendor/aes-ctr.js', import.meta.url), 'utf8');
  // Песочница: vendored файл объявляет глобальные Aes/Utf8/Base64,
  // наружу отдаём только Aes.
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  aesCache = { Aes: ctx.Aes };
  return aesCache;
}

// Отдельно от класса — для тестов round-trip тем же vendored AES.
export function ebotEncrypt(plain, authkey, aesModule) {
  const Aes = (aesModule && aesModule.Aes) || aesModule;
  if (!Aes || !Aes.Ctr || typeof Aes.Ctr.encrypt !== 'function') {
    throw new Error('AES-модуль eBot не загружен');
  }
  return Aes.Ctr.encrypt(plain, authkey, 256);
}

// ---------- socket.io v4 поверх engine.io polling, без зависимостей ----------

// Лёгкая сессия: open() — рукопожатие + connect, emit() — POST пакета «42…»,
// nextEvent() — поллинг GET до первого события или таймаута. JWT едет в
// Authorization: Bearer на каждый запрос (так его читает socketio-jwt в eBot).
export function socketioSession({ jwt, baseWsUrl, fetchImpl = globalThis.fetch, now = Date.now }) {
  return new SocketIoPolling(jwt, baseWsUrl, fetchImpl, now);
}

class SocketIoPolling {
  #jwt;
  #base;
  #fetch;
  #now;
  #sid = null;
  #pingInterval = 25_000;
  #queue = [];
  #open = true;
  #timer = null;
  #ioError = null;

  constructor(jwt, baseWsUrl, fetchImpl, now) {
    this.#jwt = jwt;
    this.#base = new URL(baseWsUrl);
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  #url() {
    const u = new URL('/socket.io/', this.#base);
    u.searchParams.set('EIO', '4');
    u.searchParams.set('transport', 'polling');
    if (this.#sid) u.searchParams.set('sid', this.#sid);
    return u;
  }

  #ensureOpen() {
    if (!this.#open) throw new Error('Соединение eBot socket.io уже закрыто');
    if (this.#ioError) throw new Error('eBot socket.io отклонил подключение');
  }

  async #request(method, url, packet, timeoutMs) {
    const headers = { authorization: 'Bearer ' + this.#jwt };
    if (packet !== null && packet !== undefined) {
      // engine.io принимает тела пакетов как text/plain.
      headers['content-type'] = 'text/plain;charset=UTF-8';
    }
    try {
      return await this.#fetch(String(url), {
        method,
        headers,
        body: packet === null || packet === undefined ? undefined : packet,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error('eBot socket.io не ответил');
    }
  }

  async #send(packet) {
    if (!this.#sid) return;
    const res = await this.#request('POST', this.#url(), packet, HTTP_TIMEOUT_MS);
    if (res.status === 200) this.#feed(await res.text());
  }

  // Разбор пачки engine.io (пакеты склеены \x1e). «ok» и прочий мусор молча
  // пропускаем: главное — события «42…» и ошибки «44…».
  #feed(text) {
    for (const raw of String(text).split('\x1e')) {
      if (!raw) continue;
      const t = raw[0];
      if (t === '3') continue; // pong
      if (t === '2') { this.#send('3').catch(() => {}); continue; } // сервер пингует нас
      if (t !== '4') continue; // 0 open, 1 close, 6 noop
      const kind = raw[1];
      if (kind === '2') {
        const arr = parseJsonOrRaw(raw.slice(2));
        if (Array.isArray(arr) && arr.length) {
          this.#queue.push({ name: arr[0], payload: arr.length > 1 ? arr[1] : null });
        }
      } else if (kind === '4') {
        this.#ioError = raw.slice(2);
      }
      // '40' — подтверждение connect, '41' — disconnect: не события.
    }
  }

  async open() {
    this.#ensureOpen();
    const hs = await this.#request('GET', this.#url(), null, HTTP_TIMEOUT_MS);
    if (hs.status !== 200) throw new Error('eBot socket.io не ответил на рукопожатие');
    const text = await hs.text();
    if (!text.startsWith('0')) throw new Error('eBot socket.io не отдал сессию');
    let info;
    try { info = JSON.parse(text.slice(1)); } catch { throw new Error('eBot socket.io не отдал сессию'); }
    this.#sid = info.sid;
    if (!this.#sid) throw new Error('eBot socket.io не отдал сессию');
    if (info.pingInterval) this.#pingInterval = info.pingInterval;

    const ack = await this.#request('POST', this.#url(), '40', HTTP_TIMEOUT_MS);
    if (ack.status !== 200) throw new Error('eBot socket.io отклонил подключение');
    this.#feed(await ack.text());
    this.#ensureOpen();

    // Пинг по спецификации eBot: сами шлём «2» каждые pingInterval.
    this.#timer = setInterval(() => {
      if (this.#open) this.#send('2').catch(() => {});
    }, this.#pingInterval);
    this.#timer.unref?.(); // короткие сессии не должны держать процесс
    return this;
  }

  async emit(name, payload) {
    this.#ensureOpen();
    const res = await this.#request('POST', this.#url(), '42' + JSON.stringify([name, payload]), HTTP_TIMEOUT_MS);
    if (res.status !== 200) throw new Error('eBot socket.io отклонил отправку');
    this.#feed(await res.text());
    this.#ensureOpen();
  }

  // Одно событие или null по таймауту. Каждое ожидание — своя серия GET-поллингов;
  // таймаут каждого запроса не больше остатка ожидания, но и не больше 10 с.
  async nextEvent(timeoutMs = 4_000) {
    const deadline = this.#now() + timeoutMs;
    while (this.#open && !this.#ioError) {
      if (this.#queue.length) return this.#queue.shift();
      const remain = deadline - this.#now();
      if (remain <= 0) return null;
      // engine.io держит GET-poll открытым до pingInterval (25 с): таймаут
      // отдельного запроса — это НЕ ошибка канала, а молчание комнаты.
      // Роняем в ошибку только если дедлайда ожидания уже не осталось.
      let res;
      try {
        res = await this.#request('GET', this.#url(), null, Math.max(200, Math.min(HTTP_TIMEOUT_MS, remain)));
      } catch (error) {
        if (this.#now() >= deadline) return null;
        throw error;
      }
      if (res.status !== 200) throw new Error('eBot socket.io прервал соединение');
      this.#feed(await res.text());
    }
    this.#ensureOpen();
    return null;
  }

  close() {
    this.#open = false;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#sid) this.#send('41').catch(() => {}); // disconnect, огонь и забыть
  }
}

// ---------- сам админ-клиент ----------

export function createEbotAdmin({
  baseUrl,
  user,
  password,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  loadAes = defaultLoadAes,
  socketUrl = null,
}) {
  return new EbotAdmin(baseUrl, user, password, fetchImpl, now, loadAes, socketUrl);
}

class EbotAdmin {
  #base;
  #user;
  #password;
  #fetch;
  #now;
  #loadAes;
  #socketBase;
  #cookies = new Map();
  #jwt = null;
  #readyPromise = null;
  #aesPromise = null;

  constructor(baseUrl, user, password, fetchImpl, now, loadAes, socketUrl) {
    try {
      this.#base = new URL(baseUrl);
    } catch {
      throw new Error('Адрес eBot задан неверно');
    }
    if (this.#base.protocol !== 'http:' && this.#base.protocol !== 'https:') {
      throw new Error('Адрес eBot задан неверно');
    }
    this.#user = user;
    this.#password = password;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#loadAes = loadAes;
    this.#socketBase = socketUrl || ebotSocketUrl(baseUrl);
  }

  #aes() {
    if (!this.#aesPromise) this.#aesPromise = Promise.resolve(this.#loadAes());
    return this.#aesPromise;
  }

  // Все запросы с сетевыми ошибками → reject «eBot не ответил», процесс не роняем.
  async #raw(url, init = {}) {
    const headers = { ...(init.headers || {}) };
    if (this.#cookies.size) headers.cookie = cookieHeader(this.#cookies);
    try {
      const res = await this.#fetch(String(url), {
        method: init.method || 'GET',
        headers,
        body: init.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(init.timeoutMs || HTTP_TIMEOUT_MS),
      });
      absorbCookies(res, this.#cookies);
      return res;
    } catch (error) {
      throw new Error('eBot не ответил: ' + (error && error.message ? error.message : 'сеть'));
    }
  }

  // Авторизованный запрос. Протухшая сессия живого eBot — это 200 с формой
  // логина в HTML (или 401/редирект на guard/login как запасные признаки);
  // читаем тело, поэтому вызывавший обязан забрать res.text() сам — мы
  // дублируем чтение через clone().
  async #authed(pathOrUrl, init = {}) {
    const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, this.#base);
    const res = await this.#raw(url, init);
    const loc = res.headers.get('location') || '';
    if (res.status === 401 ||
        (res.status >= 300 && res.status < 400 && loc.includes('guard/login'))) {
      const error = new Error('Сессия eBot истекла');
      error.stale = true;
      throw error;
    }
    if (res.status === 200 &&
        !init.skipStaleCheck &&
        (res.headers.get('content-type') || '').includes('text/html')) {
      let page = '';
      try { page = await res.clone().text(); } catch { page = ''; }
      if (page && LOGIN_FORM_RE.test(page)) {
        const error = new Error('Сессия eBot истекла');
        error.stale = true;
        throw error;
      }
    }
    return res;
  }

  // Один повтор при протухшей сессии — перелогин и вторая попытка, не цикл:
  // вторая ошибка stale уходит наружу как есть.
  async #withSession(job) {
    await this.ready();
    try {
      return await job();
    } catch (error) {
      if (error && error.stale) {
        this.#readyPromise = null;
        await this.ready();
        return await job();
      }
      throw error;
    }
  }

  // Ленивая гарантия «залогинены + есть JWT», один раз; сбрасывается при stale.
  async ready() {
    if (!this.#readyPromise) this.#readyPromise = this.#bootstrap();
    return this.#readyPromise;
  }

  async #bootstrap() {
    await this.#login();
    let res;
    try {
      res = await this.#authed('/admin.php/matchs/current');
    } catch (error) {
      // Свежая сессия сразу не принята — повторять бессмысленно.
      if (error.stale) throw new Error('eBot не отдал admin-JWT: сессия не принята');
      throw error;
    }
    if (res.status !== 200) throw new Error('eBot не отдал admin-JWT');
    const m = (await res.text()).match(JWT_RE);
    if (!m) throw new Error('eBot не отдал admin-JWT');
    this.#jwt = m[1];
  }

  async #login() {
    this.#cookies.clear();
    const url = new URL('/admin.php/guard/login', this.#base);
    const form = await this.#raw(url);
    if (form.status !== 200) throw new Error('eBot не отдал форму логина (HTTP ' + form.status + ')');
    const csrf = inputValue(await form.text(), 'signin[_csrf_token]');
    if (!csrf) throw new Error('eBot не отдал форму логина');

    const res = await this.#raw(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: urlEncode({
        'signin[_csrf_token]': csrf,
        'signin[username]': this.#user,
        'signin[password]': this.#password,
      }),
    });
    // Живой eBot (не XHR): верный логин = редирект (30x) + кука symfony;
    // неверный = 200 с формой заново. 401 оставляем как запасной случай.
    const redirected = res.status >= 300 && res.status < 400;
    if (redirected) return;
    if (res.status === 200) {
      const page = await res.text();
      if (LOGIN_FORM_RE.test(page)) throw new Error('Логин в eBot не удался');
    }
    throw new Error('Логин в eBot не удался (HTTP ' + res.status + ')');
  }

  async matchCommands(matchId) {
    return this.#withSession(async () => {
      const res = await this.#authed('/admin.php/matchs/actions/' + encodeURIComponent(String(matchId)), {
        method: 'POST',
      });
      if (res.status !== 200) throw new Error('eBot не отдал кнопки матча (HTTP ' + res.status + ')');
      let buttons;
      try {
        buttons = JSON.parse(await res.text());
      } catch {
        throw new Error('eBot вернул неожиданный ответ по кнопкам матча');
      }
      const html = Array.isArray(buttons) ? buttons.join('') : String(buttons);
      const commands = [...html.matchAll(DO_REQUEST_RE)].map(m => ({
        action: m[1], ip: m[2], id: m[3], authkey: m[4],
      }));
      return { commands, jwt: this.#jwt };
    });
  }

  async sendCommand(matchId, command, { argument } = {}) {
    const { commands, jwt } = await this.matchCommands(matchId);
    // authkey и ip у всех кнопок матча общие. Для кнопочных команд берём
    // СВОЮ кнопку: eBot отдаёт их по статусу матча, и фолбэк на чужую
    // отправил бы не ту команду («Конец разминки» превратился бы в
    // stopNoRs). executeCommand кнопкой не бывает — для него ip/authkey
    // берём с первой попавшейся.
    const entry = commands.find(c => c.action === command) ||
      (command === 'executeCommand' ? commands[0] : null);
    if (!entry) throw new Error('eBot не отдал кнопки матча — команду отправить нечем');
    const plain = argument === undefined || argument === null
      ? matchId + ' ' + command + ' ' + entry.ip
      : matchId + ' ' + command + ' ' + entry.ip + ' ' + argument;
    const cipher = ebotEncrypt(plain, entry.authkey, await this.#aes());

    const io = socketioSession({ jwt, baseWsUrl: this.#socketBase, fetchImpl: this.#fetch, now: this.#now });
    try {
      await io.open();
      await io.emit('identify', { type: 'matchs' });
      await io.emit('matchCommandSend', JSON.stringify([cipher, entry.ip]));
      if (command === 'executeCommand') {
        // RCON-ответ приходит в rcon-комнате, а не matchs — не ждём его здесь.
        return { accepted: true, reply: null };
      }
      const deadline = this.#now() + 4_000;
      for (;;) {
        const remain = deadline - this.#now();
        if (remain <= 0) return { accepted: false, reply: null };
        const ev = await io.nextEvent(remain);
        if (!ev) return { accepted: false, reply: null };
        if (ev.name !== 'matchsHandler') continue;
        // eBot присылает аргумент строкой-JSON — парсим, но не доверяем форме.
        const data = typeof ev.payload === 'string' ? parseJsonOrRaw(ev.payload) : ev.payload;
        if (data && typeof data === 'object' && String(data.id) === String(matchId)) {
          return { accepted: true, reply: data };
        }
      }
    } finally {
      io.close();
    }
  }

  async createMatch({
    teamA, teamB, map, serverId, side = 'random', password,
    maxRound = 12, rules = 'esl5on5', knifeRound = true, format = 'normal',
    teamAFlag = 'EU', teamBFlag = 'EU',
  }) {
    return this.#withSession(async () => {
      const pageRes = await this.#authed('/admin.php/matchs/create');
      if (pageRes.status !== 200) throw new Error('eBot не отдал страницу создания матча');
      const csrf = inputValue(await pageRes.text(), 'matchs[_csrf_token]');
      if (!csrf) throw new Error('eBot не отдал страницу создания матча');

      const res = await this.#authed('/admin.php/matchs/create', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: urlEncode({
          'matchs[team_a_name]': teamA,
          'matchs[team_b_name]': teamB,
          'matchs[team_a_flag]': teamAFlag,
          'matchs[team_b_flag]': teamBFlag,
          'matchs[max_round]': maxRound,
          'matchs[rules]': rules,
          'matchs[map_selection_mode]': format,
          'matchs[config_knife_round]': knifeRound === false ? 0 : 1,
          // Пароль не задан — поле пропускается: форма eBot подставит
          // сгенерированный (urlEncode отбрасывает undefined), пустая строка
          // создала бы матч без пароля на сервере CS2.
          'matchs[config_password]': password,
          maps: map,
          server_id: serverId,
          side,
          'matchs[_csrf_token]': csrf,
        }),
      });
      // Успех — редирект; 200 значит форму с ошибками.
      if (!(res.status >= 300 && res.status < 400)) throw new Error('eBot не создал матч');

      // id необязателен: пробуем вытащить flash со страницы после редиректа.
      // Идём только за относительным Location на своём же eBot: следовать
      // абсолютному адресу чужому хосту с нашей кукой сессии нельзя.
      let id;
      const loc = res.headers.get('location');
      if (loc && loc.startsWith('/') && !loc.startsWith('//')) {
        try {
          const follow = await this.#authed(new URL(loc, this.#base));
          if (follow.status === 200) {
            const m = (await follow.text()).match(/Match created with ID[^\d]*(\d+)/);
            if (m) id = Number(m[1]);
          }
        } catch { /* без id не падаем */ }
      }
      return { created: true, id };
    });
  }

  async startMatch(matchId, serverId) {
    return this.#withSession(async () => {
      const res = await this.#authed('/admin.php/matchs/start/server', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: urlEncode({ match_id: String(matchId), server_id: serverId === undefined || serverId === null ? undefined : String(serverId) }),
      });
      if (res.status >= 300 && res.status < 400) return { started: true };
      throw new Error('eBot не стартовал матч');
    });
  }

  async catalog() {
    return this.#withSession(async () => {
      const res = await this.#authed('/admin.php/matchs/create');
      if (res.status !== 200) throw new Error('eBot не отдал страницу создания матча');
      const html = await res.text();
      const servers = selectOptions(html, 'server_id')
        .map(o => ({ id: o.value, label: o.label }))
        .filter(o => o.id !== '');
      const maps = selectOptions(html, 'maps')
        .map(o => o.value || o.label)
        .filter(Boolean);
      return { servers, maps };
    });
  }

  // ── Консоль матча (живые логи + RCON), отдельный блок ─────────────────────
  // Комнаты rcon-*/logger-* и сам rconSend доступны только с admin-JWT
  // (websocket_server.mjs), поэтому всё идёт через ту же авторизацию, что и
  // sendCommand. Существующие методы не меняются: ниже только добавления.

  // Ключ шифрования и ip для AES-команд матчу: тот же вход, что ищет
  // sendCommand, вынесен отдельным методом, чтобы консоль не дублировала
  // разбор кнопок. Формат команды совпадает: «<matchId> <action> <ip> <arg>».
  async #commandChannel(matchId) {
    const { commands, jwt } = await this.matchCommands(matchId);
    const entry = commands[0];
    if (!entry) throw new Error('eBot не отдал кнопки матча — консоль недоступна');
    return { jwt, ip: entry.ip, authkey: entry.authkey };
  }

  // Кодирует «<matchId> executeCommand <ip> <команда>» тем же Aes.Ctr, что
  // и matchCommandSend. Возвращает готовую к emit строку JSON для rconSend.
  async #rconPacket(matchId, ip, authkey, command) {
    const plain = matchId + ' executeCommand ' + ip + ' ' + command;
    return JSON.stringify([ebotEncrypt(plain, authkey, await this.#aes()), ip]);
  }

  // Живая консоль матча: identify в rcon- и logger-комнаты, колбэки на
  // события (onLog — каждая строка лога CS2 уже текстом, onChat — только
  // строки say, предразобранные {nick, side, text}, onRcon — ответы на
  // executeCommand). Отдаёт {stop()}; повторный stop безопасен. Событие с
  // массивом строк (первое сообщение logger-комнаты) отдаётся построчно.
  async matchConsole(matchId, { onLog, onRcon, onChat } = {}, { timeoutMs = 15_000 } = {}) {
    if (typeof matchId !== 'string' && typeof matchId !== 'number') {
      throw new Error('Номер матча обязателен');
    }
    const callbacks = {
      log: typeof onLog === 'function' ? onLog : () => {},
      rcon: typeof onRcon === 'function' ? onRcon : () => {},
      chat: typeof onChat === 'function' ? onChat : () => {},
    };
    const channel = await this.#commandChannel(matchId);
    const packet = await this.#rconPacket(matchId, channel.ip, channel.authkey, 'status');

    const io = socketioSession({
      jwt: channel.jwt, baseWsUrl: this.#socketBase, fetchImpl: this.#fetch, now: this.#now,
    });
    let stopped = false;
    let reader = null;

    // Первое сообщение logger-комнаты — JSON-массив старых строк; дальше —
    // одиночные {id, content}. eBot кладёт в content лога ещё один слой JSON
    // (строку-JSON), как и в openRconSuccess.php — двойной parse.
    const handleLogger = (data, source) => {
      let parsed = typeof data === 'string' ? parseJsonOrRaw(data) : data;
      if (Array.isArray(parsed) && source === 'first') {
        for (const item of parsed) {
          const one = typeof item === 'string' ? parseJsonOrRaw(item) : item;
          pushLine(one && one.content !== undefined ? String(one.content) : String(item));
        }
        return;
      }
      pushLine(parsed && parsed.content !== undefined ? String(parsed.content) : String(data));
    };
    const pushLine = (line) => {
      const text = String(line ?? '');
      if (!text) return;
      callbacks.log(text);
      // Строка чата: как её разбирает сам eBot в openRconSuccess.php.
      const m = text.match(/^.+"(.+)<\d+><.+><(\w+)>"\ssay\s"(.+)"$/);
      if (m) callbacks.chat({ nick: m[1], side: m[2], text: m[3] });
    };

    // Цикл чтения: любое событие loggerHandler/rconHandler уходит в колбэки,
    // молча пропускаем служебные повторы и пустые строки.
    const loop = (async () => {
      try {
        await io.open();
        await io.emit('identify', { type: 'rcon', match_id: Number(matchId) || matchId });
        await io.emit('identify', { type: 'logger', match_id: Number(matchId) || matchId });
        // identify для matchs — держим статус матча в этой же сессии; rconSend
        // нужен для проверки канала (см. sendRcon: команды идут через него).
        await io.emit('identify', { type: 'matchs' });
        // Проба канала: status отвечает в rcon-комнату и подтверждает, что
        // консоль живая (eBot посылает ответ только для управляемого матча).
        await io.emit('rconSend', packet);
        let firstLogger = true;
        while (!stopped) {
          const ev = await io.nextEvent(timeoutMs);
          if (!ev) continue; // таймаут одной итерации — просто следующий цикл
          if (ev.name === 'rconHandler') {
            const data = typeof ev.payload === 'string' ? parseJsonOrRaw(ev.payload) : ev.payload;
            callbacks.rcon(data && data.content !== undefined ? String(data.content) : String(ev.payload ?? ''));
          } else if (ev.name === 'loggerHandler') {
            handleLogger(ev.payload, firstLogger ? 'first' : 'next');
            firstLogger = false;
          }
        }
      } catch (error) {
        if (!stopped) throw error;
      }
    })();
    reader = loop.catch(() => { /* stop() погашен в close ниже */ });

    return {
      // Закрывает сокет и прекращает чтение; ошибка чтения после stop — не
      // ошибка. Повторный вызов — пустая операция.
      stop: () => {
        if (stopped) return;
        stopped = true;
        io.close();
        reader = null;
      },
      // Дождаться окончания цикла (ошибка eBot уйдёт наружу).
      done: () => loop,
    };
  }

  // Одна RCON-команда матчу: rconSend (не matchCommandSend) и ожидание
  // первого rconHandler до 5 с. Отдельная короткая сессия — как sendCommand,
  // но ответ ждём в rcon-комнате, а не в matchs.
  async sendRcon(matchId, command) {
    const text = String(command || '');
    if (!text || !/^[ -~]{1,200}$/.test(text)) {
      throw new Error('Команда RCON нечитаема');
    }
    const channel = await this.#commandChannel(matchId);
    const packet = await this.#rconPacket(matchId, channel.ip, channel.authkey, text);
    const io = socketioSession({
      jwt: channel.jwt, baseWsUrl: this.#socketBase, fetchImpl: this.#fetch, now: this.#now,
    });
    try {
      await io.open();
      await io.emit('identify', { type: 'rcon', match_id: Number(matchId) || matchId });
      await io.emit('rconSend', packet);
      const deadline = this.#now() + 5_000;
      for (;;) {
        const remain = deadline - this.#now();
        if (remain <= 0) return { accepted: false, reply: null };
        const ev = await io.nextEvent(remain);
        if (!ev) return { accepted: false, reply: null };
        if (ev.name !== 'rconHandler') continue;
        const data = typeof ev.payload === 'string' ? parseJsonOrRaw(ev.payload) : ev.payload;
        return {
          accepted: true,
          reply: data && data.content !== undefined ? String(data.content) : String(ev.payload ?? ''),
        };
      }
    } finally {
      io.close();
    }
  }
}
