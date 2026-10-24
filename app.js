import {
  DEFAULT_SOURCE, decodeGviz, parseTeams, parseSchedule, scheduleDay,
  defaultLineup, lineupCandidates, roleSuffix, selectedPlayers,
  validatePlayers, validateMatch, viewUrl, directorUrl,
  newStreamId, applyStreamIds, playerLine, vdoStreamId,
  observerText, playerText, buildObs, safeFilename, validateMetadata,
  CAMERA_FRAMES, DEFAULT_CAMERA_FRAME, cameraFrame, normalizeCamera, cameraCss, cameraViewUrl,
  displayNick,
  MAP_POOL, VETO_RULES, validateVeto, appendVeto, vetoText,
  lanConfig, lanCams, lanSeat, lanTeams, lanSchedule, newLanPrefix, seatTeam, BLANK_CARD, cardKey
} from './core.js';

const $ = id => document.getElementById(id);
const state = {
  teams: [], schedule: [], a: '', b: '', keysA: [], keysB: [],
  matchKey: '', tab: 'observer', lastSync: null, stale: false,
  scheduleDay: '',
  source: { ...DEFAULT_SOURCE }, template: null, templateError: '', logos: {},
  veto: { format: 'BO3', first: 0, actions: [], matchKey: '' },
  cameras: readStorage('oneshot-camera-settings-v1') || {}, cameraFrame: DEFAULT_CAMERA_FRAME,
  camNicks: {},
  pending: null, sheetTeams: [], streamIds: {}, regenAsk: '', exporting: false
};
let toastTimer, regenTimer, refreshId = 0, controller, templatePromise;

function readStorage(key) {
  try { return JSON.parse(localStorage.getItem(key)); }
  catch { return null; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

// «Ник» каждой вебки (text field in «Эфир» and «Компы»): an override with its
// own key, so the table/roster nick stays intact for links, photos and cards.
const CAM_NICK_STORE = 'oneshot-cam-nicks-v1';
const savedCamNicks = readStorage(CAM_NICK_STORE);
state.camNicks = savedCamNicks && typeof savedCamNicks === 'object' && !Array.isArray(savedCamNicks) ?
  Object.fromEntries(Object.entries(savedCamNicks)
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => [key, value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40)])
    .filter(([, value]) => value)) : {};

const savedSource = readStorage('webcam-desk-source');
if (savedSource &&
    /^[\w-]{20,100}$/.test(savedSource.id) &&
    /^\d+$/.test(savedSource.gid)) {
  state.source = {
    id: savedSource.id, gid: savedSource.gid,
    scheduleId: /^[\w-]{20,100}$/.test(savedSource.scheduleId || '') ?
      savedSource.scheduleId : savedSource.id,
    scheduleGid: /^\d+$/.test(savedSource.scheduleGid || '') ?
      savedSource.scheduleGid : null
  };
  // The schedule used to be the roster sheet's day tab «Матчи 14.10»; the
  // organizer's sheet has every day, so that old default moves over.
  if (state.source.scheduleId === state.source.id &&
      state.source.scheduleGid === '1758299905') {
    state.source.scheduleId = DEFAULT_SOURCE.scheduleId;
    state.source.scheduleGid = DEFAULT_SOURCE.scheduleGid;
  }
}
// New stream IDs made with ↻ next to a player (core.applyStreamIds).
state.streamIds = readStorage('oneshot-stream-ids') || {};
// LAN mode (lan.js edits it): the event's own teams, cameras fixed per seat.
// The address decides (event.js, events/<slug>/event.json): an event without
// sheets (kind manual) is always LAN, any other never is.
const LAN_STORE = 'oneshot-lan-v1';
const EVENT_LAN = globalThis.oneshotEvent?.kind === 'manual';
const savedLan = readStorage(LAN_STORE);
state.lan = lanConfig(savedLan);
// The event's own webcam rooms and PCs (events/<slug>/event.json): what an event
// panel starts with, and keeps when a file or the stored data has none.
const EVENT_CAMS = EVENT_LAN ? lanCams(globalThis.oneshotEvent?.cameras) : null;
// REU is a LAN: 720p/30/H.264/5000, low latency and LAN-only until the operator
// picks otherwise. A saved choice wins over the manifest.
const EVENT_NET = globalThis.oneshotEvent?.cameras?.net;
const eventNet = EVENT_NET ? { ...EVENT_NET, mode: EVENT_NET.mode || (EVENT_LAN ? 'lan' : 'online') } :
  (EVENT_LAN ? { mode: 'lan' } : null);
const netNew = Boolean(eventNet && !savedLan?.net);
if (EVENT_LAN !== state.lan.on || (EVENT_CAMS && !state.lan.cams) || netNew) {
  state.lan = lanConfig({ ...state.lan, on: EVENT_LAN, cams: state.lan.cams || EVENT_CAMS,
    net: savedLan?.net || eventNet || state.lan.net,
    prefix: state.lan.prefix || newLanPrefix(crypto.getRandomValues(new Uint8Array(4))) });
  writeStorage(LAN_STORE, state.lan);
}
// A saved match belongs to the data source it was picked from.
function sourceTag() {
  return state.lan.on ? JSON.stringify(['lan', state.lan.prefix]) : JSON.stringify(state.source);
}
const savedMatch = readStorage('oneshot-webcam-match-v1');
const savedCameraFrame=readStorage('oneshot-camera-frame-v1');
// A LAN event's frame wins once each time the event changes it (REU: +20 px to
// spare); after that a frame picked here stays until the event changes again.
const eventCameraFrame=globalThis.oneshotEvent?.cameras?.frame;
const eventFrameNew=globalThis.oneshotEvent?.kind==='manual' && Object.hasOwn(CAMERA_FRAMES,eventCameraFrame) &&
  readStorage('oneshot-camera-frame-event')!==eventCameraFrame;
if(eventFrameNew){
  state.cameraFrame=eventCameraFrame;
  writeStorage('oneshot-camera-frame-v1',eventCameraFrame);
  writeStorage('oneshot-camera-frame-event',eventCameraFrame);
}
else if(typeof savedCameraFrame==='string' && Object.hasOwn(CAMERA_FRAMES,savedCameraFrame))state.cameraFrame=savedCameraFrame;
else if(Object.hasOwn(CAMERA_FRAMES,eventCameraFrame))state.cameraFrame=eventCameraFrame;
$('cameraFrame').value=state.cameraFrame;
if (savedMatch && savedMatch.source === sourceTag()) {
  for (const key of ['a', 'b', 'matchKey']) {
    if (typeof savedMatch[key] === 'string') state[key] = savedMatch[key];
  }
  for (const key of ['keysA', 'keysB']) {
    if (Array.isArray(savedMatch[key]) &&
        savedMatch[key].length <= 5 &&
        savedMatch[key].every(k => typeof k === 'string')) {
      state[key] = savedMatch[key];
    }
  }
  if (savedMatch.tab === 'players') state.tab = 'players';
  try {
    validateVeto(savedMatch.veto.actions,
      savedMatch.veto.format, savedMatch.veto.first);
    state.veto = savedMatch.veto;
  } catch { /* Ignore invalid stored progress. */ }
}
$('matchTime').value =
  !validateMetadata(savedMatch?.time || '', 'Матч') ?
    savedMatch.time :
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow', hour: '2-digit',
      minute: '2-digit', hourCycle: 'h23'
    }).format(new Date());
$('matchStage').value =
  typeof savedMatch?.stage === 'string' ?
    savedMatch.stage.slice(0, 100) : '';

