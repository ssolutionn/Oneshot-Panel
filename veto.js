// The captains' veto page. Without #v= it is the admin's form that makes the
// links (the match from the schedule sheet); with it, a captain's (or
// spectators') room. The signed log and the captains' public keys go
// around every 2.5 s over VDO.Ninja data streams: each captain pushes their
// own and views the other's, spectators view both. Same-browser tabs also
// talk over a BroadcastChannel. Rules live in veto-room.js.
import { MAP_POOL, teamLogo, DEFAULT_SOURCE, decodeGviz, parseSchedule } from './core.js';
import { seal, unseal } from './vdo.js';
import {
  decodeLink, createRoom, roomSecrets, captainKey, acceptKey, seat, verifyLog, replay, nextTurn,
  signMove, mergeLog, clock, formatClock, mapBoard, resultText, captainMessage, coinCommit, coinNonce,
  COIN_MOVES
} from './veto-room.js';

const $ = id => document.getElementById(id);
const VDO = 'https://vdo.ninja/';
const SEND_EVERY = 2500, ONLINE_FOR = 8000;
const LAST_KEY = 'oneshot-player-veto';

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode: the page still works */ }
  return null;
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
  toast('Скопировано');
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const source = $(button.dataset.copy);
  copy(source.value ?? source.textContent);
});
function showError(text) {
  $('vtError').textContent = text;
  $('vtError').hidden = !text;
}
async function teamLogos() {
  try {
    const response = await fetch('/assets/teams/teams.json', { cache: 'no-cache' });
    return response.ok ? await response.json() : {};
  } catch { return {}; }
}

// ---- Admin: make the links ----
function showLinks(made) {
  const { room, links } = made;
  $('vtLinkNameA').textContent = room.t[0];
  $('vtLinkNameB').textContent = room.t[1];
  $('vtMsgA').value = captainMessage(room, 0, links.a);
  $('vtMsgB').value = captainMessage(room, 1, links.b);
  $('vtMsgS').value = `Вето ${room.t[0]} vs ${room.t[1]} (${room.f}) вживую:\n${links.s}`;
  $('vtWatch').href = links.s;
  $('vtLinks').hidden = false;
  $('vtMade').textContent = '';
}
const RESTORE_FOR = 6 * 3600000;
// The schedule sheet the panel reads (its own source if changed there):
// matches from today (MSK) on fill the teams, nobody types them.
const mskDay = (shift = 0) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' })
  .format(new Date(Date.now() + shift * 86400000));
