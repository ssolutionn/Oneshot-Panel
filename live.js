// Site-only additions to the panel: the Подготовка/Лобби tabs, sending the
// match to OBS (directly or through the OBS dock), copying the JSON, webcam
// status from VDO.Ninja and the live veto overlay. app.js keeps working
// without this file (the Claude artifact has none of it).
import { buildObs, DEFAULT_CARD_BASE } from './core.js';
import { ObsClient, OBS_DEFAULT_URL, applyMatch, emitVeto } from './obs.js';
import { VdoLink, CamWatch, bridgeSecrets, newBridgeCode, normalizeCode } from './vdo.js';
import { mountQrReader, parseObsQr, parsePairingQr } from './assets/obs-qr.js';
import { createRoom, captainMessage, spectatorMessage, nextTurn, clock, formatClock, resultText } from './veto-room.js';
import { RoomWatch, adminRoom, roomToPanel, roomMoves } from './veto-watch.js';
import { ServerDisplayLink } from './assets/veto-relay-links.js';
import { checkRelay } from './assets/veto-relay-client.js';
import { relayEndpoint } from './assets/veto-relay-protocol.js';

const $ = id => document.getElementById(id);
const panel = window.oneshotPanel;
const OBS_STORE = 'oneshot-obs', VIEW_STORE = 'oneshot-view', CAMS_STORE = 'oneshot-watch-cams';

function read(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not kept */ }
}
const cardBase = () => /^https?:$/.test(location.protocol) ? location.origin : DEFAULT_CARD_BASE;

// ---------- tabs ----------
const views = [['prep', 'viewPrep', 'prepView'], ['veto', 'vetoNavBtn', 'vetoView'], ['lobby', 'viewLobby', 'lobbyView'],
  ['obs', 'obsNavBtn', 'obsView'], ['bookies', 'bookiesNavBtn', 'bookiesView']];
// On the site the panel's veto has a tab of its own, under the captains' room
// (the Claude artifact keeps it on the one page).
$('cvLive').after($('veto'));
export function showView(name, focus = false) {
  for (const [view, tab, pane] of views) {
    const on = view === name;
    $(tab).classList.toggle('active', on);
    $(tab).setAttribute('aria-selected', String(on));
    $(tab).tabIndex = on ? 0 : -1;
    $(pane).hidden = !on;
    if (on && focus) $(tab).focus();
  }
  write(VIEW_STORE, name);
  document.dispatchEvent(new CustomEvent('oneshot:view', { detail: name }));
}
for (const [view, tab] of views) {
  $(tab).addEventListener('click', () => showView(view));
  $(tab).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = views.findIndex(v => v[0] === view);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length;
    showView(views[next][0], true);
  });
}
const startView = location.hash.slice(1) || read(VIEW_STORE);
showView(views.some(v => v[0] === startView) ? startView : 'prep');

// ---------- match payload ----------
function matchPayload() {
  const s = panel.snapshot();
  if (s.matchError) throw new Error(s.matchError);
  const players = [
    ...s.playersA.map(p => ({ ...p, team: s.a.name })),
    ...s.playersB.map(p => ({ ...p, team: s.b.name }))
  ].map((p, i) => ({ slot: i + 1, team: p.team, nick: p.nick, id: p.id, room: p.room, password: p.password || '' }));
  return { title: `${s.a.name} vs ${s.b.name}`, match: { players, includeCards: s.includeCards, cardBase: cardBase() } };
}
function obsJson() {
  const s = panel.snapshot();
  if (!s.template) throw new Error(s.templateError || 'Шаблон OBS ещё загружается.');
  return JSON.stringify(buildObs(s.template, s.a, s.b, s.keysA, s.keysB, undefined,
    { includeCards: s.includeCards, cardBase: cardBase() }), null, 2) + '\n';
}

// ---------- OBS link ----------
function consumePairingHash() {
  if (!new URLSearchParams(location.hash.slice(1)).has('obs')) return '';
  let code = '';
  try { code = parsePairingQr(location.href, cardBase()); } catch { /* leave existing settings intact */ }
  // Pairing codes belong in the fragment, and are consumed before other links are copied.
  history.replaceState(null, '', location.pathname + location.search);
  if (code) write(OBS_STORE, { ...(read(OBS_STORE) || {}), mode: 'bridge', code });
  return code;
}
const importedPairCode = consumePairingHash();

function obsSettings() {
  const saved = read(OBS_STORE) || {};
  const code = normalizeCode(saved.code) || newBridgeCode();
  const settings = {
    mode: saved.mode === 'direct' ? 'direct' : 'bridge', code,
    url: saved.url || OBS_DEFAULT_URL, password: saved.password || '', configured: !!saved.mode
  };
  if (saved.code !== code) write(OBS_STORE, { ...saved, code });
  return settings;
}
const bridge = { link: null, opening: null, code: '', opened: 0, seen: 0, obsOk: false, obsText: '', waiting: new Map() };