function persist() {
  writeStorage('oneshot-webcam-match-v1', {
    source: sourceTag(),
    a: state.a, b: state.b, keysA: state.keysA, keysB: state.keysB,
    matchKey: state.matchKey, time: $('matchTime').value,
    stage: $('matchStage').value, tab: state.tab, veto: state.veto
  });
}
function toast(message, duration = 3500) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, duration);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  })[c]);
}
function applyIds() {
  // A LAN seat's stream is fixed: the new IDs saved for the sheet players stay
  // untouched (pruning them against LAN keys would lose them for good).
  const applied = state.lan.on ? { teams: state.sheetTeams } : applyStreamIds(state.sheetTeams, state.streamIds);
  state.teams = applied.teams.map(team=>({...team,players:team.players.map(player=>({
    ...player,camera:normalizeCamera(state.cameras[cameraKey(player)])
  }))}));
  if (state.lan.on) return;
  state.streamIds = applied.saved;
  writeStorage('oneshot-stream-ids', state.streamIds);
}
const CAMERA_STORE='oneshot-camera-settings-v1';
function cameraKey(player) {
  // On a LAN the framing belongs to the seat's webcam, whoever sits there: its
  // room and ID (two rooms may both have a pc1).
  if(state.lan.on)return JSON.stringify(['lan',player.room,player.id]);
  return JSON.stringify([state.source.id,state.source.gid,player.key]);
}
// A webcam's «Ник»: on a LAN it belongs to the seat (side and number), so the
// seats keep their names when the prefix changes; the event slug keeps two
// events in one browser apart. In the sheet panel it follows the player's
// camera and survives a new stream ID (↻).
function camNickKey(side, slot, player) {
  if (state.lan.on) return JSON.stringify(['seat', globalThis.oneshotEvent?.slug || '', side, slot]);
  return player ? cameraKey(player) : '';
}
function camNickValue(side, slot, player) {
  const key = camNickKey(side, slot, player);
  return key ? state.camNicks[key] || '' : '';
}
// Every webcam's own nick, or nothing (then the player's/seat's nick shows).
function withCamNicks(side, team) {
  if (!team) return team;
  const keys = state[side === 'a' ? 'keysA' : 'keysB'];
  return { ...team, players: team.players.map(p => {
    const slot = state.lan.on ? (p.seat ? Number(p.seat.slice(1)) - 1 : -1) : keys.indexOf(p.key);
    if (!(slot >= 0 && slot < 5)) return p;
    const nickname = camNickValue(side, slot, p);
    return nickname ? { ...p, nickname } : p;
  }) };
}
function setCamNick(side, slot, value) {
  if (!['a', 'b'].includes(side) || !(slot >= 0 && slot < 5)) return;
  const key = camNickKey(side, slot, chosen(side)[slot]);
  if (!key) return;
  const nick = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40);
  if (nick) state.camNicks[key] = nick; else delete state.camNicks[key];
  writeStorage(CAM_NICK_STORE, state.camNicks);
  // The input keeps its focus: only the outputs (observer text, OBS status) move.
  renderOutput();
}
let cameraEditor=null,cameraPreview=null,cameraPreviewTimer,cameraPreviewPoll,cameraPreviewCss='',cameraPreviewAck=false,cameraPreviewRequest='',cameraPreviewSequence=0;
// A LAN seat's webcam on its own («Компы»): framed before anyone sits there.
function seatPlayer(side,index) {
  const seat=lanSeat(state.lan,side,index);
  return {...seat,nick:seat.id,camera:normalizeCamera(state.cameras[cameraKey(seat)])};
}
function editorPlayer() {
  const player=!cameraEditor ? null : cameraEditor.seat ? seatPlayer(cameraEditor.side,cameraEditor.slot) :
    chosen(cameraEditor.side)[cameraEditor.slot];
  return player && cameraKey(player)===cameraEditor.key ? player : null;
}
function cameraPreviewStyle(camera) {
  // Only the video paints above our backdrop, including while VDO connects.
  const fit=cameraFrame(state.cameraFrame).fit==='contain' ? 'contain' : 'cover';
  return cameraCss(camera,fit)+'body *{visibility:hidden!important;}body video{visibility:visible!important;}';
}
function cameraPreviewLoading(loading) {
  $('cameraPreviewBox').dataset.loading=String(loading);
  $('cameraPreviewBox').parentElement.dataset.loading=String(loading);
}
function probeCameraPreview() {
  const player=editorPlayer();
  if(!player || !cameraPreview?.isConnected)return;
  const css=cameraPreviewStyle(player.camera);
  if(css!==cameraPreviewCss){
    cameraPreviewCss=css;
    cameraPreviewRequest='camera-preview-'+(++cameraPreviewSequence);
    cameraPreviewAck=false;
  }
  const target=cameraPreview.contentWindow;
  // A document's load event does not mean VDO's async API is listening yet.
  // Retry unacknowledged styles. The separate stats request is queued after
  // the style message, so its correlated reply acknowledges that ordering.
  if(!cameraPreviewAck)target?.postMessage({style:css},'https://vdo.ninja');
  target?.postMessage({getStats:true,streamID:player.id,cib:cameraPreviewRequest},'https://vdo.ninja');
}
window.addEventListener('message',event=>{
  if(!cameraPreview || event.source!==cameraPreview.contentWindow || event.origin!=='https://vdo.ninja')return;
  const data=event.data;
  if(!data || typeof data!=='object')return;
  if(data.action==='view-connection' && data.value===false){
    cameraPreviewCss='';cameraPreviewRequest='';cameraPreviewAck=false;cameraPreviewLoading(true);return;
  }
  if(!cameraPreviewRequest || data.cib!==cameraPreviewRequest || !Object.hasOwn(data,'stats'))return;
  cameraPreviewAck=true;
  const ready=data.stats && typeof data.stats==='object' && Object.values(data.stats).some(track=>
    track && typeof track==='object' && (
      [track._framesDecoded,track._decodeFrames,track.framesDecoded].some(n=>Number.isFinite(n) && n>0) ||
      (track._type==='video' || /video/i.test(track.type || '')) && Number.isFinite(track.FPS) && track.FPS>0 &&
        track._frameWidth>0 && track._frameHeight>0));
  cameraPreviewLoading(!ready);
});
function updateCameraPreview() {
  const player=editorPlayer();
  if(!player){$('cameraDialog').close();return;}
  const config=normalizeCamera(player.camera),rect=cameraFrame(state.cameraFrame);
  $('cameraRotation').value=String(config.rotation);
  $('cameraZoom').value=String(Math.round(config.zoom*100));
  $('cameraZoomValue').value=Math.round(config.zoom*100)+'%';
  $('cameraPreviewBox').dataset.rotation=String(config.rotation);
  $('cameraMirror').setAttribute('aria-pressed',String(config.mirror));
  for(const [name,value] of Object.entries({left:rect.x/1920*100,top:rect.y/1080*100,
    width:rect.width/1920*100,height:rect.height/1080*100,
    'rotated-width':rect.height/rect.width*100,'rotated-height':rect.width/rect.height*100})) {
    $('cameraPreviewBox').style.setProperty('--camera-'+name,value+'%');
  }
  if(!cameraPreviewTimer)cameraPreviewTimer=setTimeout(()=>{
    cameraPreviewTimer=null;
    probeCameraPreview();
  },50);
}
function saveCamera(patch) {
  const player=editorPlayer();
  if(!player)return;
  const stored=readStorage(CAMERA_STORE);
  state.cameras={...state.cameras,...(stored && typeof stored==='object' ? stored : {}),
    [cameraKey(player)]:normalizeCamera({...player.camera,...patch})};
  const kept=writeStorage(CAMERA_STORE,state.cameras);
  applyIds();
  render();
  updateCameraPreview();
  $('cameraSaveHint').textContent=kept ?
    `Сохранено для ${state.lan.on ? 'компа' : 'игрока'}. Настройки попадут в следующий JSON и отправку в OBS.` :
    'Настройки работают сейчас. Браузер запретил сохранение для следующего открытия.';
}
function openCamera(side,slot,seat=false) {
  const player=seat ? seatPlayer(side,slot) : chosen(side)[slot];
  if(!player)return;
  cameraEditor={side,slot,seat,key:cameraKey(player)};
  $('cameraHeading').textContent='Кадр: '+(seat ? `${side.toUpperCase()}${slot+1} · ${player.room} / ${player.id}` : getTeam(side).name+' / '+player.nick);
  $('cameraSaveHint').textContent='Предпросмотр без звука. Игрок должен включить свою вебку.';
  cameraPreview=document.createElement('iframe');
  cameraPreviewCss='';
  const preview=cameraPreview;
  cameraPreview.title='Предпросмотр камеры '+player.nick;
  cameraPreview.allow='autoplay';
  cameraPreview.referrerPolicy='no-referrer';
  const url=new URL(cameraViewUrl(player,state.cameraFrame));
  url.searchParams.set('b64css',btoa(cameraPreviewStyle(player.camera)));
  url.searchParams.set('darkmode','');url.searchParams.set('noaudio','');
  cameraPreview.src=url.href;
  cameraPreviewLoading(true);
  cameraPreview.addEventListener('load',()=>{
    if(cameraPreview===preview && preview.isConnected){
      cameraPreviewCss='';cameraPreviewRequest='';cameraPreviewAck=false;
      cameraPreviewLoading(true);
      updateCameraPreview();
    }
  });
  $('cameraPreviewBox').replaceChildren(cameraPreview);
  cameraPreviewPoll=setInterval(probeCameraPreview,1000);
  $('cameraDialog').showModal();
  updateCameraPreview();
}
$('closeCamera').addEventListener('click',()=>$('cameraDialog').close());
$('cameraDialog').addEventListener('close',()=>{
  clearTimeout(cameraPreviewTimer);
  clearInterval(cameraPreviewPoll);
  cameraPreviewTimer=null;
  cameraPreview?.remove();cameraPreview=null;cameraEditor=null;
});
$('cameraRotation').addEventListener('change',()=>saveCamera({rotation:Number($('cameraRotation').value)}));
$('cameraRotate').addEventListener('click',()=>{
  const player=editorPlayer();if(player)saveCamera({rotation:(normalizeCamera(player.camera).rotation+90)%360});
});
$('cameraMirror').addEventListener('click',()=>{
  const player=editorPlayer();if(player)saveCamera({mirror:!normalizeCamera(player.camera).mirror});
});
$('cameraReset').addEventListener('click',()=>saveCamera({rotation:0,panX:50,panY:50,zoom:1,mirror:false}));
$('cameraZoom').addEventListener('input',()=>saveCamera({zoom:Number($('cameraZoom').value)/100}));
for(const button of document.querySelectorAll('[data-camera-zoom]'))button.addEventListener('click',()=>{
  const player=editorPlayer();if(player)saveCamera({zoom:normalizeCamera(player.camera).zoom+Number(button.dataset.cameraZoom)/100});
});
for(const button of document.querySelectorAll('[data-camera-pan]')) {
  button.addEventListener('click',()=>{
    const player=editorPlayer();if(!player)return;
    const c=normalizeCamera(player.camera);
    const [axis,delta]=button.dataset.cameraPan.split(':');
    saveCamera(axis==='center' ? {panX:50,panY:50} : {[axis]:c[axis]+Number(delta)});
  });
}
$('cameraFrame').addEventListener('change',()=>{
  state.cameraFrame=Object.hasOwn(CAMERA_FRAMES,$('cameraFrame').value) ? $('cameraFrame').value : DEFAULT_CAMERA_FRAME;
  writeStorage('oneshot-camera-frame-v1',state.cameraFrame);
  renderOutput();
  if(cameraEditor)updateCameraPreview();
});
// ↻ next to a player: a new stream ID, so a leaked link stops being theirs.
// The new message for the player is copied right away.
function regenerate(side, slot) {
  const team = getTeam(side), player = chosen(side)[slot];
  if (!team || !player) return;
  state.streamIds[player.key] = { id: newStreamId(player.nick), was: player.sheetId ?? player.id };
  applyIds();
  render();
  const fresh = chosen(side)[slot];
  copy(playerLine(fresh)).then(() => toast(
    `Новая ссылка для ${fresh.nick} скопирована — отправь игроку. Старая больше не его. ` +
    'В OBS камеру обновит «Отправить в OBS» (или новый JSON).'));
  document.dispatchEvent(new CustomEvent('oneshot:stream-id', { detail: { team: team.name, nick: fresh.nick } }));
}
// ✎ next to a player: the ID the player really joined with (an old link, a
// typo), so OBS and the webcam status follow their camera. The player keeps
// their link; «вернуть» goes back to the sheet's ID. On a LAN the stream
// belongs to the seat, so there it edits the seat's own ID («Компы»).
function setStreamId(side, slot) {
  const team = getTeam(side), player = chosen(side)[slot];
  if (!team || !player) return;
  if (state.lan.on) return setSeatPush(side, slot, player);
  const typed = window.prompt(`${player.nick}: ID потока, под которым игрок зашёл в VDO.Ninja ` +
    '(то, что после push= в его ссылке):', player.id);
  if (typed === null) return;
  const id = vdoStreamId(typed);
  if (typed.trim() && !id) return toast('Не нашёл ни push=, ни ID — ничего не поменяли.');
  if (!id) return toast('Пустой ID — ничего не поменяли.');
  const was = player.sheetId ?? player.id;
  if (id === was) delete state.streamIds[player.key];
  else state.streamIds[player.key] = { id, was, manual: true };
  applyIds();
  render();
  toast(`Вебка ${player.nick}: ID ${id}. В OBS камеру обновит «Отправить в OBS» (или новый JSON).`);
  document.dispatchEvent(new CustomEvent('oneshot:stream-id', { detail: { team: team.name, nick: player.nick } }));
}
// A seat's «Кадр» follows its own stream ID: the PC is the same, only push= changed.
function moveSeatCamera(before, after) {
  if (!state.lan.on || !before?.room || !after?.room || !before.id || !after.id) return;
  const from = cameraKey(before), to = cameraKey(after);
  if (from === to || !state.cameras[from]) return;
  const cameras = { ...state.cameras, [to]: state.cameras[from] };
  delete cameras[from];
  state.cameras = cameras;
  writeStorage(CAMERA_STORE, state.cameras);
}
// ✎ on a seat (from «Компы» or the player's row in «Эфир»): the ID its PC
// really streams under. The automatic ones (the event's IDs, «Найти компы»)
// stay the normal way; this fixes the case where they got a stream wrong. An
// empty answer drops the fix and the seat goes back to its usual ID.
function setSeatPush(side, index, player) {
  if (!['a', 'b'].includes(side) || !(index >= 0 && index < 5)) return;
  const name = `${side.toUpperCase()}${index + 1}`;
  const lan = state.lan;
  const usual = lanSeat({ ...lan, pushes: null }, side, index).id;
  const own = lanSeat(lan, side, index).id;
  const pinned = Boolean(lan.pushes?.[side]?.[index]);
  const typed = window.prompt(`${name}: ID потока, под которым вещает компьютер (то, что стоит ` +
    'после push= в его ссылке). Пусто — вернуть обычный:', own);
  if (typed === null) return;
  const text = typed.trim(), id = vdoStreamId(text);
  if (text && !id) return toast(`${name}: не нашёл ни push=, ни ID — ничего не поменяли. ` +
    'Скопируй адрес из вкладки компа.');
  // Typing the seat's usual ID means «обычный», not «закрепи за местом»: a pin
  // that changes nothing would quietly stop «Найти компы» from fixing the seat.
  const next = id && id !== usual ? id : '';
  if (next === (pinned ? own : '')) return;
  const pushes = { a: Array(5).fill(null), b: Array(5).fill(null), ...(lan.pushes || {}) };
  const list = Array.from({ length: 5 }, (_, i) => pushes[side]?.[i] || null);
  list[index] = next || null;
  pushes[side] = list;
  const before = lanSeat(lan, side, index);
  setLan({ ...lan, pushes });
  const after = lanSeat(state.lan, side, index);
  moveSeatCamera(before, after);
  render();
  toast(next ? `${name}: ID ${next}. Открой ссылку места и отправь камеры в OBS заново.`
    : `${name}: снова обычный ID ${after.id}.`);
  document.dispatchEvent(new CustomEvent('oneshot:stream-id', { detail: { nick: player?.nick || name } }));
}
function unregenerate(side, slot) {
  const player = chosen(side)[slot];
  if (!player?.sheetId) return;
  delete state.streamIds[player.key];
  applyIds();
  render();
  toast(`У ${player.nick} снова ссылка из таблицы.`);
  document.dispatchEvent(new CustomEvent('oneshot:stream-id', { detail: { nick: player.nick } }));
}
function getTeam(side) {
  const team = state.teams.find(t => t.name === state[side]);
  if (!team) return team;
  if (!state.lan.on) return withCamNicks(side, team);
  const seated = seatTeam(team, side, state[side === 'a' ? 'keysA' : 'keysB'], state.lan);
  return withCamNicks(side, { ...seated, players: seated.players.map(p => p.id ?
    { ...p, camera: normalizeCamera(state.cameras[cameraKey(p)]) } : p) });
}
function chosen(side) {
  return selectedPlayers(getTeam(side),
    state[side === 'a' ? 'keysA' : 'keysB']);
}
function valid() {
  return validateMatch(getTeam('a'), getTeam('b'),
    state.keysA, state.keysB);
}
function showError(text) {
  $('errorBox').textContent = text;
  $('errorBox').hidden = !text;
}
// The site's live.js (OBS, webcam status, veto overlay) and lobby.js follow
// the panel through this snapshot; the Claude artifact has neither.
function snapshot() {
  return {
    a: getTeam('a'), b: getTeam('b'), playersA: chosen('a'), playersB: chosen('b'),
    keysA: [...state.keysA], keysB: [...state.keysB],
    matchError: valid(), template: state.template, templateError: state.templateError,
    includeCards: cardsOn(), logos: state.logos,
    cameraFrame:state.cameraFrame,
    veto: { ...state.veto, actions: [...state.veto.actions] }, pending: state.pending,
    schedule: state.schedule, matchKey: state.matchKey,
    time: $('matchTime').value, stage: $('matchStage').value
  };
}
function notify() {
  if(cameraEditor && !editorPlayer())$('cameraDialog').close();
  document.dispatchEvent(new CustomEvent('oneshot:change'));
}
window.oneshotPanel = { snapshot, copy: text => copy(text), toast, showError, setVeto: next => setVeto(next),
  // A file handed in by live.js (the seats' collection) is saved like our own.
  download: file => directDownload(file),
  lan: () => ({ ...state.lan }), setLan,
  // «Ник» of a webcam (a seat in «Компы», a slot in «Эфир»): read and write.
  camNick: (side, index) => camNickValue(side, index, chosen(side)[index]),
  setCamNick: (side, index, value) => setCamNick(side, index, value),
  // «Кадр» of a LAN seat's webcam (side 'a'|'b', seat 0–4), from «Компы».
  // The frame saved for a seat's PC («Кадр» in «Компы»), for sending the seats alone.
  seatCamera: (side, index) => state.lan.on ? seatPlayer(side, index).camera : undefined,
  editSeatCamera: (side, index) => { if (state.lan.on && ['a', 'b'].includes(side) && index >= 0 && index < 5) openCamera(side, index, true); },
  // ✎ у места в «Компах»: ID потока, под которым реально вещает его комп.
  editSeatPush: (side, index) => { if (state.lan.on) setSeatPush(side, index, chosen(side)[index]); },
  // lan.js registers the maker of self-contained cards (photos inside).
  setCardDocs: provider => { cardDocsProvider = provider; }, cardDocs: () => cardDocsNow(),
  // lan.js: a side's placeholder card page («Компы»), '' when there is none.
  setPlates: provider => { platesProvider = provider; notify(); }, plate: side => plateOf(side) };
