// The captains' veto page. Without #v= it is the admin's form that makes the
// links; with it, a captain's (or spectators') room. The signed log goes
// around every 2.5 s over VDO.Ninja data streams: each captain pushes their
// own and views the other's, spectators view both. Same-browser tabs also
// talk over a BroadcastChannel. Rules live in veto-room.js.
import { MAP_POOL, teamLogo } from './core.js';
import { seal, unseal } from './vdo.js';
import {
  decodeLink, createRoom, roomSecrets, privateKey, seat, verifyLog, replay, nextTurn,
  signMove, pickLog, clock, formatClock, mapBoard, resultText, captainMessage
} from './veto-room.js';

const $ = id => document.getElementById(id);
const VDO = 'https://vdo.ninja/';
const SEND_EVERY = 2500, ONLINE_FOR = 8000, COIN_WAIT = 15000;
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
}
async function setupCreate() {
  document.title = 'Новое вето · CyberClash';
  $('vtCreate').hidden = false;
  const logos = await teamLogos();
  $('vtTeamList').replaceChildren(...Object.keys(logos).sort((a, b) => a.localeCompare(b))
    .map(name => Object.assign(document.createElement('option'), { value: name })));
  const params = new URLSearchParams(location.hash.slice(1));
  // The last links made in this browser, so a reload does not lose them;
  // from the panel only when they are for the same match.
  const last = store(LAST_KEY);
  const asked = params.has('new') ? [params.get('a') || '', params.get('b') || '', params.get('f')] : null;
  if (last?.room && last?.links &&
      (!asked || (asked[0] === last.room.t[0] && asked[1] === last.room.t[1] && asked[2] === last.room.f))) {
    $('vtTeamA').value = last.room.t[0];
    $('vtTeamB').value = last.room.t[1];
    $('vtFormat').value = last.room.f;
    showLinks(last);
  } else if (asked) {
    $('vtTeamA').value = asked[0];
    $('vtTeamB').value = asked[1];
    if (['BO1', 'BO2', 'BO3', 'BO5'].includes(asked[2])) $('vtFormat').value = asked[2];
  }
  $('vtForm').addEventListener('submit', async event => {
    event.preventDefault();
    showError('');
    try {
      const base = new URL('/veto.html', location.href).href;
      const made = await createRoom(base, [$('vtTeamA').value, $('vtTeamB').value], $('vtFormat').value);
      store(LAST_KEY, made);
      showLinks(made);
      toast('Ссылки готовы');
    } catch (error) { showError(error.message); }
  });
}

