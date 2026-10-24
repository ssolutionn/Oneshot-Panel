// Source RCON over TCP (CS2 uses the same protocol as CS:GO), no dependencies.
// One short connection per command: authenticate, run, read the answer, close.
// The password stays on this computer; only a few fixed commands are sent.
import net from 'node:net';

const AUTH = 3, EXEC = 2, AUTH_RESPONSE = 2, VALUE = 0;
export function packet(id, type, body) {
  const text = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(14 + text.length);
  out.writeInt32LE(10 + text.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  text.copy(out, 12);
  return out;
}
// Splits what arrived into whole packets and the unfinished rest.
export function readPackets(buffer) {
  const packets = [];
  let at = 0;
  while (buffer.length - at >= 4) {
    const size = buffer.readInt32LE(at);
    if (size < 10 || size > 8192) throw new Error('Сервер прислал неверный пакет RCON.');
    if (buffer.length - at < 4 + size) break;
    packets.push({ id: buffer.readInt32LE(at + 4), type: buffer.readInt32LE(at + 8), body: buffer.toString('utf8', at + 12, at + 4 + size - 2) });
    at += 4 + size;
  }
  return { packets, rest: buffer.subarray(at) };
}

// Resolves the command's answer text. Rejects with a message fit for the screen.
export function rconExec({ host = '127.0.0.1', port = 27015, password, command, timeout = 4000, settle = 300 }) {
  return new Promise((resolve, reject) => {
    if (!password) return reject(new Error('Пароль RCON не задан (переменная CS2_RCON_PASSWORD).'));
    const socket = net.connect({ host: host || '127.0.0.1', port: Number(port) || 27015 });
    let pending = Buffer.alloc(0), authed = false, answer = '', timer, finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    timer = setTimeout(() => done(new Error('Сервер CS2 не отвечает по RCON.')), timeout);
    socket.on('error', error => done(new Error(error.code === 'ECONNREFUSED' ? 'RCON недоступен: сервер выключен или порт закрыт.' : 'Ошибка RCON: ' + error.message)));
    socket.on('close', () => done(authed ? null : new Error('Сервер закрыл RCON до ответа.'), answer));
    socket.on('connect', () => socket.write(packet(1, AUTH, password)));
    socket.on('data', chunk => {
      let read;
      try { read = readPackets(Buffer.concat([pending, chunk])); } catch (error) { return done(error); }
      pending = read.rest;
      for (const p of read.packets) {
        if (p.type === AUTH_RESPONSE && !authed) {
          if (p.id === -1) return done(new Error('Неверный пароль RCON.'));
          authed = true;
          socket.write(packet(2, EXEC, command));
        } else if (authed && p.type === VALUE && p.id === 2) {
          answer += p.body;
          // A long answer comes in several packets: wait a moment for more.
          clearTimeout(timer);
          timer = setTimeout(() => done(null, answer), settle);
        }
      }
    });
  });
}

// A chat line the server shows as «Console: …». No command can ride along.
export function sayCommand(text) {
  const clean = String(text ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/"/g, "'").replace(/;/g, ',').replace(/\\/g, '/').trim().slice(0, 180);
  if (!clean) throw new Error('Пустое сообщение.');
  return `say ${clean}`;
}