let cardDocsProvider = null, platesProvider = null;
const plateOf = side => state.lan.on && platesProvider ? platesProvider(side) || '' : '';
// Cards go to OBS with the checkbox, or on a LAN whenever a side has a placeholder.
const cardsOn = () => $('includeCards').checked || Boolean(plateOf('a') || plateOf('b'));
// LAN cards with their photos inside, for the players of the current match. A
// side with a placeholder gets it under every camera (seen while a webcam has
// no video); with cards off, the other side's cards show nothing.
function cardDocsNow() {
  if (!state.lan.on || !cardsOn()) return {};
  const cards = $('includeCards').checked && cardDocsProvider;
  const docs = cards ? cardDocsProvider(['a', 'b'].flatMap(side =>
    chosen(side).filter(Boolean).map(p => ({ team: getTeam(side).name, nick: displayNick(p), lookup: p.nick,
      teamId: getTeam(side).teamId, playerId: p.playerId })))) : {};
  for (const side of ['a', 'b']) {
    const plate = plateOf(side);
    for (const p of chosen(side).filter(Boolean)) {
      const key = cardKey(getTeam(side).name, displayNick(p));
      if (plate) docs[key] = plate;
      else if (!cards) docs[key] = BLANK_CARD;
    }
  }
  return docs;
}
// lan.js: another prefix is a new data source; edited teams keep the match,
// lineups and veto where they still fit, and a renamed team stays chosen.
// A team on air whose name is being retyped (blank, or for a moment the same as
// another's) is held: its side, lineup and veto wait for the new name.
const lanHold = {};
function setLan(value) {
  const next = lanConfig({ ...value, on: EVENT_LAN, cams: lanCams(value?.cams) || EVENT_CAMS });
  // With LAN off the prefix is only kept for later: the sheets match stays.
  const sameSource = next.on === state.lan.on && (!next.on || next.prefix === state.lan.prefix);
  const ready = new Set(lanTeams(next).map(t => t.teamId));
  for (const side of ['a', 'b']) {
    const id = state.lan.teams.find(t => t.name === state[side])?.id || lanHold[side];
    const team = next.teams.find(t => t.id === id);
    if (team && ready.has(team.id)) state[side] = team.name;
    if (team && !ready.has(team.id)) lanHold[side] = id; else delete lanHold[side];
  }
  state.lan = next;
  const stored = writeStorage(LAN_STORE, next);
  if (!sameSource) {
    state.teams = [];
    state.a = state.b = state.matchKey = '';
    state.keysA = [];
    state.keysB = [];
    resetVeto();
  }
  updateSourceLinks();
  refresh();
  return stored;
}
// The header opens the organizer's sheet (the schedule source), not the
// roster sheet: the panel is public and the rosters are ours to edit.
function updateSourceLinks() {
  $('sidebarSource').hidden = state.lan.on;
  const { scheduleId, scheduleGid, id, gid } = state.source;
  $('sidebarSource').href = `https://docs.google.com/spreadsheets/d/${
    scheduleGid ? scheduleId || id : id}/edit#gid=${scheduleGid || gid}`;
}
async function sheetRows(source, gid, range, signal, id = source.id, headers = '0') {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq`);
  url.search = new URLSearchParams({
    gid, range, headers, tqx: 'out:json',
    _t: String(Date.now())
  });
  const response = await fetch(url, {
    credentials: 'omit', signal, cache: 'no-store'
  });
  if (!response.ok) {
    throw new Error(`Google Sheets недоступен (${response.status}).`);
  }
  return decodeGviz(await response.text());
}
function reconcileKeys(team, keys) {
  const available = new Set(team?.players.map(p => p.key));
  // Nobody of the saved lineup is left (a roster retyped for another event,
  // every nick replaced): start from the default five, not from five empty seats.
  // Seats the operator emptied on purpose stay empty.
  if (!keys.length || team && keys.some(Boolean) && !keys.some(key => available.has(key))) return defaultLineup(team);
  return keys.map(key => available.has(key) ? key : '');
}
function syncScheduledSelection() {
  // Keys include the start time. A correction in Sheets must also update a
  // selected/restored match, without changing teams, lineups or veto progress.
  let previous;
  try { previous = JSON.parse(state.matchKey); } catch { return; }
  if (!Array.isArray(previous) || previous.length !== 6 ||
      !previous.slice(0, 5).every(value => typeof value === 'string')) return;
  const [date, time, team1, team2, stage] = previous;
  if (state.a !== team1 || state.b !== team2) return;
  const candidates = state.schedule.filter(match => match.date === date &&
    match.team1 === team1 && match.team2 === team2 && match.stage === stage);
  const match = candidates.find(match => match.key === state.matchKey) ||
    (candidates.length === 1 ? candidates[0] : null);
  if (!match) return;
  state.matchKey = match.key;
  // An operator's explicit time override stays in place.
  if ($('matchTime').value === time) $('matchTime').value = match.time;
}
async function loadTemplate() {
  if (templatePromise) return templatePromise;
  templatePromise = (async () => {
    const signal = AbortSignal.timeout(12000);
    try {
      const response = await fetch('/assets/obs-template.json', { signal });
      if (!response.ok) {
        throw new Error('Не загружен шаблон OBS. Попробуй обновить страницу.');
      }
      const template = await response.json();
      if (!Array.isArray(template.sources)) {
        throw new Error('Некорректный шаблон OBS.');
      }
      state.template = template;
      state.templateError = '';
    } catch (error) {
      state.templateError = signal.aborted || error.name === 'TimeoutError' ?
        'Шаблон OBS долго загружается. Нажми «Обновить» и повтори.' : error.message;
    } finally {
      templatePromise = null;
      renderOutput();
    }
  })();
  return templatePromise;
}
async function refresh() {
  const request = ++refreshId;
  controller?.abort();
  controller = new AbortController();
  const source = { ...state.source }, signal = controller.signal;
  const timer = setTimeout(() =>
    controller?.signal === signal &&
      controller.abort(new DOMException(
        'Таблица долго отвечает.', 'TimeoutError')), 20000);
  $('refreshBtn').disabled = true;
  $('refreshBtn').textContent = 'Обновляем…';
  showError('');
  if (!state.template) loadTemplate();
  try {
    // The organizer's default sheet: the playoffs tab comes along with the
    // group stage; it may be missing or empty without failing the schedule.
    const organizer = source.scheduleGid === DEFAULT_SOURCE.scheduleGid &&
      (source.scheduleId || source.id) === DEFAULT_SOURCE.scheduleId;
    // LAN: the event's own teams and matches, no sheets.
    const lan = state.lan.on;
    const [roster, schedule, playoffs] = lan ? [
      { status: 'fulfilled', value: null }, { status: 'fulfilled', value: [] }, { status: 'fulfilled', value: [] }
    ] : await Promise.allSettled([
      sheetRows(source, source.gid, 'A1:L2000', signal),
      source.scheduleGid ?
        // Header row as labels: the organizer's columns are found by name.
        sheetRows(source, source.scheduleGid, 'A1:N300',
          signal, source.scheduleId || source.id, '1') :
        Promise.resolve([]),
      organizer ? sheetRows(source, DEFAULT_SOURCE.playoffsGid, 'A1:N100',
        signal, DEFAULT_SOURCE.scheduleId, '1') : Promise.resolve([])
    ]);
    if (schedule.status === 'fulfilled' && playoffs.status === 'fulfilled') {
      schedule.value = [...schedule.value, ...playoffs.value];
    }
    if (request !== refreshId) return;
    if (roster.status !== 'fulfilled') throw roster.reason;
    state.sheetTeams = lan ? lanTeams(state.lan) : parseTeams(roster.value);
    const skipped = state.sheetTeams.skipped || [];
    applyIds();
    const teams = state.teams;
    const names = teams.map(t => t.name);
    state.schedule = lan ? lanSchedule(state.lan) : upcoming(schedule.status === 'fulfilled' ?
      parseSchedule(schedule.value) : state.schedule, names);

    const pair = state.a + '\n' + state.b;
    const held = side => lan && Boolean(lanHold[side]);
    if (!names.includes(state.a) && !held('a')) {
      state.a = names[0] || '';
      state.keysA = [];
    }
    if ((!names.includes(state.b) || state.b === state.a) && !held('b')) {
      state.b = names.find(n => n !== state.a) || '';
      state.keysB = [];
    }
    if (pair !== state.a + '\n' + state.b) resetVeto();
    if (!held('a')) state.keysA = reconcileKeys(getTeam('a'), state.keysA);
    if (!held('b')) state.keysB = reconcileKeys(getTeam('b'), state.keysB);
    syncScheduledSelection();
    state.lastSync = new Date();
    state.stale = false;
    render();
    const word = teams.length % 10 === 1 && teams.length % 100 !== 11 ? 'команда' :
      [2, 3, 4].includes(teams.length % 10) && ![12, 13, 14].includes(teams.length % 100) ? 'команды' : 'команд';
    $('syncTitle').textContent = lan ? (teams.length ? `${teams.length} ${word} · ЛАН` : 'Нет команд · ЛАН') : `${teams.length} команд из таблицы`;
    $('syncDot').className = 'good';
    $('syncTime').textContent = lan ? 'команды и матчи — во вкладках «Команды» и «Матчи»' :
      'Обновлено ' + state.lastSync.toLocaleTimeString('ru-RU', {
        timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit'
      }) + ' МСК';
    if (schedule.status === 'fulfilled') {
      state.scheduleDay = scheduleDay(schedule.value);
    }
    renderScheduleDay();
    if (schedule.status === 'rejected') {
      showError('Составы загружены. Расписание недоступно — выбери команды, время и стадию вручную.');
    } else if (state.scheduleDay && state.scheduleDay !== mskToday()) {
      showError(`Расписание в таблице на ${state.scheduleDay}, а сегодня ${mskToday()} по МСК. Если для нового дня завели новый лист, укажи его GID в «Источник данных».`);
    } else if (skipped.length) {
      showError(`В составах пропущены строки (поправь ${lan ? 'во вкладке «Команды»' : 'в таблице'}): ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? ` и ещё ${skipped.length - 3}` : ''}.`);
    }
  } catch (error) {
    if (request !== refreshId) return;
    state.stale = true;
    $('syncDot').className = 'stale';
    $('syncTitle').textContent = state.teams.length ?
      'Данные требуют обновления' : state.lan.on ? 'Нет команд для ЛАН' : 'Нет связи с таблицей';
    showError(
      (signal.reason?.name === 'TimeoutError' ?
        'Google Sheets долго отвечает. Попробуй обновить ещё раз.' :
        error.message) +
      (state.lastSync ? ' Показаны ранее загруженные составы.' : '')
    );
    if (!state.teams.length) {
      $('teamGrid').innerHTML =
        (state.lan.on ? '<div class="empty-panel">Добавь команды во вкладке «Команды»: название, логотип и игроков прямо в карточке.</div>' :
        '<div class="empty-panel">Не удалось загрузить составы. Проверь источник и доступ на просмотр по ссылке, затем обнови данные.</div>');
    }
    renderOutput();
    renderVeto();
  } finally {
    clearTimeout(timer);
    if (request === refreshId) {
      $('refreshBtn').disabled = false;
      $('refreshBtn').textContent = '↻ Обновить';
    }
  }
}

function mskToday(days = 0) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit'
  }).format(new Date(Date.now() + days * 86400000));
}
// Matches of teams in the rosters; dated ones from today (MSK) on, so a
// finished day drops out and the next days are ready in advance.
function upcoming(schedule, names) {
  const day = date => Number(date.slice(3, 5)) * 100 + Number(date.slice(0, 2));
  const today = day(mskToday());
  return schedule.filter(m => names.includes(m.team1) &&
    names.includes(m.team2) && (!m.date || day(m.date) >= today));
}
function dayLabel(date) {
  return date === mskToday() ? `${date} · сегодня` :
    date === mskToday(1) ? `${date} · завтра` : date;
}
// Logos: assets/teams/teams.json maps a team name to a file next to it.
async function loadLogos() {
  try {
    const response = await fetch('/assets/teams/teams.json');
    if (!response.ok) return;
    const logos = await response.json();
    state.logos = Object.fromEntries(Object.entries(logos).filter(([, file]) =>
      typeof file === 'string' && /^[\w.-]+\.(png|jpe?g|webp|svg)$/i.test(file))
      .map(([name, file]) => [name, `/assets/teams/${file}`]));
    if (state.teams.length) render();
  } catch { /* No logos: cards keep the A/B badge. */ }
}
function renderScheduleDay() {
  $('scheduleLabel').textContent = state.lan.on ? 'Матч из вкладки «Матчи»' : 'Матч по расписанию' +
    (state.scheduleDay ? ` · ${state.scheduleDay}` : '');
}
// Images come from veto.oneshot.su; if a file is missing, show no broken icon.
function dropBrokenImage(img) {
  if (img.complete && !img.naturalWidth) img.remove();
  else img.addEventListener('error', () => img.remove(), { once: true });
}

function render() {
  // Roster controls are rebuilt together; preserve the keyboard's position.
  const active = document.activeElement;
  const focusId = $('teamGrid').contains(active) ? active.id : '';
  const focusPlayer = active?.dataset.player;
  const focusSlot = active?.dataset.slot;
  const option = m => `<option value="${escapeHtml(m.key)}">${escapeHtml(
    [m.time, m.stage, `${m.team1} vs ${m.team2}`].filter(Boolean).join(' · ')
  )}</option>`;
  const days = [...new Set(state.schedule.map(m => m.date))];
  $('matchSelect').innerHTML =
    '<option value="">Выбери команды вручную</option>' +
    (days.some(Boolean) ? days.map(date =>
      `<optgroup label="${escapeHtml(dayLabel(date))}">${state.schedule
        .filter(m => m.date === date).map(option).join('')}</optgroup>`).join('') :
      state.schedule.map(option).join(''));
  // A match that left the list (past midnight, the organizer edited it,
  // the schedule is down) keeps its veto: only the select shows «вручную».
  const listed = state.schedule.find(m => m.key === state.matchKey);
  if (listed && (listed.team1 !== state.a || listed.team2 !== state.b)) state.matchKey = '';
  $('matchSelect').value = listed && state.matchKey ? state.matchKey : '';

  // An event whose teams were all removed: say where they are made, nothing stale.
  $('teamGrid').innerHTML = state.lan.on && !state.teams.length ?
    '<div class="empty-panel">Добавь команды во вкладке «Команды»: название, логотип и игроков прямо в карточке.</div>' :
    ['a', 'b'].map((side, index) => {
    const team = getTeam(side);
    if (!team) return '<div class="empty-panel">Команда не выбрана</div>';
    const keys = state[side === 'a' ? 'keysA' : 'keysB'];
    const eligible = lineupCandidates(team);
    return `<article class="team-card">
      <div class="card-top">
        ${state.lan.on ? `<div class="team-letter" data-lan-logo="${escapeHtml(team.teamId)}">${index ? 'B' : 'A'}</div>` : state.logos[team.name] ?
          `<span class="team-logo"><img src="${escapeHtml(state.logos[team.name])}"
            alt="" width="34" height="34"></span>` :
          `<div class="team-letter">${index ? 'B' : 'A'}</div>`}
        <div class="team-heading">
          <label for="team-${side}">${index ? 'ВТОРАЯ' : 'ПЕРВАЯ'} КОМАНДА</label>
          <select id="team-${side}" data-team="${side}">
            ${state.teams.map(t => `<option
              ${t.name === team.name ? 'selected' : ''}
              value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join('')}
          </select>
        </div>
        <span class="slot-caption">${index ? '06–10' : '01–05'}</span>
      </div>
      <div class="camera-list">${Array.from({ length: 5 }, (_, i) => {
        const player = team.players.find(p => p.key === keys[i]);
        const nick = camNickValue(side, i, player);
        const nickHint = player ? player.nick : (state.lan.on ? 'Ник вебки' : 'Сначала выбери игрока');
        return `<div class="player-row">
          <span class="slot-number">${String(index * 5 + i + 1).padStart(2, '0')}</span>
          <div class="player-info">
            <select data-player="${side}" data-slot="${i}" aria-label="Игрок ${index * 5 + i + 1}">
              <option value="">Выбери игрока</option>
              ${eligible.map(p => `<option
                value="${escapeHtml(p.key)}"
                ${p.key === keys[i] ? 'selected' : ''}
                ${keys.includes(p.key) && p.key !== keys[i] ? 'disabled' : ''}
              >${escapeHtml(p.nick + roleSuffix(p))}</option>`).join('')}
            </select>
            <label class="player-nick-line">
              <span class="visually-hidden">Ник вебки ${index * 5 + i + 1}</span>
              <input id="cam-nick-${side}-${i}" class="cam-nick" type="text" maxlength="40"
                value="${escapeHtml(nick)}" placeholder="${escapeHtml(nickHint)}"
                data-cam-nick="${side}" data-slot="${i}"
                ${!player && !state.lan.on ? 'disabled' : ''}
                aria-label="Ник вебки ${index * 5 + i + 1}${player ? `, по умолчанию ${escapeHtml(player.nick)}` : ''}"
                autocomplete="off" spellcheck="false">
            </label>
            <span class="player-subline">${player ?
              (player.seat ? `<b class="seat-id">Место ${player.seat}</b> · ` : '') +
              (player.sheetId ? `<b class="new-id">${player.manualId ? 'Свой ID' : 'Новый ID'}</b> <button type="button" class="link-button"
                data-unregen="${side}" data-slot="${i}"
                title="Вернуть ID из таблицы (${escapeHtml(player.sheetId)})">вернуть</button> · ` : '') +
              escapeHtml(viewUrl(player)) :
              'Место не заполнено'}</span>
            <button class="link-button camera-adjust" type="button" id="camera-${side}-${i}" data-camera="${side}" data-slot="${i}" ${!player ? 'disabled' : ''}>Кадр${player?.camera?.rotation ? ' · '+player.camera.rotation+'°' : ''}${player?.camera?.mirror ? ' · ↔' : ''}</button>
          </div>
          ${state.lan.on ? '' : `<button class="copy-icon regen-icon${state.regenAsk === `${side}${i}` ? ' asking' : ''}"
            id="regen-${side}-${i}" type="button" data-regen="${side}" data-slot="${i}"
            aria-label="${state.regenAsk === `${side}${i}` ?
              `Нажми ещё раз: новая ссылка для ${player ? escapeHtml(player.nick) : ''}` :
              `Новая ссылка игроку ${player ? escapeHtml(player.nick) : ''}`}"
            title="${state.regenAsk === `${side}${i}` ? 'Нажми ещё раз — сделать новую ссылку' :
              'Новая ссылка игроку (если старая утекла)'}" ${!player ? 'disabled' : ''}
            >${state.regenAsk === `${side}${i}` ? '✓?' : '↻'}</button>`}
          <button class="copy-icon setid-icon" type="button" data-setid="${side}" data-slot="${i}"
            aria-label="${state.lan.on ? `Указать ID потока места ${side.toUpperCase()}${i + 1} вручную` :
              `Указать ID потока вручную ${player ? escapeHtml(player.nick) : ''}`}"
            title="${state.lan.on ? 'ID, под которым вещает комп этого места (после push= в его ссылке)' :
              'Указать ID вручную (игрок зашёл по другой ссылке)'}" ${!player ? 'disabled' : ''}>✎</button>
          <button class="give-button" type="button" data-give="${side}" data-slot="${i}"
            aria-label="Скопировать ссылку игроку ${player ? escapeHtml(player.nick) : ''}"
            title="${state.lan.on ? 'Скопировать PUSH-ссылку места' : 'Скопировать PUSH-ссылку, чтобы отдать игроку'}" ${!player ? 'disabled' : ''}>${state.lan.on ? 'Ссылка места' : 'Игроку'}</button>
          <button class="copy-icon" data-view="${side}" data-slot="${i}"
            aria-label="Скопировать VIEW ${player ? escapeHtml(player.nick) : ''}"
            title="Копировать VIEW" ${!player ? 'disabled' : ''}>⧉</button>
        </div>`;
      }).join('')}</div>
      <div class="card-actions">
        <button class="text-button team-copy" data-copy-team="${side}"
          ${validatePlayers(chosen(side)) ? 'disabled' : ''}><span aria-hidden="true">⧉</span> Копировать ссылки команды</button>
        <div class="card-bottom">
          <button class="text-button roster-action" data-reset="${side}"
            title="${state.lan.on ? 'Первые пять из состава команды' : 'Восстановить порядок из таблицы'}" aria-label="Восстановить порядок ${escapeHtml(team.name)}">↻</button>
          <a class="text-button roster-action" target="_blank" rel="noreferrer"
            title="Открыть комнату директора" aria-label="Директор ${escapeHtml(team.name)}"
            href="${escapeHtml(directorUrl(team))}">↗</a>
        </div>
      </div>
    </article>`;
  }).join('');

  $('teamGrid').querySelectorAll('[data-team]').forEach(el =>
    el.addEventListener('change', () => {
      const side = el.dataset.team;
      state[side] = el.value;
      state[side === 'a' ? 'keysA' : 'keysB'] = defaultLineup(getTeam(side));
      state.matchKey = '';
      resetVeto();
      render();
    }));
  $('teamGrid').querySelectorAll('[data-player]').forEach(el =>
    el.addEventListener('change', () => {
      state[el.dataset.player === 'a' ? 'keysA' : 'keysB']
        [Number(el.dataset.slot)] = el.value;
      render();
    }));
  $('teamGrid').querySelectorAll('[data-cam-nick]').forEach(el =>
    el.addEventListener('input', () =>
      setCamNick(el.dataset.camNick, Number(el.dataset.slot), el.value)));
  $('teamGrid').querySelectorAll('[data-reset]').forEach(el =>
    el.addEventListener('click', () => {
      const side = el.dataset.reset;
      state[side === 'a' ? 'keysA' : 'keysB'] = defaultLineup(getTeam(side));
      render();
      toast('Порядок восстановлен из таблицы');
    }));
  // Two clicks: the first arms the button for 4 s, the second makes the link.
  $('teamGrid').querySelectorAll('[data-regen]').forEach(el =>
    el.addEventListener('click', () => {
      const id = el.dataset.regen + el.dataset.slot;
      clearTimeout(regenTimer);
      if (state.regenAsk !== id) {
        state.regenAsk = id;
        regenTimer = setTimeout(() => { state.regenAsk = ''; render(); }, 4000);
        return render();
      }
      state.regenAsk = '';
      regenerate(el.dataset.regen, Number(el.dataset.slot));
    }));
  // «Игроку»: this player's own line with the PUSH link, ready for a DM.
  $('teamGrid').querySelectorAll('[data-give]').forEach(el =>
    el.addEventListener('click', () => {
      const player = chosen(el.dataset.give)[Number(el.dataset.slot)];
      if (player) copy(playerLine(player)).then(() => toast(`Ссылка для ${player.nick} скопирована — отправь игроку.`));
    }));
  $('teamGrid').querySelectorAll('[data-setid]').forEach(el =>
    el.addEventListener('click', () => setStreamId(el.dataset.setid, Number(el.dataset.slot))));
  $('teamGrid').querySelectorAll('[data-camera]').forEach(el =>
    el.addEventListener('click', () => openCamera(el.dataset.camera,Number(el.dataset.slot))));
  $('teamGrid').querySelectorAll('[data-unregen]').forEach(el =>
    el.addEventListener('click', () => unregenerate(el.dataset.unregen, Number(el.dataset.slot))));
  $('teamGrid').querySelectorAll('[data-view]').forEach(el =>
    el.addEventListener('click', () => {
      const player = chosen(el.dataset.view)[Number(el.dataset.slot)];
      if (player) copy(viewUrl(player));
    }));
  $('teamGrid').querySelectorAll('[data-copy-team]').forEach(el =>
    el.addEventListener('click', () => {
      const side = el.dataset.copyTeam, players = chosen(side);
      const error = validatePlayers(players);
      if (error) return toast(error);
      copy(playerText(getTeam(side), players));
    }));
  $('teamGrid').querySelectorAll('.team-logo img').forEach(dropBrokenImage);
  renderOutput();
  renderVeto();
  persist();
  const focusTarget = focusId ? document.getElementById(focusId) :
    ['a', 'b'].includes(focusPlayer) && /^[0-4]$/.test(focusSlot || '') ?
      $('teamGrid').querySelector(`[data-player="${focusPlayer}"][data-slot="${focusSlot}"]`) : null;
  focusTarget?.focus({ preventScroll: true });
}

