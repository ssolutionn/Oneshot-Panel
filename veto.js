// The captains' veto page. Without #v= it is the admin's form that makes the
// links (the match from the schedule sheet); with it, a captain's (or
// spectators', or the admin's) room. The signed log and the captains' public
// keys go around every 2.5 s over VDO.Ninja data streams: each captain pushes
// their own and views the other's, spectators view both. Same-browser tabs
// also talk over a BroadcastChannel. Rules live in veto-room.js. English by
// default, Russian with the flag (localStorage oneshot-veto-lang).
import { MAP_POOL, teamLogo, teamHltv, DEFAULT_SOURCE, decodeGviz, parseSchedule } from './core.js';
import { seal, unseal, VDO_CONNECT_TIMEOUT, VDO_CONNECT_MAX_TIMEOUT, VDO_IDLE_TIMEOUT } from './vdo.js';
import { ServerRoomLink } from './assets/veto-relay-links.js';
import { checkRelay } from './assets/veto-relay-client.js';
import { relayEndpoint } from './assets/veto-relay-protocol.js';
import {DEFAULT_TOURNAMENT,friendlyCaptainLinks,resolveRoomLink} from './assets/veto-short-links.js';
import {shortPathValid} from './assets/veto-short-protocol.js';
import {
  decodeLink, createRoom, roomSecrets, captainKey, acceptKey, seat, verifyLog, replay, nextTurn,
  signMove, mergeLog, clock, formatClock, mapBoard, resultText, captainMessage, spectatorMessage,
  signRoomMessage, verifyRoomMessage, coinCommit, coinNonce, COIN_MOVES
} from './veto-room.js';

const $ = id => document.getElementById(id);
const VDO = 'https://vdo.ninja/';
const SEND_EVERY = 2500, ONLINE_FOR = 8000;
// «Call admin»: the call rides the captain's messages for two minutes; one
// call per 30 s.
const CALL_FOR = 120000, CALL_AGAIN = 30000;
const LAST_KEY = 'oneshot-player-veto', LANG_KEY = 'oneshot-veto-lang';

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode: the page still works */ }
  return null;
}

