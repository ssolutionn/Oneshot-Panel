// Обратный инжиниринг форм админки eBot (symfony 1.4): создание/редактирование
// матча и команды ПОЛНЫМ набором полей формы, а не усечённым, как в
// ebot-admin.js createMatch. Составы панель хранит у себя: в TeamsForm eBot
// полей игроков нет вовсе (игроки в eBot привязаны к матчу, не к команде),
// поэтому players в POST команды не уходит — только проверяется.
// Существующие файлы не меняются: собственная сессия (логин sfGuard + куки)
// повторяет ebot-admin.js, а при наличии admin.formRequest делегируем ему.

const HTTP_TIMEOUT_MS = 10_000;
const LOGIN_FORM_RE = /signin\[username\]|Username or E-Mail/;

// ---------- помощники (парная копия из ebot-admin.js: там они не экспортированы) ----------

function urlEncode(fields) {
  // Ручной: тело читается в тестах как есть; undefined/null пропускаем
  // (eBot подставит свои значения), массив повторяет ключ (seasons_list[]).
  const pairs = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const item of vals) pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(item)));
  }
  return pairs.join('&');
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

function attrValue(tag, name) {
  const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i'));
  if (!m) return null;
  return m[2] !== undefined ? m[2] : m[3];
}

function inputValue(html, name) {
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    if (attrValue(m[0], 'name') === name) {
      const v = attrValue(m[0], 'value');
      return v === null ? '' : decodeEntities(v);
    }
  }
  return null;
}

function splitSetCookie(header) {
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

// ---------- разбор страницы формы ----------

// Поля формы матча, обязательные по клиентской валидации eBot
// (createSuccess.php: rules/max_round required, maps проверяется в executeCreate).
const MATCH_REQUIRED = new Set(['matchs[rules]', 'matchs[max_round]', 'maps']);

// Поля формы команды: все необязательные (sfValidatorPass).
const TEAM_REQUIRED = new Set();

// Список полей формы: [{label, name, required, type}]. Читаем по блокам
// control-group (label над полем), скрытые поля до первого блока — без label.
function parseFormFields(html, requiredNames) {
  const formMatch = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i);
  const form = formMatch ? formMatch[0] : String(html);
  const fields = [];
  const chunks = form.split(/(?=<div\b[^>]*class="[^"]*control-group)/i);
  for (const chunk of chunks) {
    const labelM = chunk.match(/<label\b[^>]*>([\s\S]*?)<\/label>/i);
    const label = labelM ? stripTags(labelM[1]) : '';
    for (const m of chunk.matchAll(/<(input|select)\b[^>]*>/gi)) {
      const tag = m[0];
      const name = attrValue(tag, 'name');
      if (!name) continue; // кнопка submit без name — не поле
      const type = /^<select/i.test(tag) ? 'select'
        : (attrValue(tag, 'type') || 'text').toLowerCase();
      fields.push({
        label: label || name,
        name,
        required: requiredNames.has(name),
        type,
      });
    }
  }
  return fields;
}