function renderOutput() {
  const error = valid();
  const metadataError =
    validateMetadata($('matchTime').value, $('matchStage').value);
  // A LAN without a match: live.js builds the same collection from the ten seats'
  // cameras, so the file OBS imports once can be downloaded before «В эфир».
  const seatsJson = !!error && !!state.template && !!state.lan?.on &&
    typeof window.oneshotPanel?.seatsJsonFile === 'function';
  $('downloadBtn').disabled = state.exporting || !state.template ||
    (!seatsJson && (!!error || !!metadataError));
  $('exportRecovery').disabled = $('downloadBtn').disabled;
  $('copyAllBtn').disabled = !!error;
  $('swapBtn').disabled = !getTeam('a') || !getTeam('b');
  $('exportHint').textContent = seatsJson ?
    'Без матча: десять камер мест — файл для импорта в OBS' :
    error || metadataError || state.templateError ||
    (!state.template ? 'Загружаем шаблон OBS…' :
      `${state.stale ? 'По ранее загруженным данным. ' : ''}1–5: ${state.a} · 6–10: ${state.b}`);
  $('filenamePreview').textContent = seatsJson ?
    (window.oneshotPanel.seatsJsonName?.() || '') :
    !error && !metadataError ?
      safeFilename(state.a, state.b,
        $('matchTime').value, $('matchStage').value) : '';
  const playersTab = state.tab === 'players';
  for (const [id, selected] of [
    ['tabObserver', !playersTab], ['tabPlayers', playersTab]
  ]) {
    $(id).classList.toggle('selected', selected);
    $(id).setAttribute('aria-selected', String(selected));
    $(id).tabIndex = selected ? 0 : -1;
  }
  $('outputPanel').setAttribute('aria-labelledby',
    playersTab ? 'tabPlayers' : 'tabObserver');
  $('previewLabel').textContent = playersTab ?
    'Команда, жирный ник и отдельная PUSH-ссылка' :
    'Порядок слотов 1–10: команда и ник, без ссылок';
  $('output').value = error ? '' : playersTab ?
    playerText(getTeam('a'), chosen('a')) + '\n\n' +
      playerText(getTeam('b'), chosen('b')) :
    observerText(getTeam('a'), getTeam('b'), chosen('a'), chosen('b'));
  $('copyFoot').textContent = playersTab ?
    'Только выбранные игроки. Ссылки директора сюда не попадают.' :
    'Порядок совпадает со сценами «Игрок 1–10» в JSON для OBS.';
  notify();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано в буфер обмена');
    return;
  } catch { /* Continue with the same payload. */ }
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  let ok = false;
  try { ok = document.execCommand('copy'); }
  catch { /* Manual fallback below. */ }
  finally { field.remove(); }
  if (ok) return toast('Скопировано');
  $('manualCopy').value = text;
  if (!$('copyDialog').open) $('copyDialog').showModal();
  $('manualCopy').focus();
  $('manualCopy').select();
}