// ---- Words ----
const WORDS = {
  en: {
    tournament:'Tournament',openingLink:'Opening your captain link…',retryLink:'Try again',
    shortFallback:'Short addresses are temporarily unavailable. These full links work normally.',
    'short-link-invalid':'The captain link is incomplete or damaged. Copy the whole personal link from the admin.',
    'short-link-missing':'This captain link was not found. Ask the admin to send it again.',
    'short-link-unavailable':'The captain link could not be loaded. Try again.',
    transport:'Connection',ourServer:'Our server',
    serverOnline:'Server connection active',serverRetry:'Server unavailable. Reconnecting; the last verified moves are kept.',
    serverWait:'Connecting to our server…',vdoConnection:'Connection: VDO.Ninja',
    reconnect:'Reconnect',reconnecting:'Reconnecting…',
    title: 'Map veto', createHeading: "New captains' veto",
    createNote: 'The site makes a personal link for each captain, a spectator link and an admin link. By default the captains toss a fair coin; you can instead assign the first pick (first ban in BO1).',
    settings: 'Veto settings', match: 'Match from the schedule', loadingSchedule: 'Loading the schedule…',
    pickMatch: 'Pick a match — the teams fill in', noMatches: 'No upcoming matches in the schedule',
    scheduleFailed: 'The schedule did not load — type the teams below', today: 'today', tomorrow: 'tomorrow', noDate: 'No date',
    team1: 'Team 1', team2: 'Team 2', format: 'Format', timer: 'Timer',
    min5: '5 minutes', min3: '3 minutes', min7: '7 minutes', min10: '10 minutes', min15: '15 minutes', noTimer: 'No timer',
    create: 'Create links', toCaptain: 'Captain of', dm: 'DM', toSpectators: 'Spectators', public: 'any channel',
    toAdmin: 'Admin', ours: 'ours only · HLTV text', copyMessage: 'Copy message', copyLink: 'Copy link',
    watch: 'Watch the veto ↗',
    linksNote: "A captain's link is personal: it lets them move for their team. Made a mistake — just create new links.",
    made: time => `Links created at ${time}. For a new match press «Create links» again.`,
    linksReady: 'Links are ready', copied: 'Copied', you: 'YOU', resultHeading: 'Veto result', copyHltv: 'Copy for HLTV',
    newTitle: 'New veto · CyberClash', roomTitle: (a, b) => `Veto ${a} vs ${b} · CyberClash`,
    footSpectator: 'Spectator mode: only the captains move, with their own links.',
    footAdmin: 'Admin view: you watch and get the HLTV text. Keep this link to yourselves.',
    footCaptain: name => `You are the captain of ${name}. This link is yours only — do not forward it.`,
    itsYou: "that's you", online: 'online', offline: 'offline',
    startChoice: 'First pick (first ban in BO1)', coinDefault: 'Coin toss (default)',
    assignedFirst: name => `${name} — first pick`, assignedChoice: name => `${name} choose the veto order`, assignedYou: 'You choose the veto order',
    logAssignedOrder: (name, first) => `${name} chose the order: ${first} ban first`,
    coin: 'Coin', tossing: 'Tossing…', waitCaptains: 'Waiting for the captains', waitCaptain: name => `Waiting for captain ${name}`,
    coinHint: 'Both captains toss the coin once they open their links: each adds a random part, so nobody knows the result in advance — not the captains, not the admin.',
    coinWinner: name => `Coin: ${name}`, youWon: 'You won the coin', decideOrder: 'Decide who bans first.',
    weBanFirst: 'We ban first', theyBanFirst: name => `${name} ban first`, wonCoin: name => `${name} won the coin`,
    decidingOrder: 'They decide who bans first…', yourTurnSide: 'Your turn · side', turnSide: name => `${name}'s turn · side`,
    picked: (name, map) => `${name} picked ${map}`, whichSide: 'Which side do you start on?',
    startOn: side => side === 'CT' ? 'Start as CT · defence' : 'Start as T · attack',
    choosingSide: (name, map) => `${name} are choosing a side on ${map}…`,
    done: 'Done', vetoDone: 'Veto complete', playing: maps => `We play: ${maps}`, decider: '(decider)',
    yourTurn: kind => `Your turn · ${kind}`, turnOf: (name, kind) => `${name}'s turn · ${kind}`, ban: 'ban', pick: 'pick',
    confirm: (kind, map) => kind === 'ban' ? `Ban ${map}?` : `Play ${map}?`,
    removeOne: 'Remove one map', choosePlay: 'Choose a map to play',
    confirmHint: 'Confirm — a move cannot be undone.', clickHint: 'Tap a map, then confirm.',
    act: (kind, map) => kind === 'ban' ? `Ban ${map}` : `Play ${map}`, otherMap: 'Another map',
    acting: (kind, name) => kind === 'ban' ? `${name} are banning a map…` : `${name} are picking a map…`,
    tagPlay: 'PLAY', tagMap2: 'MAP 2', choosingShort: 'choosing a side…',
    logOrder: (winner, first) => `${winner} won the coin: ${first} ban first`,
    logBan: (name, map) => `${name} removed ${map}`, logPick: (name, map) => `${name} picked ${map}`,
    logSide: (name, side, map) => `${name} start as ${side} on ${map}`,
    clockRun: 'veto', clockDone: 'veto took', clockOver: "time's up",
    brokenLink: 'The veto link is broken. Copy it from Discord in full or ask the admin for a new one.',
    brokenKey: "The captain's link is broken (the key does not fit). Copy it from Discord in full or ask the admin for a new one.",
    coinLost: 'The coin cannot be opened: your part stayed in the other browser or device where you joined first. Open the link there or ask the admin for new links.',
    conflict: (who, step) => `Warning: ${who} signed two different moves for step ${step}. The first one counts. Tell the admin — they decide whether to replay the veto.`,
    captainOf: name => `the captain of ${name}`, aCaptain: 'a captain',
    'Сейчас не твой ход.': "It's not your turn.", 'Эта карта уже выбрана.': 'This map is already taken.',
    'Нужны две разные команды.': 'Two different teams are needed.', 'Слишком длинное название команды.': 'A team name is too long.',
    'Монетка не сходится.': 'The coin does not match.',
    callAdmin: '🔔 Call admin', called: s => `Admin called · again in ${s} s`,
    calledToast: 'The admin sees your call on their page',
    alert: (name, time) => `🔔 Captain of ${name} is calling the admin · ${time}`, gotIt: 'Got it',
    calling: '🔔 Admin call'
  },
  ru: {
    tournament:'Турнир',openingLink:'Открываем личную ссылку капитана…',retryLink:'Повторить',
    shortFallback:'Короткие адреса сейчас недоступны. Эти полные ссылки работают как обычно.',
    'short-link-invalid':'Личная ссылка неполная или повреждена. Скопируй ссылку от админа целиком.',
    'short-link-missing':'Личная ссылка не найдена. Попроси админа прислать её ещё раз.',
    'short-link-unavailable':'Не удалось загрузить личную ссылку. Повтори попытку.',
    transport:'Связь',ourServer:'Наш сервер',
    serverOnline:'Связь с сервером установлена',serverRetry:'Сервер недоступен. Восстанавливаем связь; проверенные ходы сохранены.',
    serverWait:'Подключаемся к нашему серверу…',vdoConnection:'Связь: VDO.Ninja',
    reconnect:'Переподключить связь',reconnecting:'Переподключаем…',
    title: 'Вето карт', createHeading: 'Новое вето для капитанов',
    createNote: 'Сайт сделает личную ссылку каждому капитану, ссылку зрителей и ссылку админа. По умолчанию капитаны бросают честную монетку; вместо неё можно сразу назначить команду на первый пик (в BO1 — первый бан).',
    settings: 'Настройки вето', match: 'Матч из расписания', loadingSchedule: 'Загружаем расписание…',
    pickMatch: 'Выбери матч — команды подставятся сами', noMatches: 'В расписании нет предстоящих матчей',
    scheduleFailed: 'Расписание не загрузилось — впиши команды ниже', today: 'сегодня', tomorrow: 'завтра', noDate: 'Без даты',
    team1: 'Команда 1', team2: 'Команда 2', format: 'Формат', timer: 'Таймер',
    min5: '5 минут', min3: '3 минуты', min7: '7 минут', min10: '10 минут', min15: '15 минут', noTimer: 'Без таймера',
    create: 'Создать ссылки', toCaptain: 'Капитану', dm: 'в личку', toSpectators: 'Зрителям', public: 'можно в общий канал',
    toAdmin: 'Админу', ours: 'только у нас · текст для HLTV', copyMessage: 'Скопировать сообщение', copyLink: 'Скопировать ссылку',
    watch: 'Смотреть вето ↗',
    linksNote: 'Ссылка капитана личная: по ней можно ходить за его команду. Ошиблись — просто создай новые ссылки.',
    made: time => `Ссылки созданы в ${time}. Для нового матча нажми «Создать ссылки» ещё раз.`,
    linksReady: 'Ссылки готовы', copied: 'Скопировано', you: 'ТЫ', resultHeading: 'Итог вето', copyHltv: 'Скопировать для HLTV',
    newTitle: 'Новое вето · CyberClash', roomTitle: (a, b) => `Вето ${a} vs ${b} · CyberClash`,
    footSpectator: 'Режим зрителя: ходят только капитаны по своим ссылкам.',
    footAdmin: 'Вид админа: смотришь и получаешь текст для HLTV. Эту ссылку держите у себя.',
    footCaptain: name => `Ты капитан ${name}. Эта ссылка только для тебя — не пересылай её.`,
    itsYou: 'это ты', online: 'online', offline: 'offline',
    startChoice: 'Первый пик (в BO1 — первый бан)', coinDefault: 'Монетка (по умолчанию)',
    assignedFirst: name => `${name} — первый пик`, assignedChoice: name => `${name} выбирают порядок вето`, assignedYou: 'Вы выбираете порядок вето',
    logAssignedOrder: (name, first) => `${name} выбрали порядок: первыми банят ${first}`,
    coin: 'Монетка', tossing: 'Подбрасываем…', waitCaptains: 'Ждём капитанов', waitCaptain: name => `Ждём капитана ${name}`,
    coinHint: 'Монетку бросают оба капитана, когда откроют свои ссылки: каждый добавляет свою случайную часть, поэтому результат заранее не знает никто — ни капитаны, ни админ.',
    coinWinner: name => `Монетка: ${name}`, youWon: 'Вы выиграли монетку', decideOrder: 'Решите, кто банит первым.',
    weBanFirst: 'Баним первыми', theyBanFirst: name => `Первыми банят ${name}`, wonCoin: name => `${name} выиграли монетку`,
    decidingOrder: 'Они решают, кто банит первым…', yourTurnSide: 'Твой ход · сторона', turnSide: name => `Ход ${name} · сторона`,
    picked: (name, map) => `${name} взяли ${map}`, whichSide: 'За какую сторону начнёте?',
    startOn: side => side === 'CT' ? 'Начинаем за CT · защита' : 'Начинаем за T · атака',
    choosingSide: (name, map) => `${name} выбирают сторону на ${map}…`,
    done: 'Готово', vetoDone: 'Вето завершено', playing: maps => `Играем: ${maps}`, decider: '(решающая)',
    yourTurn: kind => `Твой ход · ${kind}`, turnOf: (name, kind) => `Ход ${name} · ${kind}`, ban: 'бан', pick: 'пик',
    confirm: (kind, map) => kind === 'ban' ? `Забанить ${map}?` : `Играем ${map}?`,
    removeOne: 'Убери одну карту', choosePlay: 'Выбери карту, которую играем',
    confirmHint: 'Подтверди — ход нельзя отменить.', clickHint: 'Нажми на карту, потом подтверди.',
    act: (kind, map) => kind === 'ban' ? `Забанить ${map}` : `Играем ${map}`, otherMap: 'Другая карта',
    acting: (kind, name) => kind === 'ban' ? `${name} банят карту…` : `${name} выбирают карту…`,
    tagPlay: 'ИГРАЕМ', tagMap2: 'КАРТА 2', choosingShort: 'выбирают сторону…',
    logOrder: (winner, first) => `${winner} выиграли монетку: первыми банят ${first}`,
    logBan: (name, map) => `${name} убрали ${map}`, logPick: (name, map) => `${name} взяли ${map}`,
    logSide: (name, side, map) => `${name} начинают за ${side} на ${map}`,
    clockRun: 'на вето', clockDone: 'вето за', clockOver: 'время вышло',
    brokenLink: 'Ссылка на вето повреждена. Скопируй её из Discord целиком или попроси админа прислать новую.',
    brokenKey: 'Ссылка капитана повреждена (ключ не подходит). Скопируй её из Discord целиком или попроси админа прислать новую.',
    coinLost: 'Монетку открыть нельзя: твоя часть осталась в другом браузере или устройстве, где ты заходил первым. Открой ссылку там или попроси админа сделать новые ссылки.',
    conflict: (who, step) => `Внимание: ${who} подписал два разных хода на шаге ${step}. Засчитан первый. Напишите админу — он решит, переигрывать ли вето.`,
    captainOf: name => `капитан ${name}`, aCaptain: 'капитан',
    callAdmin: '🔔 Позвать админа', called: s => `Админ позван · ещё раз через ${s} с`,
    calledToast: 'Админ видит вызов у себя на странице',
    alert: (name, time) => `🔔 Капитан ${name} зовёт админа · ${time}`, gotIt: 'Понял',
    calling: '🔔 Зовут админа'
  }
};
let lang = store(LANG_KEY) === 'ru' ? 'ru' : 'en';
const t = (key, ...args) => {
  const word = WORDS[lang][key] ?? WORDS.en[key] ?? key;
  return typeof word === 'function' ? word(...args) : word;
};
// veto-room.js speaks Russian; the page shows its errors in the page's language.
const errorText = message => lang === 'ru' ? message : WORDS.en[message] || message;
const relabel = new Set();
function applyWords() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const button of document.querySelectorAll('[data-lang]')) button.setAttribute('aria-pressed', String(button.dataset.lang === lang));
  for (const redraw of relabel) redraw();
}
for (const button of document.querySelectorAll('[data-lang]')) {
  button.addEventListener('click', () => {
    lang = button.dataset.lang === 'ru' ? 'ru' : 'en';
    store(LANG_KEY, lang);
    applyWords();
  });
}

