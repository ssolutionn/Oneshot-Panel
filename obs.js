// obs-websocket v5 (built into OBS 28+) and the steps that point an already
// imported Oneshot collection at a new match. No DOM: the panel, the OBS dock
// (obs-bridge.html) and the tests share it.
import { viewUrl, cameraViewUrl, cameraGeometry, cameraFrame, DEFAULT_CAMERA_FRAME, cardUrl, cardKey, readyCard, DEFAULT_CARD_BASE } from './core.js';

export const OBS_DEFAULT_URL = 'ws://127.0.0.1:4455';
export const VETO_EVENT = 'oneshot-veto';

const FIT = {
  positionX: 0, positionY: 0, rotation: 0, alignment: 5,
  boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0,
  boundsWidth: 1920, boundsHeight: 1080,
  cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0
};

function base64(bytes) {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text);
}
async function sha256(text) {
  return base64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
// The dock runs inside OBS, so it only ever talks to OBS on its own computer.
// Settings sent from a panel (often a phone) are held to that.
export function loopbackObsUrl(value) {
  let url;
  try { url = new URL(String(value ?? '').trim() || OBS_DEFAULT_URL); }
  catch { throw new Error('Неверный адрес OBS WebSocket.'); }
  if (!/^wss?:$/.test(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname.length > 1 || url.search || url.hash || url.username || url.password) {
    throw new Error('Док подключается только к OBS на своём компьютере: ws://127.0.0.1:порт.');
  }
  return `${url.protocol}//${url.host}`;
}

// obs-websocket: base64(sha256(base64(sha256(password + salt)) + challenge)).
export async function obsAuth(password, salt, challenge) {
  return sha256(await sha256(password + salt) + challenge);
}

export class ObsClient {
  constructor(url = OBS_DEFAULT_URL, password = '', { WebSocketImpl = globalThis.WebSocket, timeout = 8000 } = {}) {
    Object.assign(this, { url, password, WebSocketImpl, timeout });
    this.pending = new Map();
    this.nextId = 0;
    this.socket = null;
    this.version = '';
  }
  connect() {
    return new Promise((resolve, reject) => {
      let ready = false, settled = false;
      const fail = message => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(message));
        try { socket?.close(); } catch { /* already closed */ }
      };
      const timer = setTimeout(() => fail('OBS не ответил. Проверь, что OBS открыт и WebSocket-сервер включён.'), this.timeout);
      let socket;
      try { socket = new this.WebSocketImpl(this.url); }
      catch { return fail('Неверный адрес OBS WebSocket.'); }
      this.socket = socket;
      socket.onerror = () => fail('Нет связи с OBS WebSocket по адресу ' + this.url + '.');
      socket.onclose = event => {
        for (const { reject: rejectRequest } of this.pending.values()) {
          rejectRequest(new Error('Связь с OBS прервалась.'));
        }
        this.pending.clear();
        this.socket = null;
        if (!ready) fail(event.code === 4009 ? 'Неверный пароль OBS WebSocket.' : 'OBS закрыл соединение.');
      };
      socket.onmessage = async event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.op === 0) {
          const hello = message.d || {};
          this.version = hello.obsWebSocketVersion || '';
          const identify = { rpcVersion: 1, eventSubscriptions: 0 };
          if (hello.authentication) {
            if (!this.password) return fail('OBS просит пароль WebSocket.');
            identify.authentication = await obsAuth(this.password,
              hello.authentication.salt, hello.authentication.challenge);
          }
          socket.send(JSON.stringify({ op: 1, d: identify }));
        } else if (message.op === 2) {
          ready = settled = true;
          clearTimeout(timer);
          resolve(this);
        } else if (message.op === 7) {
          const { requestId, requestStatus = {}, responseData } = message.d || {};
          const waiting = this.pending.get(requestId);
          if (!waiting) return;
          this.pending.delete(requestId);
          clearTimeout(waiting.timer);
          if (requestStatus.result) waiting.resolve(responseData || {});
          else waiting.reject(new Error(requestStatus.comment || `OBS отклонил ${waiting.type} (код ${requestStatus.code}).`));
        }
      };
    });
  }
  request(requestType, requestData = {}) {
    if (!this.socket) return Promise.reject(new Error('Нет связи с OBS.'));
    const requestId = `oneshot-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS не ответил на ${requestType}.`));
      }, this.timeout);
      this.pending.set(requestId, { resolve, reject, timer, type: requestType });
      this.socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }
  close() {
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
  }
}

