import {openPublicSocket} from './bookmaker-transport.js';
// Winline's anonymous public line protocol, observed on 16 October 2026.
// No account, betting commands or stored socket/session identifiers.
const MAX_COMPRESSED = 2 * 1024 * 1024, MAX_PLAIN = 12 * 1024 * 1024;
class Reader {
  constructor(bytes, offset = 0) {
    this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset; this.decoder = new TextDecoder('utf-8');
  }
  take(n) {
    if (!Number.isInteger(n) || n < 0 || this.offset + n > this.bytes.length) throw new Error('Неполный пакет Winline.');
    const start = this.offset; this.offset += n; return start;
  }
  u8() { return this.view.getUint8(this.take(1)); }
  u16() { return this.view.getUint16(this.take(2), true); }
  u32() { return this.view.getUint32(this.take(4), true); }
  text() { const n = this.u16(), start = this.take(n); return this.decoder.decode(this.bytes.subarray(start, start + n)); }
}
export function winlineDictionary(bytes) {
  const r = new Reader(bytes);
  if (r.u16() !== 16) throw new Error('Неизвестный словарь Winline.');
  const sports = r.u32();
  if (sports > 1000) throw new Error('Слишком большой словарь Winline.');
  for (let i = 0; i < sports; i++) {
    r.u32(); r.u32();
    for (let j = 0; j < 10; j++) r.text();
  }
  const count = r.u32(), markets = new Map();
  if (count > 20000) throw new Error('Слишком большой словарь Winline.');
  for (let i = 0; i < count; i++) {
    const id = r.u32(); r.text(); r.u32(); r.u32();
    const type = r.u32(), title = r.text(), outcomes = [];
    for (let j = 0; j < 30; j++) outcomes.push(r.text());
    markets.set(id, {id, type, title, outcomes});
  }
  // The dictionary has an extension after the market table; it is not needed.
  return markets;
}
const cyber = text => /cyber\s*clash|кибер\s*клэш/i.test(text);
const price = n => n > 100 && n < 65535 ? n / 100 : null;
export function winlineSnapshot(bytes, markets) {
  const r = new Reader(bytes), events = [];
  if (r.u16() !== 3) throw new Error('Неизвестный снимок Winline.');
  r.take(16);
  let championship = null, event = null, cyberSeen = false;
  while (r.offset < bytes.length) {
    const tag = r.u8();
    if (tag === 1) {
      r.u32(); r.u32(); r.text(); r.u32(); r.u8(); r.u16(); r.u16(); r.u8();
    } else if (tag === 2 || tag === 21) {
      const id = r.u32(), sport = r.u32(); r.u32();
      const name = r.text();
      r.u32(); r.u32(); r.u32(); r.u8(); r.u32(); r.u32();
      championship = {id, sport, name}; event = null;
      if (sport === 205 && cyber(name)) cyberSeen = true;
    } else if (tag === 3) {
      const id = r.u32(); r.u32(); r.u32(); r.u8(); r.u8();
      const liveOffered = !!r.u8(); r.u8(); r.u16(); r.text();
      const start = r.u32(), count = r.u8(); r.u8();
      const team1 = r.text(), team2 = r.text();
      event = championship?.sport === 205 && cyber(championship.name) ? {
        id: String(id), group: String(championship.id), tournament: championship.name,
        // The official client sets TZ_OFFSET_MS=10800000 and rounds to a minute.
        team1, team2, start: start ? Math.floor((start * 1000 + 29999 - 10800000) / 60000) * 60000 : null, odds: [null, null],
        live: false, liveOffered, markets: [], size: count ? {count, unit:'доп. рынков'} : null
      } : null;
      if (event) events.push(event);
    } else if (tag === 4) {
      r.u32();
      const market = markets.get(r.u16()); r.u16(); r.u16();
      if (!market) throw new Error('Неизвестный рынок Winline.');
      let favorite = null, parameter = null;
      if ([3,6].includes(market.type)) { favorite = r.u8(); parameter = r.u16(); }
      else if ([4,7,61,71].includes(market.type)) parameter = r.u16();
      const quotes = [r.u16(), r.u16()];
      if ([2,5,51].includes(market.type)) quotes.push(r.u16());
      else if (market.type === 9) quotes.push(r.u16(), r.u16());
      if (!event) continue;
      const odds = quotes.slice(0,2).map(price);
      if (market.id === 1366) event.odds = odds;
      else if (market.id === 1422) event.markets.push({
        kind:'total', name:'Тотал карт', line:String(parameter / 100), odds
      });
      else if (market.id === 1423 && [0,1,2].includes(favorite)) event.markets.push({
        kind:'handicap', name:'Фора карт',
        line:String((favorite === 1 ? -1 : 1) * parameter / 100), odds
      });
    } else {
      // Never scan past unknown bytes and accidentally invent a valid event.
      throw new Error('Формат снимка Winline изменился.');
    }
  }
  // The CyberClash championship was in the snapshot but no event survived tag 3:
  // its field layout changed (a name now parses as garbage, not as our match).
  // That is a feed error, never a proven «в линии нет» (parseFeed's contract).
  if (cyberSeen && !events.length) throw new Error('Формат снимка Winline изменился.');
  return events;
}
async function inflate(input) {
  const bytes = input instanceof Uint8Array ? input :
    input instanceof ArrayBuffer ? new Uint8Array(input) :
    typeof Blob !== 'undefined' && input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : null;
  if (!bytes || bytes.length < 2 || bytes.length > MAX_COMPRESSED) throw new Error('Некорректный пакет Winline.');
  if (bytes[0] !== 31 || bytes[1] !== 139) return bytes;
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_PLAIN) throw new Error('Слишком большой пакет Winline.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const output = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
export async function readWinline(fetchImpl, timeoutMs = 18000) {
  let socket, timer;
  const opened = Date.now();
  try {
    socket = await openPublicSocket('https://wss.winline.ru/data_ng?client=newsite&nb=true',
      fetchImpl, timeoutMs, {Origin:'https://winline.ru'});
    socket.accept();
    return await new Promise((resolve, reject) => {
      const packets = new Map(); let chain = Promise.resolve(), finished = false, received = 0, receivedBytes = 0;
      const finish = (error, value) => {
        if (finished) return; finished = true; clearTimeout(timer);
        socket.removeEventListener('message', message);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', closed);
        try { socket.close(1000, 'snapshot received'); } catch { /* already closed */ }
        if (error) reject(error); else resolve(value);
      };
      const failed = () => finish(new Error('Winline: нет связи.'));
      const closed = () => finish(new Error('Winline: поток закрыт до получения линии.'));
      const message = event => {
        if (finished) return;
        receivedBytes += event.data?.byteLength || event.data?.size || (typeof event.data === 'string' ? event.data.length : 0);
        if (receivedBytes > 8 * 1024 * 1024) return finish(new Error('Слишком большой поток Winline.'));
        if (++received > 80) return finish(new Error('Winline: снимок линии не получен.'));
        chain = chain.then(async () => {
          if (finished || typeof event.data === 'string') return;
          const bytes = await inflate(event.data), kind = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0,true);
          if (kind === 3 || kind === 16) packets.set(kind, bytes);
          if (packets.has(3) && packets.has(16))
            finish(null, winlineSnapshot(packets.get(3), winlineDictionary(packets.get(16))));
        }).catch(error => finish(error));
      };
      socket.addEventListener('message', message);
      socket.addEventListener('error', failed);
      socket.addEventListener('close', closed);
      timer = setTimeout(() => finish(new Error('Winline: долго не отвечает.')), Math.max(1, timeoutMs - (Date.now() - opened)));
      for (const command of ['lang', 'AA==', 'data', 'WINLINE', 'getdate']) socket.send(command);
    });
  } finally { clearTimeout(timer); try { socket?.close(); } catch { /* closed */ } }
}
