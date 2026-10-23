// Лобби: follows a FACEIT tournament, alerts admins when a map or a match ends
// (sound, browser notification, tab badge) and prepares the Discord texts.
// Tech pauses are logged by hand: FACEIT's API does not report them.
import {
  FaceitClient, FACEIT_PROXY, parseFaceitTargets, summarizeMatch, matchEvents, eventText,
  nextStart, fillTemplate, DEFAULT_TEMPLATES, scoreLine, mapScores
} from './faceit.js';
import { personKey } from './core.js';
import {notificationPermission,enableNotifications,showNotification,setFlashingTitle} from './notifications.js';

const $ = id => document.getElementById(id);
const panel = window.oneshotPanel;
const STORE = 'oneshot-lobby', LOG_STORE = 'oneshot-lobby-log';
// The siren: at most 3 more beeps (1 minute), and it stops as soon as someone looks.
const POLL = 20000, REPEAT = 20000, REPEAT_LIMIT = 3;
const lobby = {
  client: null, champ: '', timer: null, tick: 0, interval: POLL,
  matches: new Map(), pauses: new Map(), finished: null,
  alert: null, repeats: 0, repeatTimer: null, unread: 0, view: 'prep'
};

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not kept */ }
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
const settings = () => ({ delay: 10, templates: { ...DEFAULT_TEMPLATES }, ...read(STORE, {}) });
const clock = ms => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const duration = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---------- journal ----------
function log(text, kind = '') {
  const entries = read(LOG_STORE, []);
  entries.unshift({ at: Date.now(), text, kind });
  write(LOG_STORE, entries.slice(0, 150));
  renderLog();
}
// Notes from other lobby blocks (bookmakers' lines) go to the same journal.
window.addEventListener('oneshot:lobby-note', event => {
  if (typeof event.detail === 'string') log(event.detail, 'bookie');
});
function renderLog() {
  const entries = read(LOG_STORE, []);
  $('lobbyLog').innerHTML = entries.length ? entries.map(e =>
    `<li class="${escapeHtml(e.kind)}"><time>${clock(e.at)}</time> ${escapeHtml(e.text)}</li>`).join('') :
    '<li class="muted">Здесь появятся концы карт и матчей, паузы и старты.</li>';
}

// ---------- alerts ----------
let audio = null;
function unlockAudio() {
  try {
    audio ||= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
  } catch { audio = null; }
}
function beep() {
  if (!audio) return;
  const now = audio.currentTime;
  [[880, 0], [660, 0.22], [880, 0.44]].forEach(([freq, at]) => {
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.35, now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.2);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.21);
  });
}
function notifyState() {
  const state=notificationPermission(),supported=state!=='unsupported';
  const granted = state==='granted';
  $('notifyBtn').textContent = !supported ? 'Уведомления недоступны' :
    granted ? 'Проверить уведомления' : state==='denied' ?
      'Настроить уведомления' : 'Включить уведомления';
  $('notifyBtn').disabled = !supported;
}
function badge() {
  $('lobbyBadge').hidden = !lobby.unread || lobby.view === 'lobby';
  $('lobbyBadge').textContent = String(lobby.unread);
}
// loud: the siren repeats until «Принял»; quiet: one beep and a notification.
function alertAdmins(text, tag, { loud = true } = {}) {
  lobby.unread++;
  badge();
  // A quiet note (map point) does not cover a loud alert nobody has accepted yet.
  if (loud || $('lobbyAlert').hidden || !lobby.loudShown) {
    lobby.alert = text;
    lobby.loudShown = loud;
    $('lobbyAlertText').textContent = text;
  }
  $('lobbyAlert').hidden = false;
  void showNotification('Oneshot · Лобби',text,{tag}).then(shown=>{
    if(!shown && notificationPermission()==='granted')$('notifyStatus').textContent='Не удалось показать системное уведомление. Нажми «Проверить уведомления»; звуковой сигнал и сообщение в панели работают.';
  });
  beep();
  if (!loud) return;
  lobby.repeats = 0;
  clearInterval(lobby.repeatTimer);
  lobby.repeatTimer = setInterval(() => {
    if (++lobby.repeats >= REPEAT_LIMIT) return clearInterval(lobby.repeatTimer);
    beep();
  }, REPEAT);
  // The tab title blinks through the shared flasher (notifications.js): the
  // veto room's «Call admin» may ring at the same time, they must not fight.
  setFlashingTitle('lobby', `● ${text}`);
}
function hush() { clearInterval(lobby.repeatTimer); }
window.addEventListener('focus', hush);
document.addEventListener('visibilitychange', () => { if (!document.hidden) hush(); });
function acknowledge() {
  lobby.alert = null;
  lobby.unread = 0;
  badge();
  clearInterval(lobby.repeatTimer);
  setFlashingTitle('lobby', '');
  $('lobbyAlert').hidden = true;
}