// Ошибки symfony: <ul class="error_list"> стоит ПОСЛЕ поля, к которому
// относится; идём по странице по порядку и цепляем каждый список к последнему
// увиденному полю.
function parseFormErrors(html, labelByName) {
  const errors = [];
  const re = /<(input|select)\b[^>]*>|<ul\b[^>]*class="[^"]*error_list[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi;
  let lastName = null;
  for (const m of String(html).matchAll(re)) {
    if (m[1]) {
      const n = attrValue(m[0], 'name');
      if (n) lastName = n;
      continue;
    }
    const items = [...m[2].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map(x => stripTags(x[1])).filter(Boolean);
    for (const message of items) errors.push({ field: lastName, message });
  }
  // Читаемому человеком тексту нужен label поля, а не машинное имя.
  return errors.map(e => {
    const who = (e.field && labelByName.get(e.field)) || e.field || 'форма';
    return '«' + who + '»: ' + e.message;
  });
}

// ---------- собственная сессия (логин как в ebot-admin.js) ----------

class FormSession {
  #base;
  #user;
  #password;
  #fetch;
  #cookies = new Map();
  #readyPromise = null;
  #now;

  constructor({ baseUrl, user, password, fetchImpl, now }) {
    try { this.#base = new URL(baseUrl); } catch { throw new Error('Адрес eBot задан неверно'); }
    this.#user = user;
    this.#password = password;
    this.#fetch = fetchImpl;
    this.#now = now || Date.now;
  }

  async #raw(url, init = {}) {
    const headers = { ...(init.headers || {}) };
    if (this.#cookies.size) headers.cookie = [...this.#cookies].map(([k, v]) => k + '=' + v).join('; ');
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
    } catch {
      throw new Error('eBot не ответил');
    }
  }

  async #login() {
    this.#cookies.clear();
    const url = new URL('/admin.php/guard/login', this.#base);
    const form = await this.#raw(url);
    if (form.status !== 200) throw new Error('Логин в eBot не удался (HTTP ' + form.status + ')');
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
    if (res.status >= 300 && res.status < 400) return; // верный логин = редирект
    if (res.status === 200 && LOGIN_FORM_RE.test(await res.text())) {
      throw new Error('Логин в eBot не удался');
    }
    throw new Error('Логин в eBot не удался (HTTP ' + res.status + ')');
  }

  async ready() {
    if (!this.#readyPromise) this.#readyPromise = this.#login();
    return this.#readyPromise;
  }

  // Авторизованный запрос с одним перелогином при протухшей сессии:
  // живой eBot на протухшую отвечает 200 с формой логина заново.
  async request(path, init = {}) {
    const url = new URL(path, this.#base);
    const job = async () => {
      const res = await this.#raw(url, init);
      if (res.status === 200 &&
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
    };
    await this.ready();
    try {
      return await job();
    } catch (error) {
      if (!error || !error.stale) throw error;
      this.#readyPromise = null;
      await this.ready();
      return await job();
    }
  }
}

// ---------- клиент форм ----------

export function createEbotForms({ admin, baseUrl, user, password, fetchImpl = globalThis.fetch, now = Date.now }) {
  // Интеграция: ebot-admin.js может отдать публичный formRequest(path, init)
  // (Response) — тогда сессией управляет он. Пока его нет — своя сессия.
  if (admin && typeof admin.formRequest === 'function') {
    return new EbotForms((path, init) => admin.formRequest(path, init));
  }
  if (!admin && baseUrl) {
    const session = new FormSession({ baseUrl, user, password, fetchImpl, now });
    return new EbotForms((path, init) => session.request(path, init));
  }
  throw new Error('createEbotForms: нужен admin с formRequest или baseUrl/user/password');
}

class EbotForms {
  #request;

  constructor(request) {
    this.#request = request;
  }

  // GET страницы формы: поля + CSRF + значения скрытых полей (id редактирования).
  async #formPage(path, requiredNames) {
    const res = await this.#request(path);
    if (res.status !== 200) throw new Error('eBot не отдал страницу формы (HTTP ' + res.status + ')');
    const html = await res.text();
    const fields = parseFormFields(html, requiredNames);
    return { html, fields };
  }

  // Список полей формы создания матча: label, name, required, type.
  async matchFormFields() {
    const { fields } = await this.#formPage('/admin.php/matchs/create', MATCH_REQUIRED);
    return fields;
  }

  // Белый список: в POST уходят только поля, найденные на странице формы;
  // лишние входные параметры молча отбрасываются, обязательные не пустые.
  #buildBody(fields, values, extraRequired = []) {
    const allowed = new Set(fields.map(f => f.name));
    const body = {};
    for (const [name, value] of Object.entries(values)) {
      if (!allowed.has(name)) continue; // поле не из формы — не отправляем
      if (value === undefined || value === null) continue;
      body[name] = value;
    }
    for (const f of fields) {
      if (f.required && (body[f.name] === undefined || String(body[f.name]) === '')) {
        throw new Error('Поле «' + (f.label || f.name) + '» обязательно');
      }
    }
    for (const name of extraRequired) {
      if (body[name] === undefined || String(body[name]) === '') {
        throw new Error('Поле «' + name + '» обязательно');
      }
    }
    return body;
  }

  // POST формы и разбор ответа: symfony отвечает 302 (успех) либо 200 с
  // ошибками в <ul class="error_list"> — превращаем их в русскую ошибку.
  async #postForm(path, body, labelByName, failText) {
    const res = await this.#request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: urlEncode(body),
    });
    if (res.status >= 300 && res.status < 400) return res;
    if (res.status === 200) {
      const html = await res.text();
      const errors = parseFormErrors(html, labelByName);
      if (errors.length) throw new Error(failText + ': ' + errors.join('; '));
      throw new Error(failText + ': форма вернулась с ошибками');
    }
    throw new Error(failText + ' (HTTP ' + res.status + ')');
  }

  // Flash-сообщение после редиректа — единственный способ узнать id матча.
  // Идём только за относительным Location на своём же eBot (как ebot-admin):
  // чужой абсолютный адрес с нашей кукой сессии посещать нельзя.
  async #flashId(res) {
    const loc = res.headers.get('location') || '';
    if (!loc.startsWith('/') || loc.startsWith('//')) return undefined;
    try {
      const follow = await this.#request(loc);
      if (follow.status !== 200) return undefined;
      const m = (await follow.text()).match(/Match created with ID[^\d]*(\d+)/);
      return m ? Number(m[1]) : undefined;
    } catch { /* без id не падаем */ }
    return undefined;
  }

  // Полный набор полей MatchsForm: существующий createMatch в ebot-admin.js
  // шлёт лишь имена/флаги/max_round/rules/карту/сервер/side/ножи/пароль;
  // здесь добавлены season_id, overtime-поля, config_streamer,
  // config_full_score, map_selection_mode, auto_start/startdate/auto_start_time.
  async createMatch({
    teamA, teamB, map, serverId,
    side = 'random', password, maxRound = 12, rules = 'esl5on5',
    knifeRound = true, format = 'normal',
    teamAFlag = 'EU', teamBFlag = 'EU',
    seasonId, overtime = false, overtimeStartmoney, overtimeMaxRound,
    streamerReady = false, playAllRounds = false,
    autoStart = false, startdate, autoStartTime,
  }) {
    // Составы панель держит у себя — команды всегда свободным текстом
    // (team_a/team_b пустые), eBot-выборки команд не используем.
    for (const [what, v] of [['Название команды A', teamA], ['Название команды B', teamB],
      ['Карта', map], ['Сервер', serverId]]) {
      if (v === undefined || v === null || String(v) === '') {
        throw new Error(what + ' обязателен');
      }
    }
    const { html, fields } = await this.#formPage('/admin.php/matchs/create', MATCH_REQUIRED);
    const labelByName = new Map(fields.map(f => [f.name, f.label]));
    const csrf = inputValue(html, 'matchs[_csrf_token]');
    if (!csrf) throw new Error('eBot не отдал страницу создания матча');

    // Чекбоксы: непроверенный браузер не отправляет вовсе — false = undefined,
    // а не '0' (пустое значение в symfony связалось бы неверно).
    const body = this.#buildBody(fields, {
      'matchs[id]': inputValue(html, 'matchs[id]') ?? '',
      'matchs[_csrf_token]': csrf,
      'matchs[season_id]': seasonId === undefined ? '' : String(seasonId),
      'matchs[team_a]': '', 'matchs[team_b]': '',
      'matchs[team_a_name]': String(teamA),
      'matchs[team_b_name]': String(teamB),
      'matchs[team_a_flag]': teamAFlag,
      'matchs[team_b_flag]': teamBFlag,
      'matchs[max_round]': String(maxRound),
      'matchs[rules]': String(rules),
      'matchs[config_password]': password,
      'matchs[map_selection_mode]': format,
      'matchs[config_knife_round]': knifeRound === false ? undefined : '1',
      'matchs[config_ot]': overtime ? '1' : undefined,
      'matchs[overtime_startmoney]': overtimeStartmoney === undefined ? undefined : String(overtimeStartmoney),
      'matchs[overtime_max_round]': overtimeMaxRound === undefined ? undefined : String(overtimeMaxRound),
      'matchs[config_streamer]': streamerReady ? '1' : undefined,
      'matchs[config_full_score]': playAllRounds ? '1' : undefined,
      'matchs[auto_start]': autoStart ? '1' : undefined,
      'matchs[startdate]': startdate,
      'matchs[auto_start_time]': autoStartTime,
      maps: String(map),
      server_id: String(serverId),
      side,
    }, ['matchs[team_a_name]', 'matchs[team_b_name]', 'server_id']);

    const res = await this.#postForm('/admin.php/matchs/create', body, labelByName, 'eBot не создал матч');
    return { created: true, id: await this.#flashId(res) };
  }

  #checkPlayers(players) {
    if (!Array.isArray(players)) return;
    for (const p of players) {
      if (!p || typeof p !== 'object' || !p.nick || String(p.nick).trim() === '') {
        throw new Error('Игрок команды задан неверно: нужен ник');
      }
      if (p.steamid !== undefined && typeof p.steamid !== 'string') {
        throw new Error('Steam ID игрока должен быть строкой');
      }
    }
  }

  // TeamsForm: teams[name|shorthandle|flag|link] + seasons_list[] вне формы.
  // Полей игроков в форме НЕТ (в eBot игроки живут на матче), поэтому players
  // проверяются, возвращаются, но в POST не попадают.
  #teamBody(html, fields, { name, shorthandle, flag, link, seasons }) {
    const csrf = inputValue(html, 'teams[_csrf_token]');
    if (!csrf) throw new Error('eBot не отдал форму команды');
    return this.#buildBody(fields, {
      'teams[id]': inputValue(html, 'teams[id]') ?? '',
      'teams[_csrf_token]': csrf,
      'teams[name]': String(name),
      'teams[shorthandle]': shorthandle,
      'teams[flag]': flag,
      'teams[link]': link,
      'seasons_list[]': Array.isArray(seasons) && seasons.length ? seasons.map(String) : undefined,
    }, ['teams[name]']);
  }

  async createTeam({ name, players = [], shorthandle, flag = '', link, seasons = [] } = {}) {
    if (name === undefined || name === null || String(name).trim() === '') {
      throw new Error('Название команды обязательно');
    }
    this.#checkPlayers(players);
    const { html, fields } = await this.#formPage('/admin.php/teams/create', TEAM_REQUIRED);
    const labelByName = new Map(fields.map(f => [f.name, f.label]));
    const body = this.#teamBody(html, fields, { name, shorthandle, flag, link, seasons });
    await this.#postForm('/admin.php/teams/create', body, labelByName, 'eBot не создал команду');
    return { created: true, name: String(name), players };
  }

  async editTeam(id, { name, players = [], shorthandle, flag = '', link, seasons = [] } = {}) {
    if (id === undefined || id === null || String(id) === '') {
      throw new Error('Номер команды обязателен');
    }
    if (name !== undefined && String(name).trim() === '') {
      throw new Error('Название команды обязательно');
    }
    this.#checkPlayers(players);
    const path = '/admin.php/teams/edit/' + encodeURIComponent(String(id));
    const { html, fields } = await this.#formPage(path, TEAM_REQUIRED);
    const labelByName = new Map(fields.map(f => [f.name, f.label]));
    // Редактирование меняет только заданные поля: незаданные берём из формы.
    const current = {};
    for (const f of fields) {
      if (f.type === 'hidden') continue;
      const m = html.match(new RegExp('name="' + f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*value="([^"]*)"'));
      if (m) current[f.name] = decodeEntities(m[1]);
    }
    const body = this.#teamBody(html, fields, {
      name: name === undefined ? current['teams[name]'] : String(name),
      shorthandle: shorthandle === undefined ? current['teams[shorthandle]'] : shorthandle,
      flag: flag === undefined ? current['teams[flag]'] : flag,
      link: link === undefined ? current['teams[link]'] : link,
      seasons,
    });
    await this.#postForm(path, body, labelByName, 'eBot не сохранил команду');
    return { edited: true, id: String(id), name, players };
  }
}