function obsBadge(text, kind) {
  $('obsState').textContent = text;
  $('obsConnectionState').textContent = text;
  $('obsConnectionState').dataset.kind = kind || '';
  $('obsDot').className = kind || '';
  $('obsTabDot').dataset.kind = kind || '';
}
// Step 2 of «У обсервера»: says in plain words whether the Oneshot window
// in the observer's OBS (the dock) is reachable and has its OBS connected.
function bridgeStatus(settings) {
  const line = $('obsBridgeStatus');
  let text, kind = '';
  if (!settings.configured || settings.mode !== 'bridge') {
    text = 'Сначала отправь обсерверу сообщение из шага 1.';
  } else if (Date.now() - bridge.seen >= 25000) {
    text = Date.now() - bridge.opened < 15000 ? 'Ищем окно Oneshot у обсервера…' :
      'Ждём обсервера: окно Oneshot в его OBS ещё не открыто. Как только он сделает пункты из сообщения, здесь станет зелёным.';
    kind = 'bad';
  } else if (!bridge.obsOk) {
    text = `Окно Oneshot у обсервера открыто ✓, но OBS к нему не подключён${bridge.obsText ? ` (${bridge.obsText})` : ''}. Обсервер должен вписать пароль WebSocket в окне Oneshot и нажать «Подключить» — или впиши его сам ниже.`;
    kind = 'bad';
    if (!bridge.remoteShown) { bridge.remoteShown = true; $('obsRemoteBox').open = true; }
  } else {
    text = 'Всё подключено ✓ Можно жать «Отправить в OBS».';
    kind = 'good';
  }
  line.textContent = text;
  line.dataset.kind = kind;
}
function renderObsState() {
  const settings = obsSettings();
  bridgeStatus(settings);
  if (!settings.configured) return obsBadge('OBS не настроен', '');
  if (settings.mode === 'direct') return obsBadge('OBS на этом компьютере', '');
  const fresh = Date.now() - bridge.seen < 25000;
  if (!fresh) return obsBadge('Док OBS не на связи', 'wait');
  obsBadge(bridge.obsOk ? 'Док OBS на связи' : 'Док на связи, OBS не подключён', bridge.obsOk ? 'good' : 'bad');
}
async function ensureBridge() {
  const settings = obsSettings();
  if (settings.mode !== 'bridge' || !settings.configured) {
    bridge.link?.close();
    bridge.link = null;
    bridge.code = '';
    return null;
  }
  if (bridge.link && bridge.code === settings.code) return bridge.link;
  if (bridge.opening && bridge.code === settings.code) return bridge.opening;
  bridge.link?.close();
  bridge.link = null;
  bridge.code = settings.code;
  bridge.seen = 0;
  bridge.opened = Date.now();
  const opening = bridgeSecrets(settings.code).then(secrets => {
    if (bridge.code !== settings.code || obsSettings().mode !== 'bridge') return null;
    bridge.link = new VdoLink(secrets, 'panel', message => {
    if (message.type === 'presence' || message.type === 'result') {
      bridge.seen = Date.now();
      if (message.type === 'presence') {
        bridge.obsOk = !!message.ok;
        bridge.obsText = String(message.obs || '');
      }
    }
    if (message.type === 'result') {
      // A command that went through proves OBS answers on the dock's side.
      if (message.ok) bridge.obsOk = true;
      bridge.waiting.get(message.id)?.(message);
    }
    renderObsState();
    });
    return bridge.link;
  }).finally(() => { if (bridge.opening === opening) bridge.opening = null; });
  bridge.opening = opening;
  return opening;
}
setInterval(renderObsState, 5000);

async function obsCommand(message, timeout = 30000) {
  const settings = obsSettings();
  if (!settings.configured) throw new Error('Сначала настрой связь с OBS.');
  if (settings.mode === 'direct') {
    const client = await new ObsClient(settings.url, settings.password).connect();
    try {
      if (message.type === 'apply') return { ok: true, summary: await applyMatch(client, message.match) };
      if (message.type === 'veto') { await emitVeto(client, message.state); return { ok: true }; }
      return { ok: true, obs: `OBS подключён${client.version ? ` · WebSocket ${client.version}` : ''}` };
    } finally { client.close(); }
  }
  const link = await ensureBridge();
  if (!link) throw new Error('Настройки подключения изменились. Повтори команду.');
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.waiting.delete(id);
      reject(new Error(Date.now() - bridge.seen < 25000 ?
        'Док OBS не ответил вовремя. Попробуй ещё раз или скачай JSON.' :
        'Окно Oneshot у обсервера не на связи: он должен сделать пункты из сообщения (шаг 1). Пока можно скачать JSON.'));
    }, timeout);
    // Sent again every 3 s until the dock answers: a command sent while the
    // link was still connecting is not lost (the dock runs each id once).
    const resend = setInterval(() => link.send({ ...message, id }), 3000);
    bridge.waiting.set(id, reply => {
      clearTimeout(timer);
      clearInterval(resend);
      bridge.waiting.delete(id);
      reply.ok ? resolve(reply) : reject(new Error(reply.error || 'OBS не принял команду.'));
    });
    const stop = () => clearInterval(resend);
    setTimeout(stop, timeout);
    link.send({ ...message, id });
  });
}

