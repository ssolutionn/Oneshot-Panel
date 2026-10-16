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

// Rows: the schedule's matches for today and tomorrow, then CyberClash
// events the schedule doesn't know (another stage, a renamed team).
function rows() {
  const schedule = window.oneshotPanel?.snapshot?.().schedule || [];
  const list = schedule.slice(0, 12).map(m => ({
    team1: m.team1, team2: m.team2, label: `${m.team1} – ${m.team2}`,
    sub: [m.date, m.time].filter(Boolean).join(' · ')
  }));
  for (const b of BOOKMAKERS) {
    for (const e of results.get(b.id)?.events || []) {
      if (list.some(r => findMatch([e], r.team1, r.team2))) continue;
      list.push({ team1: e.team1, team2: e.team2, label: `${e.team1} – ${e.team2}`, sub: msk(e.start) });
    }
  }
  return list;
}
function render() {
  const table = $('bookiesTable');
  const head = el('tr', {}, el('th', { scope: 'col', textContent: 'Матч' }),
    ...BOOKMAKERS.map(b => {
      const r = results.get(b.id);
      const broken = r && (r.failed || r.ok === false);
      const state = !r ? 'ждём' : r.failed ? 'нет связи' : r.events.length ? `${r.events.length} матч.` :
        r.ok === false ? 'ошибка линии' : 'нет турнира';
      return el('th', { scope: 'col', title: r?.failed || (r?.errors || []).join('; ') },
        el('a', { href: b.page, target: '_blank', rel: 'noreferrer', textContent: b.name }),
        el('small', { textContent: state, className: broken && !r.events.length ? 'bad' : r?.events.length ? 'good' : '' }));
    }));
  const body = rows().map(row => el('tr', {},
    el('th', { scope: 'row' }, el('b', { textContent: row.label }), el('small', { textContent: row.sub })),
    ...BOOKMAKERS.map(b => {
      const found = findMatch(results.get(b.id)?.events || [], row.team1, row.team2);
      if (!found) return el('td', { className: 'none', textContent: '—' });
      return el('td', { className: found.live ? 'live' : 'listed' },
        el('a', { href: found.url, target: '_blank', rel: 'noreferrer', textContent: odds(found) }),
        found.live ? el('span', { className: 'bk-live', textContent: 'LIVE' }) : null);
    })));
  table.replaceChildren(el('thead', {}, head), el('tbody', {}, ...(body.length ? body :
    [el('tr', {}, el('td', { colSpan: BOOKMAKERS.length + 1, className: 'none', textContent: 'Матчей CyberClash в линиях пока нет.' }))])));
  const listed = BOOKMAKERS.filter(b => results.get(b.id)?.events?.length).map(b => b.name);
  $('bookiesStatus').textContent = !lastCheck ? 'Проверяем линии…' :
    `Проверено в ${msk(lastCheck)} МСК. ${listed.length ? `Турнир в линии: ${listed.join(', ')}.` : 'Ни у одной из проверяемых БК турнира сейчас нет.'} Следующая проверка через 5 минут.`;
}

$('bookiesManual').replaceChildren(...MANUAL.map(m =>
  el('li', {}, el('a', { href: m.url, target: '_blank', rel: 'noreferrer', textContent: m.name }))));
$('bookiesCheck').addEventListener('click', checkAll);
document.addEventListener('oneshot:change', () => { if (lastCheck) render(); });
render();
checkAll();
setInterval(checkAll, EVERY);