let toastTimer;
function toast(text) {
  const el = $('vtToast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(t('copied'));
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const source = $(button.dataset.copy);
  copy(source.value ?? source.textContent);
});
let errorKey = null;
function showError(text, key = null) {
  errorKey = key;
  $('vtError').textContent = text;
  $('vtError').hidden = !text;
}
relabel.add(() => { if (errorKey) showError(t(...errorKey), errorKey); });
async function teamLogos(file = 'teams.json') {
  try {
    const response = await fetch('/assets/teams/' + file, { cache: 'no-cache' });
    return response.ok ? await response.json() : {};
  } catch { return {}; }
}

// ---- Admin: make the links ----
let shownLinks = null;
function showLinks(made) {
  shownLinks = made;
  const { room, links } = made;
  $('vtLinkNameA').textContent = room.t[0];
  $('vtLinkNameB').textContent = room.t[1];
  $('vtMsgA').value = captainMessage(room, 0, links.a, lang);
  $('vtMsgB').value = captainMessage(room, 1, links.b, lang);
  $('vtMsgS').value = spectatorMessage(room, links.s, lang);
  $('vtMsgO').value = links.o;
  $('vtWatch').href = links.o;
  $('vtLinks').hidden = false;
  $('vtMade').textContent = [made.restored ? t('made', new Date(made.at).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' })) : '',
    room.starter != null ? t('assignedFirst', room.t[room.starter]) : room.chooser == null ? t('coinDefault') : t('assignedChoice', room.t[room.chooser]),
    made.shortLinkFallback ? t('shortFallback') : ''].filter(Boolean).join(' ');
}
relabel.add(() => { if (shownLinks) showLinks(shownLinks); });
const RESTORE_FOR = 6 * 3600000;
// The schedule sheet the panel reads (its own source if changed there):
// matches from today (MSK) on fill the teams, nobody types them.
const mskDay = (shift = 0) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' })
  .format(new Date(Date.now() + shift * 86400000));
async function scheduleRows(id, gid) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq`);
  url.search = new URLSearchParams({ gid, range: 'A1:Z300', headers: '1', tqx: 'out:json', _t: String(Date.now()) });
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Google Sheets ${response.status}`);
  return decodeGviz(await response.text());
}
let matches = null;
function fillMatches() {
  const select = $('vtMatch');
  const kept = select.value;
  if (matches === null) return;
  if (matches instanceof Error) {
    select.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: t('scheduleFailed') }));
    select.title = matches.message;
    return;
  }
  const label = date => date === mskDay() ? `${date} · ${t('today')}` : date === mskDay(1) ? `${date} · ${t('tomorrow')}` : date || t('noDate');
  const groups = new Map();
  for (const m of matches) {
    if (!groups.has(m.date)) groups.set(m.date, Object.assign(document.createElement('optgroup'), { label: label(m.date) }));
    groups.get(m.date).append(Object.assign(document.createElement('option'), {
      value: JSON.stringify([m.team1, m.team2]),
      textContent: `${m.time} · ${m.team1} vs ${m.team2}${m.stage ? ` · ${m.stage}` : ''}`
    }));
  }
  const first = Object.assign(document.createElement('option'), { value: '', textContent: matches.length ? t('pickMatch') : t('noMatches') });
  select.replaceChildren(first, ...groups.values());
  // The panel's teams (#new&a=&b=) pick their match in the list.
  const asked = kept || JSON.stringify([$('vtTeamA').value, $('vtTeamB').value]);
  if ([...select.options].some(o => o.value === asked)) select.value = asked;
}
relabel.add(fillMatches);
async function loadMatches() {
  let source = DEFAULT_SOURCE;
  try { source = { ...DEFAULT_SOURCE, ...(JSON.parse(localStorage.getItem('webcam-desk-source')) || {}) }; } catch { /* default */ }
  const id = source.scheduleId || source.id, gid = source.scheduleGid;
  try {
    if (!gid) throw new Error('no schedule sheet');
    const tabs = [scheduleRows(id, gid)];
    if (id === DEFAULT_SOURCE.scheduleId && gid === DEFAULT_SOURCE.scheduleGid) {
      tabs.push(scheduleRows(id, DEFAULT_SOURCE.playoffsGid).catch(() => []));
    }
    const rows = (await Promise.all(tabs)).flat();
    const key = date => Number(date.slice(3, 5)) * 100 + Number(date.slice(0, 2));
    const today = key(mskDay());
    matches = parseSchedule(rows).filter(m => !m.date || key(m.date) >= today);
  } catch (error) { matches = error; }
  fillMatches();
}
async function setupCreate() {
  $('vtCreate').hidden = false;
  relabel.add(() => { document.title = t('newTitle'); });
  applyWords();
  const choiceOptions = () => {
    for (const [team, id] of ['vtTeamA', 'vtTeamB'].entries()) {
      $('vtStart').options[team + 1].textContent = t('assignedFirst', $(id).value.trim() || `Team ${team + 1}`);
    }
  };
  for (const id of ['vtTeamA', 'vtTeamB']) $(id).addEventListener('input', choiceOptions);
  relabel.add(choiceOptions);
  // The form works before anything else loads (a slow teams.json or odd
  // saved data must not leave it submitting natively).
  $('vtForm').addEventListener('submit', async event => {
    event.preventDefault();
    showError('');
    try {
      const base = new URL(location.pathname, location.href).href; // this page, here or on the veto site
      const relay = $('vtTransport').value === 'server' ? relayEndpoint('/api/veto-relay', base) : '';
      const submit = $('vtForm').querySelector('[type="submit"]');
      submit.disabled = true;
      let made;
      try {
        if (relay) await checkRelay(relay);
        made = await createRoom(base, [$('vtTeamA').value, $('vtTeamB').value], $('vtFormat').value, Number($('vtTimer').value), relay,
          $('vtStart').value === 'coin' ? null : Number($('vtStart').value));
        made = await friendlyCaptainLinks(made,base,$('vtTournament').value);
      } finally { submit.disabled = false; }
      made.at = Date.now();
      store(LAST_KEY, made);
      const prefill = new URLSearchParams(location.hash.slice(1));
      if (prefill.has('new')) {
        for (const [name,value] of Object.entries({a:made.room.t[0],b:made.room.t[1],f:made.room.f,m:made.room.m,start:made.room.starter ?? 'coin',via:relay?'server':'vdo'})) prefill.set(name,String(value));
        history.replaceState(null,'',location.pathname+location.search+'#'+prefill);
      }
      showLinks(made);
      toast(t('linksReady'));
    } catch (error) { showError(errorText(error.message)); }
  });
  $('vtMatch').addEventListener('change', () => {
    if (!$('vtMatch').value) return;
    const [a, b] = JSON.parse($('vtMatch').value);
    $('vtTeamA').value = a;
    $('vtTeamB').value = b;
    choiceOptions();
  });
  const params = new URLSearchParams(location.hash.slice(1));
  $('vtTournament').value = (params.get('tournament')||DEFAULT_TOURNAMENT).slice(0,60);
  const asked = params.has('new') ? [params.get('a') || '', params.get('b') || '', params.get('f')] : null;
  if (['server','vdo'].includes(params.get('via'))) $('vtTransport').value = params.get('via');
  if (['coin','0','1'].includes(params.get('start'))) $('vtStart').value = params.get('start');
  if (asked) {
    $('vtTeamA').value = asked[0];
    $('vtTeamB').value = asked[1];
    if (['BO1', 'BO2', 'BO3', 'BO5'].includes(asked[2])) $('vtFormat').value = asked[2];
    if (['0', '3', '5', '7', '10', '15'].includes(params.get('m'))) $('vtTimer').value = params.get('m');
  }
  // The last links made in this browser, for a few hours, so a reload does
  // not lose them; from the panel only when they are for the same match.
  try {
    const last = store(LAST_KEY);
    const room = last?.room;
    const fresh = Date.now() - (Number(last?.at) || 0) < RESTORE_FOR;
    if (fresh && room && room.chooser == null && Array.isArray(room.t) && last.links?.a && last.links?.b && last.links?.s && last.links?.o &&
        (!asked || (asked[0] === room.t[0] && asked[1] === room.t[1] && asked[2] === room.f && (!params.has('via') || Boolean(room.relay) === (params.get('via') === 'server')) &&
          (!params.has('tournament') || params.get('tournament') === (last.tournament||DEFAULT_TOURNAMENT)) &&
          (!params.has('start') || params.get('start') === String(room.starter ?? 'coin'))))) {
      $('vtTeamA').value = room.t[0];
      $('vtTeamB').value = room.t[1];
      $('vtFormat').value = room.f;
      $('vtTimer').value = String(room.m ?? 5);
      $('vtStart').value = String(room.starter ?? 'coin');
      $('vtTransport').value = room.relay ? 'server' : 'vdo';
      $('vtTournament').value = last.tournament||DEFAULT_TOURNAMENT;
      showLinks({ ...last, restored: true });
    }
  } catch { /* odd saved data: start clean */ }
  choiceOptions();
  loadMatches();
  const logos = await teamLogos();
  $('vtTeamList').replaceChildren(...Object.keys(logos).sort((a, b) => a.localeCompare(b))
    .map(name => Object.assign(document.createElement('option'), { value: name })));
}

