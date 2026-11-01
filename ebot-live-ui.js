// Живой матч eBot (только сайт): подписка на SSE-канал /api/ebot-live,
// который сервер панели транслирует из eBot. События — счёт, статус, пауза,
// раунды и киллы. Модуль обновляет карточку матча в блоке «Матчи eBot»
// (счёт и статус — только textContent, класс карточки — флаг statusFlag),
// ленту киллов и мини-радар: точки киллов ложатся на тот же радар карты и
// в те же пиксели, что у хитмапы ebot-stats.js. innerHTML не используется —
// DOM строится через el() (паттерн ebot-ui.js). Артефакт-сборку модуль не
// ломает: чистые функции внизу не трогают DOM и работают в node --test,
// initEbotLive и DOM-код запускаются только вызовом с сайта; импортов из
// live.js/lobby.js нет (и вообще импортов нет: ebot-stats.js движок радара
// не экспортирует, а его топ-уровень живёт в DOM — см. допущения).

// Повтор оборванного потока: 5 с, максимум 3 попытки — как консоль матча
// в ebot-ui.js, чтобы поведение живых каналов панели было одинаковым.
const RETRY_DELAY = 5000, RETRY_LIMIT = 3;
const LIVE = '/api/ebot-live';

// ---------- чистые функции (покрыты test/ebot-live-ui.test.js, без DOM) ----------

// Лента киллов — кольцо на limit записей: длинный матч не растит список
// бесконечно, DOM ленты перерисовывается из этого же источника.
export function newKillFeed(limit = 50) {
  const entries = [];
  return {
    push(entry) {
      entries.push(entry);
      while (entries.length > limit) entries.shift();
    },
    items() { return entries.slice(); }
  };
}

// «Nick ▸ weapon ▸ Nick2 (HS)». Поля могут не прийти (undefined-ники от
// сервера) — пустые фрагменты выпадают, строка не разваливается, одинокий
// «(HS)» без имён не остаётся.
export function killFeedText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const parts = [entry.killer, entry.weapon, entry.killed]
    .filter(part => part !== undefined && part !== null && part !== '');
  const text = parts.join(' ▸ ');
  return text && entry.headshot ? text + ' (HS)' : text;
}

// Number('') — это 0, а не мусор: пустое значение счёта не должно
// обнулять модель, поэтому пустое отсеиваем до приведения.
function toScore(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'string' && !value.trim()) return NaN;
  return Number(value);
}

// Счёт приходит числами, но JSON мог донести строку: поле модели — всегда
// число, иначе строгое сравнение в ebotEvents (ebot.js) промахнётся и
// журнал лобби задублирует смену счёта. Мусорное значение поле не трогает —
// остаётся прежний счёт, а не NaN.
export function applyScore(match, scoreA, scoreB) {
  if (!match) return match;
  const a = toScore(scoreA), b = toScore(scoreB);
  if (Number.isFinite(a)) match.scoreA = a;
  if (Number.isFinite(b)) match.scoreB = b;
  return match;
}

// Флаг карточки по статусу. Пауза приходит и отдельным событием, и текстом
// статуса (is_paused) — функция вычисляет флаг из любого источника, а
// обновление DOM идёт одним путём (renderCard), повторного срабатывания
// нет. Терминальные статусы сильнее паузы: «пауза» у завершённого матча
// вводит в заблуждение. Статусы и фазы живые («First side», «knife»),
// иначе карточка подсвечивается как идущий матч.
export function statusFlag(statusText, paused) {
  const text = String(statusText ?? '').trim();
  if (/^(finished|archived|stop|canceled|cancelled|заверш|останов)/i.test(text)) return 'finished';
  const isPaused = Boolean(paused) || /paus|пауз/i.test(text);
  if (/^(not[ -]?started|starting|waiting|pending)/i.test(text)) return isPaused ? 'paused' : null;
  if (isPaused) return 'paused';
  if (/warmup|разминк/i.test(text)) return 'warmup';
  if (!text) return null;
  return 'live';
}

// ---------- живой блок (вызывается только с сайта) ----------

// Паттерн ebot-ui.js: dataset — readonly в DOM, Object.assign бросает
// TypeError, поэтому заполняем отдельно по ключу после остальных свойств.
const el = (tag, props = {}, ...children) => {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) for (const [key, value] of Object.entries(dataset)) node.dataset[key] = value;
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
};

// Радары eBot (assets/maps/radar/) и миниатюры-фоллбэки — тот же набор,
// что у хитмапы ebot-stats.js. Движок там не экспортируется (а его
// топ-уровень трогает DOM), поэтому константы продублированы здесь:
// координаты киллов — те же пиксели радара, фон обязан совпадать.
const RADAR_DIR = '/assets/maps/radar/';
const FALLBACK_DIR = '/assets/maps/';
const RADARS = new Set([
  'de_dust2', 'de_mirage', 'de_inferno', 'de_nuke', 'de_cbble',
  'de_cache', 'de_train', 'de_season'
]);
const RADAR_SIZE = { width: 500, height: 509 };

