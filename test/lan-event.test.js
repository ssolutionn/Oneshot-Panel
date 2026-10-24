import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {
  readZip, collectTeams, rosterLine, normalizeAssets, readAssets, writeAssets, AssetStore, photoOf, logoOf,
  eventCardHtml, eventCardUrl, cardDocs, paletteFrom, DEFAULT_COLORS, splitChunks, ChunkAssembler, docKey, CHUNK, ASSETS_STORE, ownKey
} from '../lan-event.js';
import { parseLanRoster, defaultLineup, seatTeam, lanConfig, buildObs, cardKey } from '../core.js';
import { slotPlan } from '../obs.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

// A ZIP the way Drive or macOS make it, built here: stored and deflated entries.
function zip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, data, method = 8] of files) {
    const raw = Buffer.from(data), packed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x800, 8);
    head.writeUInt16LE(method, 10); head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(nameBytes.length, 28); head.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...locals, centralBuffer, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}
const files = list => list.map(path => ({ path, size: 1, blob: async () => new Blob([path]) }));

test('ZIP: stored and deflated entries are read, folders skipped, UTF-8 names kept', async () => {
  const entries = await readZip(zip([
    ['Event/', '', 0], ['Event/Команда/Ник.png', 'photo-bytes'.repeat(50)], ['Event/Team/logo.png', 'logo', 0]]));
  assert.deepEqual(entries.map(e => e.path), ['Event/Команда/Ник.png', 'Event/Team/logo.png']);
  assert.equal(await (await entries[0].blob()).text(), 'photo-bytes'.repeat(50));
  assert.equal(await (await entries[1].blob()).text(), 'logo');
});

test('ZIP: not an archive, a damaged one and an unknown method are refused in words', async () => {
  await assert.rejects(readZip(new TextEncoder().encode('just text, not a zip file at all').buffer), /не ZIP/);
  const broken = new Uint8Array(zip([['a/b.png', 'x']]));
  broken[0] = 0;
  const [entry] = await readZip(broken.buffer);
  await assert.rejects(entry.blob(), /повреждён/);
  const odd = new Uint8Array(zip([['a/b.png', 'x', 0]]));
  new DataView(odd.buffer).setUint16(10, 99, true);
  new DataView(odd.buffer).setUint16(odd.length - 22 + 0 + 0, 0x4b50, true);
  const cd = new DataView(odd.buffer).getUint32(odd.length - 22 + 16, true);
  new DataView(odd.buffer).setUint16(cd + 10, 99, true);
  const [unknown] = await readZip(odd.buffer);
  await assert.rejects(unknown.blob(), /способ сжатия/);
});

test('team folders: files become players and logos, problems are explained', () => {
  const { teams, problems } = collectTeams(files([
    'LAN/Team Alpha/Nick2.png', 'LAN/Team Alpha/nick1 (1).png', 'LAN/Team Alpha/NICK1.jpg', 'LAN/Team Alpha/Logo.PNG',
    'LAN/Браво/Игрок.webp', 'LAN/Браво/IMG_1.HEIC', 'LAN/Браво/notes.txt', 'LAN/.DS_Store', 'LAN/__MACOSX/Браво/._x.png',
    'LAN/loose.png', 'LAN/Empty/readme.txt']));
  assert.deepEqual(teams.map(t => t.name), ['Team Alpha', 'Браво']);
  assert.equal(rosterLine(teams[0]), 'nick1, Nick2');
  assert.ok(teams[0].logo);
  assert.equal(teams[1].logo, null);
  assert.deepEqual(problems.map(p => p.replace(/:.*/, '')), ['Team Alpha', 'Браво/IMG_1.HEIC', 'loose.png']);
  assert.match(problems.join('\n'), /HEIC.*PNG/);
  assert.match(problems.join('\n'), /встречается дважды/);
  // A picked folder is the team itself: «Team/nick.png».
  assert.deepEqual(collectTeams(files(['Solo/a.png'])).teams.map(t => t.name), ['Solo']);
});

test('assets: only small data: images are kept, in the browser store and back', () => {
  const clean = normalizeAssets({
    photos: { 'a|b': PNG, 'x|y': 'javascript:alert(1)', 'p|q': 'data:text/html;base64,AAAA', big: PNG.replace('AAAA', 'A'.repeat(500000)) },
    logos: { a: WEBP, b: 'https://evil.example/x.png' }
  });
  assert.deepEqual(Object.keys(clean.photos), ['a|b']);
  assert.deepEqual(Object.keys(clean.logos), ['a']);
  const storage = new Map();
  const shim = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  assert.equal(writeAssets({ photos: { [cardKey('Team', 'Nick')]: PNG }, logos: { team: WEBP } }, shim), true);
  const back = readAssets(shim);
  assert.equal(photoOf(back, 'TEAM', 'nick!'), PNG);
  assert.equal(logoOf(back, 'Team'), WEBP);
  storage.set(ASSETS_STORE, '{broken');
  assert.deepEqual(readAssets(shim), { v: 1, photos: {}, logos: {} });
  assert.equal(writeAssets({}, { setItem() { throw new Error('quota'); } }), false);
});

