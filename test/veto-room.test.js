import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom, decodeLink, encodeLink, roomSecrets, captainKey, acceptKey, fingerprint, publicPoint,
  signMove, verifyLog, replay, nextTurn, mergeLog, clock, formatClock, mapBoard, resultText,
  captainMessage, spectatorMessage, signRoomMessage, verifyRoomMessage, coinCommit, coinNonce
} from '../veto-room.js';

const BASE = 'https://oneshot-panel.pages.dev/veto.html';
const b64 = bytes => Buffer.from(bytes).toString('base64url');

async function seats(format = 'BO3') {
  const { links, room } = await createRoom(BASE, ['UPGRADE', 'Lavked'], format);
  const a = decodeLink(new URL(links.a).hash), b = decodeLink(new URL(links.b).hash);
  const s = decodeLink(new URL(links.s).hash);
  const ka = await captainKey(a), kb = await captainKey(b);
  // Public keys travel with the captains' messages: everyone learns both.
  for (const room of [a, b, s]) {
    for (const team of [0, 1]) assert.ok(await acceptKey(room, team, (team ? b : a).p[team]));
  }
  return { room, links, a, b, s, ka, kb };
}
// The coin: A commits to a nonce, B adds a seed, A reveals. With fixed
// nonce and seed the winner is (nonce[0] ^ seed[0]) & 1.
async function tossCoin({ a, b, ka, kb }, winner = 0, log = []) {
  const nonce = b64(Buffer.alloc(16, 0)), seed = b64(Buffer.alloc(16, winner));
  log = await signMove(a, log, ka, 'commit', await coinCommit(a, nonce));
  log = await signMove(b, log, kb, 'seed', seed);
  return signMove(a, log, ka, 'reveal', nonce);
}

test('links: short; each captain gets their own secret, spectators none', async () => {
  const { links, a, b, s, room } = await seats();
  assert.equal(a.me, 'a');
  assert.equal(b.me, 'b');
  assert.equal(s.me, 's');
  assert.equal(s.k, undefined);
  assert.notEqual(a.k, b.k);
  assert.deepEqual(a.fp, s.fp);
  assert.deepEqual(a.t, ['UPGRADE', 'Lavked']);
  assert.equal(a.f, 'BO3');
  assert.ok(links.a.startsWith(BASE + '#v='));
  assert.ok(links.a.length < 150, `captain link ${links.a.length} chars`);
  assert.ok(links.s.length < 125, `spectator link ${links.s.length} chars`);
  assert.deepEqual(a.p, room.p, 'the captain key from the secret is the one the admin made');
  assert.equal(decodeLink('#v=broken'), null);
  assert.equal(decodeLink(''), null);
  assert.equal(decodeLink('#v=' + new URL(links.a).hash.slice(3, 40)), null, 'cut link');
  assert.equal(await captainKey(s), null);
  await assert.rejects(createRoom(BASE, ['A', 'A'], 'BO3'), /две разные/);
  await assert.rejects(createRoom(BASE, ['A', 'B'.repeat(61)], 'BO3'), /длинное/);
  // Unicode and HTML in names survive the round trip.
  const odd = await createRoom(BASE, ['Honvéd', '<b>A"B</b>'], 'BO1');
  assert.deepEqual(decodeLink(new URL(odd.links.s).hash).t, ['Honvéd', '<b>A"B</b>']);
  assert.equal(encodeLink(BASE, s), links.s);
  // The admin's link: a spectator that also gets the HLTV text; no secret.
  const o = decodeLink(new URL(links.o).hash);
  assert.equal(o.me, 'o');
  assert.equal(o.k, undefined);
  assert.equal(await captainKey(o), null);
  assert.equal(new Set(Object.values(links)).size, 4);
});

