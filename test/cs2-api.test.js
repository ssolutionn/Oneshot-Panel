import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCs2, handleCs2, keepRaw, loadToken } from '../server/cs2-api.js';
import { packet, readPackets, rconExec, sayCommand } from '../server/cs2-rcon.js';

const TOKEN = 'T'.repeat(24);
const A = '"nick1<2><[U:1:111]><CT>"', B = '"nick2<3><[U:1:222]><TERRORIST>"';

async function withApi(run, options = {}) {
  const sent = [];
  const cs2 = createCs2({
    token: TOKEN, env: { CS2_RCON_PASSWORD: 'pw', ...(options.env || {}) },
    rcon: options.rcon || (async config => { sent.push(config.command); return ''; })
  });
  const server = http.createServer(async (req, res) => { if (!await handleCs2(req, res, cs2)) { res.writeHead(404); res.end('x'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const call = (method, url, { headers = {}, body, host = `127.0.0.1:${port}` } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host, ...headers } }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  try { await run({ call, cs2, sent, port }); } finally { await new Promise(resolve => server.close(resolve)); }
}
const logBody = `L 10/20/2026 - 18:31:05: World triggered "Match_Start" on "de_mirage"
L 10/20/2026 - 18:31:06: World triggered "Round_Start"
L 10/20/2026 - 18:31:09: ${A} say "ping"
L 10/20/2026 - 18:31:12: ${A} [1 2 3] killed ${B} [4 5 6] with "ak47" (headshot)
`;

test('log in, journal out: the CS2 server posts with the token, the panel reads', async () => {
  await withApi(async ({ call }) => {
    assert.equal((await call('POST', `/api/cs2-log?token=${TOKEN}`, { body: logBody })).status, 200);
    const status = (await call('GET', '/api/cs2-status')).json();
    assert.deepEqual([status.ok, status.rcon, status.map, status.round, status.lines], [true, true, 'de_mirage', 1, 4]);
    const events = (await call('GET', '/api/cs2-events?since=0')).json();
    assert.deepEqual(events.events.map(e => e.type), ['match_start', 'round_start', 'chat', 'kill']);
    const next = (await call('GET', `/api/cs2-events?since=${events.events[2].seq}`)).json();
    assert.deepEqual(next.events.map(e => e.type), ['kill']);
    const text = (await call('GET', '/api/cs2-round?n=1')).text;
    assert.match(text, /nick1 \(CT\) убил nick2 \(T\) · ak47 · хедшот/);
    const setup = (await call('GET', '/api/cs2-setup')).json();
    assert.match(setup.commands[0], /^logaddress_add_http "http:\/\/127\.0\.0\.1:3000\/api\/cs2-log\?token=T{24}"$/);
    assert.deepEqual(setup.commands.slice(1), ['mp_logdetail 3', 'log on']);
  });
});

test('CS2_RAW_LOG keeps what the server sent, and only that', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2raw-'));
  const file = path.join(dir, 'sub', 'raw.log');
  try {
    const cs2 = createCs2({ token: TOKEN, rawLog: file });
    const server = http.createServer((req, res) => handleCs2(req, res, cs2));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const post = body => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api/cs2-log?token=${body.token || TOKEN}`, method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(body.text);
    });
    assert.equal(await post({ text: 'L 10/20/2026 - 18:31:05: odd line' }), 200);
    assert.equal(await post({ text: 'refused', token: 'wrong' }), 403);
    await new Promise(resolve => server.close(resolve));
    assert.equal(fs.readFileSync(file, 'utf8'), 'L 10/20/2026 - 18:31:05: odd line\n');
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    keepRaw('', 'nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a request the URL parser refuses does not take the server down', async () => {
  const cs2 = createCs2({ token: TOKEN });
  const server = http.createServer(async (req, res) => { if (!await handleCs2(req, res, cs2)) { res.writeHead(404); res.end('x'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const raw = text => new Promise(resolve => {
    const socket = net.connect(server.address().port, '127.0.0.1', () => socket.write(text));
    let got = '';
    socket.on('data', d => { got += d; });
    socket.on('close', () => resolve(got));
    setTimeout(() => socket.destroy(), 300);
  });
  try {
    for (const target of ['http://[::1', 'http://', '//[', 'http://a b/']) await raw(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    const answer = await raw('GET /api/cs2-status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.match(answer, /^HTTP\/1\.1 (200|403)/, 'still answering');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('the log endpoint refuses a wrong or missing token and other methods', async () => {
  await withApi(async ({ call, cs2 }) => {
    for (const url of ['/api/cs2-log', '/api/cs2-log?token=wrong', `/api/cs2-log?token=${TOKEN}x`])
      assert.equal((await call('POST', url, { body: logBody })).status, 403, url);
    assert.equal((await call('GET', `/api/cs2-log?token=${TOKEN}`)).status, 405);
    assert.equal(cs2.journal.lines, 0);
  });
});

test('the panel side is local only: a foreign Host (DNS rebinding) is refused', async () => {
  await withApi(async ({ call, port }) => {
    for (const host of ['evil.example', `evil.example:${port}`, '192.168.1.5:3000'])
      assert.equal((await call('GET', '/api/cs2-status', { host })).status, 403, host);
    assert.equal((await call('GET', '/api/cs2-status', { host: `localhost:${port}` })).status, 200);
    assert.equal((await call('GET', '/api/cs2-status', { host: `[::1]:${port}` })).status, 200);
  });
});

test('CS2_ALLOW_REMOTE lets other hosts in only with the token', async () => {
  await withApi(async ({ call }) => {
    assert.equal((await call('GET', '/api/cs2-status', { host: '192.168.1.5:3000' })).status, 403);
    assert.equal((await call('GET', `/api/cs2-status?token=${TOKEN}`, { host: '192.168.1.5:3000' })).status, 200);
    assert.equal((await call('GET', '/api/cs2-status', { host: '192.168.1.5:3000', headers: { 'x-oneshot-token': TOKEN } })).status, 200);
    assert.equal((await call('GET', '/api/cs2-status?token=nope', { host: '192.168.1.5:3000' })).status, 403);
  }, { env: { CS2_ALLOW_REMOTE: '1' } });
});

test('say: only a same-origin JSON request reaches RCON, and nothing can ride along', async () => {
  await withApi(async ({ call, sent, port }) => {
    const json = { 'content-type': 'application/json' };
    const say = (text, headers = {}) => call('POST', '/api/cs2-say', { headers: { ...json, 'sec-fetch-site': 'same-origin', ...headers }, body: JSON.stringify({ text }) });
    assert.equal((await say('hello')).status, 200);
    assert.deepEqual(sent, ['say hello']);
    // A website open in the same browser: cross-site, or a plain form post (no JSON type).
    assert.equal((await say('x', { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await call('POST', '/api/cs2-say', { headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' }, body: '{"text":"x"}' })).status, 403);
    assert.equal((await call('POST', '/api/cs2-say', { headers: { ...json, origin: 'http://evil.example' }, body: '{"text":"x"}' })).status, 403);
    assert.equal((await call('POST', '/api/cs2-say', { headers: { ...json, origin: `http://127.0.0.1:${port}` }, body: '{"text":"old browser"}' })).status, 200);
    assert.equal((await call('POST', '/api/cs2-say', { headers: json, body: '{"text":"no origin at all"}' })).status, 403);
    assert.equal((await say('')).status, 400);
    assert.equal((await call('POST', '/api/cs2-say', { headers: { ...json, 'sec-fetch-site': 'same-origin' }, body: 'not json' })).status, 400);
    assert.deepEqual(sent, ['say hello', 'say old browser']);
    await say('gg"; rcon_password hacked; say "x\nquit');
    assert.ok(!sent.at(-1).includes(';') && !sent.at(-1).includes('\n') && !sent.at(-1).includes('"'), sent.at(-1));
    assert.ok(sent.at(-1).startsWith('say '));
  });
});

test('say: a server that is down or refuses the password says so in words', async () => {
  await withApi(async ({ call }) => {
    const res = await call('POST', '/api/cs2-say', { headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{"text":"hi"}' });
    assert.equal(res.status, 502);
    assert.equal(res.json().error, 'Неверный пароль RCON.');
  }, { rcon: async () => { throw new Error('Неверный пароль RCON.'); } });
});

test('token: from the environment, or made once and kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2-'));
  try {
    assert.equal(loadToken({ env: { CS2_LOG_TOKEN: 'a'.repeat(20) }, dir }), 'a'.repeat(20));
    assert.throws(() => loadToken({ env: { CS2_LOG_TOKEN: 'short' }, dir }), /CS2_LOG_TOKEN/);
    const made = loadToken({ env: {}, dir });
    assert.match(made, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(loadToken({ env: {}, dir }), made);
    assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o077, 0, 'the token file is private');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- RCON against a fake CS2 server ----
function fakeRcon({ password = 'pw', reply = 'ok', split = false } = {}) {
  const commands = [];
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      const read = readPackets(Buffer.concat([buffer, chunk]));
      buffer = read.rest;
      for (const p of read.packets) {
        if (p.type === 3) {
          socket.write(packet(p.id, 0, ''));
          socket.write(packet(p.body === password ? p.id : -1, 2, ''));
        } else if (p.type === 2) {
          commands.push(p.body);
          const whole = packet(p.id, 0, reply);
          if (split) { socket.write(whole.subarray(0, 7)); setTimeout(() => socket.write(whole.subarray(7)), 20); } else socket.write(whole);
        }
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, commands, port: server.address().port })));
}