// ---- Transport ----
class Link {
  constructor(secrets, push, views, onMessage) {
    Object.assign(this, { secrets, onMessage });
    this.frames = [];
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
    };
    if (push) make('push', push);
    for (const stream of views) make('view', stream);
    addEventListener('message', event => {
      if (!this.frames.some(f => f.contentWindow === event.source)) return;
      const box = event.data?.dataReceived?.oneshotVeto;
      if (box) this.open(box);
    });
    try {
      this.channel = new BroadcastChannel('oneshot-veto:' + secrets.streams.join(':'));
      this.channel.onmessage = event => this.open(event.data);
    } catch { this.channel = null; }
  }
  async open(box) {
    const message = await unseal(this.secrets.key, box);
    if (message) this.onMessage(message);
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
  const logKey = 'oneshot-veto-log:' + room.r;
  const checked = new Set();
  const seen = { a: 0, b: 0 };
  const opened = Date.now();
  let log = [], key = null, selected = '', busy = false, coin = 'hidden';
  let queue = Promise.resolve();

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
  if (me !== null) key = await privateKey(room);
  const link = new Link(secrets, me === null ? '' : secrets.streams[me],
    me === null ? secrets.streams : [secrets.streams[1 - me]], receive);

  const online = team => team === me || Date.now() - seen[team ? 'b' : 'a'] < ONLINE_FOR;
  const send = () => link.send({ t: 'log', from: room.me, log });

  function adopt(incoming) {
    queue = queue.then(async () => {
      const verified = await verifyLog(room, incoming, checked);
      const best = pickLog(log, verified);
      if (best === log) return;
      log = best;
      selected = '';
      store(logKey, log);
      render();
      send();
    });
    return queue;
  }
  function receive(message) {
    if (!message || message.t !== 'log') return;
    if (message.from === 'a' || message.from === 'b') seen[message.from] = Date.now();
    adopt(message.log);
  }

  async function move(kind, value) {
    if (busy || !key) return;
    busy = true;
    try {
      const next = await signMove(room, log, key, kind, value);
      selected = '';
      await adopt(next);
    } catch (error) { toast(error.message); }
    finally { busy = false; render(); }
  }

  function flipCoin() {
    if (coin !== 'hidden') return;
    coin = 'flipping';
    $('vtCoin').dataset.result = String(room.c);
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
  // moves the clock and re-renders when presence or the coin wait changed.
  let shownFor = '';
  const presenceKey = () => [online(0), online(1), Date.now() - opened > COIN_WAIT].join();
  function tick() {
    if (presenceKey() !== shownFor) return render();
    const state = replay(room, log);
    showClock(state, nextTurn(room, state));
  }

  function render() {
    let state;
    try { state = replay(room, log); } catch { log = []; state = replay(room, log); }
    const turn = nextTurn(room, state);
    if (log.length && coin !== 'shown') {
      coin = 'shown';
      $('vtCoin').dataset.result = String(room.c);
    }
    if (coin === 'hidden' && online(0) && online(1)) flipCoin();

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
      if (coin === 'flipping') { prompt = 'Подбрасываем…'; }
      else {
        prompt = me === null ? 'Ждём капитанов' : `Ждём капитана ${names[opp]}`;
        hint = 'Монетку подбросим, когда оба капитана откроют свои ссылки.';
        if (Date.now() - opened > COIN_WAIT) {
          hint += ' Соперник не появляется? Напиши админу или подбрось сейчас — результат от этого не меняется.';
          actions.push(button('Подбросить сейчас', flipCoin));
        }
      }
    } else if (turn.kind === 'order') {
      stage.dataset.phase = mine ? 'mine' : 'wait';
      kicker = `Монетка: ${names[room.c]}`;
      if (mine) {
        prompt = 'Вы выиграли монетку';
        hint = 'Решите, кто банит первым.';
        actions.push(button('Баним первыми', () => move('order', String(me)), true));
        actions.push(button(`Первыми банят ${names[opp]}`, () => move('order', String(opp))));
      } else {
        prompt = `${names[room.c]} выиграли монетку`;
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
        ...board.filter(m => m.status === 'decider').map(m => m.map + (room.f === 'BO1' ? '' : ' (решающая)'))];
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
    $('vtKicker').textContent = kicker;
    $('vtPrompt').textContent = prompt;
    $('vtHint').textContent = hint;
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
      else if (card.status === 'decider') tag.textContent = room.f === 'BO1' ? 'ИГРАЕМ' : 'DECIDER';
      const side = document.createElement('span');
      side.className = 'vt-map-side';
      if (card.side) side.textContent = `${names[card.sideTeam]} · ${card.side}`;
      else if (card.status === 'pick') side.textContent = 'выбирают сторону…';
      const num = Object.assign(document.createElement('span'), { className: 'vt-map-num', textContent: order.get(card.map) || '' });
      el.append(...[img, num, name, tag, side].filter(Boolean));
      el.addEventListener('click', () => {
        selected = selected === card.map ? '' : card.map;
        render();
      });
      return el;
    }));

    const result = resultText(room, state);
    $('vtResult').hidden = !result;
    $('vtResultText').textContent = result;
    $('vtLog').replaceChildren(...log.map((entry, i) =>
      Object.assign(document.createElement('li'), { textContent: describe(entry, i, state) })));
  }

  const saved = store(logKey);
  if (saved) await adopt(saved);
  render();
  send();
  setInterval(send, SEND_EVERY);
  setInterval(tick, 1000);
  addEventListener('hashchange', () => location.reload());
}

const room = decodeLink(location.hash);
if (room) enterRoom(room).catch(error => showError(error.message));
else if (/(?:^#|&)v=/.test(location.hash)) {
  showError('Ссылка на вето повреждена. Скопируй её из Discord целиком или попроси админа прислать новую.');
} else setupCreate();
