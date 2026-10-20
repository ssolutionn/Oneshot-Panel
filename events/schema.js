// The event manifest (docs/ARCHITECTURE.md §4): everything that differs from one
// tournament to the next, as data. Pure functions, no DOM and no I/O, so the
// panel, the build scripts and the tests all read an event the same way.
//
// validateEvent() is strict on purpose: an unknown field, a bad colour or a path
// that leaves the event's folder is an error in words, found when the event is
// loaded, not a broken broadcast. The manifest holds NO secrets (FACEIT key,
// RCON password, tokens): those stay in the server's environment.
import { MAP_POOL } from '../core.js';
import { TIMERS } from '../veto-room.js';

export const EVENT_VERSION = 1;
export const KINDS = ['sheets', 'manual', 'faceit'];
export const FORMATS = ['BO1', 'BO2', 'BO3', 'BO5'];
export const FRAMES = ['inner43', 'full43', 'wide'];
export const COLOR_KEYS = ['accent', 'deep', 'black', 'ink', 'muted', 'ban', 'pick', 'decider', 'ct', 't'];

// The panel's tabs. `default` is what an event gets when it does not say.
export const MODULES = [
  { id: 'cameras', label: 'Подготовка', default: true },
  { id: 'veto', label: 'Вето', default: true },
  { id: 'obs', label: 'OBS', default: true },
  { id: 'server', label: 'Сервер', default: false },
  { id: 'lobby', label: 'Лобби', default: false },
  { id: 'bookmakers', label: 'Букмекеры', default: false }
];

// The look an event has when it brings none of its own (the CyberClash look,
// which is what the cards, the overlay and the veto page use today).
export const DEFAULT_BRAND = Object.freeze({
  accent: '#00d3ef', deep: '#043746', black: '#031b24', ink: '#ffffff', muted: '#9fc6cf',
  ban: '#ed1637', pick: '#2fbf71', decider: '#f2c14e', ct: '#7fb2f0', t: '#f0a95e'
});

const TOP = ['v', 'slug', 'name', 'short', 'kind', 'language', 'brand', 'modules', 'source', 'veto', 'cameras', 'lobby', 'bookmakers', 'operators'];
const SLUG = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const HEX = /^#[0-9a-f]{6}$/i;
const SHEET_ID = /^[\w-]{20,100}$/;
const GID = /^\d{1,12}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const ASSET = /\.(png|jpe?g|webp|svg|woff2?|ttf)$/i;

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\r\n\t\x00-\x1f]/.test(value);

// A file of the event: under assets/ (the files of today) or under its own folder.
export function assetPathValid(path, slug) {
  if (typeof path !== 'string' || path.length > 200 || !ASSET.test(path)) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('//') || /^[a-z]+:/i.test(path)) return false;
  const parts = path.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.startsWith('.'))) return false;
  return parts[0] === 'assets' || (parts[0] === 'events' && parts[1] === slug);
}

