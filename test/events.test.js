import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validateEvent, loadEvent, enabledModules, assetPathValid, contrast, brandWarnings,
  MODULES, COLOR_KEYS, DEFAULT_BRAND, EVENT_VERSION
} from '../events/schema.js';
import { DEFAULT_SOURCE, MAP_POOL, CAMERA_FRAMES, DEFAULT_CAMERA_FRAME } from '../core.js';
import { TIMERS } from '../veto-room.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const json = path => JSON.parse(read(path));
const cyberclash = () => json('events/cyberclash/event.json');

test('the CyberClash manifest is valid and every default is filled in', () => {
  const { event, errors } = validateEvent(cyberclash());
  assert.deepEqual(errors, []);
  assert.equal(event.v, EVENT_VERSION);
  assert.deepEqual(enabledModules(event), ['cameras', 'veto', 'obs', 'lobby', 'bookmakers']);
  assert.deepEqual(brandWarnings(event), []);
  // A bare event gets every default.
  const bare = loadEvent({ slug: 'bare', name: 'Bare', kind: 'manual' });
  assert.deepEqual(enabledModules(bare), ['cameras', 'veto', 'obs']);
  assert.deepEqual(bare.brand.colors, Object.fromEntries(COLOR_KEYS.map(key => [key, DEFAULT_BRAND[key]])));
  assert.deepEqual([bare.veto.format, bare.veto.timerMinutes, bare.veto.tournament, bare.cameras.frame, bare.language, bare.short], ['BO3', 5, 'Bare', 'inner43', 'ru', 'Bare']);
  assert.deepEqual(bare.source, { type: 'manual' });
});

// --- contracts: the manifest says what the code does today -----------------
test('contract: the sheets in the manifest are the ones the panel reads', () => {
  const { source } = cyberclash();
  assert.deepEqual([source.roster.id, source.roster.gid], [DEFAULT_SOURCE.id, DEFAULT_SOURCE.gid]);
  assert.deepEqual([source.schedule.id, source.schedule.gid, source.schedule.playoffsGid],
    [DEFAULT_SOURCE.scheduleId, DEFAULT_SOURCE.scheduleGid, DEFAULT_SOURCE.playoffsGid]);
});

test('contract: the manifest colours are the ones the veto page, the card and the overlay draw with', () => {
  const { brand } = loadEvent(cyberclash());
  const veto = read('veto.css'), card = read('card.css'), scene = read('assets/veto-overlay/scene.js');
  const has = (text, token, value) => assert.ok(new RegExp(`${token.replace(/[-]/g, '\\-')}:\\s*${value}\\b`, 'i').test(text), `${token} should be ${value}`);
  for (const [key, token] of [['accent', '--vt-accent'], ['black', '--vt-bg'], ['muted', '--vt-muted'], ['ban', '--vt-ban'], ['pick', '--vt-pick'], ['decider', '--vt-decider'], ['ct', '--vt-ct'], ['t', '--vt-t']])
    has(veto, token, brand.colors[key]);
  has(card, '--card-accent', brand.colors.accent);
  has(card, '--card-deep', brand.colors.deep);
  has(card, '--card-black', brand.colors.black);
  // The overlay (scene.js) still has its own constants (its «deep» is #05131d, not the card's #043746):
  // the L0 tokens of ARCHITECTURE §5 will make it read the manifest. Until then only its accent is pinned.
  assert.ok(scene.includes(`accent:'${brand.colors.accent === '#00d3ef' ? '#03dcf3' : brand.colors.accent}'`), 'overlay accent changed: update the manifest or the note');
});

test('contract: pool, timers, frame and files of the manifest exist in the code', () => {
  const event = loadEvent(cyberclash());
  assert.deepEqual(event.veto.pool, MAP_POOL);
  assert.ok(TIMERS.includes(event.veto.timerMinutes));
  assert.equal(event.cameras.frame, DEFAULT_CAMERA_FRAME);
  assert.ok(Object.hasOwn(CAMERA_FRAMES, event.cameras.frame));
  for (const key of ['logo', 'backdrop']) assert.ok(fs.existsSync(new URL('../' + event.brand[key], import.meta.url)), `${key}: ${event.brand[key]}`);
  assert.ok(fs.existsSync(new URL('../' + event.brand.font.display, import.meta.url)));
});