// ---------- messages ----------
function nextOptions() {
  const s = panel.snapshot();
  const seen = new Set(), options = [];
  const add = (label, team1, team2) => {
    const key = [personKey(team1), personKey(team2)].sort().join('|');
    if (!team1 || !team2 || seen.has(key)) return;
    seen.add(key);
    options.push({ label, team1, team2 });
  };
  const upcoming = [...lobby.matches.values()].filter(m => !m.live && !m.done)
    .sort((x, y) => (x.scheduledAt || Infinity) - (y.scheduledAt || Infinity));
  for (const m of upcoming) add(`FACEIT · ${m.teams[0]} vs ${m.teams[1]}`, m.teams[0], m.teams[1]);
  for (const m of s.schedule || []) {
    add([m.date, m.time, m.stage, `${m.team1} vs ${m.team2}`].filter(Boolean).join(' · '), m.team1, m.team2);
  }
  return options;
}
// A message the admin edited by hand stays until the generated text changes
// (another match, a new result); polls must not wipe their edits.
function setMessage(id, text) {
  const el = $(id);
  if (el.dataset.generated === text) return;
  el.dataset.generated = text;
  el.value = text;
}
function renderMessages() {
  const { delay, templates } = settings();
  const options = nextOptions();
  // Options are keyed by the two teams, so a match going live or a new one
  // appearing in the list never moves the selection to other teams.
  const keyOf = o => JSON.stringify([o.team1, o.team2]);
  const current = $('nextMatch').value;
  const seen = new Set();
  const unique = options.filter(o => !seen.has(keyOf(o)) && seen.add(keyOf(o)));
  $('nextMatch').innerHTML = '<option value="">Выбери команды</option>' + unique.map(o =>
    `<option value="${escapeHtml(keyOf(o))}">${escapeHtml(o.label)}</option>`).join('');
  if (current && unique.some(o => keyOf(o) === current)) $('nextMatch').value = current;
  else if (unique.length) $('nextMatch').value = keyOf(unique[0]);
  const next = unique.find(o => keyOf(o) === $('nextMatch').value);
  const done = lobby.finished;
  const time = nextStart(done?.finishedAt || Date.now(), delay);
  setMessage('msgThanks', done ? fillTemplate(templates.thanks, {
    team1: done.teams[0], team2: done.teams[1], score: scoreLine(done), time,
    maps: (done.mapScores || []).join(', ')
  }) : '');
  $('msgThanks').placeholder = 'Появится после конца матча на FACEIT';
  setMessage('msgNext', next ? fillTemplate(templates.next, { team1: next.team1, team2: next.team2, time }) : '');
}
function fillTemplatesForm() {
  const { templates, delay } = settings();
  $('tplThanks').value = templates.thanks;
  $('tplNext').value = templates.next;
  $('nextDelay').value = String(delay);
}
function saveTemplates() {
  const delay = Math.min(120, Math.max(0, Number($('nextDelay').value) || 0));
  write(STORE, { ...read(STORE, {}), delay, templates: { thanks: $('tplThanks').value, next: $('tplNext').value } });
  renderMessages();
}

