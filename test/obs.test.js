import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { ObsClient, obsAuth, applyMatch, slotPlan, cardIndex, emitVeto, VETO_EVENT, loopbackObsUrl } from '../obs.js';
import { cameraViewUrl as viewUrl, cardUrl } from '../core.js';

// A small obs-websocket v5 server: enough of the protocol and of OBS scenes
// to run applyMatch end to end over a real WebSocket.
function mockObs({ password = '', scenes = 10, cameraName = i => `Камера ${i}` } = {}) {
  const state = { inputs: new Map(), scenes: new Map(), log: [], vendor: [] };
  let nextItem = 100;
  for (let i = 1; i <= scenes; i++) {
    const name = cameraName(i);
    state.inputs.set(name, { kind: 'browser_source', settings: { url: '', css: 'keep' } });
    state.scenes.set(`Игрок ${i}`, [
      { sceneItemId: 1, sourceName: 'Фоновый цвет', inputKind: 'color_source_v3', enabled: false },
      { sceneItemId: 2, sourceName: 'Текст (GDI+)', inputKind: 'text_gdiplus_v2', enabled: false },
      { sceneItemId: 4, sourceName: name, inputKind: 'browser_source', enabled: true }
    ]);
  }
  const items = scene => state.scenes.get(scene).map((it, index) => ({ ...it, sceneItemIndex: index }));
  const salt = 'c2FsdA==', challenge = 'Y2hhbGxlbmdl';
  const handlers = {
    GetSceneItemList({ sceneName }) {
      if (!state.scenes.has(sceneName)) throw [600, 'No source was found'];
      return { sceneItems: items(sceneName) };
    },
    SetInputSettings({ inputName, inputSettings, overlay }) {
      const input = state.inputs.get(inputName);
      if (!input) throw [600, 'No input'];
      input.settings = overlay ? { ...input.settings, ...inputSettings } : inputSettings;
    },
    SetInputName({ inputName, newInputName }) {
      if (state.inputs.has(newInputName)) throw [601, 'Name already exists'];
      state.inputs.set(newInputName, state.inputs.get(inputName));
      state.inputs.delete(inputName);
      for (const list of state.scenes.values()) {
        for (const it of list) if (it.sourceName === inputName) it.sourceName = newInputName;
      }
    },
    SetSceneItemTransform({ sceneName, sceneItemId, sceneItemTransform }) {
      state.scenes.get(sceneName).find(it => it.sceneItemId === sceneItemId).transform = sceneItemTransform;
    },
    SetSceneItemEnabled({ sceneName, sceneItemId, sceneItemEnabled }) {
      state.scenes.get(sceneName).find(it => it.sceneItemId === sceneItemId).enabled = sceneItemEnabled;
    },
    CreateInput({ sceneName, inputName, inputKind, inputSettings, sceneItemEnabled }) {
      if (state.inputs.has(inputName)) throw [601, 'Name already exists'];
      state.inputs.set(inputName, { kind: inputKind, settings: inputSettings });
      const sceneItemId = ++nextItem;
      state.scenes.get(sceneName).push({ sceneItemId, sourceName: inputName, inputKind, enabled: sceneItemEnabled });
      return { sceneItemId };
    },
    SetSceneItemIndex({ sceneName, sceneItemId, sceneItemIndex }) {
      const list = state.scenes.get(sceneName);
      const from = list.findIndex(it => it.sceneItemId === sceneItemId);
      const [item] = list.splice(from, 1);
      list.splice(sceneItemIndex, 0, item);
    },
    CallVendorRequest(data) { state.vendor.push(data); return { responseData: {} }; }
  };

  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    const accept = crypto.createHash('sha1')
      .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (value, opcode = 1) => {
      const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      const head = body.length < 126 ? Buffer.from([0x80 | opcode, body.length]) :
        Buffer.concat([Buffer.from([0x80 | opcode, 126]), Buffer.from([body.length >> 8, body.length & 255])]);
      socket.write(Buffer.concat([head, body]));
    };
    const close = code => {
      socket.write(Buffer.from([0x88, 2, code >> 8, code & 255]));
      socket.end();
    };
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        let length = buffer[1] & 127, offset = 2;
        if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length)).map((b, i) => b ^ mask[i % 4]);
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 8) { socket.end(); return; }
        const message = JSON.parse(payload.toString());
        if (message.op === 1) {
          const expected = password && crypto.createHash('sha256').update(
            crypto.createHash('sha256').update(password + salt).digest('base64') + challenge).digest('base64');
          if (password && message.d.authentication !== expected) return close(4009);
          send({ op: 2, d: { negotiatedRpcVersion: 1 } });
        } else if (message.op === 6) {
          const { requestType, requestId, requestData } = message.d;
          state.log.push(requestType);
          try {
            const result = handlers[requestType](requestData) || {};
            send({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData: result.responseData ? {} : result } });
          } catch (error) {
            const [code, comment] = Array.isArray(error) ? error : [500, String(error)];
            send({ op: 7, d: { requestType, requestId, requestStatus: { result: false, code, comment } } });
          }
        }
      }
    });
    socket.on('error', () => {});
    send({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1,
      ...(password ? { authentication: { salt, challenge } } : {}) } });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ state, url: `ws://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const players = (team = 'A', start = 0) => Array.from({ length: 10 }, (_, i) => ({
  slot: i + 1, team: i < 5 ? team : 'B', nick: `nick${start + i}`,
  id: `stream${start + i}`, room: i < 5 ? 'room-a' : 'room-b'
}));
const ordered = (obs, scene) => obs.state.scenes.get(scene).map(it => it.sourceName);

test('obs-websocket password hash follows the protocol', async () => {
  const secret = crypto.createHash('sha256').update('pw' + 'salt').digest('base64');
  const expected = crypto.createHash('sha256').update(secret + 'challenge').digest('base64');
  assert.equal(await obsAuth('pw', 'salt', 'challenge'), expected);
});

test('Sending a match updates cameras and puts cards right under them', async () => {
  const obs = await mockObs({ password: 'secret' });
  const client = await new ObsClient(obs.url, 'secret').connect();
  try {
    const progress = [];
    const match = { players: players(), includeCards: true, cardBase: 'https://panel.example' };
    assert.deepEqual(await applyMatch(client, match, (done, total) => progress.push(`${done}/${total}`)),
      { slots: 10, cards: 10 });
    assert.equal(progress.at(-1), '10/10');
    for (const p of match.players) {
      const slot = String(p.slot).padStart(2, '0');
      const camera = `CAM ${slot} | ${p.team} | ${p.nick}`, card = `CARD ${slot} | ${p.team} | ${p.nick}`;
      assert.deepEqual(ordered(obs, `Игрок ${p.slot}`), ['Фоновый цвет', 'Текст (GDI+)', card, camera]);
      assert.equal(obs.state.inputs.get(camera).settings.url, viewUrl(p));
      assert.equal(obs.state.inputs.get(camera).settings.css, 'keep');
      assert.equal(obs.state.inputs.get(card).settings.url, cardUrl(p, 'https://panel.example'));
      for (const it of obs.state.scenes.get(`Игрок ${p.slot}`).slice(2)) {
        assert.equal(it.transform.boundsWidth, 1296);
        assert.equal(it.transform.boundsType, 'OBS_BOUNDS_SCALE_INNER');
      }
    }
    // Next match: other players, cards switched off. Sources are renamed in
    // place and the old cards are hidden, not deleted.
    const next = { players: players('C', 20), includeCards: false };
    await applyMatch(client, next);
    const scene = obs.state.scenes.get('Игрок 1');
    assert.deepEqual(scene.map(it => it.sourceName).slice(2), ['CARD 01 | A | nick0', 'CAM 01 | C | nick20']);
    assert.equal(scene[2].enabled, false);
    assert.equal(obs.state.inputs.get('CAM 01 | C | nick20').settings.url, viewUrl(next.players[0]));
    // Cards back on: the existing card is reused, renamed and shown again.
    await applyMatch(client, { ...next, includeCards: true });
    assert.deepEqual(ordered(obs, 'Игрок 1').slice(2), ['CARD 01 | C | nick20', 'CAM 01 | C | nick20']);
    assert.equal(obs.state.scenes.get('Игрок 1')[2].enabled, true);
    await emitVeto(client, { maps: [] });
    assert.deepEqual(obs.state.vendor[0], { vendorName: 'obs-browser', requestType: 'emit_event',
      requestData: { event_name: VETO_EVENT, event_data: { maps: [] } } });
  } finally {
    client.close();
    obs.close();
  }
});

test('OBS errors are explained instead of half-applying a match', async () => {
  const obs = await mockObs({ password: 'secret', scenes: 6 });
  await assert.rejects(new ObsClient(obs.url, 'wrong').connect(), /Неверный пароль/);
  await assert.rejects(new ObsClient(obs.url, '').connect(), /пароль/);
  const client = await new ObsClient(obs.url, 'secret').connect();
  try {
    await assert.rejects(applyMatch(client, { players: players() }), /нет сцены «Игрок 7»/);
    // Nothing was changed: scenes are checked before the first update.
    assert.ok(!obs.state.log.includes('SetInputSettings'));
  } finally {
    client.close();
    obs.close();
  }
  await assert.rejects(new ObsClient('ws://127.0.0.1:9', '', { timeout: 2000 }).connect(), /OBS/);
});

test('Card placement keeps the card directly under the camera', () => {
  const camera = { sceneItemIndex: 2 };
  assert.equal(cardIndex({ sceneItemIndex: 4 }, camera), 2);
  assert.equal(cardIndex({ sceneItemIndex: 0 }, camera), 1);
  assert.throws(() => slotPlan([{ inputKind: 'color_source_v3', sourceName: 'x' }], players()[0]), /нет камеры/);
  const plan = slotPlan([
    { inputKind: 'browser_source', sourceName: 'CARD 01 | A | old', sceneItemIndex: 1 },
    { inputKind: 'browser_source', sourceName: 'CAM 01 | A | old', sceneItemIndex: 2 }
  ], players()[0], { includeCards: false });
  assert.equal(plan.camera.item.sourceName, 'CAM 01 | A | old');
  assert.equal(plan.hideCard.sourceName, 'CARD 01 | A | old');
});

test('The dock takes OBS settings from a panel only for its own computer', () => {
  assert.equal(loopbackObsUrl('ws://127.0.0.1:4466'), 'ws://127.0.0.1:4466');
  assert.equal(loopbackObsUrl(' ws://localhost:4455/ '), 'ws://localhost:4455');
  assert.equal(loopbackObsUrl('ws://[::1]:4455'), 'ws://[::1]:4455');
  assert.equal(loopbackObsUrl(''), 'ws://127.0.0.1:4455');
  for (const bad of ['ws://192.168.1.9:4455', 'ws://evil.example:4455', 'ws://127.0.0.1.evil.example:4455',
    'http://127.0.0.1:4455', 'ws://127.0.0.1:4455/x', 'ws://u:p@127.0.0.1:4455', 'ws://127.0.0.1:4455?x', 'nonsense']) {
    assert.throws(() => loopbackObsUrl(bad), /своём компьютере|Неверный адрес/, bad);
  }
});