test('room envelopes prove captain identity on a reverse data channel', async () => {
  const { a, s, ka } = await seats('BO1');
  const now = Date.now();
  const body = { t: 'log', log: [], p: a.p.map(point => point ? [...point] : point), call: now - 1000 };
  const message = await signRoomMessage(a, ka, body, now);
  assert.equal(message.from, 'a');
  assert.equal(await verifyRoomMessage(s, message, now + 1000), true);

  assert.equal(await verifyRoomMessage(s, { ...message, from: 'b' }, now), false);
  assert.equal(await verifyRoomMessage(s, { ...message, call: now }, now), false);
  assert.equal(await verifyRoomMessage(s, { ...message, log: [{ k: 'ban' }] }, now), false);
  assert.equal(await verifyRoomMessage(s, { ...message, at: now - 11 * 60000 }, now), false);
  assert.equal(await verifyRoomMessage(s, { ...message, proof: 'broken' }, now), false);
});

test('timer: in the link, 5 minutes by default, 0 for none', async () => {
  const plain = await createRoom(BASE, ['A1', 'B1'], 'BO1');
  assert.equal(decodeLink(new URL(plain.links.b).hash).m, 5);
  for (const minutes of [3, 7, 10, 15, 0]) {
    const made = await createRoom(BASE, ['A1', 'B1'], 'BO5', minutes);
    const room = decodeLink(new URL(made.links.s).hash);
    assert.equal(room.m, minutes);
    assert.equal(room.f, 'BO5');
  }
  await assert.rejects(createRoom(BASE, ['A1', 'B1'], 'BO1', 4), /таймер/);
  assert.equal(clock({ startedAt: 0 }, 150000, 3).left, 30000);
});

test('captain key: a damaged secret or a foreign key is refused', async () => {
  const { links, a, s } = await seats();
  const bytes = Buffer.from(new URL(links.a).hash.slice(3), 'base64url');
  bytes[32] ^= 1; // the captain's secret starts after version, flags, room and two fingerprints
  const broken = decodeLink('#v=' + b64(bytes));
  await assert.rejects(captainKey(broken), /не подходит/);
  const other = await seats();
  const fresh = decodeLink(new URL(links.s).hash);
  assert.equal(await acceptKey(fresh, 0, other.a.p[0]), false, 'another room’s key');
  assert.equal(await acceptKey(fresh, 0, ['x', 'y']), false);
  assert.equal(fresh.p[0], null);
  assert.equal(await acceptKey(fresh, 0, a.p[0]), true);
  assert.equal(await acceptKey(fresh, 0, other.a.p[0]), false, 'a known key is not replaced');
  assert.deepEqual(s.p, a.p);
});

test('P-256: public points from private scalars match WebCrypto', async () => {
  for (let i = 0; i < 3; i++) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const d = BigInt('0x' + Buffer.from(jwk.d, 'base64url').toString('hex'));
    const [x, y] = publicPoint(d).map(n => b64(Buffer.from(n.toString(16).padStart(64, '0'), 'hex')));
    assert.deepEqual([x, y], [jwk.x, jwk.y]);
    assert.equal((await fingerprint([x, y])).length, 14);
  }
});

test('room secrets: derived from the code, the code stays out', async () => {
  const { a, b } = await seats();
  const sa = await roomSecrets(a), sb = await roomSecrets(b);
  assert.deepEqual(sa.streams, sb.streams);
  assert.equal(sa.password, sb.password);
  assert.notEqual(sa.streams[0], sa.streams[1]);
  assert.ok(!sa.streams.join().includes(a.r) && !sa.password.includes(a.r));
});

test('coin: tossed in the room by both captains; the nonce must match its commitment', async () => {
  const seat = await seats('BO1');
  const { a, b, s, ka, kb } = seat;
  assert.deepEqual(nextTurn(s, replay(s, [])), { kind: 'commit', team: 0 });
  await assert.rejects(signMove(b, [], kb, 'commit', 'x'), /не твой ход/);
  const nonce = coinNonce();
  let log = await signMove(a, [], ka, 'commit', await coinCommit(a, nonce));
  assert.deepEqual(nextTurn(s, replay(s, log)), { kind: 'seed', team: 1 });
  log = await signMove(b, log, kb, 'seed', coinNonce());
  await assert.rejects(signMove(a, log, ka, 'reveal', coinNonce()), /не сходится/);
  const honest = await signMove(a, log, ka, 'reveal', nonce);
  const state = replay(s, honest);
  assert.ok([0, 1].includes(state.coin));
  assert.deepEqual(nextTurn(s, state), { kind: 'order', team: state.coin });
  assert.equal((await verifyLog(s, honest)).length, 3);
  // A reveal that does not open the commitment is cut off even when signed.
  const forgedReveal = [...log, { ...honest[2], v: coinNonce() }];
  assert.equal((await verifyLog(s, forgedReveal)).length, 2);
  // Fixed parts: the winner is (nonce ^ seed) & 1.
  for (const winner of [0, 1]) {
    assert.equal(replay(s, await tossCoin(seat, winner)).coin, winner);
  }
});

