import { ObsClient, OBS_DEFAULT_URL, applyMatch, emitVeto } from './obs.js';
import { VdoLink, bridgeSecrets, normalizeCode } from './vdo.js';

// The OBS dock: receives sealed commands from the panel over VDO.Ninja and
// runs them against this computer's obs-websocket.
const $ = id => document.getElementById(id);
const STORE = 'oneshot-obs-bridge';
let link = null, obs = null, panelSeen = 0, presence;

function read() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
function save(value) {
  try { localStorage.setItem(STORE, JSON.stringify(value)); } catch { /* not kept */ }
}
function status(id, text, kind) {
  $(id).textContent = text;
  $(id + 'Dot').className = kind || '';
}
function log(text, kind = '') {
  const item = document.createElement('li');
  item.className = kind;
  item.textContent = `${new Date().toLocaleTimeString('ru-RU')} · ${text}`;
  $('dockLog').prepend(item);
  while ($('dockLog').children.length > 20) $('dockLog').lastChild.remove();
}

// One connection, shared by commands that arrive while it is still opening.
let connecting = null;
function connectObs() {
  if (obs?.socket && connecting) return connecting;
  const { url, password } = read();
  obs = new ObsClient(url || OBS_DEFAULT_URL, password || '');
  const client = obs;
  connecting = client.connect().then(() => {
    status('dockObs', `OBS: подключён${client.version ? ` · WebSocket ${client.version}` : ''}`, 'good');
    announce();
    return client;
  }, error => {
    if (obs === client) { obs = null; connecting = null; }
    status('dockObs', error.message, 'bad');
    announce();
    throw error;
  });
  return connecting;
}

async function handle(message) {
  panelSeen = Date.now();
  status('dockPanel', 'Панель: на связи', 'good');
  if (!message || typeof message !== 'object' || typeof message.id !== 'string') return;
  const reply = extra => link.send({ type: 'result', id: message.id, ...extra });
  try {
    if (message.type === 'hello') {
      await connectObs().catch(() => {});
      return reply({ ok: !!obs, obs: $('dockObs').textContent });
    }
    const client = await connectObs();
    if (message.type === 'apply') {
      const summary = await applyMatch(client, message.match);
      log(`Матч отправлен: ${message.title || 'без названия'}`, 'good');
      return reply({ ok: true, summary });
    }
    if (message.type === 'veto') {
      await emitVeto(client, message.state);
      return reply({ ok: true });
    }
    reply({ ok: false, error: 'Неизвестная команда.' });
  } catch (error) {
    log(error.message, 'bad');
    reply({ ok: false, error: error.message });
  }
}

// Lets the panel show whether this OBS is reachable without sending a match.
function announce() {
  link?.send({ type: 'presence', obs: $('dockObs').textContent, ok: !!obs?.socket });
}

async function start() {
  const settings = read();
  link?.close();
  link = null;
  clearInterval(presence);
  if (!normalizeCode(settings.code)) {
    status('dockPanel', 'Панель: вставь код связи', '');
    return;
  }
  const secrets = await bridgeSecrets(settings.code);
  link = new VdoLink(secrets, 'dock', handle, peers => {
    if (!peers && Date.now() - panelSeen > 30000) status('dockPanel', 'Панель: ждём', '');
  });
  status('dockPanel', 'Панель: ждём', '');
  connectObs().catch(() => {});
  presence = setInterval(announce, 10000);
}

const fromHash = normalizeCode(new URLSearchParams(location.hash.slice(1)).get('k'));
const initial = read();
if (fromHash && fromHash !== initial.code) save({ ...initial, code: fromHash });
const current = read();
$('dockCode').value = current.code || '';
$('dockUrl').value = current.url || OBS_DEFAULT_URL;
$('dockPassword').value = current.password || '';
$('dockForm').addEventListener('submit', event => {
  event.preventDefault();
  const code = normalizeCode($('dockCode').value);
  if (!code) return log('Код связи: 16 букв и цифр из панели.', 'bad');
  save({ code, url: $('dockUrl').value.trim() || OBS_DEFAULT_URL, password: $('dockPassword').value });
  obs?.close();
  obs = null;
  connecting = null;
  log('Настройки сохранены');
  start();
});
start();
