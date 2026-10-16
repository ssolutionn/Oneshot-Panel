// Site-only additions to the panel: the Подготовка/Лобби tabs, sending the
// match to OBS (directly or through the OBS dock), copying the JSON, webcam
// status from VDO.Ninja and the live veto overlay. app.js keeps working
// without this file (the Claude artifact has none of it).
import { buildObs, DEFAULT_CARD_BASE } from './core.js';
import { ObsClient, OBS_DEFAULT_URL, applyMatch, emitVeto } from './obs.js';
import { VdoLink, CamWatch, bridgeSecrets, newBridgeCode, normalizeCode } from './vdo.js';
import { mountQrReader, parseObsQr, parsePairingQr } from './assets/obs-qr.js';

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
const views = [['prep', 'viewPrep', 'prepView'], ['lobby', 'viewLobby', 'lobbyView']];
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
showView(location.hash === '#lobby' ? 'lobby' : read(VIEW_STORE) === 'lobby' ? 'lobby' : 'prep');

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
    bridge.waiting.set(id, reply => {
      clearTimeout(timer);
      bridge.waiting.delete(id);
      reply.ok ? resolve(reply) : reject(new Error(reply.error || 'OBS не принял команду.'));
    });
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
function openObsSettings() {
  showView('prep');
  const section = $('obsDialog');
  section.open = true;
  section.scrollIntoView({ block: 'start' });
  const direct = document.querySelector('input[name=obsMode]:checked')?.value === 'direct';
  $(direct ? 'obsUrl' : 'copyDockUrl').focus({ preventScroll: true });
}
$('obsSetupBtn').addEventListener('click', openObsSettings);
$('obsNavBtn').addEventListener('click', openObsSettings);
$('closeObs').addEventListener('click', () => {
  $('obsDialog').open = false;
  $('obsDialog').querySelector('summary').focus({ preventScroll: true });
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
let vetoLink = null, vetoOpening = null, vetoTimer, lastVeto = '', vetoId = '', vetoAck = '', vetoSeen = 0, vetoSending = false;
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
function ensureVetoLink() {
  if (vetoLink) return Promise.resolve(vetoLink);
  if (vetoOpening) return vetoOpening;
  vetoOpening = bridgeSecrets(vetoCode).then(secrets => {
    if (!$('vetoLive').checked) return null;
    vetoLink = new VdoLink(secrets, 'dock', message => {
      if (message.type !== 'veto-received' || message.id !== vetoId) return;
      vetoAck = message.id;
      vetoSeen = Date.now();
      paintVetoStatus();
    });
    return vetoLink;
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
  panel.copy(`${cardBase()}/assets/veto-overlay/overlay.html?layout=${$('vetoLayout').value}${$('vetoLayout').value === 'strip' ? '&crop=1' : ''}#s=${encodeState(vetoState())}&r=${vetoCode}`);
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
  }
  sendVeto();
});
async function flushVeto() {
  if (!$('vetoLive').checked || vetoSending) return;
  vetoSending = true;
  let sentKey = null;
  try {
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
}
// The captains' veto site (veto.html) opens with this match's teams and format.
function playerVetoLink(s) {
  const params = new URLSearchParams({ a: s.a?.name || '', b: s.b?.name || '', f: s.veto.format });
  $('playerVeto').href = '/veto.html#new&' + params;
}
document.addEventListener('oneshot:change', onChange);
fillObsDialog();
$('obsDialog').open = !obsSettings().configured || !!importedPairCode;
function revealPairing() {
  fillObsDialog();
  showView('prep');
  $('obsDialog').open = true;
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