test('BO3: coin winner orders, picks get the opponent\'s side, decider is left', async () => {
  const seat = await seats('BO3');
  const { a, b, s, ka, kb } = seat;
  let log = await tossCoin(seat, 1);
  assert.deepEqual(nextTurn(s, replay(s, log)), { kind: 'order', team: 1 });
  await assert.rejects(signMove(a, log, ka, 'order', '0'), /не твой ход/);
  log = await signMove(b, log, kb, 'order', '0'); // Lavked gives UPGRADE the first ban
  log = await signMove(a, log, ka, 'ban', 'Ancient');
  log = await signMove(b, log, kb, 'ban', 'Anubis');
  log = await signMove(a, log, ka, 'pick', 'Mirage');
  assert.deepEqual(nextTurn(s, replay(s, log)), { kind: 'side', team: 1 });
  await assert.rejects(signMove(a, log, ka, 'side', 'CT'), /не твой ход/);
  log = await signMove(b, log, kb, 'side', 'CT');
  log = await signMove(b, log, kb, 'pick', 'Nuke');
  log = await signMove(a, log, ka, 'side', 'T');
  log = await signMove(a, log, ka, 'ban', 'Cache');
  await assert.rejects(signMove(b, log, kb, 'ban', 'Cache'), /уже выбрана/);
  log = await signMove(b, log, kb, 'ban', 'Dust2');

  const verified = await verifyLog(s, JSON.parse(JSON.stringify(log)));
  assert.equal(verified.length, log.length);
  const state = replay(s, verified);
  assert.equal(nextTurn(s, state).kind, 'done');
  assert.equal(resultText(s, state), [
    'UPGRADE removed Ancient', 'Lavked removed Anubis',
    'UPGRADE pick Mirage (Lavked CT)', 'Lavked pick Nuke (UPGRADE T)',
    'UPGRADE removed Cache', 'Lavked removed Dust2', 'Inferno was left over'
  ].join('\n'));
  const board = mapBoard(s, state);
  assert.deepEqual(board.find(m => m.map === 'Inferno'), { map: 'Inferno', status: 'decider' });
  assert.deepEqual(board.find(m => m.map === 'Mirage'),
    { map: 'Mirage', status: 'pick', team: 0, side: 'CT', sideTeam: 1 });
});

test('verifyLog: forged, edited, foreign or unkeyed moves are dropped', async () => {
  const seat = await seats('BO1');
  const { b, s, kb } = seat;
  let log = await tossCoin(seat, 1);
  log = await signMove(b, log, kb, 'order', '1');
  log = await signMove(b, log, kb, 'ban', 'Nuke');
  const other = await seats('BO1');
  const stolen = await tossCoin(other, 0);
  assert.equal((await verifyLog(s, [...log, { k: 'ban', v: 'Mirage', at: Date.now(), s: log[4].s }])).length, 5);
  assert.equal((await verifyLog(s, [{ ...log[0], v: log[0].v.replace(/^./, c => c === 'A' ? 'B' : 'A') }, ...log.slice(1)])).length, 0, 'edited entry');
  assert.equal((await verifyLog(s, stolen)).length, 0, 'other room');
  assert.equal((await verifyLog(s, log.slice(1))).length, 0, 'out of order');
  // A spectator who has not got B's key yet verifies only A's commit.
  const fresh = decodeLink(new URL(seat.links.s).hash);
  await acceptKey(fresh, 0, seat.a.p[0]);
  assert.equal((await verifyLog(fresh, log)).length, 1);
  const checked = new Set();
  await verifyLog(s, log, checked);
  assert.equal((await verifyLog(s, [{ ...log[0], v: 'A'.repeat(43) }], checked)).length, 0, 'cache keys the content');
});