function fillObsDialog() {
  const settings = obsSettings();
  for (const input of document.querySelectorAll('input[name=obsMode]')) input.checked = input.value === settings.mode;
  $('obsUrl').value = settings.url;
  $('obsPassword').value = settings.password;
  fillObsLink(settings.code);
  toggleObsFields();
  $('obsTestResult').textContent = '';
  $('obsTestResult').className = 'obs-test';
}
// What the admin sends the observer: the link and the three clicks in OBS.
function dockMessage(url) {
  return [
    'Нужно один раз добавить в OBS окно Oneshot — через него мы отправляем камеры и матч в твой OBS.',
    '',
    '1. OBS → Док-панели → Пользовательские док-панели браузера (Docks → Custom Browser Docks).',
    `2. Имя: Oneshot. Адрес: ${url} → Применить.`,
    '3. В появившемся окне Oneshot впиши пароль WebSocket и нажми «Подключить». Пароль: OBS → Сервис → Настройки сервера WebSocket → включить сервер → «Показать сведения о подключении».',
    '',
    'Окно Oneshot не закрывай до конца эфира.'
  ].join('\n');
}
function fillObsLink(code) {
  const url = `${cardBase()}/obs-bridge.html#k=${code}`;
  $('obsCode').textContent = code;
  $('obsDockUrl').value = url;
  $('obsDockMessage').value = dockMessage(url);
}
function toggleObsFields() {
  const direct = document.querySelector('input[name=obsMode]:checked')?.value === 'direct';
  $('obsDirectFields').hidden = !direct;
  $('obsBridgeFields').hidden = direct;
}
function saveObsDialog() {
  const mode = document.querySelector('input[name=obsMode]:checked')?.value === 'direct' ? 'direct' : 'bridge';
  const code = obsSettings().code;
  write(OBS_STORE, {
    mode, code,
    url: $('obsUrl').value.trim() || OBS_DEFAULT_URL, password: $('obsPassword').value
  });
  fillObsLink(code);
  ensureBridge().catch(() => {});
  renderObsState();
}
// «OBS» is a tab of its own: the form on top, the step-by-step guide below.
function openObsSettings() {
  showView('obs');
  $('obsDialog').scrollIntoView({ block: 'start' });
  const direct = document.querySelector('input[name=obsMode]:checked')?.value === 'direct';
  $(direct ? 'obsUrl' : 'copyDockUrl').focus({ preventScroll: true });
}
$('obsSetupBtn').addEventListener('click', openObsSettings);
$('closeObs').addEventListener('click', () => {
  showView('prep', true);
  $('exportBar').scrollIntoView({ block: 'center' });
});
for (const input of document.querySelectorAll('input[name=obsMode]')) input.addEventListener('change', () => {
  toggleObsFields();
  $('obsTestResult').textContent = '';
  $('obsTestResult').className = 'obs-test';
});
// Handing out the dock link means OBS is on another computer: start
// listening for that dock right away so step 2 shows when it appears.
function useBridge() {
  if (obsSettings().configured && obsSettings().mode === 'bridge') return;
  saveObsDialog();
}
$('copyDockUrl').addEventListener('click', () => {
  useBridge();
  panel.copy($('obsDockMessage').value);
});
if (navigator.share) {
  $('shareDockUrl').hidden = false;
  $('shareDockUrl').addEventListener('click', () => {
    useBridge();
    navigator.share({
      title: 'Окно Oneshot для OBS',
      text: $('obsDockMessage').value
    }).catch(() => {});
  });
}
function pairWith(code) {
  write(OBS_STORE, { ...(read(OBS_STORE) || {}), mode: 'bridge', code });
  fillObsDialog();
  ensureBridge().catch(() => {});
  renderObsState();
}
// These fields sit inside #obsForm: Enter must not save the old settings.
for (const [field, button] of [['obsCodeInput', 'applyObsCode'], ['obsRemotePassword', 'sendObsConfig'], ['obsRemotePort', 'sendObsConfig']]) {
  $(field).addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    $(button).click();
  });
}
$('applyObsCode').addEventListener('click', () => {
  const code = normalizeCode($('obsCodeInput').value);
  if (!code) return panel.toast('Код связи — 16 букв и цифр, как в окне Oneshot: XXXX-XXXX-XXXX-XXXX.');
  $('obsCodeInput').value = '';
  pairWith(code);
  panel.toast('Код подставлен — смотри статус в шаге 2');
});
$('newObsCode').addEventListener('click', () => {
  if (!confirm('Новый код отключит текущий док OBS. Сменить?')) return;
  write(OBS_STORE, { ...(read(OBS_STORE) || {}), code: newBridgeCode() });
  fillObsLink(obsSettings().code);
  ensureBridge().catch(() => {});
});
$('obsForm').addEventListener('submit', event => {
  event.preventDefault();
  saveObsDialog();
  $('obsTestResult').className = 'obs-test';
  $('obsTestResult').textContent = 'Настройки сохранены. Нажми «Проверить связь», чтобы убедиться, что OBS отвечает.';
  panel.toast('Связь с OBS сохранена');
});
$('testObs').addEventListener('click', async () => {
  const button = $('testObs');
  button.disabled = true;
  saveObsDialog();
  $('obsTestResult').className = 'obs-test';
  $('obsTestResult').textContent = 'Проверяем…';
  try {
    const reply = await obsCommand({ type: 'hello' }, 15000);
    $('obsTestResult').textContent = reply.obs || 'OBS на связи.';
    $('obsTestResult').className = 'obs-test ' + (reply.ok ? 'good' : 'bad');
  } catch (error) {
    $('obsTestResult').textContent = error.message;
    $('obsTestResult').className = 'obs-test bad';
  } finally {
    button.disabled = false;
  }
});

mountQrReader($('obsPairQr'), {
  title: 'Заполнить по QR',
  hint: 'QR «Подключить телефон» из окна Oneshot у обсервера подключит этот сайт к нему (его можно открыть и обычной камерой телефона). QR из OBS («Показать сведения о подключении», можно скриншотом) подставит порт и пароль.',
  onRead(text) {
    if (/^\s*obsws:/i.test(text)) {
      const settings = parseObsQr(text);
      $('obsRemotePort').value = /:(\d+)$/.exec(settings.url)?.[1] || '4455';
      $('obsRemotePassword').value = settings.password;
      $('obsRemoteBox').open = true;
      return 'Порт и пароль OBS подставлены выше. Нажми «Отправить в OBS обсервера».';
    }
    let code = normalizeCode(text);
    if (!code) {
      try { code = parsePairingQr(text, cardBase()); }
      catch { throw new Error('Это не QR из окна Oneshot и не QR подключения OBS.'); }
    }
    pairWith(code);
    return 'Код связи подставлен. Смотри статус в шаге 2.';
  }
});

// Port and password of the observer's OBS, typed or scanned on this device
// (often a phone). They go to the dock sealed with the pairing code and are
// not kept here; the dock keeps them only once its OBS accepts them.
function remoteResult(text, kind = '') {
  $('obsRemoteResult').textContent = text;
  $('obsRemoteResult').className = 'obs-test ' + kind;
}
$('sendObsConfig').addEventListener('click', async () => {
  const port = $('obsRemotePort').value.trim() || '4455';
  if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) {
    return remoteResult('Порт — число от 1 до 65535, обычно 4455.', 'bad');
  }
  const button = $('sendObsConfig');
  button.disabled = true;
  saveObsDialog();
  remoteResult('Отправляем в док…');
  try {
    const reply = await obsCommand({
      type: 'obs-config', url: `ws://127.0.0.1:${+port}`, password: $('obsRemotePassword').value
    }, 20000);
    $('obsRemotePassword').value = '';
    remoteResult(reply.obs || 'Док подключился к OBS.', 'good');
  } catch (error) {
    remoteResult(error.message === 'Неизвестная команда.' ?
      'Окно Oneshot у обсервера старой версии: пусть нажмёт по нему правой кнопкой → Обновить, и повтори.' : error.message, 'bad');
  } finally {
    button.disabled = false;
  }
});