let vetoPresentation = { match: '', count: 0, revealAt: 0, timer: null };
// The veto resets only when someone picks other teams or another match
// (resetVeto); refreshing, midnight or schedule edits never wipe it.
function resetVeto() {
  state.veto = { format: state.veto.format, first: state.veto.first, actions: [], matchKey: '' };
  state.pending = null;
}
// ⇄ only relabels the sides: every move keeps its real team.
function swapVeto() {
  state.veto = {
    ...state.veto, first: 1 - state.veto.first,
    actions: state.veto.actions.map(a => ({ ...a, team: 1 - a.team }))
  };
}
function renderVeto() {
  const identity = JSON.stringify([state.a, state.b]);
  const { actions, format, first } = state.veto;
  const ready = !!getTeam('a') && !!getTeam('b') && state.a !== state.b;
  const finished = actions.length === 6;
  if (vetoPresentation.match === identity && vetoPresentation.count < 6 && finished) {
    vetoPresentation.revealAt = performance.now() + 1500;
    clearTimeout(vetoPresentation.timer);
    vetoPresentation.timer = setTimeout(renderVeto, 1500);
  } else if (vetoPresentation.match !== identity || !finished) {
    clearTimeout(vetoPresentation.timer);
    vetoPresentation.revealAt = 0;
  }
  vetoPresentation.match = identity;
  vetoPresentation.count = actions.length;
  const showDecider = finished && performance.now() >= vetoPresentation.revealAt;
  $('vetoFormat').value = format;
  $('vetoFormat').disabled = actions.length > 0 || !!state.pending;
  $('vetoFirst').innerHTML =
    [state.a || 'Первая команда', state.b || 'Вторая команда']
      .map((name, index) =>
        `<option value="${index}">${escapeHtml(name)}</option>`).join('');
  $('vetoFirst').value = String(first);
  $('vetoFirst').disabled = !ready || actions.length > 0 || !!state.pending;

  const team = (first + actions.length) % 2;
  const teams = [state.a, state.b];
  const type = VETO_RULES[format][actions.length];
  $('vetoStatus').textContent = !ready ?
    'Выбери две разные команды.' :
    state.pending ? `Выбери сторону для ${teams[1 - team]} на ${state.pending}.` :
    finished ? 'Вето завершено. Текст готов для HLTV.' :
    `Ход ${actions.length + 1}/6 · ${teams[team]} · ${type === 'pick' ?
      'PICK — выбирает карту' : 'BAN — убирает карту'}`;
  $('sideChoice').hidden = !state.pending;
  $('sideLabel').textContent = state.pending ?
    `${teams[1 - team]} начинает на ${state.pending}:` : '';

  const selectedMaps = [...actions.map(action => action.map), ...(state.pending ? [state.pending] : [])];
  const orderedMaps = [...selectedMaps, ...MAP_POOL.filter(map => !selectedMaps.includes(map))];
  $('mapGrid').innerHTML = orderedMaps.map(map => {
    const actionIndex = actions.findIndex(action => action.map === map);
    const action = actions[actionIndex];
    const pending = state.pending === map;
    const leftover = showDecider && !action;
    const turn = action ? actionIndex + 1 : pending ? actions.length + 1 : leftover ? 7 : null;
    const role = action?.type || (pending ? 'pick' : leftover ? 'leftover' : '');
    const owner = action ? teams[action.team] : pending ? teams[team] : '';
    const label = action ?
      `${action.type === 'pick' ? 'PICK' : 'BAN'} · ${teams[action.team]}${action.type === 'pick' ?
        ` · ${teams[1 - action.team]} ${action.side}` : ''}` :
      pending ? `PICK · ${owner} · сторону выбирает ${teams[1 - team]}` :
      leftover ? 'DECIDER · was left over' : 'Выбрать карту';
    const status = action ? action.type === 'pick' ? '✓ Пик' : '⊘ Бан' :
      leftover ? '— Решающая' : pending ? '✓ Пик · сторона…' : 'Выбрать';
    const turnLabel = role === 'leftover' ? 'DECIDER' : role.toUpperCase();
    return `<button
      class="map-card ${role} ${pending ? 'pending' : ''}"
      data-map="${map}"
      ${!ready || !!action || finished || !!state.pending ? 'disabled' : ''}
      aria-label="${escapeHtml(map + ': ' + label)}">
      <img src="/assets/maps/${map}.jpg" alt="" loading="lazy" width="960" height="180">
      ${turn ? `<span class="map-turn">${String(turn).padStart(2, '0')} · ${turnLabel}</span>` : ''}
      <span class="map-name">${map}</span>
      ${owner ? `<span class="map-team" title="${escapeHtml(owner)}">${escapeHtml(owner)}</span>` : ''}
      <span class="map-action" title="${escapeHtml(label)}">${status}</span>
    </button>`;
  }).join('');
  $('mapGrid').querySelectorAll('img').forEach(dropBrokenImage);
  $('mapGrid').querySelectorAll('[data-map]').forEach(el =>
    el.addEventListener('click', () => {
      if (VETO_RULES[state.veto.format][state.veto.actions.length] === 'pick') {
        state.pending = el.dataset.map;
        renderVeto();
        $('chooseCT').focus();
      } else commitVeto(el.dataset.map);
    }));
  $('vetoOutput').value =
    ready ? vetoText(teams, actions, format, first) : '';
  $('vetoHint').textContent = finished ?
    'Полное вето · 7 строк' :
    'Неполное вето — текст обновляется после каждого хода.';
  $('copyVeto').disabled = !ready || actions.length === 0 || !!state.pending;
  $('vetoUndo').disabled = !state.pending && actions.length === 0;
  $('vetoReset').disabled = !state.pending && actions.length === 0;
  notify();
}
function commitVeto(map, side) {
  try {
    state.veto.actions = appendVeto(state.veto.actions,
      state.veto.format, state.veto.first, map, side);
    state.pending = null;
    renderVeto();
    persist();
    // The map buttons were re-rendered; keep keyboard users on the grid.
    ($('mapGrid').querySelector('button:not(:disabled)') || $('copyVeto'))
      .focus({ preventScroll: true });
    if (state.veto.actions.length === 6 && $('autoCopyVeto').checked) {
      copy($('vetoOutput').value);
    }
  } catch (error) { toast(error.message); }
}
// The site's captains' room (live.js) writes the captains' moves here, in the
// panel's team order; pending is the map of a pick waiting for its side.
function setVeto({ format, first, actions, pending = null }) {
  const left = validateVeto(actions, format, first);
  if (pending !== null && (!left.includes(pending) || VETO_RULES[format][actions.length] !== 'pick')) {
    throw new Error('Некорректное вето.');
  }
  state.veto = { ...state.veto, format, first, actions: actions.map(a => ({ ...a })) };
  state.pending = pending;
  renderVeto();
  persist();
}