async function scheduleRows(id, gid) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq`);
  url.search = new URLSearchParams({ gid, range: 'A1:N300', headers: '1', tqx: 'out:json', _t: String(Date.now()) });
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Google Sheets недоступен (${response.status}).`);
  return decodeGviz(await response.text());
}
async function loadMatches() {
  const select = $('vtMatch');
  let source = DEFAULT_SOURCE;
  try { source = { ...DEFAULT_SOURCE, ...(JSON.parse(localStorage.getItem('webcam-desk-source')) || {}) }; } catch { /* default */ }
  const id = source.scheduleId || source.id, gid = source.scheduleGid;
  try {
    if (!gid) throw new Error('В панели не указан лист расписания.');
    const tabs = [scheduleRows(id, gid)];
    if (id === DEFAULT_SOURCE.scheduleId && gid === DEFAULT_SOURCE.scheduleGid) {
      tabs.push(scheduleRows(id, DEFAULT_SOURCE.playoffsGid).catch(() => []));
    }
    const rows = (await Promise.all(tabs)).flat();
    const key = date => Number(date.slice(3, 5)) * 100 + Number(date.slice(0, 2));
    const today = key(mskDay());
    const matches = parseSchedule(rows).filter(m => !m.date || key(m.date) >= today);
    const label = date => date === mskDay() ? `${date} · сегодня` : date === mskDay(1) ? `${date} · завтра` : date || 'Без даты';
    const groups = new Map();
    for (const m of matches) {
      if (!groups.has(m.date)) groups.set(m.date, Object.assign(document.createElement('optgroup'), { label: label(m.date) }));
      groups.get(m.date).append(Object.assign(document.createElement('option'), {
        value: JSON.stringify([m.team1, m.team2]),
        textContent: `${m.time} · ${m.team1} vs ${m.team2}${m.stage ? ` · ${m.stage}` : ''}`
      }));
    }
    const first = Object.assign(document.createElement('option'), {
      value: '', textContent: matches.length ? 'Выбери матч — команды подставятся сами' : 'В расписании нет предстоящих матчей'
    });
    select.replaceChildren(first, ...groups.values());
    // The panel's teams (#new&a=&b=) pick their match in the list.
    const asked = JSON.stringify([$('vtTeamA').value, $('vtTeamB').value]);
    if ([...select.options].some(o => o.value === asked)) select.value = asked;
  } catch (error) {
    select.replaceChildren(Object.assign(document.createElement('option'), {
      value: '', textContent: 'Расписание не загрузилось — впиши команды ниже'
    }));
    select.title = error.message;
  }
}
async function setupCreate() {
  document.title = 'Новое вето · CyberClash';
  $('vtCreate').hidden = false;
  // The form works before anything else loads (a slow teams.json or odd
  // saved data must not leave it submitting natively).
  $('vtForm').addEventListener('submit', async event => {
    event.preventDefault();
    showError('');
    try {
      const base = new URL('/veto.html', location.href).href;
      const made = await createRoom(base, [$('vtTeamA').value, $('vtTeamB').value], $('vtFormat').value);
      made.at = Date.now();
      store(LAST_KEY, made);
      showLinks(made);
      toast('Ссылки готовы');
    } catch (error) { showError(error.message); }
  });
  $('vtMatch').addEventListener('change', () => {
    if (!$('vtMatch').value) return;
    const [a, b] = JSON.parse($('vtMatch').value);
    $('vtTeamA').value = a;
    $('vtTeamB').value = b;
  });
  const params = new URLSearchParams(location.hash.slice(1));
  const asked = params.has('new') ? [params.get('a') || '', params.get('b') || '', params.get('f')] : null;
  if (asked) {
    $('vtTeamA').value = asked[0];
    $('vtTeamB').value = asked[1];
    if (['BO1', 'BO2', 'BO3', 'BO5'].includes(asked[2])) $('vtFormat').value = asked[2];
  }
  // The last links made in this browser, for a few hours, so a reload does
  // not lose them; from the panel only when they are for the same match.
  try {
    const last = store(LAST_KEY);
    const room = last?.room;
    const fresh = Date.now() - (Number(last?.at) || 0) < RESTORE_FOR;
    if (fresh && room && Array.isArray(room.t) && last.links?.a && last.links?.b && last.links?.s &&
        (!asked || (asked[0] === room.t[0] && asked[1] === room.t[1] && asked[2] === room.f))) {
      $('vtTeamA').value = room.t[0];
      $('vtTeamB').value = room.t[1];
      $('vtFormat').value = room.f;
      showLinks(last);
      $('vtMade').textContent = `Ссылки созданы в ${new Date(last.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}. Для нового матча нажми «Создать ссылки» ещё раз.`;
    }
  } catch { /* odd saved data: start clean */ }
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
    const make = (side, stream) => {
      const url = new URL(VDO);
      url.search = new URLSearchParams({ [side]: stream, password: secrets.password, label: 'oneshot-veto' }) +
        '&dataonly&cleanoutput';
      const iframe = document.createElement('iframe');
      Object.assign(iframe, { src: url.href, title: 'Связь вето', className: 'vdo-frame', tabIndex: -1 });
      iframe.allow = 'autoplay';
      iframe.setAttribute('aria-hidden', 'true');
      document.body.append(iframe);
      this.frames.push(iframe);
      if (side === 'view') this.streams.set(iframe, stream);
    };
    if (push) make('push', push);
    for (const stream of views) make('view', stream);
    addEventListener('message', event => {
      const frame = this.frames.find(f => f.contentWindow === event.source);
      if (!frame) return;
      const box = event.data?.dataReceived?.oneshotVeto;
      // Through a view frame the sender is that stream's owner; through our
      // own push frame it is anyone viewing us (not proof of who it is).
      if (box) this.open(box, this.streams.get(frame) || '');
    });
    try {
      this.channel = new BroadcastChannel('oneshot-veto:' + secrets.streams.join(':'));
      this.channel.onmessage = event => this.open(event.data, 'tab');
    } catch { this.channel = null; }
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
}