$('sendObsBtn').addEventListener('click', async () => {
  let payload;
  try { payload = matchPayload(); } catch (error) { return panel.toast(error.message); }
  if (!obsSettings().configured) {
    return openObsSettings();
  }
  const button = $('sendObsBtn');
  button.disabled = true;
  obsBadge('Отправляем в OBS…', 'wait');
  try {
    const { summary } = await obsCommand({ type: 'apply', ...payload });
    delete button.dataset.attention;
    button.title = '';
    panel.toast(`OBS обновлён: ${summary.slots} камер${summary.cards ? `, ${summary.cards} карточек` : ''}.`);
  } catch (error) {
    panel.showError(`${error.message} JSON для импорта можно скачать или скопировать рядом.`);
  } finally {
    button.disabled = !!panel.snapshot().matchError;
    renderObsState();
  }
});
// ↻ next to a player made a new stream ID: the camera in OBS still has the
// old one until the match is sent again.
document.addEventListener('oneshot:stream-id', event => {
  const s = panel.snapshot();
  const inMatch = [...s.playersA, ...s.playersB].some(p => p?.nick === event.detail?.nick);
  if (!inMatch || !obsSettings().configured) return;
  $('sendObsBtn').dataset.attention = '1';
  $('sendObsBtn').title = `У ${event.detail.nick} новая ссылка — отправь матч в OBS ещё раз`;
});
$('copyJsonBtn').addEventListener('click', () => {
  try { panel.copy(obsJson()); } catch (error) { panel.showError(error.message); }
});

// ---------- webcam status ----------
let watcher = null, live = new Set(), checking = new Set();
function camGroups(s) {
  const groups = new Map();
  for (const p of [...s.playersA, ...s.playersB]) {
    if (!p?.room || !p?.id) continue;
    const group = groups.get(p.room) || { room: p.room, password: p.password || '', ids: [] };
    group.ids.push(p.id);
    groups.set(p.room, group);
  }
  return [...groups.values()];
}
function paintCams() {
  const s = panel.snapshot();
  const on = !!watcher;
  const sides = [['a', s.playersA], ['b', s.playersB]];
  let total = 0, up = 0, pending = 0;
  for (const [side, players] of sides) {
    const card = document.querySelector(`[data-team="${side}"]`)?.closest('.team-card');
    if (!card) continue;
    let count = card.querySelector('.team-cams');
    if (!count) {
      count = document.createElement('span');
      count.className = 'team-cams';
      card.querySelector('.card-top')?.append(count);
    }
    let teamUp = 0;
    card.querySelectorAll('.player-row').forEach((row, i) => {
      const player = players[i];
      let dot = row.querySelector('.cam-dot');
      if (!dot) {
        dot = document.createElement('i');
        dot.className = 'cam-dot';
        dot.setAttribute('aria-hidden', 'true');
        row.querySelector('.slot-number')?.append(dot);
      }
      const state = !on || !player ? '' : live.has(player.id) ? 'live' : checking.has(player.id) ? 'wait' : 'off';
      dot.className = 'cam-dot ' + state;
      dot.hidden = !on;
      row.dataset.cam = state || 'none';
      if (player) total++;
      if (state === 'live') { up++; teamUp++; }
      if (state === 'wait') pending++;
    });
    count.hidden = !on;
    count.textContent = `${teamUp}/${players.filter(Boolean).length}`;
  }
  const label = $('camTotal');
  label.className = 'cam-total';
  if (!on) label.textContent = 'Статус вебок выключен';
  else if (!total) label.textContent = 'Выбери игроков';
  else if (pending) label.textContent = `Проверяем… ${up}/${total} в эфире`;
  else {
    label.textContent = up === total ? `Все вебки на месте · ${up}/${total}` : `Нет камеры: ${total - up} · ${up}/${total} в эфире`;
    label.classList.add(up === total ? 'all' : 'missing');
  }
}
function syncWatcher() {
  const s = panel.snapshot();
  if ($('watchCams').checked) {
    watcher ||= new CamWatch((nowLive, nowChecking) => {
      live = nowLive;
      checking = nowChecking;
      paintCams();
    });
    watcher.watch(camGroups(s));
  } else if (watcher) {
    watcher.stop();
    watcher = null;
    live = new Set();
    checking = new Set();
  }
  paintCams();
}
$('watchCams').checked = read(CAMS_STORE) !== false;
$('watchCams').addEventListener('change', () => {
  write(CAMS_STORE, $('watchCams').checked);
  syncWatcher();
});

