// Lobby block «Наш турнир у букмекеров» (site only): every 5 minutes asks the
// site's /api/bookmakers for each bookmaker's CyberClash events and shows the
// day's matches against the bookmakers: winner odds, the other markets of the
// feed, how big the line is, live. Every line seen is kept for a week in this
// browser (opening and current odds, live) for the summary and the CSV. A
// newly opened line goes to the lobby journal. Parsing lives in bookmakers.js.
import { BOOKMAKERS, MANUAL, findMatch, eventKey, marketText } from './bookmakers.js';

const $ = id => document.getElementById(id);
const STORE = 'oneshot-bookies';
const EVERY = 5 * 60000;
const KEEP = 7 * 24 * 3600000;
const results = new Map();
let lines = {}, checked = {}, checking = false, lastCheck = 0;

try {
  const stored = JSON.parse(localStorage.getItem(STORE)) || {};
  lines = stored.lines && typeof stored.lines === 'object' ? stored.lines : {};
  checked = stored.checked && typeof stored.checked === 'object' ? stored.checked : {};
} catch { lines = {}; checked = {}; }
function save() {
  const old = Date.now() - KEEP;
  lines = Object.fromEntries(Object.entries(lines).filter(([, l]) => l?.at > old));
  try { localStorage.setItem(STORE, JSON.stringify({ lines, checked })); } catch { /* not kept */ }
}
const nameOf = id => BOOKMAKERS.find(b => b.id === id)?.name || id;
const msk = (ms, withDate) => ms ? new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', ...(withDate ? { day: '2-digit', month: '2-digit' } : {})
}).format(new Date(ms)) : '';
const pair = odds => odds?.every(Boolean) ? `${odds[0].toFixed(2)} · ${odds[1].toFixed(2)}` : '';
const odds = e => pair(e.odds) || 'линия открыта';
const sizeText = s => s ? `${s.count} ${s.unit}` : '';
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false && c !== ''));
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
    collect(bookmaker, body.events || []);
  } catch (error) {
    const old = results.get(bookmaker.id);
    results.set(bookmaker.id, { ...(old || { events: [] }), ok: false, failed: error.name === 'TimeoutError' ? 'долго не отвечает' : error.message });
  }
}
// Every event goes to the week's history: when the line opened and at what
// odds, the current odds, whether it was in live. A line seen for the first
// time (after this browser's first check of that bookmaker) goes to the
// lobby journal.
function collect(bookmaker, events) {
  const now = Date.now();
  const known = !!checked[bookmaker.id];
  for (const e of events) {
    const key = eventKey(bookmaker.id, e);
    const line = lines[key];
    const fresh = !line;
    lines[key] = {
      b: bookmaker.id, team1: e.team1, team2: e.team2, start: e.start, url: e.url,
      first: line?.first || now, open: line?.open?.some(Boolean) ? line.open : e.odds,
      odds: e.odds, markets: e.markets || [], size: e.size || line?.size || null,
      liveSeen: !!(line?.liveSeen || e.live), liveOffered: !!(line?.liveOffered || e.liveOffered), at: now
    };
    if (fresh && known) {
      window.dispatchEvent(new CustomEvent('oneshot:lobby-note', {
        detail: `${bookmaker.name}: открыта линия ${e.team1} – ${e.team2}${e.start ? ` (${msk(e.start)})` : ''}, ${odds(e)}`
      }));
    }
  }
  checked[bookmaker.id] = now;
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
// The kept line of a found event, opening odds turned to our team order.
function history(bookmaker, found) {
  const line = lines[eventKey(bookmaker.id, found)];
  if (!line) return null;
  const open = found.swapped ? [line.open?.[1], line.open?.[0]] : line.open;
  return { ...line, open };
}
const liveText = (live, seen, offered) => live ? '' : seen ? 'был в лайве' : offered ? 'лайв заявлен' : '';

// Text never sits inside a link to a bookmaker: ad blockers hide such links
// (and the odds in them). The link is a separate ↗.
const open = href => el('a', { href, target: '_blank', rel: 'noreferrer', className: 'bk-open', title: 'Открыть', textContent: '↗' });
function cell(bookmaker, found) {
  const kept = history(bookmaker, found);
  const moved = kept && pair(kept.open) && pair(kept.open) !== pair(found.odds);
  const facts = [sizeText(found.size), liveText(found.live, kept?.liveSeen, found.liveOffered || kept?.liveOffered)].filter(Boolean).join(' · ');
  return el('td', { className: found.live ? 'live' : 'listed' },
    el('span', { className: 'bk-odds', textContent: odds(found) }),
    found.live ? el('span', { className: 'bk-live', textContent: 'LIVE' }) : null, open(found.url),
    moved ? el('small', { textContent: `откр. ${pair(kept.open)}` }) : null,
    ...(found.markets || []).map(m => el('small', { className: 'bk-market', textContent: marketText(m) })),
    facts ? el('small', { textContent: facts }) : null);
}
function render() {
  const table = $('bookiesTable');
  const cols = matches();
  const head = el('tr', {}, el('th', { scope: 'col', textContent: 'Контора' }),
    ...cols.map(m => el('th', { scope: 'col' }, el('b', { textContent: `${m.team1} – ${m.team2}` }), el('small', { textContent: m.sub }))));
  const auto = BOOKMAKERS.map(b => {
    const r = results.get(b.id);
    const events = r?.events || [];
    const broken = r && (r.failed || r.ok === false);
    const biggest = events.map(e => e.size).filter(Boolean).sort((x, y) => y.count - x.count)[0];
    const live = events.some(e => e.live) ? 'сейчас в лайве' :
      liveText(false, events.some(e => lines[eventKey(b.id, e)]?.liveSeen), events.some(e => e.liveOffered));
    const state = !r ? 'проверяем…' : r.failed ? `нет связи: ${r.failed}` :
      events.length ? [`в линии: ${events.length}`, biggest && `до ${sizeText(biggest)}`, live].filter(Boolean).join(' · ') :
        r.ok === false ? 'ошибка линии' : 'турнира нет';
    const cells = cols.map(m => {
      const found = findMatch(events, m.team1, m.team2);
      return found ? cell(b, found) : el('td', { className: 'none', textContent: '—' });
    });
    const row = el('tr', { className: events.length ? 'has' : '' },
      el('th', { scope: 'row', title: (r?.errors || []).join('; ') }, el('span', { textContent: b.name }), open(b.page),
        el('small', { textContent: state, className: broken && !events.length ? 'bad' : events.length ? 'good' : '' })),
      ...cells);
    return { row, order: events.length ? 0 : 1 };
  });
  const manual = MANUAL.map(m => ({ order: 2, row: el('tr', { className: 'manual' },
    el('th', { scope: 'row' }, el('span', { textContent: m.name }), open(m.url),
      el('small', { textContent: 'авто-проверки нет — смотреть вручную' })),
    ...cols.map(() => el('td', { className: 'none', textContent: '?' }))) }));
  const rows = [...auto, ...manual].sort((x, y) => x.order - y.order).map(x => x.row);
  table.replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));
  const listed = BOOKMAKERS.filter(b => results.get(b.id)?.events?.length).map(b => b.name);
  const inLive = BOOKMAKERS.filter(b => results.get(b.id)?.events?.some(e => e.live)).map(b => b.name);
  $('bookiesStatus').textContent = !lastCheck ? 'Проверяем линии…' :
    `Проверено в ${msk(lastCheck)} МСК. ${listed.length ? `Турнир в линии: ${listed.join(', ')}.` : 'Ни у одной из проверяемых БК турнира сейчас нет.'} ` +
    `${inLive.length ? `Сейчас в лайве: ${inLive.join(', ')}. ` : ''}` +
    `Автоматически: ${BOOKMAKERS.length} из ${BOOKMAKERS.length + MANUAL.length} контор, следующая проверка через 5 минут.`;
}