$('chooseCT').addEventListener('click', () => {
  if (state.pending) commitVeto(state.pending, 'CT');
});
$('chooseT').addEventListener('click', () => {
  if (state.pending) commitVeto(state.pending, 'T');
});
$('cancelSide').addEventListener('click', () => {
  state.pending = null;
  renderVeto();
});
$('vetoUndo').addEventListener('click', () => {
  if (state.pending) state.pending = null;
  else state.veto.actions.pop();
  renderVeto();
  persist();
});
$('vetoReset').addEventListener('click', () => {
  if (confirm('Сбросить текущее вето?')) {
    state.veto.actions = [];
    state.pending = null;
    renderVeto();
    persist();
  }
});
$('vetoFormat').addEventListener('change', () => {
  state.veto.format = $('vetoFormat').value;
  renderVeto();
  persist();
});
$('vetoFirst').addEventListener('change', () => {
  state.veto.first = Number($('vetoFirst').value);
  renderVeto();
  persist();
});
$('copyVeto').addEventListener('click', () => copy($('vetoOutput').value));
$('refreshBtn').addEventListener('click', refresh);
$('swapBtn').addEventListener('click', () => {
  [state.a, state.b] = [state.b, state.a];
  [state.keysA, state.keysB] = [state.keysB, state.keysA];
  state.matchKey = '';
  swapVeto();
  render();
  // On a LAN a side is a row of PCs: the swap moves each team to the other seats' webcams.
  toast(state.lan.on ? 'Команды поменялись местами: первая теперь за компами A1–A5, вторая — за B1–B5' : 'Команды поменялись сторонами');
});
$('matchSelect').addEventListener('change', () => {
  state.matchKey = $('matchSelect').value;
  const match = state.schedule.find(m => m.key === state.matchKey);
  if (match && (match.team1 !== state.a || match.team2 !== state.b)) resetVeto();
  if (match) {
    state.a = match.team1;
    state.b = match.team2;
    state.keysA = defaultLineup(getTeam('a'));
    state.keysB = defaultLineup(getTeam('b'));
    $('matchTime').value = match.time;
    $('matchStage').value = match.stage;
    // An event's match says its format; a veto already begun keeps its own.
    if (match.format && VETO_RULES[match.format] && !state.veto.actions.length) state.veto.format = match.format;
  }
  render();
});
for (const id of ['matchTime', 'matchStage']) {
  $(id).addEventListener('input', () => { renderOutput(); persist(); });
}
for (const [id, tab] of [
  ['tabObserver', 'observer'], ['tabPlayers', 'players']
]) {
  $(id).addEventListener('click', () => {
    state.tab = tab;
    renderOutput();
    persist();
  });
  $(id).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 'tabObserver' :
        event.key === 'End' ? 'tabPlayers' :
        id === 'tabObserver' ? 'tabPlayers' : 'tabObserver';
      $(next).click();
      $(next).focus();
    }
  });
}
$('copyAllBtn').addEventListener('click', () => copy($('output').value));
function exportObsFile() {
  // A LAN without a match has no teams to build from: live.js builds the seats'
  // collection instead, and this is the file OBS imports before the first match.
  const seats = window.oneshotPanel?.seatsJsonFile?.();
  if (seats) return seats;
  const filename = safeFilename(state.a, state.b, $('matchTime').value, $('matchStage').value);
  const data = buildObs(state.template, getTeam('a'), getTeam('b'), state.keysA, state.keysB, undefined, {
    includeCards: cardsOn(),
    cameraFrame:state.cameraFrame, cardDocs: cardDocsNow(),
    ...(/^https?:$/.test(location.protocol) ? { cardBase: location.origin } : {})
  });
  return { filename, text: JSON.stringify(data, null, 2) + '\n' };
}
function directDownload(file) {
  const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
let exportFile = null;
$('downloadBtn').addEventListener('click', async () => {
  if (state.exporting) return;
  state.exporting = true;
  renderOutput();
  try {
    const file = exportFile = exportObsFile();
    $('exportRecovery').hidden = false;
    if (typeof window.showSaveFilePicker === 'function') {
      let writer;
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: file.filename,
          types: [{ description: 'Коллекция сцен OBS', accept: { 'application/json': ['.json'] } }]
        });
        writer = await handle.createWritable();
        await writer.write(file.text);
        await writer.close();
        toast('JSON сохранён. OBS → Коллекция сцен → Импорт.');
        return;
      } catch (error) {
        try { await writer?.abort(); } catch { /* release an unsuccessful file write */ }
        if (error.name === 'AbortError') return toast('Сохранение отменено. Можно повторить.');
        // Sandboxed and embedded browsers can expose the API but reject it.
      }
    }
    directDownload(file);
    toast('Сохранение JSON запрошено. Если файла нет — «Файл не появился?» под кнопкой.');
  } catch (error) { showError(error.message); }
  finally { state.exporting = false; renderOutput(); }
});
$('exportRecovery').addEventListener('click', () => {
  try {
    // Rebuild for the currently selected match, not a previous export.
    exportFile = exportObsFile();
    $('exportFilename').textContent = exportFile.filename;
    $('exportText').value = exportFile.text;
    if (!$('exportDialog').open) $('exportDialog').showModal();
  } catch (error) { showError(error.message); }
});
$('closeExport').addEventListener('click', () => $('exportDialog').close());
$('exportAgain').addEventListener('click', () => { if (exportFile) directDownload(exportFile); });
$('exportCopy').addEventListener('click', async () => {
  if (!exportFile) return;
  // Close before the manual-copy fallback opens its own modal dialog.
  $('exportDialog').close();
  await copy(exportFile.text);
});