// ---------- veto overlay ----------
function vetoState() {
  const s = panel.snapshot();
  const teams = [s.a?.name || '', s.b?.name || ''];
  // The snapshot assets/veto-overlay/overlay.js accepts (window.vetoOverlay.setState).
  return {
    version: 1, teams, format: s.veto.format, first: s.veto.first,
    actions: s.veto.actions, pending: s.pending || null,
    stage: (s.stage || '').trim() || 'GROUP STAGE'
  };
}
function encodeState(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const VETO_CHANNEL_STORE = 'oneshot-veto-channel';
const savedVetoCode = normalizeCode(read(VETO_CHANNEL_STORE));
const vetoCode = savedVetoCode || newBridgeCode();
write(VETO_CHANNEL_STORE, vetoCode);
let vetoLink = null, vetoOpening = null, vetoTimer, lastVeto = '', vetoId = '', vetoAck = '', vetoSeen = 0,
  vetoOpenedAt = 0, vetoSending = false;
function setVetoStatus(text, kind = '') {
  $('vetoLiveStatus').textContent = text;
  $('vetoLiveStatus').dataset.kind = kind;
}
function paintVetoStatus() {
  if (!$('vetoLive').checked) return setVetoStatus('Живое обновление выключено. Копирование ссылки включает его автоматически.');
  if (JSON.stringify(vetoState()) === lastVeto && vetoAck === vetoId && vetoSeen && Date.now() - vetoSeen < 12000) {
    return setVetoStatus('Оверлей получает вето · ' + new Date(vetoSeen).toLocaleTimeString('ru-RU'), 'good');
  }
  setVetoStatus('Ждём оверлей. В OBS добавь Источники → + → Браузер, вставь ссылку на оверлей и задай 1920 × 1080.', 'wait');
}
let vetoEndpoint = '';
function displayEndpoint() {
  const room = watchTarget()?.room;
  return room?.relay && sameMatch(room, panel.snapshot()) ? room.relay : '';
}
function ensureVetoLink() {
  const endpoint = displayEndpoint();
  if (vetoEndpoint !== endpoint) {
    vetoLink?.close(); vetoLink = null; vetoAck = ''; vetoSeen = 0; vetoOpenedAt = 0; lastVeto = '';
    vetoEndpoint = endpoint;
  }
  if (vetoLink) return Promise.resolve(vetoLink);
  if (vetoOpening) return vetoOpening;
  lastVeto = ''; vetoId = ''; vetoAck = ''; vetoSeen = 0;
  vetoOpening = bridgeSecrets(vetoCode).then(secrets => {
    if (!$('vetoLive').checked) return null;
    const receive = message => {
      if (message.type !== 'veto-received' || message.id !== vetoId) return;
      vetoAck = message.id;
      vetoSeen = Date.now();
      paintVetoStatus();
    };
    return endpoint ? ServerDisplayLink.create(vetoCode, 'dock', endpoint, receive).then(link => {
      if (!$('vetoLive').checked || endpoint !== displayEndpoint()) { link.close(); return null; }
      vetoLink = link; return link;
    }) : (vetoOpenedAt = Date.now(), vetoLink = new VdoLink(secrets, 'dock', receive));
  }).finally(() => { vetoOpening = null; });
  return vetoOpening;
}
function enableLiveVeto() {
  $('vetoLive').checked = true;
  write('oneshot-veto-live', true);
  sendVeto();
}
$('copyOverlay').addEventListener('click', () => {
  // This display-only code cannot operate OBS. Never reuse its control code.
  panel.copy(`${cardBase()}/assets/veto-overlay/overlay.html?layout=${$('vetoLayout').value}${$('vetoLayout').value === 'strip' ? '&crop=1' : ''}#s=${encodeState(vetoState())}&r=${vetoCode}&at=${Date.now()}${displayEndpoint() ? '&relay=' + encodeURIComponent(displayEndpoint()) : ''}`);
  enableLiveVeto();
});
function overlaySizeHint() {
  $('overlaySizeHint').textContent = $('vetoLayout').value === 'strip' ?
    'Источник «Браузер» в OBS: ширина 1920, высота 400. В сцене 1920 × 1080 поставь X = 0, Y = 680; верх останется под камеры и другое содержимое. Ссылку копируй с устройства, на котором кликаешь вето.' :
    'Источник «Браузер» в OBS: ширина 1920, высота 1080. Ссылку копируй с устройства, на котором кликаешь вето. Живому вето не нужен пароль OBS.';
}
$('vetoLayout').addEventListener('change', overlaySizeHint);
overlaySizeHint();
$('vetoLive').checked = !!read('oneshot-veto-live');
$('vetoLive').addEventListener('change', () => {
  write('oneshot-veto-live', $('vetoLive').checked);
  if (!$('vetoLive').checked) {
    vetoLink?.close();
    vetoLink = null;
    vetoSeen = 0;
    vetoOpenedAt = 0;
  }
  sendVeto();
});
async function flushVeto() {
  if (!$('vetoLive').checked || vetoSending) return;
  vetoSending = true;
  let sentKey = null;
  try {
    // VDO can leave an iframe present but its data channel dead. The overlay
    // acknowledges every snapshot, so a missing ACK is an objective reason to
    // rebuild only this display channel.
    if (!vetoEndpoint && vetoLink && Date.now() - Math.max(vetoSeen, vetoOpenedAt) >= 15000) {
      vetoLink.close();
      vetoLink = null;
      vetoOpenedAt = 0;
    }
    const link = await ensureVetoLink();
    if (!link || !$('vetoLive').checked) return;
    // Capture after connection setup so an older queued move cannot acquire
    // the latest revision ID or overtake a newer snapshot.
    const state = vetoState(), key = JSON.stringify(state);
    sentKey = key;
    if (key !== lastVeto) {
      lastVeto = key;
      vetoId = crypto.randomUUID();
    }
    await link.send({ type: 'veto-state', id: vetoId, state });
    paintVetoStatus();
  } catch (error) {
    setVetoStatus('Оверлей: ' + error.message + ' Повторим автоматически.', 'bad');
  } finally {
    vetoSending = false;
    if ($('vetoLive').checked && sentKey !== null && JSON.stringify(vetoState()) !== sentKey) sendVeto();
  }
}
function sendVeto() {
  clearTimeout(vetoTimer);
  if (!$('vetoLive').checked) return paintVetoStatus();
  paintVetoStatus();
  vetoTimer = setTimeout(flushVeto, 150);
}
// Replay only the current full snapshot. Late/reloaded sources recover;
// identical updates preserve ongoing transitions in the renderer.
setInterval(() => {
  paintVetoStatus();
  if ($('vetoLive').checked) flushVeto();
}, 2500);

// ---------- follow the panel ----------
function onChange() {
  const s = panel.snapshot();
  $('sendObsBtn').disabled = !!s.matchError;
  $('copyJsonBtn').disabled = !!s.matchError || !s.template;
  syncWatcher();
  sendVeto();
  playerVetoLink(s);
  captainVeto(s);
  followRoom();
  syncPanel(true);
}
// The captains' veto site (veto.html) opens with this match's teams and format.
function playerVetoLink(s) {
  const params = new URLSearchParams({ a: s.a?.name || '', b: s.b?.name || '', f: $('cvFormat').value, m: $('cvTimer').value });
  params.set('via', $('cvTransport').value === 'server' ? 'server' : 'vdo');
  $('playerVeto').href = vetoSite() + '#new&' + params;
}

// ---------- captains' veto ----------
// Links for the selected match right here: the format follows the panel's
// veto until changed in this block; the timer and the language of the
// captains' messages are remembered. The admin's link (HLTV text) stays ours.
const CV_STORE = 'oneshot-captain-veto', CV_KEEP = 6 * 3600000;
// The veto lives on a site of its own (the oneshot-veto repo): captains and
// viewers never see the panel's address.
const VETO_SITE = 'https://oneshot-veto.pages.dev/';
// Links made before the move to Pages: the room is in the #v= part, so the
// same room opens on the new address (old links keep working too).
const OLD_VETO_SITES = ['https://oneshot-veto.cyberclash.workers.dev/'];
const movedLink = link => {
  const old = OLD_VETO_SITES.find(site => String(link).startsWith(site));
  return old ? vetoSite() + String(link).slice(old.length) : link;
};
function vetoSite() {
  try {
    const url = new URL($('cvSite').value.trim() || VETO_SITE);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('https');
    url.hash = ''; url.search = '';
    return url.href;
  } catch { return VETO_SITE; }
}
const cv = { touched: false, made: null };
{
  const saved = read(CV_STORE) || {};
  $('cvSite').value = typeof saved.site === 'string' ? saved.site : '';
  if (['0', '3', '5', '7', '10', '15'].includes(String(saved.timer))) $('cvTimer').value = String(saved.timer);
  if (['en', 'ru'].includes(saved.lang)) $('cvLang').value = saved.lang;
  $('cvTransport').value = saved.transport === 'server' ? 'server' : 'vdo';
}
const cvMatch = s => s.a?.name && s.b?.name ? JSON.stringify([s.a.name, s.b.name]) : '';
function cvSave(last = read(CV_STORE)?.last) {
  write(CV_STORE, { timer: $('cvTimer').value, lang: $('cvLang').value, site: $('cvSite').value.trim(), transport: $('cvTransport').value, last });
}
function cvShow(made) {
  cv.made = made;
  const lang = $('cvLang').value, room = made.room;
  const links = Object.fromEntries(Object.entries(made.links).map(([seat, link]) => [seat, movedLink(link)]));
  $('cvNameA').textContent = room.t[0];
  $('cvNameB').textContent = room.t[1];
  $('cvMsgA').value = captainMessage(room, 0, links.a, lang);
  $('cvMsgB').value = captainMessage(room, 1, links.b, lang);
  $('cvMsgS').value = spectatorMessage(room, links.s, lang);
  $('cvMsgO').value = links.o;
  $('cvOpen').href = links.o;
  $('cvLinks').hidden = false;
  const time = new Date(made.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  cvStatus(`Ссылки для ${room.t[0]} vs ${room.t[1]} (${room.f}${room.m ? `, ${room.m} мин` : ', без таймера'}) созданы в ${time}. ` +
    `Связь: ${room.relay ? 'наш сервер' : 'VDO.Ninja'}. Новые ссылки — снова «Создать ссылки»: старые продолжат работать, но это будет другая комната.`);
}
function cvStatus(text, kind = '') {
  $('cvStatus').textContent = text;
  $('cvStatus').dataset.kind = kind;
}
function captainVeto(s) {
  if (!cv.touched && s.veto?.format) $('cvFormat').value = s.veto.format;
  const match = cvMatch(s);
  const last = read(CV_STORE)?.last;
  if (cv.made?.match === match) return;
  if (last?.match === match && match && Date.now() - last.at < CV_KEEP && last.links?.o) return cvShow(last);
  cv.made = null;
  $('cvLinks').hidden = true;
  cvStatus(match ? '' : 'Выбери матч с двумя командами — ссылки сделаем для него.');
}
$('cvFormat').addEventListener('change', () => { cv.touched = true; playerVetoLink(panel.snapshot()); });
$('cvTimer').addEventListener('change', () => { cvSave(); playerVetoLink(panel.snapshot()); });
$('cvTransport').addEventListener('change', () => { cvSave(); playerVetoLink(panel.snapshot()); });
$('cvLang').addEventListener('change', () => { cvSave(); if (cv.made) cvShow(cv.made); });
$('cvSite').addEventListener('change', () => { cvSave(); playerVetoLink(panel.snapshot()); });
$('cvCreate').addEventListener('click', async () => {
  const s = panel.snapshot();
  try {
    if (!cvMatch(s)) throw new Error('Выбери матч с двумя командами.');
    $('cvCreate').disabled = true;
    const relay = $('cvTransport').value === 'server' ? relayEndpoint('/api/veto-relay', vetoSite()) : '';
    if (relay) { cvStatus('Проверяем сервер вето…'); await checkRelay(relay); }
    const made = await createRoom(vetoSite(), [s.a.name, s.b.name], $('cvFormat').value, Number($('cvTimer').value), relay);
    if (cvMatch(panel.snapshot()) !== cvMatch(s)) throw new Error('За время подключения матч изменился. Создай ссылки для выбранного матча ещё раз.');
    const last = { match: cvMatch(s), at: Date.now(), room: made.room, links: made.links };
    cvSave(last);
    cvShow(last);
    watchSave({ pasted: null });
    followRoom();
    panel.toast('Ссылки на вето готовы: капитанам — в личку, админская — только у нас.');
  } catch (error) {
    cvStatus(error.message, 'bad');
  } finally { $('cvCreate').disabled = false; }
});
for (const button of document.querySelectorAll('[data-cv-copy]')) {
  button.addEventListener('click', () => { if ($(button.dataset.cvCopy).value) panel.copy($(button.dataset.cvCopy).value); });
}

// ---------- the captains' room, live ----------
// The panel watches the room of this match's links (or a room link pasted
// here) the way the admin's link does: who is in, the coin, every move and
// «Call admin». With «Переносить» on, each new move of the captains lands in
// the panel's veto, and so in the OBS overlay; a manual edit in the panel
// stays until the captains' next move.
const WATCH_STORE = 'oneshot-veto-watch';
const watch = { live: null, adminLink: '', pasted: false, ringing: new Map(), answered: new Set(), synced: '' };
function watchSave(patch) {
  write(WATCH_STORE, { ...(read(WATCH_STORE) || {}), ...patch });
}
// A pasted room wins over the last links made here while it is fresh. The
// room stays watched when another match is selected (a call still rings);
// its moves go to the panel only while the panel shows its teams.
function watchTarget() {
  const pasted = read(WATCH_STORE)?.pasted;
  if (pasted && Date.now() - pasted.at < CV_KEEP) {
    const found = adminRoom(pasted.link);
    if (found) return { ...found, pasted: true };
  }
  const made = read(CV_STORE)?.last;
  if (!made?.room?.r || !made.links?.o || !(Date.now() - made.at < CV_KEEP)) return null;
  const p = Array.isArray(made.room.p) ? [...made.room.p] : [null, null];
  return { room: { ...made.room, p, me: 'o' }, adminLink: movedLink(made.links.o), pasted: false };
}
function followRoom() {
  const target = watchTarget();
  if ((target?.room.r || '') !== (watch.live?.room.r || '')) {
    watch.live?.stop();
    watch.live = null;
    watch.ringing.clear();
    watch.synced = '';
    if (target) {
      const stored = read(WATCH_STORE) || {};
      watch.answered = new Set(stored.calls?.r === target.room.r ? stored.calls.ids : []);
      // «Переносить» stays as it was set for this room (after a reset, off).
      $('cvSync').checked = stored.syncOff !== target.room.r;
      const live = new RoomWatch(target.room, {
        saved: stored.log,
        onChange: () => { if (live === watch.live) roomChanged(); },
        onCall: (team, at) => { if (live === watch.live) roomCall(team, at); }
      });
      watch.live = live;
    }
  }
  watch.adminLink = target?.adminLink || '';
  watch.pasted = !!target?.pasted;
  paintWatch();
}
function roomChanged() {
  watchSave({ log: watch.live.saved() });
  syncPanel();
  paintWatch();
}
const vetoKey = v => JSON.stringify([v.format, v.first, v.pending || null,
  v.actions.map(a => [a.map, a.type, a.team, a.side || ''])]);
// fromPanel: the panel changed. Only another match (or ⇄) brings the room's
// veto back; a manual edit of the same match stays until the next move.
function syncPanel(fromPanel = false) {
  const live = watch.live;
  if (!live || !$('cvSync').checked) return;
  const s = panel.snapshot();
  const teams = [s.a?.name, s.b?.name];
  const next = roomToPanel(live.room, live.state, teams);
  const key = next ? JSON.stringify(teams) : '';
  if (fromPanel && key === watch.synced) return;
  watch.synced = key;
  if (!next || vetoKey(next) === vetoKey({ ...s.veto, pending: s.pending })) return;
  try { panel.setVeto(next); } catch (error) { panel.toast(error.message); }
}

const callTime = at => new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
let roomAudio = null;
addEventListener('pointerdown', () => {
  try { roomAudio ||= new AudioContext(); if (roomAudio.state === 'suspended') roomAudio.resume(); } catch { roomAudio = null; }
}, { once: true });
function callBeep() {
  try {
    roomAudio ||= new AudioContext();
    const now = roomAudio.currentTime;
    for (let i = 0; i < 3; i++) {
      const tone = roomAudio.createOscillator(), gain = roomAudio.createGain();
      tone.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + i * 0.35);
      gain.gain.exponentialRampToValueAtTime(0.3, now + i * 0.35 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.35 + 0.25);
      tone.connect(gain).connect(roomAudio.destination);
      tone.start(now + i * 0.35);
      tone.stop(now + i * 0.35 + 0.3);
    }
  } catch { /* no sound: the banner, the badge and the title still ring */ }
}
// A captain's «Call admin» rides their messages for two minutes: one ring per call.
function roomCall(team, at) {
  const id = `${team}:${at}`;
  if (watch.answered.has(id) || watch.ringing.has(id)) return;
  const name = watch.live.room.t[team];
  watch.ringing.set(id, { name, at: Date.now() });
  callBeep();
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Oneshot · Вето', { body: `Капитан ${name} зовёт админа`, tag: 'oneshot-veto-call' }); } catch { /* the banner is enough */ }
  }
  paintWatch();
}
$('cvAlertOk').addEventListener('click', () => {
  for (const id of watch.ringing.keys()) watch.answered.add(id);
  watch.ringing.clear();
  if (watch.live) watchSave({ calls: { r: watch.live.room.r, ids: [...watch.answered].slice(-50) } });
  paintWatch();
});
// The title blinks only while a call rings (the lobby's siren blinks it too).
const panelTitle = document.title, CALL_TITLE = '🔔 Капитан зовёт админа';
setInterval(() => {
  if (watch.ringing.size) document.title = document.title === CALL_TITLE ? panelTitle : CALL_TITLE;
  else if (document.title === CALL_TITLE) document.title = panelTitle;
}, 1000);