test('contract: every module the manifest can switch on has a tab in the panel', () => {
  const html = read('index.html');
  const tabs = { cameras: 'viewPrep', veto: 'vetoNavBtn', obs: 'obsNavBtn', server: 'serverNavBtn', lobby: 'viewLobby', bookmakers: 'bookiesNavBtn' };
  assert.deepEqual(Object.keys(tabs).sort(), MODULES.map(m => m.id).sort());
  for (const [module, id] of Object.entries(tabs)) assert.ok(html.includes(`id="${id}"`), `${module}: no #${id} in index.html`);
});

test('templates: LAN and blank are ready as they are; the sheets one waits for real sheet IDs', () => {
  assert.deepEqual(validateEvent(json('events/_templates/lan.json')).errors, []);
  assert.deepEqual(validateEvent(json('events/_templates/blank.json')).errors, []);
  assert.deepEqual(enabledModules(loadEvent(json('events/_templates/lan.json'))), ['cameras', 'veto', 'obs', 'server']);
  const sheets = json('events/_templates/sheets-tournament.json');
  const { errors } = validateEvent(sheets);
  assert.deepEqual(errors.map(e => e.split(':')[0]), ['source.roster', 'source.schedule']);
  sheets.source.roster = { id: 'a'.repeat(44), gid: '12' };
  sheets.source.schedule = { id: 'b'.repeat(44), gid: '34', playoffsGid: '56' };
  assert.deepEqual(validateEvent(sheets).errors, []);
});

// --- the rules ---------------------------------------------------------------
const base = () => ({ slug: 'winter-lan', name: 'Winter LAN', kind: 'manual' });
const errorsOf = change => validateEvent({ ...base(), ...change }).errors.join(' | ');

test('slug, name and kind', () => {
  for (const slug of ['', 'ab', 'Has-Upper', '-start', 'end-', 'with space', 'a'.repeat(40), 'кириллица', 'a/b', '../x'])
    assert.match(validateEvent({ ...base(), slug }).errors.join(), /slug/, slug);
  for (const slug of ['abc', 'winter-lan', 'cup-2026', 'a1b'])
    assert.deepEqual(validateEvent({ ...base(), slug }).errors, [], slug);
  assert.match(errorsOf({ name: '' }), /name/);
  assert.match(errorsOf({ name: 'two\nlines' }), /name/);
  assert.match(errorsOf({ name: 'x'.repeat(61) }), /name/);
  assert.match(errorsOf({ name: ' padded ' }), /name/);
  assert.match(errorsOf({ kind: 'cloud' }), /kind/);
  assert.match(errorsOf({ kind: undefined }), /kind/);
  assert.equal(validateEvent(null).errors.length, 1);
  assert.equal(validateEvent([]).errors.length, 1);
  assert.equal(validateEvent('x').event, null);
});

test('unknown fields are refused at every level, so a typo does not go unnoticed', () => {
  assert.match(errorsOf({ colour: 1 }), /colour: неизвестное поле/);
  assert.match(errorsOf({ brand: { colors: { accent: '#00d3ef', glow: '#fff000' } } }), /brand\.colors\.glow/);
  assert.match(errorsOf({ brand: { logoo: 'assets/x.png' } }), /brand\.logoo/);
  assert.match(errorsOf({ modules: { bookies: true } }), /modules\.bookies/);
  assert.match(errorsOf({ veto: { timer: 5 } }), /veto\.timer/);
  assert.match(errorsOf({ cameras: { zoom: 1 } }), /cameras\.zoom/);
  assert.match(errorsOf({ v: 2 }), /версия 2/);
});