// Returns { event, errors }: the event with every default filled in (when there
// are no errors), and what is wrong in plain words (when there are).
export function validateEvent(value) {
  const errors = [];
  const bad = (where, message) => errors.push(`${where}: ${message}`);
  if (!isObject(value)) return { event: null, errors: ['Событие должно быть объектом.'] };
  for (const key of Object.keys(value)) if (!TOP.includes(key)) bad(key, 'неизвестное поле');
  if (value.v !== undefined && value.v !== EVENT_VERSION) bad('v', `версия ${value.v} не поддерживается (нужна ${EVENT_VERSION})`);
  if (!SLUG.test(value.slug || '')) bad('slug', 'латиница, цифры и дефис, 3–32 знака, без дефиса по краям');
  if (!text(value.name, 60)) bad('name', 'название до 60 символов, без переводов строк');
  if (value.short !== undefined && !text(value.short, 12)) bad('short', 'до 12 символов');
  if (!KINDS.includes(value.kind)) bad('kind', `одно из: ${KINDS.join(', ')}`);
  if (value.language !== undefined && !['ru', 'en'].includes(value.language)) bad('language', 'ru или en');

  const brand = value.brand ?? {};
  if (!isObject(brand)) bad('brand', 'должен быть объектом');
  else {
    for (const key of Object.keys(brand)) if (!['logo', 'mark', 'backdrop', 'font', 'colors'].includes(key)) bad(`brand.${key}`, 'неизвестное поле');
    for (const key of ['logo', 'mark', 'backdrop']) {
      if (brand[key] !== undefined && !assetPathValid(brand[key], value.slug)) bad(`brand.${key}`, 'путь к файлу внутри assets/ или events/<slug>/, png/jpg/webp/svg');
    }
    if (brand.font !== undefined) {
      if (!isObject(brand.font)) bad('brand.font', 'должен быть объектом {display, text}');
      else {
        for (const key of Object.keys(brand.font)) if (!['display', 'text'].includes(key)) bad(`brand.font.${key}`, 'неизвестное поле');
        if (brand.font.display !== undefined && !(brand.font.display === 'system' || assetPathValid(brand.font.display, value.slug))) bad('brand.font.display', 'файл шрифта (woff2/ttf) или system');
        if (brand.font.text !== undefined && brand.font.text !== 'system' && !assetPathValid(brand.font.text, value.slug)) bad('brand.font.text', 'файл шрифта (woff2/ttf) или system');
      }
    }
    if (brand.colors !== undefined) {
      if (!isObject(brand.colors)) bad('brand.colors', 'должен быть объектом');
      else for (const [key, color] of Object.entries(brand.colors)) {
        if (!COLOR_KEYS.includes(key)) bad(`brand.colors.${key}`, `неизвестный цвет (есть: ${COLOR_KEYS.join(', ')})`);
        else if (typeof color !== 'string' || !HEX.test(color)) bad(`brand.colors.${key}`, 'нужен цвет вида #rrggbb');
      }
    }
  }

  const modules = value.modules ?? {};
  if (!isObject(modules)) bad('modules', 'должен быть объектом');
  else for (const [key, on] of Object.entries(modules)) {
    if (!MODULES.some(m => m.id === key)) bad(`modules.${key}`, `неизвестный модуль (есть: ${MODULES.map(m => m.id).join(', ')})`);
    else if (typeof on !== 'boolean') bad(`modules.${key}`, 'true или false');
  }

  const source = value.source;
  if (value.kind === 'sheets') {
    if (!isObject(source) || source.type !== 'sheets') bad('source', 'для kind=sheets нужен source {type:"sheets", roster, schedule?}');
    else {
      for (const key of Object.keys(source)) if (!['type', 'roster', 'schedule'].includes(key)) bad(`source.${key}`, 'неизвестное поле');
      if (!isObject(source.roster) || !SHEET_ID.test(source.roster.id || '') || !GID.test(source.roster.gid || '')) bad('source.roster', 'нужны id таблицы и числовой gid листа');
      if (source.schedule !== undefined) {
        const s = source.schedule;
        if (!isObject(s) || !SHEET_ID.test(s.id || '') || !GID.test(s.gid || '') || (s.playoffsGid !== undefined && !GID.test(s.playoffsGid))) bad('source.schedule', 'id таблицы, числовой gid и, если есть, playoffsGid');
      }
    }
  } else if (value.kind === 'manual') {
    if (source !== undefined && !(isObject(source) && source.type === 'manual' && Object.keys(source).length === 1)) bad('source', 'для kind=manual источник не нужен (или {type:"manual"})');
  } else if (value.kind === 'faceit') {
    if (source !== undefined && !(isObject(source) && source.type === 'faceit' && Object.keys(source).length === 1)) bad('source', 'для kind=faceit источник не нужен (или {type:"faceit"})');
  }

  const veto = value.veto ?? {};
  if (!isObject(veto)) bad('veto', 'должен быть объектом');
  else {
    for (const key of Object.keys(veto)) if (!['pool', 'format', 'timerMinutes', 'tournament'].includes(key)) bad(`veto.${key}`, 'неизвестное поле');
    if (veto.pool !== undefined && !(Array.isArray(veto.pool) && veto.pool.length === 7 && new Set(veto.pool).size === 7 && veto.pool.every(map => MAP_POOL.includes(map)))) bad('veto.pool', `ровно 7 разных карт из: ${MAP_POOL.join(', ')}`);
    if (veto.format !== undefined && !FORMATS.includes(veto.format)) bad('veto.format', FORMATS.join(', '));
    if (veto.timerMinutes !== undefined && !TIMERS.includes(veto.timerMinutes)) bad('veto.timerMinutes', `одно из: ${TIMERS.join(', ')}`);
    if (veto.tournament !== undefined && !text(veto.tournament, 60)) bad('veto.tournament', 'до 60 символов');
  }

  const cameras = value.cameras ?? {};
  if (!isObject(cameras)) bad('cameras', 'должен быть объектом');
  else {
    for (const key of Object.keys(cameras)) if (key !== 'frame') bad(`cameras.${key}`, 'неизвестное поле');
    if (cameras.frame !== undefined && !FRAMES.includes(cameras.frame)) bad('cameras.frame', FRAMES.join(', '));
  }

  for (const key of ['lobby', 'bookmakers']) {
    const part = value[key];
    if (part === undefined) continue;
    if (!isObject(part)) bad(key, 'должен быть объектом');
    else if (key === 'lobby' && Object.keys(part).some(k => k !== 'faceit')) bad('lobby', 'только поле faceit');
    else if (key === 'lobby' && part.faceit !== undefined && typeof part.faceit !== 'boolean') bad('lobby.faceit', 'true или false');
    else if (key === 'bookmakers') {
      if (Object.keys(part).some(k => k !== 'match')) bad('bookmakers', 'только поле match');
      else if (part.match !== undefined && !(Array.isArray(part.match) && part.match.length <= 10 && part.match.every(s => text(s, 60)))) bad('bookmakers.match', 'список строк до 60 символов, не больше 10');
    }
  }

  if (value.operators !== undefined && !(Array.isArray(value.operators) && value.operators.length <= 50 && value.operators.every(e => typeof e === 'string' && EMAIL.test(e)))) bad('operators', 'список e-mail, не больше 50');

  if (errors.length) return { event: null, errors };
  const slug = value.slug;
  return {
    errors,
    event: {
      v: EVENT_VERSION, slug, name: value.name, short: value.short ?? value.name.slice(0, 12), kind: value.kind, language: value.language ?? 'ru',
      brand: {
        ...(brand.logo ? { logo: brand.logo } : {}), ...(brand.mark ? { mark: brand.mark } : {}), ...(brand.backdrop ? { backdrop: brand.backdrop } : {}),
        font: { display: brand.font?.display ?? 'system', text: brand.font?.text ?? 'system' },
        colors: Object.fromEntries(COLOR_KEYS.map(key => [key, (brand.colors?.[key] ?? DEFAULT_BRAND[key]).toLowerCase()]))
      },
      modules: Object.fromEntries(MODULES.map(m => [m.id, modules[m.id] ?? m.default])),
      source: value.kind === 'sheets' ? source : { type: value.kind },
      veto: { pool: veto.pool ?? [...MAP_POOL], format: veto.format ?? 'BO3', timerMinutes: veto.timerMinutes ?? 5, tournament: veto.tournament ?? value.name },
      cameras: { frame: cameras.frame ?? 'inner43' },
      lobby: { faceit: value.lobby?.faceit ?? false },
      bookmakers: { match: value.bookmakers?.match ?? [] },
      operators: value.operators ?? []
    }
  };
}