// ---- Transport ----
class Link {
  constructor(secrets, push, views, onMessage) {
    Object.assign(this, { secrets, onMessage });
    this.frames = [];
    this.streams = new Map();
    this.views = new Map();
    this.closed = false;
    this.pushStream = push;
    if (push) this.claimPush(push);
    for (const stream of views) this.make('view', stream);
    this.listener = event => {
      const frame = this.frames.find(item => item.contentWindow === event.source);
      if (!frame) return;
      const box = event.data?.dataReceived?.oneshotVeto;
      const stream = this.streams.get(frame) || '';
      if (box && stream) {
        const view = this.views.get(stream);
        if (view) { view.last = Date.now(); view.retry = VDO_IDLE_TIMEOUT; }
      }
      // Through a view frame the sender is that stream's owner; through our
      // own push frame identity is proved by the signed room envelope.
      if (box) this.open(box, stream);
    };
    addEventListener('message', this.listener);
    this.watchdog = setInterval(() => {
      if (document.hidden || this.closed) return;
      const now = Date.now();
      for (const [stream, view] of this.views) {
        if (now - view.last >= view.retry) this.replaceView(stream);
      }
    }, 5000);
    try {
      this.channel = new BroadcastChannel('oneshot-veto:' + secrets.streams.join(':'));
      this.channel.onmessage = event => this.open(event.data, 'tab');
    } catch { this.channel = null; }
  }
  claimPush(stream) {
    if (!navigator.locks?.request) {
      this.make('push', stream);
      return;
    }
    // Two tabs publishing the same VDO stream can evict each other. Keep one
    // publisher per browser; a waiting tab takes over as soon as it closes.
    this.pushTask = navigator.locks.request('oneshot-veto-push:' + stream, async () => {
      if (this.closed) return;
      const frame = this.make('push', stream);
      await new Promise(resolve => { this.releasePush = resolve; });
      this.releasePush = null;
      if (frame) this.removeFrame(frame);
    }).catch(() => {
      if (!this.closed) this.make('push', stream);
    });
  }
  make(side, stream, retry = VDO_CONNECT_TIMEOUT) {
    const url = new URL(VDO);
    url.search = new URLSearchParams({ [side]: stream, password: this.secrets.password, label: 'oneshot-veto' }) +
      '&dataonly&cleanoutput';
    const iframe = document.createElement('iframe');
    Object.assign(iframe, { src: url.href, title: 'Veto link', className: 'vdo-frame', tabIndex: -1 });
    iframe.allow = 'autoplay';
    iframe.setAttribute('aria-hidden', 'true');
    document.body.append(iframe);
    this.frames.push(iframe);
    if (side === 'push') this.pushFrame = iframe;
    if (side === 'view') {
      this.streams.set(iframe, stream);
      this.views.set(stream, { frame: iframe, last: Date.now(), retry });
    }
    return iframe;
  }
  removeFrame(frame) {
    if (frame === this.pushFrame) this.pushFrame = null;
    this.frames = this.frames.filter(item => item !== frame);
    this.streams.delete(frame);
    frame.remove();
  }
  replaceView(stream, manual = false) {
    const view = this.views.get(stream);
    if (!view || this.closed) return;
    const retry = Math.min(VDO_CONNECT_MAX_TIMEOUT, Math.max(VDO_CONNECT_TIMEOUT, view.retry * 2));
    this.views.delete(stream);
    this.removeFrame(view.frame);
    this.make('view', stream, retry);
  }
  reconnect() {
    for (const stream of [...this.views.keys()]) this.replaceView(stream, true);
    // Retain the Web Lock while restarting only this tab's publisher.
    // A standby tab must never create a competing push iframe.
    if (this.pushFrame) {
      this.removeFrame(this.pushFrame);
      this.make('push', this.pushStream);
    }
  }
  reconnectStream(stream) {
    const view = this.views.get(stream);
    if (view && Date.now() - view.last >= view.retry) this.replaceView(stream, true);
  }
  async open(box, via) {
    const message = await unseal(this.secrets.key, box);
    if (message) this.onMessage(message, via);
  }
  async send(message) {
    const box = await seal(this.secrets.key, message);
    for (const iframe of this.frames) iframe.contentWindow?.postMessage({ sendData: { oneshotVeto: box } }, '*');
    this.channel?.postMessage(box);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    removeEventListener('message', this.listener);
    this.channel?.close();
    this.releasePush?.();
    this.releasePush = null;
    for (const frame of [...this.frames]) this.removeFrame(frame);
    this.views.clear();
  }
}

