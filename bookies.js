// Live, read-only tournament coverage. Every source renders as soon as it
// answers; background tabs pause polling and returning to the page resumes it.
import { BOOKMAKERS, MANUAL, findMatch, eventKey } from './bookmakers.js';

const $ = id => document.getElementById(id);
const STORE = 'oneshot-bookies';
const EVERY = 60000, RESUME_AFTER = 15000;
const results = new Map();
let seen = {}, checking = false, lastCheck = 0, startedAt = 0, nextCheck = 0, timer;
const active = () => !document.hidden && navigator.onLine !== false;
const msk = ms => ms ? new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit'
}).format(new Date(ms)) : '';
const matchTime = ms => ms ? new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
}).format(new Date(ms)) : '';
try {
  const stored = JSON.parse(localStorage.getItem(STORE));
  if (stored?.seen && typeof stored.seen === 'object' && !Array.isArray(stored.seen)) seen = stored.seen;
} catch { /* First visit or unavailable storage. */ }
function save() {
  const day = Date.now() - 36 * 3600000;
  seen = Object.fromEntries(Object.entries(seen).filter(([, at]) => Number.isFinite(at) && at > day));
  try { localStorage.setItem(STORE, JSON.stringify({ seen })); } catch { /* not kept */ }
}
const odds = e => e.odds?.length === 2 && e.odds.every(v => Number.isFinite(v) && v > 1) ?
  e.odds.map(v => v.toFixed(2)).join(' · ') : 'линия открыта';
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
  return node;
};

async function check(bookmaker) {
  try {
    const response = await fetch('/api/bookmakers?id=' + bookmaker.id, {
      cache: 'no-store', signal: AbortSignal.timeout(35000)
    });
    if (!/json/.test(response.headers.get('content-type') || '')) {
      throw new Error('у сайта нет функции /api/bookmakers');
    }
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || 'HTTP ' + response.status);
    if (!Array.isArray(body.events) || typeof body.ok !== 'boolean') throw new Error('неверный ответ источника');
    if (!body.ok) throw new Error(body.errors?.join('; ') || 'источник недоступен');
    results.set(bookmaker.id, {
      ...body, failed: '', checkedAt: Number.isFinite(body.checkedAt) ? body.checkedAt : Date.now()
    });
    note(bookmaker, body.events);
  } catch (error) {
    const old = results.get(bookmaker.id);
    results.set(bookmaker.id, {
      ...(old || { events: [], checkedAt: 0 }), failed:
        ['TimeoutError', 'AbortError'].includes(error.name) ? 'долго не отвечает' : error.message
    });
  }
  // A slow feed never holds back the other bookmakers or newly found matches.
  render();
}
function note(bookmaker, events) {
  const known = Object.keys(seen).some(key => key.startsWith(bookmaker.id + ':'));
  for (const e of events) {
    const key = eventKey(bookmaker.id, e);
    if (seen[key]) continue;
    seen[key] = Date.now();
    if (known) {
      window.dispatchEvent(new CustomEvent('oneshot:lobby-note', {
        detail: bookmaker.name + ': открыта линия ' + e.team1 + ' – ' + e.team2 +
          (e.start ? ' (' + matchTime(e.start) + ')' : '') + ', ' + odds(e)
      }));
    }
  }
  if (!events.length) seen[bookmaker.id + ':checked'] = Date.now();
  save();
}

function scheduleCheck() {
  clearTimeout(timer);
  nextCheck = active() ? Math.max(Date.now() + 1000, startedAt + EVERY) : 0;
  if (nextCheck) timer = setTimeout(checkAll, nextCheck - Date.now());
}
async function checkAll() {
  if (checking) return;
  clearTimeout(timer);
  if (!active()) { nextCheck = 0; render(); return; }
  checking = true;
  startedAt = Date.now();
  nextCheck = 0;
  $('bookiesCheck').disabled = true;
  render();
  try {
    await Promise.allSettled(BOOKMAKERS.map(check));
    lastCheck = Date.now();
  } finally {
    checking = false;
    $('bookiesCheck').disabled = false;
    scheduleCheck();
    render();
  }
}
function wake() {
  clearTimeout(timer);
  if (!active()) { nextCheck = 0; render(); return; }
  if (!checking && (!startedAt || Date.now() - startedAt >= RESUME_AFTER)) checkAll();
  else if (!checking) { scheduleCheck(); render(); }
}