test('assets: an event\'s photos go to IndexedDB, older localStorage photos move there once', async () => {
  const storage = new Map();
  const shim = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
  writeAssets({ photos: { [cardKey('Team', 'Nick')]: PNG } }, shim);
  let kept = null, full = false;
  const db = { get: async () => kept, put: async value => { if (full) throw new Error('quota'); kept = structuredClone(value); } };
  const store = new AssetStore({ db, storage: shim });
  assert.equal(photoOf(await store.load(), 'Team', 'Nick'), PNG);
  assert.equal(photoOf(kept, 'Team', 'Nick'), PNG, 'moved to IndexedDB');
  assert.equal(storage.has(ASSETS_STORE), false, 'and gone from localStorage');
  // More than localStorage could take is fine in IndexedDB.
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`t|p${i}`, PNG.replace('AAAA', 'A'.repeat(100000))]));
  assert.equal(await store.save({ photos: many }), true);
  assert.equal(Object.keys(new AssetStore({ db, storage: shim }).assets.photos).length, 0, 'nothing until loaded');
  assert.equal(Object.keys((await new AssetStore({ db, storage: shim }).load()).photos).length, 80);
  // No room: false, and the photos kept before stay.
  full = true;
  assert.equal(await store.save({}), false);
  assert.equal(Object.keys(store.assets.photos).length, 80);
  // No IndexedDB (a private window): localStorage, as before.
  const plain = new AssetStore({ db: { get: async () => { throw new Error('blocked'); } }, storage: shim });
  await plain.load();
  assert.equal(await plain.save({ logos: { team: WEBP } }), true);
  assert.equal(logoOf(readAssets(shim), 'Team'), WEBP);
});

test('card page: nick and team are text, images only from data: URLs, nothing else gets in', () => {
  const html = eventCardHtml({ team: '<b>T"1</b>', nick: '</h1><script>alert(1)</script>', photo: PNG, logo: WEBP });
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!html.includes('<b>T'));
  assert.match(html, /&lt;\/h1&gt;&lt;script&gt;alert\(1\)/);
  assert.match(html, /class="card photo-layout"/);
  assert.ok(html.includes(`src="${PNG}"`) && html.includes(`src="${WEBP}"`));
  const bad = eventCardHtml({ nick: 'x', photo: 'javascript:alert(1)" onerror="x', logo: 'https://evil.example/a.png', colors: { accent: 'red;}</style>' } });
  assert.ok(!bad.includes('javascript:') && !bad.includes('evil.example') && !bad.includes('red;}'));
  assert.match(bad, /no-photo-layout/);
  assert.match(bad, /--accent:#00d3ef/);
  assert.equal(eventCardHtml({}).includes('Игрок'), true);
  const url = eventCardUrl({ team: 'T', nick: 'Ник#1 100%', photo: PNG });
  assert.ok(url.startsWith('data:text/html;charset=utf-8,'));
  assert.ok(decodeURIComponent(url.slice(url.indexOf(',') + 1)).includes('Ник#1 100%'));
  assert.ok(!url.slice(url.indexOf(',') + 1).includes('#'));
});

const LAN = lanConfig({ on: true, prefix: 'k7qz' });
const roster = () => {
  const [alpha, bravo] = parseLanRoster('Team Alpha: n1, n2, n3, n4, n5\nBravo: b1, b2, b3, b4, b5');
  const keysA = defaultLineup(alpha), keysB = defaultLineup(bravo);
  return [seatTeam(alpha, 'a', keysA, LAN), seatTeam(bravo, 'b', keysB, LAN), keysA, keysB];
};

test('card docs: one per player, with that player\'s photo and the team logo', () => {
  const assets = normalizeAssets({ photos: { [cardKey('Team Alpha', 'n2')]: PNG }, logos: { [cardKey('Team Alpha', '').slice(0, -1)]: WEBP } });
  const docs = cardDocs([{ team: 'Team Alpha', nick: 'n1' }, { team: 'Team Alpha', nick: 'n2' }, { team: '', nick: 'x' }], assets);
  assert.deepEqual(Object.keys(docs), [cardKey('Team Alpha', 'n1'), cardKey('Team Alpha', 'n2')]);
  const text = url => decodeURIComponent(url.slice(url.indexOf(',') + 1));
  assert.ok(text(docs[cardKey('Team Alpha', 'n2')]).includes('photo-layout'));
  assert.ok(text(docs[cardKey('Team Alpha', 'n1')]).includes('no-photo-layout'));
  assert.ok(text(docs[cardKey('Team Alpha', 'n1')]).includes(WEBP));
});