test('RCON: authenticates, runs the command, reads the answer (also in pieces)', async () => {
  for (const split of [false, true]) {
    const { server, commands, port } = await fakeRcon({ reply: 'sent', split });
    try {
      assert.equal(await rconExec({ port, password: 'pw', command: 'say hello', settle: 50 }), 'sent');
      assert.deepEqual(commands, ['say hello']);
    } finally { server.close(); }
  }
});

test('RCON: wrong password, nobody listening, no password, a silent server', async () => {
  const { server, commands, port } = await fakeRcon({ password: 'other' });
  try {
    await assert.rejects(rconExec({ port, password: 'pw', command: 'say x' }), /Неверный пароль RCON/);
    assert.deepEqual(commands, [], 'nothing runs without a good login');
  } finally { server.close(); }
  const closed = net.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const free = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(rconExec({ port: free, password: 'pw', command: 'x' }), /RCON недоступен/);
  await assert.rejects(rconExec({ port: free, password: '', command: 'x' }), /CS2_RCON_PASSWORD/);
  const silent = net.createServer(() => {});
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(rconExec({ port: silent.address().port, password: 'pw', command: 'x', timeout: 150 }), /не отвечает/); }
  finally { silent.close(); }
});

test('RCON packets: framing and the say command', () => {
  const bytes = packet(7, 2, 'say hi');
  assert.equal(bytes.readInt32LE(0), bytes.length - 4);
  assert.deepEqual(readPackets(bytes).packets, [{ id: 7, type: 2, body: 'say hi' }]);
  assert.equal(readPackets(bytes.subarray(0, 9)).packets.length, 0);
  assert.throws(() => readPackets(Buffer.from([255, 255, 255, 127, 0, 0, 0, 0])), /неверный пакет/);
  assert.equal(sayCommand('  привет, зал  '), 'say привет, зал');
  assert.equal(sayCommand('a'.repeat(500)).length, 4 + 180);
  assert.throws(() => sayCommand(' \n '), /Пустое/);
});