// Цвета точек — палитра точек хитмапы ebot-stats.js (синий/красный), радиус
// тот же (2.2): живой радар и хитмапа читаются как одна система.
const KILLER_COLOR = 'rgba(36,107,222,.85)';
const VICTIM_COLOR = 'rgba(214,80,32,.85)';

// de_dust2 → Dust2.jpg — так лежат наши миниатюры (как в ebot-stats.js).
function mapNameToJpg(map) {
  return map.replace(/^de_/, '').replace(/(^\w|_\w)/g, m => m.replace('_', '').toUpperCase()) + '.jpg';
}

function hhmm(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Живой матч: { open(matchId), close() }.
 * getMatch(matchId) — текущая модель матча от ebot-ui.js (объект списка;
 * applyScore обновляет его поля, следующий опрос отрисует свежий счёт).
 * feedList / radarCanvas — элементы (или их id) ленты киллов и canvas
 * мини-радара. mapName — карта матча (строка или () => строка) для фона
 * радара. note(text) — строка статуса живого блока, log(text) — запись в
 * журнал лобби; оба колбэка ставит интегратор.
 */
export function initEbotLive({ getMatch, feedList, radarCanvas, mapName, note = () => {}, log = () => {} }) {
  const list = typeof feedList === 'string' ? document.getElementById(feedList) : feedList;
  const canvas = typeof radarCanvas === 'string' ? document.getElementById(radarCanvas) : radarCanvas;
  const currentMap = () => (typeof mapName === 'function' ? mapName() : mapName);
  const state = {
    matchId: null, source: null, timer: 0, retries: 0,
    statusText: '', phase: '', paused: false, finished: false,
    points: [], radar: { img: null, width: RADAR_SIZE.width, height: RADAR_SIZE.height }
  };
  let feed = newKillFeed();

  function closeStream() {
    if (state.source) { state.source.close(); state.source = null; }
  }

  function onMessage(event) {
    let msg = null;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    // Один канал на все матчи: чужие matchId молча пропускаем.
    if (state.matchId === null || String(msg.matchId) !== state.matchId) return;
    state.retries = 0; // живое событие пришло — поток есть, попытки с нуля
    handle(msg);
  }

  function handle(msg) {
    switch (msg.type) {
      case 'score': {
        const match = typeof getMatch === 'function' ? getMatch(msg.matchId) : null;
        if (match) applyScore(match, msg.scoreA, msg.scoreB);
        const node = card();
        const scoreNode = node?.querySelector('.lm-score');
        // Показ из модели: там числа и прежнее значение, если новое пришло
        // мусором; модели нет — показываем пришедшее как есть.
        if (scoreNode) scoreNode.textContent = `${match ? match.scoreA : Number(msg.scoreA) || 0} : ${match ? match.scoreB : Number(msg.scoreB) || 0}`;
        break;
      }
      case 'status': {
        state.phase = typeof msg.phase === 'string' ? msg.phase : '';
        if (typeof msg.text === 'string' && msg.text) state.statusText = msg.text;
        if (statusFlag(state.phase || state.statusText, state.paused) === 'finished') {
          finish('Матч завершён.');
        } else {
          renderCard();
        }
        break;
      }
      case 'paused': {
        state.paused = Boolean(msg.paused);
        // Пауза могла уже прийти текстом статуса — renderCard идемпотентен,
        // класс и текст карточки просто сходятся к одному состоянию.
        renderCard();
        note(state.paused ? 'Матч на паузе.' : 'Пауза снята — матч идёт.');
        break;
      }
      case 'stop': finish('Матч остановлен.'); break;
      case 'newRound': {
        // Новый раунд — точки прошлого раунда не должны висеть на радаре.
        state.points = [];
        drawRadar();
        if (typeof msg.status === 'string' && msg.status) {
          state.statusText = msg.status;
          renderCard();
        }
        const round = Number(msg.round);
        if (Number.isFinite(round)) note(`Раунд ${round}`);
        break;
      }
      case 'kill': {
        const entry = { ...msg, at: Date.now() };
        feed.push(entry);
        renderFeed();
        addPoint(msg.killerPosX, msg.killerPosY, 'killer');
        addPoint(msg.killedPosX, msg.killedPosY, 'victim');
        drawRadar();
        break;
      }
      default: /* teams, map и прочее — молча: контракт открытый */ break;
    }
  }

  // Один путь обновления карточки: события status и paused сходятся сюда,
  // классы и текст ставятся идемпотентно — двойного срабатывания паузы нет.
  function renderCard() {
    const node = card();
    if (!node) return;
    const flag = state.finished ? 'finished' : statusFlag(state.phase || state.statusText, state.paused);
    for (const name of ['live', 'paused', 'warmup', 'finished']) {
      node.classList.toggle('ebot-live-' + name, flag === name);
    }
    const statusNode = node.querySelector('.lm-status');
    if (statusNode) {
      // Текст статуса — от eBot; пауза, пришедшая событием, видна и в
      // тексте (статус eBot паузу может не содержать).
      let text = state.statusText;
      if (flag === 'paused' && !/paus|пауз/i.test(text)) text = text ? 'Пауза · ' + text : 'Пауза';
      if (text) statusNode.textContent = text;
    }
  }

  function card() {
    if (state.matchId === null) return null;
    return document.querySelector(`.lobby-match[data-match="${CSS.escape(state.matchId)}"]`);
  }

  // Терминальное состояние: поток закрываем один раз (и stop, и finished
  // ведут сюда), русская пометка — в статус, ленту и журнал.
  function finish(text) {
    if (state.finished) return;
    state.finished = true;
    closeStream();
    clearTimeout(state.timer);
    note(text);
    log(`eBot: матч #${state.matchId} — ${text}`);
    feed.push({ type: 'note', text, at: Date.now() });
    renderFeed();
    renderCard();
  }

  function renderFeed() {
    if (!list) return;
    list.replaceChildren();
    for (const entry of feed.items()) {
      const isNote = entry.type !== 'kill';
      list.append(el('li', { className: isNote ? 'ebot-live-note' : 'ebot-live-kill' },
        el('time', { textContent: hhmm(entry.at || Date.now()) }),
        el('span', { textContent: isNote ? String(entry.text ?? '') : killFeedText(entry) })));
    }
    list.scrollTop = list.scrollHeight;
  }

  function addPoint(x, y, kind) {
    const px = Number(x), py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    state.points.push({ x: px, y: py, kind });
  }

  // Канвас натурального размера картинки, ужимает CSS — координаты точек
  // не масштабируются (как у хитмапы). Меньше одного килла — чистый холст
  // с радаром карты.
  function drawRadar() {
    if (!canvas) return;
    if (canvas.width !== state.radar.width) canvas.width = state.radar.width;
    if (canvas.height !== state.radar.height) canvas.height = state.radar.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, state.radar.width, state.radar.height);
    if (state.radar.img) ctx.drawImage(state.radar.img, 0, 0, state.radar.width, state.radar.height);
    for (const point of state.points) {
      ctx.fillStyle = point.kind === 'killer' ? KILLER_COLOR : VICTIM_COLOR;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Фон: радар eBot для знакомой карты, миниатюра для прочей, чистый холст
  // без карты (карта неизвестна — не притворяемся dust2). CSP img-src 'self'
  // — только свои ассеты.
  function loadRadar() {
    state.radar.img = null;
    state.radar.width = RADAR_SIZE.width;
    state.radar.height = RADAR_SIZE.height;
    const map = String(currentMap() ?? '').trim().toLowerCase();
    if (!map) { drawRadar(); return; }
    const url = RADARS.has(map) ? RADAR_DIR + map + '.png' : FALLBACK_DIR + mapNameToJpg(map);
    const img = new Image();
    img.onload = () => {
      state.radar.img = img;
      state.radar.width = img.naturalWidth || RADAR_SIZE.width;
      state.radar.height = img.naturalHeight || RADAR_SIZE.height;
      drawRadar();
    };
    img.onerror = () => {
      // Нет и миниатюры: чистый холст, точки всё равно видны.
      state.radar.img = null;
      state.radar.width = RADAR_SIZE.width;
      state.radar.height = RADAR_SIZE.height;
      drawRadar();
    };
    img.src = url;
  }

  function connect() {
    if (state.matchId === null) return;
    closeStream();
    const source = new EventSource(LIVE);
    state.source = source;
    source.onmessage = onMessage;
    // EventSource после фатальной ошибки сам не пересоздаётся: закрываем
    // и поднимаем заново через 5 с, до 3 попыток; дальше честный статус
    // «нет живого потока» (20-с опрос списка продолжает работать).
    source.onerror = () => {
      if (!state.source || state.finished) return; // уже закрыли сами
      closeStream();
      if (++state.retries <= RETRY_LIMIT) {
        note(`Живой поток оборвался (${state.retries}). Переподключаемся…`);
        state.timer = setTimeout(connect, RETRY_DELAY);
      } else {
        note('Нет живого потока — матч не обновляется.');
      }
    };
  }

  function open(matchId) {
    // Прежний поток закрываем: канал один, следим за одним матчем.
    closeStream();
    clearTimeout(state.timer);
    state.matchId = String(matchId);
    state.retries = 0;
    state.paused = false;
    state.finished = false;
    state.statusText = '';
    state.phase = '';
    state.points = [];
    feed = newKillFeed();
    renderFeed();
    loadRadar();
    connect();
    note(`Живой поток матча #${matchId} открыт.`);
  }

  function close() {
    closeStream();
    clearTimeout(state.timer);
    state.matchId = null;
    note('Живой поток закрыт.');
  }

  return { open, close };
}