// ---- Room ----
const VERB = { ban: 'Забанить', pick: 'Играем' };
const SIDE_NAME = { CT: 'CT · защита', T: 'T · атака' };

async function enterRoom(room) {
  const me = seat(room);
  const names = room.t;
  const logKey = 'oneshot-veto-log:' + room.r, keysKey = 'oneshot-veto-keys:' + room.r;
  const coinKey = 'oneshot-veto-coin:' + room.r;
  const checked = new Set();
  const seen = { a: 0, b: 0 };
  const conflicts = new Map();
  let log = [], key = null, selected = '', busy = false, coin = 'hidden', autoTried = '';
  let queue = Promise.resolve(), pending = null;


  document.title = `Вето ${names[0]} vs ${names[1]} · CyberClash`;
  $('vtTitle').textContent = `${names[0]} vs ${names[1]}`;
  $('vtEyebrow').textContent = `MAP VETO · ${room.f}`;
  $('vtRoom').hidden = false;
  $('vtFoot').textContent = me === null ?
    'Режим зрителя: ходят только капитаны по своим ссылкам.' :
    `Ты капитан ${names[me]}. Эта ссылка только для тебя — не пересылай её.`;
  for (const team of [0, 1]) {
    const card = $('vtTeam' + team);
    card.querySelector('.vt-team-name').textContent = names[team];
    card.querySelector('.vt-you').hidden = me !== team;
    card.classList.toggle('is-you', me === team);
  }
  $('vtCoin').querySelector('.vt-coin-0').textContent = names[0].slice(0, 2).toUpperCase();
  $('vtCoin').querySelector('.vt-coin-1').textContent = names[1].slice(0, 2).toUpperCase();
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

  const secrets = await roomSecrets(room);
  if (me !== null) {
    try { key = await captainKey(room); } catch {
      $('vtRoom').hidden = true;
      return showError('Ссылка капитана повреждена (ключ не подходит). Скопируй её из Discord целиком или попроси админа прислать новую.');
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
  const link = new Link(secrets, me === null ? '' : secrets.streams[me],
    me === null ? secrets.streams : [secrets.streams[1 - me]], receive);

  const online = team => team === me || Date.now() - seen[team ? 'b' : 'a'] < ONLINE_FOR;
  // Spectators only listen: they add no load on the captains' phones.
  const send = () => { if (me !== null) link.send({ t: 'log', from: room.me, log, p: room.p }); };

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
  function receive(message, via) {
    if (!message || message.t !== 'log' || !Array.isArray(message.log)) return;
    // Presence: the opponent's own stream (or another tab of this browser).
    const from = via === 'tab' ? message.from :
      via === secrets.streams[0] ? 'a' : via === secrets.streams[1] ? 'b' : '';
    if (from === 'a' || from === 'b') seen[from] = Date.now();
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
    showError(`Внимание: ${team === null ? 'капитан' : `капитан ${names[team]}`} подписал два разных хода на шаге ${index + 1}. Засчитан первый. Напишите админу — он решит, переигрывать ли вето.`);
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
    } catch (error) { if (!quiet) toast(error.message); }
    finally { busy = false; render(); autoCoin(); }
  }
  // The coin goes by itself once both captains are here: A commits to a
  // hidden nonce (kept in this browser for the reveal), B adds a seed, A
  // reveals. Nobody knows the result before both parts are in.
  function autoCoin() {
    if (me === null || busy) return;
    const turn = nextTurn(room, replay(room, log));
    if (turn.team !== me || !COIN_MOVES.includes(turn.kind)) return;
    if (turn.kind === 'commit' && !(online(0) && online(1))) return;
    const attempt = turn.kind + log.length;
    if (autoTried === attempt) return;
    autoTried = attempt;
    if (turn.kind === 'commit') {
      move('commit', async () => {
        let nonce = store(coinKey);
        if (typeof nonce !== 'string') { nonce = coinNonce(); store(coinKey, nonce); }
        return coinCommit(room, nonce);
      }, true);
    } else if (turn.kind === 'seed') {
      move('seed', coinNonce(), true);
    } else {
      const nonce = store(coinKey);
      if (typeof nonce !== 'string') {
        return showError('Монетку открыть нельзя: твоя часть осталась в другом браузере или устройстве, где ты заходил первым. Открой ссылку там или попроси админа сделать новые ссылки.');
      }
      move('reveal', nonce, true);
    }
  }

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
    if (entry.k === 'order') {
      const first = Number(entry.v);
      return `${names[team]} выиграли монетку: первыми банят ${names[first]}`;
    }
    if (entry.k === 'ban') return `${names[team]} убрали ${entry.v}`;
    if (entry.k === 'pick') return `${names[team]} взяли ${entry.v}`;
    return `${names[team]} начинают за ${entry.v} на ${prior.pending?.map || state.pending?.map || ''}`;
  }

  function showClock(state, turn) {
    const t = clock(state);
    $('vtClock').hidden = !t.started;
    if (!t.started) return;
    const done = turn.kind === 'done';
    const spent = done ? log[log.length - 1].at - state.startedAt : 0;
    $('vtClockTime').textContent = formatClock(done ? Math.max(0, spent) : t.left);
    $('vtClock').querySelector('.vt-clock-label').textContent = done ? 'вето за' : t.over ? 'время вышло' : 'на вето';
    $('vtClock').dataset.state = done ? 'done' : t.over ? 'over' : t.left < 60000 ? 'low' : 'run';
  }
  // Rebuilding the map buttons every second would eat clicks: the tick only
  // moves the clock and re-renders when presence changed.
  let shownFor = '';
  const presenceKey = () => [online(0), online(1)].join();
  function tick() {
    autoCoin();
    if (presenceKey() !== shownFor) return render();
    const state = replay(room, log);
    showClock(state, nextTurn(room, state));
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
    if (state.first !== null && coin !== 'shown') {
      coin = 'shown';
      $('vtCoin').dataset.result = String(state.coin);
    }
    if (coin === 'hidden' && state.coin !== null) flipCoin(state.coin);

    for (const team of [0, 1]) {
      const card = $('vtTeam' + team);
      const live = online(team);
      card.dataset.online = live ? 'yes' : 'no';
      card.querySelector('.vt-presence').textContent = team === me ? 'это ты' : live ? 'на сайте' : 'не в сети';
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
      kicker = 'Монетка';
      const tossing = state.commit !== null || (online(0) && online(1));
      if (coin === 'flipping' || tossing) { prompt = 'Подбрасываем…'; }
      else prompt = me === null ? 'Ждём капитанов' : `Ждём капитана ${names[opp]}`;
      hint = 'Монетку бросают оба капитана, когда откроют свои ссылки: каждый добавляет свою случайную часть, поэтому результат заранее не знает никто — ни капитаны, ни админ.';
    } else if (turn.kind === 'order') {
      stage.dataset.phase = mine ? 'mine' : 'wait';
      kicker = `Монетка: ${names[state.coin]}`;
      if (mine) {
        prompt = 'Вы выиграли монетку';
        hint = 'Решите, кто банит первым.';
        actions.push(button('Баним первыми', () => move('order', String(me)), true));
        actions.push(button(`Первыми банят ${names[opp]}`, () => move('order', String(opp))));
      } else {
        prompt = `${names[state.coin]} выиграли монетку`;
        hint = 'Они решают, кто банит первым…';
      }
    } else if (turn.kind === 'side') {
      const map = state.pending.map;
      stage.dataset.phase = mine ? 'mine' : 'wait';
      kicker = mine ? 'Твой ход · сторона' : `Ход ${names[turn.team]} · сторона`;
      if (mine) {
        prompt = `${names[state.pending.team]} взяли ${map}`;
        hint = 'За какую сторону начнёте?';
        for (const side of ['CT', 'T']) actions.push(button(`Начинаем за ${SIDE_NAME[side]}`, () => move('side', side), side === 'CT'));
      } else {
        prompt = `${names[turn.team]} выбирают сторону на ${map}…`;
      }
    } else if (turn.kind === 'done') {
      stage.dataset.phase = 'done';
      kicker = 'Готово';
      prompt = 'Вето завершено';
      const board = mapBoard(room, state);
      const play = [...state.actions.filter(a => a.type === 'pick').map(a => a.map),
        ...board.filter(m => m.status === 'decider').map(m => m.map + (room.f === 'BO3' || room.f === 'BO5' ? ' (решающая)' : ''))];
      hint = `Играем: ${play.join(', ')}`;
    } else {
      stage.dataset.phase = mine ? 'mine' : 'wait';
      const ban = turn.kind === 'ban';
      kicker = mine ? `Твой ход · ${ban ? 'бан' : 'пик'}` : `Ход ${names[turn.team]} · ${ban ? 'бан' : 'пик'}`;
      if (mine) {
        prompt = selected ? `${VERB[turn.kind]} ${selected}?` : ban ? 'Убери одну карту' : 'Выбери карту, которую играем';
        hint = selected ? 'Подтверди — ход нельзя отменить.' : 'Нажми на карту, потом подтверди.';
        if (selected) {
          actions.push(button(`${VERB[turn.kind]} ${selected}`, () => move(turn.kind, selected), true));
          actions.push(button('Другая карта', () => { selected = ''; render(); }));
        }
      } else {
        prompt = `${names[turn.team]} ${ban ? 'банят' : 'выбирают'} карту…`;
      }
    }
    setText($('vtKicker'), kicker);
    setText($('vtPrompt'), prompt);
    setText($('vtHint'), hint);
    $('vtActions').replaceChildren(...actions);
    $('vtCoin').hidden = coin === 'shown' && turn.kind !== 'order';

    const choosing = mine && coin === 'shown' && (turn.kind === 'ban' || turn.kind === 'pick');
    const order = new Map(state.actions.map((a, i) => [a.map, i + 1]));
    if (state.pending) order.set(state.pending.map, state.actions.length + 1);
    $('vtMaps').replaceChildren(...mapBoard(room, state).map(card => {
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
      else if (card.status === 'decider') tag.textContent = room.f === 'BO1' ? 'ИГРАЕМ' : room.f === 'BO2' ? 'КАРТА 2' : 'DECIDER';
      const side = document.createElement('span');
      side.className = 'vt-map-side';
      if (card.side) side.textContent = `${names[card.sideTeam]} · ${card.side}`;
      else if (card.status === 'pick') side.textContent = 'выбирают сторону…';
      const num = Object.assign(document.createElement('span'), { className: 'vt-map-num', textContent: order.get(card.map) || '' });
      el.append(...[img, num, name, tag, side].filter(Boolean));
      el.addEventListener('click', () => {
        selected = selected === card.map ? '' : card.map;
        focusConfirm = !!selected;
        render();
      });
      return el;
    }));
    if (focusConfirm && $('vtActions').firstElementChild) {
      focusConfirm = false;
      $('vtActions').firstElementChild.focus({ preventScroll: true });
    } else if (focusMap) {
      const again = $('vtMaps').querySelector(`[data-map="${focusMap}"]`);
      (again && !again.disabled ? again : $('vtMaps').querySelector('.vt-map:not(:disabled)'))?.focus({ preventScroll: true });
    } else if (focusAction >= 0) {
      ($('vtActions').children[focusAction] || $('vtActions').firstElementChild)?.focus({ preventScroll: true });
    }

    const result = resultText(room, state);
    $('vtResult').hidden = !result;
    $('vtResultText').textContent = result;
    $('vtLog').replaceChildren(...log.map((entry, i) => describe(entry, i, state)).filter(Boolean)
      .map(text => Object.assign(document.createElement('li'), { textContent: text })));
  }

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
const room = decodeLink(location.hash);
if (room) enterRoom(room).catch(error => showError(error.message));
else if (/(?:^#|&)v=/.test(location.hash)) {
  showError('Ссылка на вето повреждена. Скопируй её из Discord целиком или попроси админа прислать новую.');
} else setupCreate();