// ---------- matches ----------
function renderMatches() {
  const list = [...lobby.matches.values()];
  const live = list.filter(m => m.live).sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));
  const upcoming = list.filter(m => !m.live && !m.done)
    .sort((x, y) => (x.scheduledAt || Infinity) - (y.scheduledAt || Infinity)).slice(0, 4);
  const finished = list.filter(m => m.done)
    .sort((x, y) => (y.finishedAt || 0) - (x.finishedAt || 0)).slice(0, 3);
  const shown = [...live, ...upcoming, ...finished];
  if (!shown.length) {
    $('lobbyMatches').innerHTML = `<div class="empty-panel">${lobby.champ ?
      'В турнире пока нет текущих и ближайших матчей.' : 'Матчи появятся после подключения турнира.'}</div>`;
    return;
  }
  $('lobbyMatches').innerHTML = shown.map(m => {
    const pause = lobby.pauses.get(m.id);
    const maps = m.picks.length ? m.picks : m.maps.map((_, i) => `Карта ${i + 1}`);
    return `<article class="lobby-match ${m.live ? 'live' : m.done ? 'done' : 'soon'}" data-match="${escapeHtml(m.id)}">
      <div class="lm-top">
        <span class="lm-status">${escapeHtml(m.statusText)}</span>
        <span class="lm-meta">${escapeHtml([m.bestOf ? `BO${m.bestOf}` : '',
          m.scheduledAt && !m.live && !m.done ? clock(m.scheduledAt).slice(0, 5) : ''].filter(Boolean).join(' · '))}</span>
        ${m.url ? `<a class="text-button" href="${escapeHtml(m.url)}" target="_blank" rel="noreferrer">Матчрум ↗</a>` : ''}
      </div>
      <div class="lm-teams">
        <span class="lm-team ${m.winner === 0 ? 'won' : ''}">${escapeHtml(m.teams[0])}</span>
        <div class="lm-series"><span>Серия · по картам</span><b class="lm-score">${m.score[0]} : ${m.score[1]}</b></div>
        <span class="lm-team right ${m.winner === 1 ? 'won' : ''}">${escapeHtml(m.teams[1])}</span>
      </div>
      ${m.live ? `<div class="lm-game"><span>Раунды на текущей карте${maps[m.liveMap - 1] ? ` · ${escapeHtml(maps[m.liveMap - 1])}` : ''}</span><b>${m.rounds ? `${m.rounds[0]} : ${m.rounds[1]}` : 'Нет данных FACEIT'}</b></div>` : ''}
      ${maps.length ? `<ol class="lm-maps">${maps.map((name, i) => {
        const result = m.maps[i]?.winner;
        return `<li class="${result === 0 ? 'a' : result === 1 ? 'b' : ''}">${escapeHtml(String(name).replace(/^de_/, ''))}</li>`;
      }).join('')}</ol>` : ''}
      ${m.live ? `<div class="lm-pause">${pause ?
        `<span class="pause-on">Тех. пауза · ${escapeHtml(m.teams[pause.team])} · <time data-since="${pause.start}">${duration(Date.now() - pause.start)}</time></span>
         <button class="button small" type="button" data-resume="${escapeHtml(m.id)}">Продолжили</button>` :
        `<button class="text-button" type="button" data-pause="${escapeHtml(m.id)}" data-side="0">Тех. пауза: ${escapeHtml(m.teams[0])}</button>
         <button class="text-button" type="button" data-pause="${escapeHtml(m.id)}" data-side="1">Тех. пауза: ${escapeHtml(m.teams[1])}</button>`}
      </div>` : ''}
    </article>`;
  }).join('');
}
$('lobbyMatches').addEventListener('click', event => {
  const pauseBtn = event.target.closest('[data-pause]');
  const resumeBtn = event.target.closest('[data-resume]');
  if (pauseBtn) {
    const match = lobby.matches.get(pauseBtn.dataset.pause);
    if (!match) return;
    const team = Number(pauseBtn.dataset.side);
    lobby.pauses.set(match.id, { team, start: Date.now() });
    log(`Тех. пауза: ${match.teams[team]} (${match.teams[0]} vs ${match.teams[1]})`, 'pause');
  } else if (resumeBtn) {
    const match = lobby.matches.get(resumeBtn.dataset.resume), pause = lobby.pauses.get(resumeBtn.dataset.resume);
    if (!match || !pause) return;
    lobby.pauses.delete(match.id);
    log(`Пауза ${match.teams[pause.team]} закончилась через ${duration(Date.now() - pause.start)}`, 'pause');
  } else return;
  renderMatches();
});
setInterval(() => {
  document.querySelectorAll('#lobbyMatches time[data-since]').forEach(el => {
    el.textContent = duration(Date.now() - Number(el.dataset.since));
  });
}, 1000);