// Like validateEvent, but throws one error holding every problem.
export function loadEvent(value) {
  const { event, errors } = validateEvent(value);
  if (!event) throw new Error('Событие не прошло проверку:\n' + errors.map(e => ' · ' + e).join('\n'));
  return event;
}

// The panel's tabs for an event, in their fixed order.
export const enabledModules = event => MODULES.filter(m => event.modules[m.id]).map(m => m.id);

// WCAG contrast of two #rrggbb colours (4.5 is the bar for body text).
export function contrast(a, b) {
  const light = hex => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [light(a), light(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
// Warnings (not errors) about a brand that would be hard to read on air.
export function brandWarnings(event) {
  const c = event.brand.colors, warnings = [];
  for (const [fg, bg, min] of [['ink', 'black', 4.5], ['ink', 'deep', 4.5], ['muted', 'black', 4.5], ['accent', 'black', 3], ['ban', 'black', 3], ['pick', 'black', 3], ['decider', 'black', 3]]) {
    const ratio = contrast(c[fg], c[bg]);
    if (ratio < min) warnings.push(`${fg} на ${bg}: контраст ${ratio.toFixed(1)}, нужен ≥ ${min}`);
  }
  if (c.ban.toLowerCase() === c.pick.toLowerCase()) warnings.push('ban и pick совпадают: бан и пик не различить');
  return warnings;
}