const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
function moveText(names, move) {
  if (move.kind === 'coin') return `Монетка — ${names[move.team]}`;
  if (move.kind === 'order') return `${names[move.team]}: первыми банят ${names[Number(move.value)]}`;
  if (move.kind === 'side') return `${names[move.team]} — ${move.value} на ${move.map}`;
  return `${names[move.team]} — ${move.kind === 'ban' ? 'BAN' : 'PICK'} ${move.value}`;
}
function paintWatch() {
  const live = watch.live;
  const [ring] = watch.ringing.values();
  $('cvAlert').hidden = !ring;
  if (ring) setText($('cvAlertText'), `🔔 Капитан ${ring.name} зовёт админа · ${callTime(ring.at)}`);
  $('vetoBadge').hidden = !watch.ringing.size;
  $('vetoBadge').textContent = watch.ringing.size ? '!' : '';
  $('cvLiveEmpty').hidden = !!live;
  $('cvRoom').hidden = !live;
  $('cvWatchStop').hidden = !watch.pasted;
  $('cvAdminOpen').hidden = !live;
  if (watch.adminLink) $('cvAdminOpen').href = watch.adminLink;
  if (!live) {
    $('cvLiveState').dataset.state = 'off';
    return setText($('cvLiveState'), 'нет комнаты');
  }
  const { room } = live, names = room.t;
  let state;
  try { state = live.state; } catch { return; }
  const turn = nextTurn(room, state);
  const online = [0, 1].map(team => live.online(team));
  for (const team of [0, 1]) {
    const card = $('cvTeam' + team);
    card.dataset.online = online[team] ? 'yes' : 'no';
    card.classList.toggle('is-turn', turn.team === team && state.coin !== null);
    setText(card.querySelector('b'), names[team]);
    setText(card.querySelector('span'), online[team] ? 'online' : 'offline');
  }
  const done = turn.kind === 'done';
  $('cvLiveState').dataset.state = done ? 'done' : online.some(Boolean) ? 'live' : 'wait';
  setText($('cvLiveState'), done ? 'вето готово' : online.every(Boolean) ? 'оба капитана здесь' :
    online.some(Boolean) ? `здесь ${names[online.indexOf(true)]}` : 'капитанов нет');
  let stage;
  if (state.coin === null) {
    stage = state.commit !== null || online.every(Boolean) ? 'Капитаны бросают монетку…' :
      `Ждём капитанов: ${names.filter((_, team) => !online[team]).join(' и ')}.`;
  } else if (turn.kind === 'order') stage = `Монетку выиграли ${names[state.coin]} — выбирают, кто банит первым.`;
  else if (turn.kind === 'side') stage = `${names[turn.team]} выбирают сторону на ${state.pending.map}.`;
  else if (done) stage = 'Вето завершено. Текст для HLTV — в вето панели ниже.';
  else stage = `Ход ${state.actions.length + 1}/6 · ${names[turn.team]} · ${turn.kind === 'ban' ? 'BAN — убирают карту' : 'PICK — выбирают карту'}`;
  if (live.conflict) stage += ` Внимание: на шаге ${live.conflict.index + 1} капитан подписал два разных хода — остался первый.`;
  setText($('cvStage'), stage);
  const minutes = room.m ?? 5, start = live.startedAt(state);
  $('cvClock').hidden = !minutes || start === null;
  if (!$('cvClock').hidden) {
    const c = clock({ startedAt: start }, Date.now(), minutes);
    const spent = done ? live.log[live.log.length - 1].at - state.startedAt : 0;
    setText($('cvClock'), done ? `вето за ${formatClock(Math.max(0, spent))}` : c.over ? 'время вышло' : formatClock(c.left));
    $('cvClock').dataset.state = done ? 'done' : c.over || c.left < 60000 ? 'low' : 'run';
  }
  const moves = roomMoves(room, live.log).map(move => {
    const li = document.createElement('li');
    const time = Object.assign(document.createElement('time'), {
      textContent: new Date(move.at).toLocaleTimeString('ru-RU'), dateTime: new Date(move.at).toISOString()
    });
    li.append(time, ' ', moveText(names, move));
    return li;
  });
  const movesKey = room.r + moves.map(li => li.textContent).join('|');
  if ($('cvMoves').dataset.key !== movesKey) {
    $('cvMoves').dataset.key = movesKey;
    $('cvMoves').replaceChildren(...moves);
  }
  const s = panel.snapshot();
  const synced = roomToPanel(room, state, [s.a?.name, s.b?.name]);
  const sameTeams = roomToPanel(room, { ...state, first: state.first ?? 0 }, [s.a?.name, s.b?.name]);
  setText($('cvSyncNote'), !$('cvSync').checked ? 'Ходы не переносятся: вето панели ведётся вручную.' :
    !sameTeams ? `В панели выбран другой матч — ходы ${names[0]} vs ${names[1]} не переносятся. Выбери этот матч в «Подготовке».` :
    !synced ? 'Ходы появятся в вето панели, как только победитель монетки выберет порядок.' :
    done ? 'Вето панели и оверлей повторяют комнату капитанов.' : 'Вето панели и оверлей идут за капитанами: каждый новый ход переносится сам.');
  $('cvSyncNote').dataset.kind = !sameTeams && $('cvSync').checked ? 'bad' : '';
  $('cvCopyResult').hidden = !done;
}
setInterval(() => { if (watch.live) paintWatch(); }, 1000);
const saveSync = () => watchSave({ syncOff: $('cvSync').checked ? null : watch.live?.room.r || null });
$('cvSync').addEventListener('change', () => {
  saveSync();
  watch.synced = '';
  syncPanel();
  paintWatch();
});
const sameMatch = (room, s) => !!roomToPanel(room, { first: 0, actions: [], pending: null }, [s.a?.name, s.b?.name]);
// «Сбросить вето» in the panel while the room's moves are carried over: the
// room would bring them back, so carrying stops (until ticked again).
$('vetoReset').addEventListener('click', () => {
  const s = panel.snapshot(), live = watch.live;
  if (!live || !$('cvSync').checked || s.veto.actions.length || s.pending || !sameMatch(live.room, s)) return;
  $('cvSync').checked = false;
  saveSync();
  paintWatch();
  panel.toast('Вето панели сброшено, ходы комнаты капитанов больше не переносятся. Новое вето капитанов — «↺ Начать вето заново».');
});
// A test or broken veto: a new room for the same teams, format and timer on
// the same veto site, new links for the captains, the panel's veto from zero.
// The captains' moves can't be undone, so the old room is simply left.
$('cvRestart').addEventListener('click', async () => {
  const live = watch.live;
  if (!live) return;
  const { room } = live;
  if (!confirm(`Начать вето ${room.t[0]} vs ${room.t[1]} заново?\n\nБудут новые ссылки — их нужно снова отправить капитанам. ` +
    'Старые ссылки панель больше не смотрит.')) return;
  $('cvRestart').disabled = true;
  try {
    const site = new URL(watch.adminLink);
    if (room.relay) await checkRelay(room.relay);
    const made = await createRoom(site.origin + site.pathname, room.t, room.f, room.m ?? 5, room.relay || '');
    const s = panel.snapshot();
    cvSave({ match: JSON.stringify(room.t), at: Date.now(), room: made.room, links: made.links });
    watchSave({ pasted: null, syncOff: null });
    if (sameMatch(room, s)) panel.setVeto({ format: room.f, first: s.veto.first, actions: [], pending: null });
    cv.made = null;
    captainVeto(panel.snapshot());
    followRoom();
    if (!$('cvLinks').hidden) $('captainVeto').scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel.toast('Новые ссылки готовы — отправь их капитанам. Вето панели с нуля.');
  } catch (error) {
    panel.toast(error.message);
  } finally { $('cvRestart').disabled = false; }
});
$('cvCopyResult').addEventListener('click', () => {
  const live = watch.live;
  if (live) panel.copy(resultText(live.room, live.state));
});
$('cvWatchGo').addEventListener('click', () => {
  const found = adminRoom($('cvWatchLink').value);
  if (!found) return panel.toast('Это не ссылка комнаты вето: нужна ссылка с …#v=…');
  watchSave({ pasted: { link: found.adminLink, at: Date.now() } });
  // A captain's link must not stay on screen: only the admin's view is kept.
  $('cvWatchLink').value = '';
  $('cvWatchMore').open = false;
  followRoom();
  panel.toast(`Следим за комнатой ${found.room.t[0]} vs ${found.room.t[1]}`);
});
$('cvWatchLink').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); $('cvWatchGo').click(); }
});
$('cvWatchStop').addEventListener('click', () => {
  watchSave({ pasted: null });
  followRoom();
});

document.addEventListener('oneshot:change', onChange);
fillObsDialog();
function revealPairing() {
  fillObsDialog();
  showView('obs');
  $('obsTestResult').textContent = 'Код связи из QR подставлен. Подключаемся к доку OBS…';
}
if (importedPairCode) revealPairing();
// Scanning a link into a tab already at "/" may only change the fragment.
window.addEventListener('hashchange', () => {
  if (!consumePairingHash()) return;
  revealPairing();
  ensureBridge().catch(() => {});
  renderObsState();
});
ensureBridge().catch(() => {});
renderObsState();
onChange();