// Summary for the team chat: who lists the tournament, per match the odds,
// the opening odds, the line size and live.
function summary() {
  const cols = matches();
  const out = [`CyberClash у букмекеров — ${msk(lastCheck || Date.now(), true)} МСК`];
  const listed = BOOKMAKERS.filter(b => results.get(b.id)?.events?.length).map(b => b.name);
  out.push(`В линии у ${listed.length} из ${BOOKMAKERS.length} проверяемых${listed.length ? `: ${listed.join(', ')}` : ''}` +
    ` (ещё ${MANUAL.length} — вручную)`);
  for (const m of cols) {
    out.push('', `${m.team1} – ${m.team2}${m.sub ? ` (${m.sub})` : ''}`);
    const none = [];
    for (const b of BOOKMAKERS) {
      const found = findMatch(results.get(b.id)?.events || [], m.team1, m.team2);
      if (!found) { none.push(b.name); continue; }
      const kept = history(b, found);
      const moved = kept && pair(kept.open) && pair(kept.open) !== pair(found.odds) ? ` (откр. ${pair(kept.open)})` : '';
      const facts = [sizeText(found.size), found.live ? 'LIVE' : liveText(false, kept?.liveSeen, found.liveOffered || kept?.liveOffered),
        ...(found.markets || []).map(marketText)].filter(Boolean);
      out.push(`• ${b.name}: ${odds(found)}${moved}${facts.length ? ' · ' + facts.join(' · ') : ''}`);
    }
    if (none.length) out.push(`Нет линии: ${none.join(', ')}`);
  }
  return out.join('\n');
}
// Every line kept this week, one row each, for Excel (";" and a BOM).
function csv() {
  const cellText = v => {
    const text = String(v ?? '');
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const num = v => v ? v.toFixed(2).replace('.', ',') : '';
  const head = ['Контора', 'Команда 1', 'Команда 2', 'Начало (МСК)', 'Линия открыта (МСК)', 'П1 откр.', 'П2 откр.',
    'П1', 'П2', 'Другие рынки', 'Размер линии', 'Лайв', 'Проверено (МСК)', 'Ссылка'];
  const rows = Object.values(lines).sort((x, y) => (x.start || 0) - (y.start || 0) || x.b.localeCompare(y.b)).map(l => [
    nameOf(l.b), l.team1, l.team2, msk(l.start, true), msk(l.first, true), num(l.open?.[0]), num(l.open?.[1]),
    num(l.odds?.[0]), num(l.odds?.[1]), (l.markets || []).map(marketText).join('; '), sizeText(l.size),
    l.liveSeen ? 'был' : l.liveOffered ? 'заявлен' : '', msk(l.at, true), l.url
  ]);
  return '﻿' + [head, ...rows].map(r => r.map(cellText).join(';')).join('\r\n');
}
function download() {
  if (!Object.keys(lines).length) return window.oneshotPanel?.toast?.('Пока нечего выгружать: ни одной линии не видели.');
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  const link = el('a', { href: URL.createObjectURL(new Blob([csv()], { type: 'text/csv;charset=utf-8' })),
    download: `cyberclash-bookmakers-${day}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$('bookiesCheck').addEventListener('click', checkAll);
$('bookiesCopy').addEventListener('click', () => window.oneshotPanel?.copy?.(summary()));
$('bookiesCsv').addEventListener('click', download);
document.addEventListener('oneshot:change', () => { if (lastCheck) render(); });
render();
checkAll();
setInterval(checkAll, EVERY);