function fillSource(source) {
  $('sourceUrl').value =
    `https://docs.google.com/spreadsheets/d/${source.id}/edit`;
  $('sourceGid').value = source.gid;
  $('scheduleUrl').value = source.scheduleGid ?
    `https://docs.google.com/spreadsheets/d/${source.scheduleId || source.id}/edit` : '';
  $('scheduleGid').value = source.scheduleGid || '';
}
function sheetId(value) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/spreadsheets\/d\/([\w-]{20,100})(?:\/|$)/);
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' ||
      url.username || url.password || !match) {
    throw new Error('Вставь ссылку на Google Sheets.');
  }
  return match[1];
}
$('settingsBtn').addEventListener('click', () => {
  fillSource(state.source);
  $('sourceError').hidden = true;
  $('settingsDialog').showModal();
});
$('closeSettings').addEventListener('click', () => $('settingsDialog').close());
$('closeCopy').addEventListener('click', () => $('copyDialog').close());
$('resetSource').addEventListener('click', () => fillSource(DEFAULT_SOURCE));
$('settingsForm').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const id = sheetId($('sourceUrl').value.trim());
    const gid = $('sourceGid').value.trim();
    const scheduleUrl = $('scheduleUrl').value.trim();
    const scheduleGid = $('scheduleGid').value.trim();
    if (!/^\d+$/.test(gid) ||
        (scheduleUrl && !/^\d+$/.test(scheduleGid))) {
      throw new Error('Укажи числовой GID нужного листа.');
    }
    state.source = {
      id, gid, scheduleId: scheduleUrl ? sheetId(scheduleUrl) : null,
      scheduleGid: scheduleUrl ? scheduleGid : null
    };
    const stored = writeStorage('webcam-desk-source', state.source);
    state.teams = [];
    state.schedule = [];
    state.scheduleDay = '';
    renderScheduleDay();
    state.lastSync = null;
    state.a = '';
    state.b = '';
    state.keysA = [];
    state.keysB = [];
    state.matchKey = '';
    resetVeto();
    updateSourceLinks();
    $('settingsDialog').close();
    $('teamGrid').innerHTML =
      '<div class="empty-panel">Загружаем составы…</div>';
    renderOutput();
    renderVeto();
    refresh();
    if (!stored) {
      toast('Источник подключён. Браузер не разрешил сохранить настройки для следующего открытия.');
    }
  } catch (error) {
    $('sourceError').textContent = error.message;
    $('sourceError').hidden = false;
  }
});

// The «Ник» fields are edited in «Компы» too: coming back to «Эфир» shows the
// stored values without a full redraw.
document.addEventListener('oneshot:view', event => {
  if (event.detail !== 'prep') return;
  for (const el of $('teamGrid').querySelectorAll('[data-cam-nick]')) {
    if (document.activeElement === el) continue;
    const side = el.dataset.camNick, slot = Number(el.dataset.slot);
    el.value = camNickValue(side, slot, chosen(side)[slot]);
  }
});

document.querySelectorAll('.brand img').forEach(dropBrokenImage);
updateSourceLinks();
renderOutput();
renderVeto();
loadTemplate();
loadLogos();
refresh();