test('mergeLog: only continuations are taken; a second move for a step is a conflict', async () => {
  const seat = await seats('BO1');
  const { a, b, ka, kb } = seat;
  const base = await signMove(a, await tossCoin(seat, 0), ka, 'order', '0');
  const one = await signMove(a, base, ka, 'ban', 'Nuke');
  const two = await signMove(a, base, ka, 'ban', 'Mirage');
  assert.equal(mergeLog(base, one).log, one);
  assert.equal(mergeLog(one, base).log, one);
  // Captain A tries to take back Nuke: the move once seen stays.
  const undo = mergeLog(one, two);
  assert.equal(undo.log, one);
  assert.equal(undo.conflict.index, 4);
  assert.equal(undo.conflict.theirs.v, 'Mirage');
  // Erase: A let B ban first; after B's ban, A publishes another history of
  // the same length («A bans first» plus A's own ban).
  const coin = await tossCoin(seat, 0);
  const replied = await signMove(b, await signMove(a, coin, ka, 'order', '1'), kb, 'ban', 'Ancient');
  const rewritten = await signMove(a, await signMove(a, coin, ka, 'order', '0'), ka, 'ban', 'Nuke');
  assert.equal(mergeLog(replied, rewritten).log, replied);
  assert.equal(mergeLog(replied, rewritten).conflict.index, 3);
  // The same moves with other valid signatures change nothing.
  const resigned = [...base.slice(0, 3), ...(await signMove(a, base.slice(0, 3), ka, 'order', '0', base[3].at)).slice(3)];
  assert.equal(mergeLog(base, resigned).log, base);
  assert.equal(mergeLog(base, resigned).conflict, null);
});

test('replay: move times must be real, in order and close together', async () => {
  const seat = await seats('BO1');
  const { a, b, s, ka, kb } = seat;
  const now = Date.now();
  await assert.rejects(signMove(a, [], ka, 'commit', 'A'.repeat(43), 0), /время/);
  await assert.rejects(signMove(a, [], ka, 'commit', 'A'.repeat(43), 1e300), /время/);
  const base = await signMove(a, [], ka, 'commit', 'A'.repeat(43), now);
  await assert.rejects(signMove(b, base, kb, 'seed', coinNonce(), now - 120000), /время/);
  await assert.rejects(signMove(b, base, kb, 'seed', coinNonce(), now + 7 * 3600000), /время/);
  const ok = await signMove(b, base, kb, 'seed', coinNonce(), now - 30000); // a little clock skew
  assert.equal((await verifyLog(s, ok)).length, 2);
});

test('clock: five minutes from the order choice, then "over"', () => {
  assert.deepEqual(clock({ startedAt: null }, 0), { started: false, left: 300000, over: false });
  assert.equal(clock({ startedAt: 1000 }, 61000).left, 240000);
  assert.equal(clock({ startedAt: 1000 }, 400000).over, true);
  assert.equal(clock({ startedAt: 9000 }, 1000).left, 300000, 'a clock ahead of ours');
  assert.equal(formatClock(300000), '5:00');
  assert.equal(formatClock(61001), '1:02');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(1e300), '99:59');
});

test('captain message: names the team, the coin in the room, warns about the link; EN and RU', async () => {
  const { room, links } = await seats();
  const text = captainMessage(room, 1, links.b);
  assert.match(text, /Капитан \*\*Lavked\*\*/);
  assert.match(text, /Монетку бросите на сайте/);
  assert.match(text, /На всё вето 5 минут/);
  assert.match(text, /никому не пересылай/);
  assert.ok(text.includes(links.b));
  const en = captainMessage({ ...room, m: 0 }, 0, links.a, 'en');
  assert.match(en, /Captain of \*\*UPGRADE\*\*/);
  assert.match(en, /No time limit/);
  assert.match(en, /Do not forward this link/);
  assert.equal(spectatorMessage(room, links.s, 'en'), `Map veto UPGRADE vs Lavked (BO3) live:\n${links.s}`);
});