// ---- Room ----
async function enterRoom(room) {
  const me = seat(room);
  const admin = room.me === 'o';
  const names = room.t;
  const logKey = 'oneshot-veto-log:' + room.r, keysKey = 'oneshot-veto-keys:' + room.r;
  const coinKey = 'oneshot-veto-coin:' + room.r;
  const checked = new Set();
  const seen = { a: 0, b: 0 }, proofSeen = { a: 0, b: 0 };
  const conflicts = new Map();
  let log = [], key = null, selected = '', busy = false, coin = 'hidden', autoTried = '';
  let queue = Promise.resolve(), pending = null, orderSeen = null, callAt = 0;
  // A quota/privacy failure must not discard a nonce while this page is
  // still completing its commit/reveal. Persistence is only for reloads.
  let rememberedCoin = null;
  // The admin's page: calls seen (team:at) and the ones answered.
  const callsKey = 'oneshot-veto-calls:' + room.r;
  const answered = new Set(Array.isArray(store(callsKey)) ? store(callsKey) : []);
  const ringing = new Map();

  $('vtTitle').removeAttribute('data-i18n');
  $('vtTitle').textContent = `${names[0]} vs ${names[1]}`;
  $('vtEyebrow').textContent = `MAP VETO · ${room.f}`;
  $('vtRoom').hidden = false;
  relabel.add(() => {
    document.title = t('roomTitle', names[0], names[1]);
    $('vtFoot').textContent = me !== null ? t('footCaptain', names[me]) : admin ? t('footAdmin') : t('footSpectator');
  });
  for (const team of [0, 1]) {
    const card = $('vtTeam' + team);
    card.querySelector('.vt-team-name').textContent = names[team];
    card.querySelector('.vt-you').hidden = me !== team;
    card.classList.toggle('is-you', me === team);
  }
  $('vtCoin').querySelector('.vt-coin-0').textContent = names[0].slice(0, 2).toUpperCase();
  $('vtCoin').querySelector('.vt-coin-1').textContent = names[1].slice(0, 2).toUpperCase();
  // The team's HLTV page beside its name.
  teamLogos('hltv.json').then(pages => {
    for (const team of [0, 1]) {
      const url = teamHltv(pages, names[team]);
      const link = $('vtTeam' + team).querySelector('.vt-hltv');
      if (!url) continue;
      link.href = url;
      link.title = `${names[team]} · HLTV`;
      link.hidden = false;
    }
  });
  teamLogos().then(logos => {
    for (const team of [0, 1]) {
      const file = teamLogo(logos, names[team]);
      if (!file) continue;
      const src = '/assets/teams/' + file;
      const img = $('vtTeam' + team).querySelector('img');
      img.onerror = () => { img.hidden = true; };
      img.src = src;
      img.hidden = false;
      const face = $('vtCoin').querySelector('.vt-coin-' + team);
      const logo = Object.assign(document.createElement('img'), { src, alt: '' });
      logo.onerror = () => logo.remove();
      face.replaceChildren(logo);
    }
  });
  applyWords();

  const secrets = await roomSecrets(room);
  if (me !== null) {
    try { key = await captainKey(room); } catch {
      $('vtRoom').hidden = true;
      return showError(t('brokenKey'), ['brokenKey']);
    }
  }
  // Public keys come with the captains' messages (and stay for a reload);
  // only those matching the link's fingerprints are taken.
  async function learnKeys(keys) {
    if (!Array.isArray(keys)) return;
    let learned = false;
    for (const team of [0, 1]) {
      if (!room.p[team] && keys[team] && await acceptKey(room, team, keys[team])) learned = true;
    }
    if (learned) store(keysKey, room.p);
  }
  await learnKeys(store(keysKey));
  let transportState = room.relay ? 'serverWait' : 'vdoConnection';
  const paintTransport = () => { $('vtTransportStatus').textContent = t(transportState); };
  relabel.add(paintTransport);
  const link = room.relay ? new ServerRoomLink(room, secrets, key, receive, status => {
    transportState = status === 'online' ? 'serverOnline' : 'serverRetry'; paintTransport();
  }) : new Link(secrets, me === null ? '' : secrets.streams[me],
    me === null ? secrets.streams : [secrets.streams[1 - me]], receive);
  paintTransport();
  $('vtReconnect').hidden = Boolean(room.relay);
  $('vtReconnect').addEventListener('click', () => {
    link.reconnect?.();
    toast(t('reconnecting'));
  });
  let localLog = null;
  if (room.relay) {
    // A background Safari tab may throttle network requests. Other tabs of
    // this room can still adopt the signed local journal; this never proves
    // presence or creates a captain signature.
    localLog = event => {
      if (event.storageArea === localStorage && [logKey, keysKey].includes(event.key))
        adopt(store(logKey) || [], store(keysKey));
    };
    addEventListener('storage', localLog);
  }
  addEventListener('pagehide', event => {
    if (!event.persisted) {
      link.close?.();
      if (localLog) removeEventListener('storage', localLog);
    }
  });

  const online = team => team === me || Date.now() - seen[team ? 'b' : 'a'] < ONLINE_FOR;
  // Spectators and the admin only listen: they add no load on the captains' phones.
  // Serialize envelopes so their signed timestamps cannot overtake each other.
  let sending = null, pendingMessage = null;
  const send = () => {
    if (me === null) return Promise.resolve();
    const call = callAt && Date.now() - callAt < CALL_FOR ? callAt : undefined;
    pendingMessage = { t: 'log', log: log.map(entry => ({ ...entry })),
      p: room.p.map(point => point ? [...point] : point), call };
    if (sending) return sending;
    sending = (async () => {
      while (pendingMessage) {
        const message = pendingMessage;
        pendingMessage = null;
        try { await link.send(await signRoomMessage(room, key, message)); } catch { /* next heartbeat retries */ }
      }
    })().finally(() => { sending = null; });
    return sending;
  };

  function adopt(incoming, keys) {
    queue = queue.then(async () => {
      await learnKeys(keys);
      const verified = await verifyLog(room, incoming, checked);
      const { log: merged, conflict } = mergeLog(log, verified);
      if (conflict) noteConflict(conflict);
      if (merged === log) return;
      log = merged;
      if (selected && !mapBoard(room, replay(room, log)).some(c => c.map === selected && c.status === 'open')) selected = '';
      store(logKey, log);
      render();
      send();
      autoCoin();
    });
    return queue;
  }
  // Only the newest log from each source waits for verification, so a flood
  // of junk cannot hold real moves back.
  async function receive(message, via) {
    if (!message || message.t !== 'log' || !Array.isArray(message.log)) return;
    await learnKeys(message.p);
    // The dedicated viewer iframe proves its stream owner. If that iframe is
    // stuck, the same signed envelope can arrive through our push iframe.
    let from = via === secrets.streams[0] ? 'a' : via === secrets.streams[1] ? 'b' : '';
    let proofFrom = '';
    const candidate = ['a', 'b'].includes(message.from) ? message.from : '';
    const needProof = !from || (admin && Number.isSafeInteger(message.call));
    if (needProof && candidate && message.at > proofSeen[candidate] &&
        await verifyRoomMessage(room, message) && message.at > proofSeen[candidate]) {
      proofFrom = candidate;
      proofSeen[candidate] = message.at;
    }
    if (!from && !room.relay && proofFrom) {
      from = proofFrom;
      link.reconnectStream?.(secrets.streams[from === 'a' ? 0 : 1]);
    }
    if (from) seen[from] = Date.now();
    // Calls additionally require the captain's signature: knowing a public
    // spectator link and a VDO stream ID is not enough to ring the admin.
    if (admin && from && proofFrom === from && Number.isSafeInteger(message.call)) {
      ring(from === 'a' ? 0 : 1, message.call);
    }
    const unkeyed = Array.isArray(message.p) && [0, 1].some(team => !room.p[team] && message.p[team]);
    if (message.log.length < log.length && !unkeyed) return;
    const idle = !pending;
    pending = message;
    // Not chained into queue itself: adopt() appends to it.
    if (idle) queue.then(() => { const next = pending; pending = null; if (next) adopt(next.log, next.p); });
  }
  function noteConflict({ index, theirs }) {
    if (conflicts.has(index)) return;
    let team = null;
    try { team = nextTurn(room, replay(room, log.slice(0, index))).team; } catch { /* unknown */ }
    conflicts.set(index, theirs);
    const who = team === null ? ['aCaptain'] : ['captainOf', names[team]];
    const words = () => t('conflict', t(...who), index + 1);
    showError(words(), ['conflict', t(...who), index + 1]);
    errorKey = null;
    relabel.add(() => showError(words()));
  }

  // Two tabs of one captain take turns: the lock plus the log both tabs
  // write to localStorage keep them from signing two moves for one step.
  // value may be a function: it runs inside the lock (the coin's nonce).
  async function move(kind, value, quiet = false) {
    if (busy || !key) return;
    busy = true;
    render();
    const sign = async () => {
      const stored = store(logKey);
      if (Array.isArray(stored) && stored.length > log.length) await adopt(stored);
      else await queue;
      const turn = nextTurn(room, replay(room, log));
      if (quiet && (turn.kind !== kind || turn.team !== me)) return;
      const next = await signMove(room, log, key, kind, typeof value === 'function' ? await value() : value);
      selected = '';
      await adopt(next);
    };
    try {
      if (navigator.locks?.request) await navigator.locks.request('oneshot-veto-sign:' + room.r, sign);
      else await sign();
    } catch (error) { if (!quiet) toast(errorText(error.message)); }
    finally { busy = false; render(); autoCoin(); }
  }
  // The coin goes by itself once both captains are here: A commits to a
  // hidden nonce (kept in this browser for the reveal), B adds a seed, A
  // reveals. Nobody knows the result before both parts are in.
  function autoCoin() {
    if (me === null || busy) return;
    const state = replay(room, log);
    const turn = nextTurn(room, state);
    if (turn.team !== me || !COIN_MOVES.includes(turn.kind)) return;
    if (turn.kind === 'commit' && !(online(0) && online(1))) return;
    const attempt = turn.kind + log.length;
    if (autoTried === attempt) return;
    autoTried = attempt;
    if (turn.kind === 'commit') {
      move('commit', async () => {
        let nonce = store(coinKey) || rememberedCoin;
        if (typeof nonce !== 'string') nonce = coinNonce();
        rememberedCoin = nonce;
        store(coinKey, nonce);
        return coinCommit(room, nonce);
      }, true);
    } else if (turn.kind === 'seed') {
      move('seed', coinNonce(), true);
    } else {
      const nonce = store(coinKey) || rememberedCoin;
      if (typeof nonce !== 'string') return showError(t('coinLost'), ['coinLost']);
      move('reveal', async () => {
        if (await coinCommit(room, nonce) !== state.commit) {
          showError(t('coinLost'), ['coinLost']);
          throw new Error('Монетка не сходится.');
        }
        return nonce;
      }, true);
    }
  }

  // ---- «Call admin» ----
  function callAdmin() {
    if (Date.now() - callAt < CALL_AGAIN) return;
    callAt = Date.now();
    send();
    toast(t('calledToast'));
    showCall();
  }
  function showCall() {
    const left = Math.ceil((CALL_AGAIN - (Date.now() - callAt)) / 1000);
    $('vtCallAdmin').disabled = left > 0;
    setText($('vtCallState'), left > 0 ? t('called', left) : '');
  }
  let audio = null;
  function beep() {
    try {
      audio ||= new AudioContext();
      for (let i = 0; i < 3; i++) {
        const tone = audio.createOscillator(), gain = audio.createGain();
        tone.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, audio.currentTime + i * 0.35);
        gain.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + i * 0.35 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.35 + 0.25);
        tone.connect(gain).connect(audio.destination);
        tone.start(audio.currentTime + i * 0.35);
        tone.stop(audio.currentTime + i * 0.35 + 0.3);
      }
    } catch { /* no sound: the banner and the title still ring */ }
  }
  function ring(team, at) {
    const id = `${team}:${at}`;
    if (answered.has(id) || ringing.has(id)) return;
    ringing.set(id, { team, at: Date.now() });
    beep();
    showAlert();
  }
  function showAlert() {
    const [first] = ringing.values();
    $('vtAlert').hidden = !first;
    if (!first) return;
    const time = new Date(first.at).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
    $('vtAlertText').textContent = t('alert', names[first.team], time);
  }
  $('vtAlertOk').addEventListener('click', () => {
    for (const id of ringing.keys()) answered.add(id);
    ringing.clear();
    store(callsKey, [...answered].slice(-50));
    showAlert();
    document.title = t('roomTitle', names[0], names[1]);
  });
  $('vtCallAdmin').addEventListener('click', callAdmin);
  $('vtHelp').hidden = me === null;
  relabel.add(() => { showAlert(); showCall(); });
  // An unanswered call blinks in the tab title.
  setInterval(() => {
    if (!ringing.size) return;
    document.title = document.title.startsWith('🔔') ? t('roomTitle', names[0], names[1]) : t('calling');
  }, 1000);

  function flipCoin(result) {
    if (coin !== 'hidden') return;
    coin = 'flipping';
    $('vtCoin').dataset.result = String(result);
    $('vtCoin').classList.add('is-flipping');
    const done = () => { coin = 'shown'; render(); };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else setTimeout(done, 2400);
    render();
  }

  function button(text, onClick, primary = false) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'vt-button' + (primary ? ' vt-primary' : '');
    el.textContent = text;
    el.disabled = busy;
    el.addEventListener('click', onClick);
    return el;
  }

  function describe(entry, index, state) {
    const prior = replay(room, log.slice(0, index));
    const team = nextTurn(room, prior).team;
    if (COIN_MOVES.includes(entry.k)) return '';
    if (entry.k === 'order') return t(room.chooser == null ? 'logOrder' : 'logAssignedOrder', names[team], names[Number(entry.v)]);
    if (entry.k === 'ban') return t('logBan', names[team], entry.v);
    if (entry.k === 'pick') return t('logPick', names[team], entry.v);
    return t('logSide', names[team], entry.v, prior.pending?.map || state.pending?.map || '');
  }

  // The clock runs from the order choice. Its time is the signer's clock: if
  // that one is ahead of ours, the moment we first saw the move counts, so
  // the clock does not stand still until our clock catches up.
  function startedAt(state) {
    if (state.startedAt === null) return null;
    if (orderSeen === null) orderSeen = Date.now();
    return Math.min(state.startedAt, orderSeen);
  }
  function showClock(state, turn) {
    const minutes = room.m ?? 5;
    const start = startedAt(state);
    const c = clock({ startedAt: start }, Date.now(), minutes);
    $('vtClock').hidden = !c.started || !minutes;
    if ($('vtClock').hidden) return;
    const done = turn.kind === 'done';
    const spent = done ? log[log.length - 1].at - state.startedAt : 0;
    $('vtClockTime').textContent = formatClock(done ? Math.max(0, spent) : c.left);
    $('vtClock').querySelector('.vt-clock-label').textContent = done ? t('clockDone') : c.over ? t('clockOver') : t('clockRun');
    $('vtClock').dataset.state = done ? 'done' : c.over ? 'over' : c.left < 60000 ? 'low' : 'run';
  }
  // Rebuilding the map buttons every second would eat clicks: the tick only
  // moves the clock and re-renders when presence changed.
  let shownFor = '';
  const presenceKey = () => [online(0), online(1)].join();
  function tick() {
    try { autoCoin(); } catch { /* the clock still moves */ }
    if (me !== null) showCall();
    if (presenceKey() !== shownFor) return render();
    const state = replay(room, log);
    showClock(state, nextTurn(room, state));
  }

  // Map cards in veto order: the moves made, the pick waiting for its side,
  // then the rest of the pool — a chosen map moves to the left at once.
  function ordered(board, state) {
    const index = new Map(state.actions.map((a, i) => [a.map, i]));
    if (state.pending) index.set(state.pending.map, state.actions.length);
    const rank = card => index.has(card.map) ? index.get(card.map) : 100 + MAP_POOL.indexOf(card.map);
    return [...board].sort((x, y) => rank(x) - rank(y));
  }
  // Cards slide to their new place instead of jumping (FLIP).
  function slide(before) {
    if (!before.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const el of $('vtMaps').children) {
      const old = before.get(el.dataset.map);
      if (!old) continue;
      const now = el.getBoundingClientRect();
      const dx = old.left - now.left, dy = old.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }

  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  let focusConfirm = false;
  function render() {
    // Rebuilt buttons must not throw keyboard users back to the page start.
    const active = document.activeElement;
    const focusMap = active?.closest?.('#vtMaps') ? active.dataset.map : '';
    const focusAction = active?.closest?.('#vtActions') ? [...$('vtActions').children].indexOf(active) : -1;
    let state;
    try { state = replay(room, log); } catch { log = []; state = replay(room, log); }
    const turn = nextTurn(room, state);
    // A coin tossed long ago (a reload, a late viewer) is shown at once;
    // a fresh one flips.
    if ((state.first !== null || room.chooser != null) && coin !== 'shown') {
      coin = 'shown';
      $('vtCoin').dataset.result = String(state.coin);
    }
    if (coin === 'hidden' && state.coin !== null) flipCoin(state.coin);

    for (const team of [0, 1]) {
      const card = $('vtTeam' + team);
      const live = online(team);
      card.dataset.online = live ? 'yes' : 'no';
      card.querySelector('.vt-presence').textContent = team === me ? t('itsYou') : live ? t('online') : t('offline');
      card.classList.toggle('is-turn', turn.team === team && coin === 'shown');
    }

    showClock(state, turn);
    shownFor = presenceKey();

    const stage = $('vtStage');
    const actions = [];
    let kicker = '', prompt = '', hint = '';
    const mine = me !== null && turn.team === me;
    const opp = me === null ? null : 1 - me;
    if (coin !== 'shown') {
      stage.dataset.phase = 'coin';
      kicker = t('coin');
      const tossing = state.commit !== null || (online(0) && online(1));
      if (coin === 'flipping' || tossing) prompt = t('tossing');
      else prompt = me === null ? t('waitCaptains') : t('waitCaptain', names[opp]);
      hint = t('coinHint');
    } else if (turn.kind === 'order') {
      stage.dataset.phase = mine ? 'mine' : 'wait';
      kicker = room.chooser == null ? t('coinWinner', names[state.coin]) : t('assignedChoice', names[state.chooser]);
      if (mine) {
        prompt = t(room.chooser == null ? 'youWon' : 'assignedYou');
        hint = t('decideOrder');
        actions.push(button(t('weBanFirst'), () => move('order', String(me)), true));
        actions.push(button(t('theyBanFirst', names[opp]), () => move('order', String(opp))));
      } else {
        prompt = room.chooser == null ? t('wonCoin', names[state.coin]) : t('assignedChoice', names[state.chooser]);
        hint = t('decidingOrder');
      }
    } else if (turn.kind === 'side') {
      const map = state.pending.map;
      stage.dataset.phase = mine ? 'mine' : 'wait';
      kicker = mine ? t('yourTurnSide') : t('turnSide', names[turn.team]);
      if (mine) {
        prompt = t('picked', names[state.pending.team], map);
        hint = t('whichSide');
        for (const side of ['CT', 'T']) {
          const el = button(t('startOn', side), () => move('side', side));
          el.dataset.side = side;
          actions.push(el);
        }
      } else {
        prompt = t('choosingSide', names[turn.team], map);
      }
    } else if (turn.kind === 'done') {
      stage.dataset.phase = 'done';
      kicker = t('done');
      prompt = t('vetoDone');
      const board = mapBoard(room, state);
      const play = [...state.actions.filter(a => a.type === 'pick').map(a => a.map),
        ...board.filter(m => m.status === 'decider').map(m => m.map + (room.f === 'BO3' || room.f === 'BO5' ? ` ${t('decider')}` : ''))];
      hint = t('playing', play.join(', '));
    } else {
      stage.dataset.phase = mine ? 'mine' : 'wait';
      const kind = t(turn.kind);
      kicker = mine ? t('yourTurn', kind) : t('turnOf', names[turn.team], kind);
      if (mine) {
        prompt = selected ? t('confirm', turn.kind, selected) : turn.kind === 'ban' ? t('removeOne') : t('choosePlay');
        hint = selected ? t('confirmHint') : t('clickHint');
        if (selected) {
          actions.push(button(t('act', turn.kind, selected), () => move(turn.kind, selected), true));
          actions.push(button(t('otherMap'), () => { selected = ''; render(); }));
        }
      } else {
        prompt = t('acting', turn.kind, names[turn.team]);
      }
    }
    setText($('vtKicker'), kicker);
    setText($('vtPrompt'), prompt);
    setText($('vtHint'), hint);
    $('vtActions').replaceChildren(...actions);
    $('vtCoin').hidden = room.starter != null || room.chooser != null || (coin === 'shown' && turn.kind !== 'order');

    const choosing = mine && coin === 'shown' && (turn.kind === 'ban' || turn.kind === 'pick');
    const order = new Map(state.actions.map((a, i) => [a.map, i + 1]));
    if (state.pending) order.set(state.pending.map, state.actions.length + 1);
    const before = new Map([...$('vtMaps').children].map(el => [el.dataset.map, el.getBoundingClientRect()]));
    $('vtMaps').replaceChildren(...ordered(mapBoard(room, state), state).map(card => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'vt-map';
      el.dataset.map = card.map;
      el.dataset.status = card.status;
      el.disabled = !choosing || card.status !== 'open' || busy;
      el.classList.toggle('is-selected', selected === card.map);
      el.setAttribute('aria-pressed', String(selected === card.map));
      const img = Object.assign(document.createElement('img'), { src: `/assets/maps/${card.map}.jpg`, alt: '' });
      img.onerror = () => img.remove();
      const name = Object.assign(document.createElement('span'), { className: 'vt-map-name', textContent: card.map });
      const tag = document.createElement('span');
      tag.className = 'vt-map-tag';
      if (card.status === 'ban') tag.textContent = `BAN · ${names[card.team]}`;
      else if (card.status === 'pick') tag.textContent = `PICK · ${names[card.team]}`;
      else if (card.status === 'decider') tag.textContent = room.f === 'BO1' ? t('tagPlay') : room.f === 'BO2' ? t('tagMap2') : 'DECIDER';
      const side = document.createElement('span');
      side.className = 'vt-map-side';
      if (card.side) {
        const mark = Object.assign(document.createElement('b'), { className: 'vt-side', textContent: card.side });
        mark.dataset.side = card.side;
        side.append(`${names[card.sideTeam]} · `, mark);
      }
      else if (card.status === 'pick') side.textContent = t('choosingShort');
      const num = Object.assign(document.createElement('span'), { className: 'vt-map-num', textContent: order.get(card.map) || '' });
      el.append(...[img, num, name, tag, side].filter(Boolean));
      el.addEventListener('click', () => {
        selected = selected === card.map ? '' : card.map;
        focusConfirm = !!selected;
        render();
      });
      return el;
    }));
    slide(before);
    if (focusConfirm && $('vtActions').firstElementChild) {
      focusConfirm = false;
      $('vtActions').firstElementChild.focus({ preventScroll: true });
    } else if (focusMap) {
      const again = $('vtMaps').querySelector(`[data-map="${focusMap}"]`);
      (again && !again.disabled ? again : $('vtMaps').querySelector('.vt-map:not(:disabled)'))?.focus({ preventScroll: true });
    } else if (focusAction >= 0) {
      ($('vtActions').children[focusAction] || $('vtActions').firstElementChild)?.focus({ preventScroll: true });
    }

    // The HLTV text is ours: only the admin's link shows it.
    const result = admin ? resultText(room, state) : '';
    $('vtResult').hidden = !result;
    $('vtResultText').textContent = result;
    $('vtLog').replaceChildren(...log.map((entry, i) => describe(entry, i, state)).filter(Boolean)
      .map(text => Object.assign(document.createElement('li'), { textContent: text })));
  }
  relabel.add(render);

  const saved = store(logKey);
  if (saved) await adopt(saved);
  render();
  send();
  autoCoin();
  setInterval(send, SEND_EVERY);
  setInterval(tick, 1000);
}

// A room link pasted into the form's tab: open it.
addEventListener('hashchange', () => location.reload());
$('vtRetryLink').addEventListener('click',()=>location.reload());
async function openVeto() {
  const short=new URLSearchParams(location.hash.slice(1)).has('k')||shortPathValid(location.pathname);
  if(short){applyWords();$('vtLinkStatus').hidden=false;}
  let resolved;
  try{resolved=await resolveRoomLink(location.href);}
  catch(error){
    applyWords();showError(t(error.message),[error.message]);
    $('vtRetryLink').hidden=error.message!=='short-link-unavailable';return;
  }finally{$('vtLinkStatus').hidden=true;}
  if(resolved)return enterRoom(resolved.room);
  if(/(?:^#|&)v=/.test(location.hash)){
    applyWords();showError(t('brokenLink'),['brokenLink']);
  }else return setupCreate();
}
openVeto().catch(error=>showError(errorText(error.message)));