function handle(event) {
  const text = eventText(event);
  if (!text) return;
  if (event.type === 'start' || event.type === 'resumed') return log(text, 'start');
  log(text, event.type === 'paused' ? 'pause' : event.type === 'final' ? 'match' :
    event.type === 'mappoint' ? 'map' : event.type);
  if (event.type === 'match' || event.type === 'final') {
    lobby.finished = event.match;
    lobby.pauses.delete(event.match.id);
    renderMessages();
    finalScores(event.match);
  }
  if (['map', 'match', 'paused'].includes(event.type)) {
    alertAdmins(text, `${event.match.id}:${event.type}:${event.map || ''}`);
  } else if (event.type === 'mappoint') {
    alertAdmins(text, `${event.match.id}:point:${event.map}`, { loud: false });
  }
}
// Round scores per map come from /stats once FACEIT has them.
async function finalScores(match) {
  try {
    const scores = mapScores(await lobby.client.stats(match.id), match.teams);
    if (!scores.length) return;
    match.mapScores = scores;
    log(`Карты ${match.teams[0]} vs ${match.teams[1]}: ${scores.join(', ')}`, 'match');
    renderMessages();
  } catch { /* the series score is already in the journal */ }
}

async function poll() {
  const client = lobby.client, champ = lobby.champ, rooms = lobby.rooms || [];
  if (!client || (!champ && !rooms.length)) return;
  const full = lobby.tick++ % 3 === 0;
  try {
    // Each request stands alone: one refused list must not hide the others.
    const results = await Promise.allSettled([
      champ ? client.matches(champ, 'ongoing', 20) : null,
      champ && full ? client.matches(champ, 'upcoming', 20) : null,
      champ && full ? client.matches(champ, 'past', 10) : null,
      ...rooms.map(id => client.match(id))
    ]);
    if (client !== lobby.client) return;
    const failed = results.find(r => r.status === 'rejected')?.reason;
    const answered = results.filter(r => r.status === 'fulfilled' && r.value);
    if (failed && !answered.length) throw failed;
    const seen = new Map();
    for (const raw of answered.flatMap(r => r.value).filter(Boolean)) {
      const m = summarizeMatch(raw);
      if (m.id) seen.set(m.id, m);
    }
    // A live match that left the "ongoing" list has ended: ask for its result.
    for (const [id, before] of lobby.matches) {
      if (before.live && !seen.has(id)) {
        try { seen.set(id, summarizeMatch(await client.match(id))); } catch { /* next poll */ }
        if (client !== lobby.client) return;
      }
    }
    if (client !== lobby.client) return;
    for (const [id, after] of seen) {
      matchEvents(lobby.matches.get(id), after).forEach(handle);
      lobby.matches.set(id, after);
    }
    if (!lobby.finished) {
      lobby.finished = [...lobby.matches.values()].filter(m => m.status === 'FINISHED')
        .sort((x, y) => (y.finishedAt || 0) - (x.finishedAt || 0))[0] || null;
    }
    lobby.interval = POLL;
    const live = [...lobby.matches.values()].filter(m => m.live).length;
    const soon = [...lobby.matches.values()].filter(m => !m.live && !m.done).length;
    $('lobbyStatus').textContent = `Обновлено ${clock(Date.now())} · идут: ${live} · впереди: ${soon} · проверка каждые ${POLL / 1000} с`;
    $('lobbyError').textContent = failed ? `Часть запросов FACEIT не прошла: ${failed.message}` : '';
    $('lobbyError').hidden = !failed;
    renderMatches();
    renderMessages();
  } catch (error) {
    if (client !== lobby.client) return;
    $('lobbyError').textContent = error.message + (champ && !rooms.length && /ошибкой 4\d\d/.test(error.message) ?
      ' Если FACEIT не отдаёт турнир, вставь ссылку на комнату матча (faceit.com/…/room/1-…): лобби будет следить за матчем напрямую.' : '');
    $('lobbyError').hidden = false;
    if (/реже/.test(error.message)) lobby.interval = Math.min(lobby.interval * 2, 120000);
  } finally {
    if (client === lobby.client) {
      clearTimeout(lobby.timer);
      lobby.timer = setTimeout(poll, lobby.interval);
    }
  }
}