test('colours are #rrggbb, paths stay inside assets/ or the event folder', () => {
  for (const color of ['red', '#fff', '#00d3e', '#00d3eff', 'rgb(0,0,0)', '#00d3ex', 5, null, 'url(javascript:1)'])
    assert.match(errorsOf({ brand: { colors: { accent: color } } }), /brand\.colors\.accent/, String(color));
  assert.deepEqual(validateEvent({ ...base(), brand: { colors: { accent: '#00D3EF' } } }).event.brand.colors.accent, '#00d3ef', 'lower-cased');
  const ok = ['assets/logo.png', 'events/winter-lan/brand/logo.svg', 'assets/fonts/A.woff2'];
  const bad = ['/etc/passwd.png', '../x.png', 'assets/../x.png', 'assets//x.png', 'http://evil.example/a.png', 'data:image/png;base64,AAAA', 'assets\\x.png',
    'events/other/logo.png', 'events/winter-lan/../other/x.png', 'assets/.hidden.png', 'assets/logo.exe', 'assets/logo', 'file:///x.png', '', 5];
  for (const path of ok) assert.equal(assetPathValid(path, 'winter-lan'), true, path);
  for (const path of bad) assert.equal(assetPathValid(path, 'winter-lan'), false, String(path));
  for (const path of bad) assert.match(errorsOf({ brand: { logo: path } }), /brand\.logo/, String(path));
  assert.match(errorsOf({ brand: { font: { display: 'Comic Sans' } } }), /brand\.font\.display/);
  assert.deepEqual(validateEvent({ ...base(), brand: { font: { display: 'system' } } }).errors, []);
});

test('modules, veto, cameras, source and people', () => {
  assert.match(errorsOf({ modules: { server: 'yes' } }), /modules\.server/);
  assert.match(errorsOf({ veto: { pool: ['Mirage'] } }), /veto\.pool/);
  assert.match(errorsOf({ veto: { pool: [...MAP_POOL.slice(0, 6), 'Mirage'] } }), /veto\.pool/);
  assert.match(errorsOf({ veto: { pool: [...MAP_POOL.slice(0, 6), 'Overpass'] } }), /veto\.pool/);
  assert.match(errorsOf({ veto: { format: 'BO7' } }), /veto\.format/);
  assert.match(errorsOf({ veto: { timerMinutes: 4 } }), /veto\.timerMinutes/);
  assert.match(errorsOf({ cameras: { frame: 'huge' } }), /cameras\.frame/);
  assert.match(errorsOf({ operators: ['not-an-email'] }), /operators/);
  assert.match(errorsOf({ operators: Array.from({ length: 51 }, (_, i) => `a${i}@x.ru`) }), /operators/);
  assert.deepEqual(validateEvent({ ...base(), operators: ['ops@example.com'] }).errors, []);
  assert.match(errorsOf({ bookmakers: { match: ['x'.repeat(61)] } }), /bookmakers\.match/);
  assert.match(errorsOf({ lobby: { faceit: 'yes' } }), /lobby\.faceit/);
  // kind decides the source
  assert.match(errorsOf({ kind: 'sheets' }), /source/);
  assert.match(errorsOf({ kind: 'sheets', source: { type: 'sheets', roster: { id: 'short', gid: '1' } } }), /source\.roster/);
  assert.match(errorsOf({ kind: 'sheets', source: { type: 'sheets', roster: { id: 'a'.repeat(30), gid: 'x' } } }), /source\.roster/);
  assert.match(errorsOf({ source: { type: 'sheets' } }), /source/);
  assert.match(errorsOf({ source: { type: 'manual', password: 'x' } }), /source/);
});

test('a manifest carries no secrets: any secret-looking field is an unknown field', () => {
  for (const key of ['faceitKey', 'rconPassword', 'token', 'apiKey', 'password'])
    assert.match(errorsOf({ [key]: 'x' }), new RegExp(`${key}: неизвестное поле`));
  assert.match(errorsOf({ lobby: { faceit: true, key: 'x' } }), /lobby/);
});

test('loadEvent: one error that lists everything wrong', () => {
  assert.throws(() => loadEvent({ slug: 'A', name: '', kind: 'x', brand: { colors: { accent: 'red' } } }),
    error => /slug/.test(error.message) && /name/.test(error.message) && /kind/.test(error.message) && /brand\.colors\.accent/.test(error.message));
});

test('brand readability: contrast is measured, bad brands get a warning, not a block', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#777777', '#777777'), 1);
  const weak = loadEvent({ ...base(), brand: { colors: { ink: '#555555', black: '#444444', ban: '#00ff00', pick: '#00ff00' } } });
  const warnings = brandWarnings(weak).join(' | ');
  assert.match(warnings, /ink на black/);
  assert.match(warnings, /ban и pick совпадают/);
  assert.deepEqual(brandWarnings(loadEvent(base())), []);
});