test('card docs: a webcam\'s own nick is shown, while its photo is still found by the roster nick', () => {
  const assets = normalizeAssets({ photos: { [cardKey('Team Alpha', 'n2')]: PNG } });
  const docs = cardDocs([{ team: 'Team Alpha', nick: 'Кастом', lookup: 'n2' }], assets);
  assert.deepEqual(Object.keys(docs), [cardKey('Team Alpha', 'Кастом')]);
  const text = decodeURIComponent(docs[cardKey('Team Alpha', 'Кастом')].slice(docs[cardKey('Team Alpha', 'Кастом')].indexOf(',') + 1));
  assert.ok(text.includes('photo-layout'));
  assert.ok(text.includes(PNG));
  assert.ok(text.includes('Кастом'));
});

test('OBS: a ready card page replaces the card address; players without one keep it', () => {
  const [a, b, keysA, keysB] = roster();
  const template = JSON.parse(fs.readFileSync(new URL('../assets/obs-template.json', import.meta.url), 'utf8'));
  const docs = { [cardKey('Team Alpha', 'n1')]: 'data:text/html;charset=utf-8,READY' };
  const obs = buildObs(template, a, b, keysA, keysB, () => crypto.randomUUID(), { includeCards: true, cardBase: 'https://panel.example', cardDocs: docs });
  const cards = Object.fromEntries(obs.sources.filter(s => s.name.startsWith('CARD ')).map(s => [s.name, s.settings.url]));
  assert.equal(cards['CARD 01 | Team Alpha | n1'], 'data:text/html;charset=utf-8,READY');
  assert.match(cards['CARD 02 | Team Alpha | n2'], /^https:\/\/panel\.example\/card\.html\?team=Team\+Alpha&nick=n2$/);
  const items = [{ inputKind: 'browser_source', sourceName: 'Камера', sceneItemId: 1, sceneItemIndex: 0 }];
  const plan = slotPlan(items, { slot: 1, team: 'Team Alpha', nick: 'n1', id: 'k7qza1', room: 'k7qz' }, { includeCards: true, cardDocs: docs });
  assert.equal(plan.card.settings.url, 'data:text/html;charset=utf-8,READY');
  // Only a data: page counts as a ready card; another address in its place is ignored.
  const hostile = slotPlan(items, { slot: 1, team: 'Team Alpha', nick: 'n1', id: 'k7qza1', room: 'k7qz' },
    { includeCards: true, cardBase: 'https://p.example', cardDocs: { [cardKey('Team Alpha', 'n1')]: 'file:///etc/passwd' } });
  assert.match(hostile.card.settings.url, /^https:\/\/p\.example\/card\.html/);
  const other = slotPlan(items, { slot: 2, team: 'Team Alpha', nick: 'n2', id: 'k7qza2', room: 'k7qz' }, { includeCards: true, cardBase: 'https://p.example', cardDocs: docs });
  assert.match(other.card.settings.url, /^https:\/\/p\.example\/card\.html/);
});

test('dock parts: a card is split, rebuilt in any order, and only a real card page is kept', async () => {
  const url = 'data:text/html;charset=utf-8,' + 'x'.repeat(CHUNK * 2 + 123);
  const parts = splitChunks(url);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(''), url);
  const key = await docKey(cardKey('Team', 'Nick'), url);
  assert.match(key, /^team\|nick:[0-9a-f]{12}$/);
  assert.equal(await docKey(cardKey('Team', 'Nick'), url), key);
  assert.notEqual(await docKey(cardKey('Team', 'Nick'), url + '!'), key);
  const dock = new ChunkAssembler();
  assert.equal(dock.has(key), false);
  assert.equal(dock.add(key, 2, 3, parts[2]), false);
  assert.equal(dock.add(key, 0, 3, parts[0]), false);
  assert.equal(dock.add(key, 0, 3, parts[0]), false); // a resent part changes nothing
  assert.equal(dock.add(key, 1, 3, parts[1]), true);
  assert.equal(dock.get(key), url);
  assert.equal(dock.has(key), true);
  assert.throws(() => dock.add(key, 0, 1, 'javascript:alert(1)'), /Неверная карточка/);
  assert.throws(() => dock.add('bad key!', 0, 1, 'x'), /Неверная часть/);
  assert.throws(() => dock.add(key, 3, 3, 'x'), /Неверная часть/);
  assert.throws(() => dock.add(key, 0, 99, 'x'), /Неверная часть/);
  assert.throws(() => dock.add(key, 0, 1, 5), /Неверная часть/);
  const many = new ChunkAssembler();
  for (let i = 0; i < 45; i++) many.add('k' + i, 0, 1, 'data:text/html;charset=utf-8,x');
  assert.equal(many.has('k0'), false);
  assert.equal(many.has('k44'), true);
});