// What one "Игрок N" scene needs. Cameras keep their source; the card (CARD)
// sits right under the camera when cards are on and is hidden when they are off.
export function slotPlan(sceneItems, player, { includeCards = false, cardBase = DEFAULT_CARD_BASE, cameraFrame: frame = DEFAULT_CAMERA_FRAME, legacyCamera = false, cardDocs = {} } = {}) {
  const scene = `Игрок ${player.slot}`;
  const browsers = (sceneItems || []).filter(it => it.inputKind === 'browser_source');
  const card = browsers.find(it => /^CARD /.test(it.sourceName));
  const camera = browsers.find(it => !/^CARD /.test(it.sourceName));
  if (!camera) throw new Error(`В сцене «${scene}» нет камеры. Импортируй коллекцию из JSON один раз.`);
  const slot = String(player.slot).padStart(2, '0');
  if(legacyCamera){frame='wide';player={...player,camera:null};}
  const geometry=cameraGeometry(player,frame),rect=cameraFrame(frame);
  return {
    scene,
    camera: {
      item: camera, name: `CAM ${slot} | ${player.team} | ${player.nick}`,
      settings: {url:legacyCamera ? viewUrl(player) : cameraViewUrl(player),width:geometry.width,height:geometry.height},
      transform:{...FIT,positionX:geometry.x,positionY:geometry.y,rotation:geometry.rotation,
        boundsWidth:geometry.width,boundsHeight:geometry.height}
    },
    card: includeCards ? {
      item: card || null, name: `CARD ${slot} | ${player.team} | ${player.nick}`,
      // A ready page fills the frame (its size); the site's card stays 1920×1080.
      settings: readyCard(cardDocs, cardKey(player.team, player.nick)) ?
        { url: readyCard(cardDocs, cardKey(player.team, player.nick)), width: rect.width, height: rect.height } :
        { url: cardUrl(player, cardBase), width:1920,height:1080 },
      transform:{...FIT,positionX:rect.x,positionY:rect.y,boundsWidth:rect.width,boundsHeight:rect.height}
    } : null,
    hideCard: !includeCards && card ? card : null
  };
}

// Index that puts the card directly under the camera (0 is the bottom).
export function cardIndex(card, camera) {
  if (card.sceneItemIndex > camera.sceneItemIndex) return camera.sceneItemIndex;
  return camera.sceneItemIndex - 1;
}

async function applySlot(obs, plan) {
  const { scene, camera, card, hideCard } = plan;
  // Name first: if anything stops halfway, a camera never shows one player's
  // stream under another player's name.
  if (camera.item.sourceName !== camera.name) {
    await obs.request('SetInputName', { inputName: camera.item.sourceName, newInputName: camera.name });
  }
  await obs.request('SetInputSettings', {
    inputName: camera.name, inputSettings: camera.settings, overlay: true
  });
  await obs.request('SetSceneItemTransform', {
    sceneName: scene, sceneItemId: camera.item.sceneItemId, sceneItemTransform: camera.transform
  });
  if (hideCard) {
    await obs.request('SetSceneItemEnabled', {
      sceneName: scene, sceneItemId: hideCard.sceneItemId, sceneItemEnabled: false
    });
  }
  if (!card) return;
  let cardId;
  if (card.item) {
    cardId = card.item.sceneItemId;
    await obs.request('SetInputSettings', {
      inputName: card.item.sourceName, inputSettings: card.settings, overlay: true
    });
    if (card.item.sourceName !== card.name) {
      await obs.request('SetInputName', { inputName: card.item.sourceName, newInputName: card.name });
    }
    await obs.request('SetSceneItemEnabled', { sceneName: scene, sceneItemId: cardId, sceneItemEnabled: true });
    if (card.item.sceneItemIndex !== camera.item.sceneItemIndex - 1) {
      await obs.request('SetSceneItemIndex', {
        sceneName: scene, sceneItemId: cardId, sceneItemIndex: cardIndex(card.item, camera.item)
      });
    }
  } else {
    ({ sceneItemId: cardId } = await obs.request('CreateInput', {
      sceneName: scene, inputName: card.name, inputKind: 'browser_source',
      inputSettings: card.settings, sceneItemEnabled: true
    }));
    // New items land on top; moving to the camera's index lifts the camera.
    await obs.request('SetSceneItemIndex', {
      sceneName: scene, sceneItemId: cardId, sceneItemIndex: camera.item.sceneItemIndex
    });
  }
  await obs.request('SetSceneItemTransform', { sceneName: scene, sceneItemId: cardId, sceneItemTransform: card.transform });
}

// match: { players: [{ slot, team, nick, id, room }], includeCards, cardBase }.
export async function applyMatch(obs, match, onProgress = () => {}) {
  const plans = [];
  for (const player of match.players) {
    let items;
    try {
      ({ sceneItems: items } = await obs.request('GetSceneItemList', { sceneName: `Игрок ${player.slot}` }));
    } catch {
      throw new Error(`В OBS нет сцены «Игрок ${player.slot}». Импортируй коллекцию из JSON один раз.`);
    }
    plans.push(slotPlan(items, player, match));
  }
  for (const [index, plan] of plans.entries()) {
    await applySlot(obs, plan);
    onProgress(index + 1, plans.length);
  }
  return { slots: plans.length, cards: plans.filter(p => p.card).length };
}

// The veto overlay (assets/veto-overlay/overlay.html) listens for this obs-browser event.
export function emitVeto(obs, state) {
  return obs.request('CallVendorRequest', {
    vendorName: 'obs-browser', requestType: 'emit_event',
    requestData: { event_name: VETO_EVENT, event_data: state }
  });
}