// The nearest scheduled match day plus events discovered directly in the
// tournament feeds. No fixed match list and no eight-column truncation.
function matches() {
  const schedule = window.oneshotPanel?.snapshot?.().schedule || [];
  const day = schedule[0]?.date;
  const list = schedule.filter(m => m.date === day).map(m => ({
    team1: m.team1, team2: m.team2, date: m.date || '', sub: [m.date, m.time].filter(Boolean).join(' · ')
  }));
  for (const b of BOOKMAKERS) {
    for (const e of results.get(b.id)?.events || []) {
      const date = e.start ? new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit'
      }).format(new Date(e.start)) : '';
      if (list.some(r => (!date || !r.date || r.date === date) && findMatch([e], r.team1, r.team2))) continue;
      list.push({ team1: e.team1, team2: e.team2, date, sub: matchTime(e.start) });
    }
  }
  return list;
}
const eventDate = e => e.start ? new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit'
}).format(new Date(e.start)) : '';
const open = href => {
  // API data cannot turn a link into script execution or navigate off the
  // bookmaker's own site. No credentials or user-supplied URLs are accepted.
  let url;
  try { url = new URL(href); } catch { return null; }
  const domains = [...BOOKMAKERS.map(b => b.page), ...MANUAL.map(b => b.url)]
    .map(value => new URL(value).hostname);
  if (url.protocol !== 'https:' || url.username || url.password || !domains.includes(url.hostname)) return null;
  return el('a', { href: url.href, target: '_blank', rel: 'noreferrer', className: 'bk-open', title: 'Открыть', textContent: '↗' });
};
function render() {
  const cols = matches();
  const head = el('tr', {}, el('th', { scope: 'col', textContent: 'Контора' }),
    ...cols.map(m => el('th', { scope: 'col' },
      el('b', { textContent: m.team1 + ' – ' + m.team2 }), el('small', { textContent: m.sub }))));
  const auto = BOOKMAKERS.map(b => {
    const r = results.get(b.id), partial = !!r?.errors?.length;
    const stale = !!r && (!!r.failed || navigator.onLine === false);
    const state = !r ? 'проверяем…' : stale ?
      'нет связи' + (r.checkedAt ? '; данные на ' + msk(r.checkedAt) : ': ' + r.failed) :
      (r.events.length ? 'в линии: ' + r.events.length : 'матчи не найдены') +
        (partial ? ' · неполные данные' : '') + ' · ' + msk(r.checkedAt);
    const cells = cols.map(m => {
      const candidates = (r?.events || []).filter(e => !m.date || !e.start || eventDate(e) === m.date);
      const found = findMatch(candidates, m.team1, m.team2);
      if (!found) return el('td', { className: 'none', textContent: stale || partial ? '?' : '—' });
      return el('td', { className: stale ? 'stale' : found.live ? 'live' : 'listed',
        title: stale ? 'Последние доступные данные: ' + msk(r.checkedAt) + ' МСК' : '' },
        el('span', { className: 'bk-odds', textContent: odds(found) }),
        stale ? el('small', { className: 'bad', textContent: 'данные устарели' }) :
          found.live ? el('span', { className: 'bk-live', textContent: 'LIVE' }) : null,
        open(found.url));
    });
    return { order: r?.events?.length ? 0 : 1, row: el('tr', { className: r?.events?.length ? 'has' : '', id: 'bookie-' + b.id },
      el('th', { scope: 'row', title: r?.failed || (r?.errors || []).join('; ') },
        el('span', { textContent: b.name }), open(b.page),
        el('small', { textContent: state, className: stale || partial ? 'bad' : r?.events?.length ? 'good' : '' })),
      ...cells) };
  });
  const manual = MANUAL.map(m => ({ order: 2, row: el('tr', { className: 'manual' },
    el('th', { scope: 'row' }, el('span', { textContent: m.name }), open(m.url),
      el('small', { textContent: 'авто-проверки нет — смотреть вручную' })),
    ...cols.map(() => el('td', { className: 'none', textContent: '?' }))) }));
  $('bookiesTable').replaceChildren(el('thead', {}, head),
    el('tbody', {}, ...[...auto, ...manual].sort((x, y) => x.order - y.order).map(x => x.row)));
  const stale = BOOKMAKERS.filter(b => {
    const r = results.get(b.id);
    return r && (r.failed || navigator.onLine === false);
  }).length;
  const listed = BOOKMAKERS.filter(b => results.get(b.id)?.events?.length && !results.get(b.id)?.failed && navigator.onLine !== false).map(b => b.name);
  const summary = listed.length ? 'В линии: ' + listed.join(', ') + '.' :
    'Подтверждённых матчей в доступных источниках пока нет.';
  const progress = navigator.onLine === false ? 'Нет сети. Обновим после подключения.' :
    document.hidden ? 'Автообновление продолжится при возвращении на вкладку.' :
      checking ? 'Обновляем линии…' : 'Автообновление каждую минуту.' + (nextCheck ? ' Следующая проверка: ' + msk(nextCheck) + ' МСК.' : '');
  $('bookiesStatus').textContent = progress + ' ' + summary +
    (stale ? ' Недоступно источников: ' + stale + '; прежние коэффициенты отмечены как устаревшие.' : '') +
    (lastCheck && !checking ? ' Проверка: ' + msk(lastCheck) + ' МСК.' : '') +
    ' Автоматически: ' + BOOKMAKERS.length + ' из ' + (BOOKMAKERS.length + MANUAL.length) + ' контор.';
}

$('bookiesCheck').addEventListener('click', checkAll);
document.addEventListener('oneshot:change', render);
document.addEventListener('visibilitychange', wake);
window.addEventListener('focus', wake);
window.addEventListener('online', wake);
window.addEventListener('offline', wake);
render();
checkAll();