test('palette: three chosen colours become the five of a card; none chosen changes nothing', () => {
  assert.deepEqual(paletteFrom({}), {});
  assert.deepEqual(paletteFrom({ accent: 'nope', deep: '', black: '#12' }), {});
  const palette = paletteFrom({ accent: '#ff0066', deep: '#101010', black: '#000000' });
  assert.deepEqual([palette.accent, palette.cyan, palette.deep, palette.black], ['#ff0066', '#ff0066', '#101010', '#000000']);
  assert.match(palette.teal, /^#[0-9a-f]{6}$/);
  assert.notEqual(palette.teal, '#ff0066');
  // Only the accent chosen: the rest of the card keeps its defaults, the teal follows the accent.
  const accentOnly = paletteFrom({ accent: '#ff0066' });
  assert.deepEqual(Object.keys(accentOnly).sort(), ['accent', 'cyan', 'teal']);
  const html = text => decodeURIComponent(text.slice(text.indexOf(',') + 1));
  const [url] = Object.values(cardDocs([{ team: 'T', nick: 'n' }], normalizeAssets({}), palette));
  assert.ok(html(url).includes('--accent:#ff0066') && html(url).includes('--black:#000000'));
  const [plain] = Object.values(cardDocs([{ team: 'T', nick: 'n' }], normalizeAssets({})));
  assert.ok(html(plain).includes(`--accent:${DEFAULT_COLORS.accent}`));
});

test('a ZIP from a Mac: __MACOSX and ._ files do not make real team folders look misplaced', () => {
  const file = path => ({ path, size: 100, blob: async () => new Blob([PNG]) });
  const { teams, problems } = collectTeams([file('TeamA/s1mple.png'), file('TeamB/zywoo.png'), file('TeamA/logo.png'),
    file('__MACOSX/TeamA/._s1mple.png'), file('TeamA/._logo.png'), file('desktop.ini')]);
  assert.deepEqual(teams.map(t => [t.name, [...t.players.keys()], Boolean(t.logo)]), [['TeamA', ['s1mple'], true], ['TeamB', ['zywoo'], false]]);
  assert.deepEqual(problems, []);
});

test('the dock takes the largest card the panel can make; event pictures are kept by #id', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(399000);
  const url = eventCardUrl({ team: 'T', nick: 'n', photo: big, logo: big });
  const parts = splitChunks(url), dock = new ChunkAssembler();
  assert.ok(url.length > 600000, 'bigger than the old limit');
  parts.forEach((data, index) => dock.add('T|n', index, parts.length, data));
  assert.equal(dock.get('T|n'), url);
  // A team named «T1» (old name key «t1») and an event team with id t1 do not meet.
  const assets = normalizeAssets({ photos: { [ownKey('p1')]: PNG }, logos: { t1: WEBP, [ownKey('t1')]: PNG } });
  const docs = cardDocs([{ team: 'Navi', nick: 'n1', teamId: 't1', playerId: 'p1' }, { team: 'T1', nick: 'x', teamId: 't2', playerId: 'p2' }], assets, {});
  assert.match(decodeURIComponent(docs[cardKey('Navi', 'n1')]), /data:image\/png;base64,/);
  assert.doesNotMatch(decodeURIComponent(docs[cardKey('T1', 'x')]), /data:image\/webp/);
});

test('a placeholder is one page with only its picture, covering the frame; anything else gives none', async () => {
  const { plateCardUrl } = await import('../lan-event.js');
  const { BLANK_CARD, readyCard } = await import('../core.js');
  const image = 'data:image/jpeg;base64,AAAA';
  const url = plateCardUrl(image);
  assert.ok(readyCard({ k: url }, 'k'));
  const html = decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length));
  assert.match(html, /url\("data:image\/jpeg;base64,AAAA"\) center\/cover/);
  assert.doesNotMatch(html, /<script/);
  for (const bad of ['', 'https://evil.example/x.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AA"A'])
    assert.equal(plateCardUrl(bad), '', bad);
  assert.ok(readyCard({ k: BLANK_CARD }, 'k'));
});