function start() {
  const { url, key } = read(STORE, {});
  const target = parseFaceitTargets(url);
  clearTimeout(lobby.timer);
  lobby.client = null;
  lobby.champ = '';
  lobby.rooms = [];
  lobby.matches = new Map();
  lobby.tick = 0;
  if (!target) return renderMatches();
  lobby.client = new FaceitClient(key, undefined, { proxy: new URL(FACEIT_PROXY, location.origin).href });
  lobby.champ = target.champ;
  lobby.rooms = target.rooms;
  $('lobbyStatus').textContent = target.champ ? 'Подключаем турнир…' : 'Подключаем матч…';
  poll();
}

$('lobbyForm').addEventListener('submit', event => {
  event.preventDefault();
  unlockAudio();
  const url = $('faceitUrl').value.trim(), key = $('faceitKey').value.trim();
  if (!parseFaceitTargets(url)) {
    $('lobbyError').textContent = 'Не похоже на ссылку FACEIT: нужна ссылка на турнир (faceit.com/…/championship/<id>/…) или на комнату матча (faceit.com/…/room/1-…).';
    $('lobbyError').hidden = false;
    return;
  }
  write(STORE, { ...read(STORE, {}), url, key });
  log('Слежение за турниром включено', 'start');
  start();
});
$('notifyBtn').addEventListener('click', async () => {
  unlockAudio();
  $('notifyBtn').disabled=true;
  try {
    const permission=await enableNotifications();
    if(permission==='granted'){
      const shown=await showNotification('Oneshot · Проверка','Уведомления включены. Здесь будут концы карт и матчей, а также вызовы капитанов.',{tag:'oneshot-notification-test',requireInteraction:false});
      $('notifyStatus').textContent=shown ? 'Тестовое уведомление отправлено. Если оно не появилось, проверь настройки уведомлений браузера в системе и режим «Не беспокоить».' : 'Браузер не смог показать уведомление. Проверь разрешение для сайта и системные настройки уведомлений.';
    }else $('notifyStatus').textContent=permission==='denied' ? 'В настройках этого сайта в браузере разреши «Уведомления», затем нажми кнопку ещё раз.' : 'Разрешение не выдано. Нажми «Включить уведомления» и разреши их в запросе браузера.';
  }catch{$('notifyStatus').textContent='Не удалось включить уведомления. Проверь разрешение для этого сайта в браузере.';}
  finally{notifyState();}
});
$('soundBtn').addEventListener('click', () => { unlockAudio(); beep(); });
$('lobbyAck').addEventListener('click', acknowledge);
$('copyThanks').addEventListener('click', () => $('msgThanks').value && panel.copy($('msgThanks').value));
$('copyNext').addEventListener('click', () => $('msgNext').value && panel.copy($('msgNext').value));
$('nextMatch').addEventListener('change', renderMessages);
for (const id of ['tplThanks', 'tplNext', 'nextDelay']) $(id).addEventListener('input', saveTemplates);
$('resetTemplates').addEventListener('click', () => {
  write(STORE, { ...read(STORE, {}), templates: { ...DEFAULT_TEMPLATES } });
  fillTemplatesForm();
  renderMessages();
});
$('copyJournal').addEventListener('click', () => {
  const entries = read(LOG_STORE, []);
  if (entries.length) panel.copy(entries.slice().reverse().map(e => `${clock(e.at)} · ${e.text}`).join('\n'));
});
// Any click on the page lets the alert sound play later (browser autoplay rules).
addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('oneshot:view', event => {
  lobby.view = event.detail;
  if (lobby.view === 'lobby') { lobby.unread = 0; }
  badge();
});
window.addEventListener('oneshot:open-lobby', () => document.getElementById('viewLobby')?.click());
document.addEventListener('oneshot:change', renderMessages);

lobby.view = $('viewLobby').getAttribute('aria-selected') === 'true' ? 'lobby' : 'prep';
const saved = read(STORE, {});
$('faceitUrl').value = saved.url || '';
$('faceitKey').value = saved.key || '';
fillTemplatesForm();
notifyState();
renderLog();
renderMatches();
renderMessages();
start();
