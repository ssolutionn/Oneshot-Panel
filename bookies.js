// Lobby block «Наш турнир у букмекеров» (site only): every 5 minutes asks the
// site's /api/bookmakers for each bookmaker's CyberClash events and shows the
// day's matches against the bookmakers, with odds and links. A newly opened
// line goes to the lobby journal. Parsing lives in bookmakers.js.
import { BOOKMAKERS, MANUAL, findMatch, eventKey } from './bookmakers.js';

const $ = id => document.getElementById(id);
const STORE = 'oneshot-bookies';
const EVERY = 5 * 60000;
const results = new Map();
let seen = {}, checking = false, lastCheck = 0;

try { seen = JSON.parse(localStorage.getItem(STORE))?.seen || {}; } catch { seen = {}; }
function save() {
  // Keep a day of first sightings: enough to tell what is new.
  const day = Date.now() - 36 * 3600000;
  seen = Object.fromEntries(Object.entries(seen).filter(([, at]) => at > day));
  try { localStorage.setItem(STORE, JSON.stringify({ seen })); } catch { /* not kept */ }
}
const msk = ms => ms ? new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit'
}).format(new Date(ms)) : '';
const odds = e => e.odds.every(Boolean) ? `${e.odds[0].toFixed(2)} · ${e.odds[1].toFixed(2)}` : 'линия открыта';
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
  return node;
};

async function check(bookmaker) {
  try {
    const response = await fetch(`/api/bookmakers?id=${bookmaker.id}`, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
    const type = response.headers.get('content-type') || '';
    if (!/json/.test(type)) throw new Error('у сайта нет функции /api/bookmakers');
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    results.set(bookmaker.id, body);
    note(bookmaker, body.events);
  } catch (error) {
    const old = results.get(bookmaker.id);
    results.set(bookmaker.id, { ...(old || { events: [] }), ok: false, failed: error.name === 'TimeoutError' ? 'долго не отвечает' : error.message });
  }
}
// A line seen for the first time (after this browser's first check of that
// bookmaker) goes to the lobby journal.
function note(bookmaker, events) {
  const known = Object.keys(seen).some(key => key.startsWith(bookmaker.id + ':'));
  for (const e of events) {
    const key = eventKey(bookmaker.id, e);
    if (seen[key]) continue;
    seen[key] = Date.now();
    if (known) {
      window.dispatchEvent(new CustomEvent('oneshot:lobby-note', {
        detail: `${bookmaker.name}: открыта линия ${e.team1} – ${e.team2}${e.start ? ` (${msk(e.start)})` : ''}, ${odds(e)}`
      }));
    }
  }
  // Nothing listed yet still counts as checked, so later lines are "new".
  if (!events.length) seen[`${bookmaker.id}:checked`] = Date.now();
  save();
}

async function checkAll() {
  if (checking) return;
  checking = true;
  $('bookiesCheck').disabled = true;
  $('bookiesStatus').textContent = 'Проверяем линии…';
  await Promise.allSettled(BOOKMAKERS.map(check));
  lastCheck = Date.now();
  checking = false;
  $('bookiesCheck').disabled = false;
  render();
}

// Columns: the schedule's matches of the nearest match day, then CyberClash
// events the schedule doesn't know (another stage, a renamed team).
function matches() {
  const schedule = window.oneshotPanel?.snapshot?.().schedule || [];
  const day = schedule[0]?.date;
  const list = schedule.filter(m => m.date === day).slice(0, 8).map(m => ({
    team1: m.team1, team2: m.team2, sub: m.time || ''
  }));
  for (const b of BOOKMAKERS) {
    for (const e of results.get(b.id)?.events || []) {
      if (list.some(r => findMatch([e], r.team1, r.team2))) continue;
      list.push({ team1: e.team1, team2: e.team2, sub: msk(e.start) });
    }
  }
  return list;
}
// Text never sits inside a link to a bookmaker: ad blockers hide such links
// (and the odds in them). The link is a separate ↗.
const open = href => el('a', { href, target: '_blank', rel: 'noreferrer', className: 'bk-open', title: 'Открыть', textContent: '↗' });
function render() {
  const table = $('bookiesTable');
  const cols = matches();
  const head = el('tr', {}, el('th', { scope: 'col', textContent: 'Контора' }),
    ...cols.map(m => el('th', { scope: 'col' }, el('b', { textContent: `${m.team1} – ${m.team2}` }), el('small', { textContent: m.sub }))));
  const auto = BOOKMAKERS.map(b => {
    const r = results.get(b.id);
    const broken = r && (r.failed || r.ok === false);
    const state = !r ? 'проверяем…' : r.failed ? `нет связи: ${r.failed}` : r.events.length ? `в линии: ${r.events.length}` :
      r.ok === false ? 'ошибка линии' : 'турнира нет';
    const cells = cols.map(m => {
      const found = findMatch(r?.events || [], m.team1, m.team2);
      if (!found) return el('td', { className: 'none', textContent: '—' });
      return el('td', { className: found.live ? 'live' : 'listed' },
        el('span', { className: 'bk-odds', textContent: odds(found) }),
        found.live ? el('span', { className: 'bk-live', textContent: 'LIVE' }) : null, open(found.url));
    });
    const row = el('tr', { className: r?.events?.length ? 'has' : '' },
      el('th', { scope: 'row', title: (r?.errors || []).join('; ') }, el('span', { textContent: b.name }), open(b.page),
        el('small', { textContent: state, className: broken && !r.events.length ? 'bad' : r?.events?.length ? 'good' : '' })),
      ...cells);
    return { row, order: r?.events?.length ? 0 : 1 };
  });
  const manual = MANUAL.map(m => ({ order: 2, row: el('tr', { className: 'manual' },
    el('th', { scope: 'row' }, el('span', { textContent: m.name }), open(m.url),
      el('small', { textContent: 'авто-проверки нет — смотреть вручную' })),
    ...cols.map(() => el('td', { className: 'none', textContent: '?' }))) }));
  const rows = [...auto, ...manual].sort((x, y) => x.order - y.order).map(x => x.row);
  table.replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));
  const listed = BOOKMAKERS.filter(b => results.get(b.id)?.events?.length).map(b => b.name);
  $('bookiesStatus').textContent = !lastCheck ? 'Проверяем линии…' :
    `Проверено в ${msk(lastCheck)} МСК. ${listed.length ? `Турнир в линии: ${listed.join(', ')}.` : 'Ни у одной из проверяемых БК турнира сейчас нет.'} ` +
    `Автоматически: ${BOOKMAKERS.length} из ${BOOKMAKERS.length + MANUAL.length} контор, следующая проверка через 5 минут.`;
}

$('bookiesCheck').addEventListener('click', checkAll);
document.addEventListener('oneshot:change', () => { if (lastCheck) render(); });
render();
checkAll();
setInterval(checkAll, EVERY);
