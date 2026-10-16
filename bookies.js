// Lobby block «Наш турнир у букмекеров» (site only): every minute asks the
// site's /api/bookmakers for each bookmaker's CyberClash events and shows the
// day's matches against the bookmakers: winner odds, the other markets of the
// feed, how big the line is, live. Every line seen is kept for a week in this
// browser (opening and current odds, live) for the summary and the CSV. A
// newly opened line goes to the lobby journal. Each bookmaker's own name for
// the tournament is shown as it is (they misspell it; there is no "right"
// one to compare with). Parsing lives in bookmakers.js.
import { BOOKMAKERS, MANUAL, findMatch, eventKey, marketText } from './bookmakers.js';
import { moscowDay, validDay, normalizeDay } from './assets/bookmaker-history.js';

const $ = id => document.getElementById(id);
const STORE = 'oneshot-bookies';
const EVERY = 60000, RESUME_AFTER = 15000;
const active = () => !document.hidden && navigator.onLine !== false;
const KEEP = 7 * 24 * 3600000;
const results = new Map();
let archive = null, archiveError = '', archiveLoading = false, archiveRequest = 0;
let historyDay = moscowDay(), followToday = true;
let lines = {}, checked = {}, checking = false, lastCheck = 0, startedAt = 0, nextCheck = 0, timer;

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
const matchTime = ms => msk(ms, true);
const pair = odds => odds?.every(Boolean) ? `${odds[0].toFixed(2)} · ${odds[1].toFixed(2)}` : '';
const odds = e => pair(e.odds) || 'линия открыта';
const sizeText = s => s ? `${s.count} ${s.unit}` : '';
// The tournament as this bookmaker writes it (every distinct spelling).
const tournaments = events => [...new Set(events.map(e => String(e.tournament || '').trim()).filter(Boolean))];
const quoted = names => names.map(n => `«${n}»`).join(' · ');
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
};

async function check(bookmaker) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  try {
    const response = await fetch('/api/bookmakers?id=' + bookmaker.id, {
      cache: 'no-store', signal: controller.signal
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
    collect(bookmaker, body.events);
  } catch (error) {
    const old = results.get(bookmaker.id);
    results.set(bookmaker.id, {
      ...(old || { events: [], checkedAt: 0 }), failed:
        ['TimeoutError', 'AbortError'].includes(error.name) ? 'долго не отвечает' : error.message
    });
  }
  clearTimeout(timeout);
  // A slow feed never holds back the other bookmakers or newly found matches.
  render();
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
      b: bookmaker.id, id: e.id, team1: e.team1, team2: e.team2, start: e.start, url: e.url,
      tournament: String(e.tournament || line?.tournament || ''),
      first: line?.first || now, open: line?.open?.some(Boolean) ? line.open : e.odds,
      odds: e.odds, markets: e.markets || [], size: e.size || line?.size || null,
      liveSeen: !!(line?.liveSeen || e.live), liveOffered: !!(line?.liveOffered || e.liveOffered), at: now
    };
    if (fresh && known) {
      window.dispatchEvent(new CustomEvent('oneshot:lobby-note', {
        detail: `${bookmaker.name}: открыта линия ${e.team1} – ${e.team2}${e.start ? ` (${msk(e.start)})` : ''}, ${odds(e)}` +
          (e.tournament ? ` · турнир у них: «${e.tournament}»` : '')
      }));
    }
  }
  checked[bookmaker.id] = now;
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
    await Promise.allSettled([...BOOKMAKERS.map(check), loadArchive()]);
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

// Columns: the schedule's matches of the nearest match day, then CyberClash
// events the schedule doesn't know (another stage, a renamed team).
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
function cell(bookmaker, found, stale = false) {
  const kept = history(bookmaker, found);
  const moved = kept && pair(kept.open) && pair(kept.open) !== pair(found.odds);
  const facts = [sizeText(found.size), liveText(found.live, kept?.liveSeen, found.liveOffered || kept?.liveOffered)].filter(Boolean).join(' · ');
  return el('td', { className: stale ? 'stale' : found.live ? 'live' : 'listed', title: found.tournament ? `Турнир у конторы: «${found.tournament}»` : '' },
    el('span', { className: 'bk-odds', textContent: odds(found) }),
    stale ? el('small', {className:'bad', textContent:'данные устарели'}) : found.live ? el('span', { className: 'bk-live', textContent: 'LIVE' }) : null, open(found.url),
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
    const broken = r && (r.failed || r.ok === false || navigator.onLine === false);
    const partial = !!r?.errors?.length;
    const biggest = events.map(e => e.size).filter(Boolean).sort((x, y) => y.count - x.count)[0];
    const live = events.some(e => e.live) ? 'сейчас в лайве' :
      liveText(false, events.some(e => lines[eventKey(b.id, e)]?.liveSeen), events.some(e => e.liveOffered));
    const state = !r ? 'проверяем…' : broken ?
      'нет связи' + (r.checkedAt ? '; данные на ' + msk(r.checkedAt) : ': ' + (r.failed || 'нет сети')) :
      // Read fine, just no CyberClash on sale there: not a broken source.
      (events.length ? ['в линии: ' + events.length, biggest && 'до ' + sizeText(biggest), live].filter(Boolean).join(' · ') :
        partial ? 'на связи · часть линии не прочитана' : 'на связи · CyberClash в линии нет') +
      (partial ? ' · неполные данные' : '') + (r.coverage === 'prematch' ? ' · только прематч' : '') + (r.checkedAt ? ' · ' + msk(r.checkedAt) : '');
    const cells = cols.map(m => {
      const candidates = events.filter(e => !m.date || !e.start || eventDate(e) === m.date);
      const found = findMatch(candidates, m.team1, m.team2);
      return found ? cell(b, found, broken) : el('td', {className:'none', textContent: !r ? '…' : broken || partial ? '?' : '—',
        title: !r ? 'Проверяем' : broken ? 'Нет связи с конторой' : partial ? 'Ответ неполный' : 'Контора на связи, этого матча в её линии нет'});
    });
    const names = tournaments(events);
    const row = el('tr', { className: events.length ? 'has' : '', id: 'bookie-' + b.id },
      el('th', { scope: 'row', title: r?.failed || (r?.errors || []).join('; ') }, el('span', { textContent: b.name }), open(b.page),
        el('small', { textContent: state, className: broken || partial ? 'bad' : events.length ? 'good' : '' }),
        names.length ? el('em', { className: 'bk-tournament', title: 'Так турнир назван у этой конторы', textContent: quoted(names) }) : null),
      ...cells);
    return { row, order: events.length ? 0 : 1 };
  });
  const manual = MANUAL.map(m => ({ order: 2, row: el('tr', { className: 'manual', id:'bookie-' + m.id },
    el('th', { scope: 'row' }, el('span', { textContent: m.name }), open(m.url),
      el('small', { textContent: m.reason ? 'Вручную: ' + m.reason : 'авто-проверки нет — смотреть вручную' })),
    ...cols.map(() => el('td', { className: 'none', textContent: '?' }))) }));
  const rows = [...auto, ...manual].sort((x, y) => x.order - y.order).map(x => x.row);
  table.replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));
  renderHistory();
  const unavailable = b => {
    const r = results.get(b.id);
    return r && (r.failed || navigator.onLine === false);
  };
  const listed = BOOKMAKERS.filter(b => results.get(b.id)?.events?.length && !unavailable(b)).map(b => b.name);
  const empty = $('bookiesEmpty');
  empty.hidden = !!listed.length || !results.size;
  if (!empty.hidden) empty.textContent = checking ? 'Обновляем источники. Матчи, которые уже видели за день, доступны ниже в истории.' :
    'Сейчас подтверждённых матчей CyberClash в линии нет. Завершённые или снятые с линии матчи могут исчезать у букмекеров — сохранённые наблюдения за день доступны ниже. Недоступные источники отмечены отдельно.';
  const inLive = BOOKMAKERS.filter(b => results.get(b.id)?.events?.some(e => e.live) && !unavailable(b)).map(b => b.name);
  const stale = BOOKMAKERS.filter(unavailable).length;
  const reached = BOOKMAKERS.filter(b => results.has(b.id) && !unavailable(b) && results.get(b.id).ok !== false).length;
  const progress = navigator.onLine === false ? 'Нет сети. Обновим после подключения.' :
    document.hidden ? 'Автообновление продолжится при возвращении на вкладку.' :
    checking ? 'Обновляем линии…' : 'Автообновление каждую минуту.' +
      (nextCheck ? ' Следующая проверка: ' + msk(nextCheck) + ' МСК.' : '');
  $('bookiesStatus').textContent = progress + ' ' +
    (listed.length ? 'Турнир в линии: ' + listed.join(', ') + '.' : 'Подтверждённых матчей в доступных источниках пока нет.') +
    (inLive.length ? ' Сейчас в лайве: ' + inLive.join(', ') + '.' : '') +
    (stale ? ' Недоступно источников: ' + stale + '; прежние коэффициенты отмечены как устаревшие.' : '') +
    (lastCheck && !checking ? ' Проверка: ' + msk(lastCheck) + ' МСК.' : '') +
    ' Автоматически: ' + BOOKMAKERS.length + ' из ' + (BOOKMAKERS.length + MANUAL.length) + ' контор' +
    (results.size ? `, на связи ${reached} из ${BOOKMAKERS.length}` : '') + '. «—» — контора на связи, но этого матча у неё нет.';

}

// Summary for the team chat: who lists the tournament, per match the odds,
// the opening odds, the line size and live.
function summary() {
  const cols = matches();
  const out = [`CyberClash у букмекеров — ${msk(lastCheck || Date.now(), true)} МСК`];
  const listed = BOOKMAKERS.filter(b => { const r = results.get(b.id); return r?.events?.length && !r.failed && r.ok !== false && navigator.onLine !== false; }).map(b => b.name);
  out.push(`В линии у ${listed.length} из ${BOOKMAKERS.length} проверяемых${listed.length ? `: ${listed.join(', ')}` : ''}` +
    ` (ещё ${MANUAL.length} — вручную)`);
  const spelled = BOOKMAKERS.map(b => [b.name, tournaments(results.get(b.id)?.events || [])]).filter(([, names]) => names.length);
  if (spelled.length) out.push('', 'Как называют турнир:', ...spelled.map(([name, names]) => `• ${name}: ${quoted(names)}`));
  for (const m of cols) {
    out.push('', `${m.team1} – ${m.team2}${m.sub ? ` (${m.sub})` : ''}`);
    const none = [], unknown = [], prematch = [];
    for (const b of BOOKMAKERS) {
      const found = findMatch((results.get(b.id)?.events || []).filter(e =>
        !m.date || !e.start || eventDate(e) === m.date), m.team1, m.team2);
      const result = results.get(b.id);
      const stale = !result || result.failed || result.ok === false || navigator.onLine === false;
      if (!found) { (stale || result.errors?.length ? unknown : result.coverage === 'prematch' ? prematch : none).push(b.name); continue; }
      const kept = history(b, found);
      const moved = kept && pair(kept.open) && pair(kept.open) !== pair(found.odds) ? ` (откр. ${pair(kept.open)})` : '';
      const facts = [stale ? 'ДАННЫЕ УСТАРЕЛИ' : '', sizeText(found.size), !stale && found.live ? 'LIVE' : liveText(false, kept?.liveSeen, found.liveOffered || kept?.liveOffered),
        ...(found.markets || []).map(marketText)].filter(Boolean);
      out.push(`• ${b.name}: ${odds(found)}${moved}${facts.length ? ' · ' + facts.join(' · ') : ''}`);
    }
    if (none.length) out.push(`Нет линии: ${none.join(', ')}`);
    if (prematch.length) out.push(`Нет в прематче (лайв не проверен): ${prematch.join(', ')}`);
    if (unknown.length) out.push(`Не удалось проверить: ${unknown.join(', ')}`);
  }
  return out.join('\n');
}
// Every line kept this week, one row each, for Excel (";" and a BOM).
function csv() {
  const cellText = v => {
    let text = String(v ?? '');
    // CSV is data, never a spreadsheet formula from an external team name.
    if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text)) text = "'" + text;
    return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const num = v => v ? v.toFixed(2).replace('.', ',') : '';
  const head = ['Контора', 'Турнир у конторы', 'Команда 1', 'Команда 2', 'Начало (МСК)', 'Линия открыта (МСК)', 'П1 откр.', 'П2 откр.',
    'П1', 'П2', 'Другие рынки', 'Размер линии', 'Лайв', 'Проверено (МСК)', 'Ссылка'];
  const rows = Object.values(lines).sort((x, y) => (x.start || 0) - (y.start || 0) || x.b.localeCompare(y.b)).map(l => [
    nameOf(l.b), l.tournament || '', l.team1, l.team2, msk(l.start, true), msk(l.first, true), num(l.open?.[0]), num(l.open?.[1]),
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


async function loadArchive() {
  if (followToday) historyDay = moscowDay();
  $('bookiesDay').value = historyDay;
  const day = historyDay, request = ++archiveRequest;
  archiveLoading = true; archiveError = ''; renderHistory();
  try {
    const response = await fetch('/api/bookmakers?history=' + day, {cache:'no-store',signal:AbortSignal.timeout(12000)});
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw Error('unavailable');
    const value = normalizeDay(body.archive,day);
    if (request === archiveRequest) archive = value;
  } catch {
    if (request === archiveRequest) archiveError = 'Общий архив временно недоступен. Показываем сохранённое в этом браузере.';
  } finally {
    if (request === archiveRequest) { archiveLoading = false; renderHistory(); }
  }
}
function dayEvents(book) {
  const byId = new Map((archive?.day === historyDay ? archive.books[book.id]?.events || [] : []).map(e => [e.id,e]));
  for (const [key,line] of Object.entries(lines)) {
    if (line.b !== book.id || !Number.isFinite(line.at) ||
        moscowDay(line.start || line.at) !== historyDay) continue;
    const id = line.id || key.slice(book.id.length + 1), old = byId.get(id);
    if (old && old.last > line.at) continue;
    byId.set(id,{...line,id,first:Math.min(line.first || line.at,old?.first || Infinity),last:line.at,
      names:[...new Set([...(old?.names || []),line.tournament].filter(Boolean))]});
  }
  return [...byId.values()].sort((a,b) => (a.start || 0)-(b.start || 0) || a.team1.localeCompare(b.team1));
}
function renderHistory() {
  const table = $('bookiesHistoryTable');
  const rows = [...BOOKMAKERS.map(book => {
    const events = dayEvents(book);
    const record = archive?.day === historyDay ? archive.books[book.id] : null;
    const state = events.length ? 'Сохранено матчей: ' + events.length : !record?.checkedAt ? 'Наблюдений пока нет' :
      record.status === 'error' ? 'Проверить не удалось' : record.status === 'partial' ? 'Ответ был неполным; отсутствие не подтверждено' :
      'В сохранённых проверках матчи не встречались';
    return el('tr',{id:'history-' + book.id},
      el('th',{scope:'row'},el('span',{textContent:book.name}),open(book.page),
        el('small',{textContent:state})),
      el('td',{},...(events.length ? events.map(e => el('div',{className:'bk-history-match'},
        el('b',{textContent:e.team1 + ' – ' + e.team2}),open(e.url),
        el('small',{textContent:(e.start ? matchTime(e.start) + ' МСК · ' : 'время матча не указано · ') +
          'последние замеченные кэфы: ' + (pair(e.odds) || 'не опубликованы')}),
        el('small',{textContent:(e.first && e.last ? 'Видели: ' + msk(e.first,true) + ' — ' + msk(e.last,true) + ' МСК' : 'Восстановлено из сохранённого ответа; время наблюдения неизвестно') +
          (e.liveSeen ? ' · был в лайве' : '')}),
        (e.names?.length || e.tournament) ? el('em',{className:'bk-tournament',
          textContent:quoted(e.names?.length ? e.names : [e.tournament])}) : null
      )) : [el('span',{className:'none',textContent:!record?.checkedAt ? 'Нет сохранённых наблюдений; это не означает отсутствие линии.' :
        record.status !== 'ok' ? 'Наличие матчей неизвестно.' : 'Не зафиксированы. Между проверками могли появляться другие матчи.'})])));
  }), ...MANUAL.map(book => el('tr',{id:'history-' + book.id,className:'manual'},
    el('th',{scope:'row'},el('span',{textContent:book.name}),open(book.url)),
    el('td',{textContent:'Автоматическое чтение пока недоступно. История матчей не подтверждена.'})))];
  table.replaceChildren(el('thead',{},el('tr',{},el('th',{scope:'col',textContent:'Контора'}),
    el('th',{scope:'col',textContent:'Матчи за выбранный день (МСК)'}))),el('tbody',{},...rows));
  const total = BOOKMAKERS.reduce((n,b) => n + dayEvents(b).length,0);
  $('bookiesHistoryStatus').textContent =
    (archiveLoading ? 'Загружаем общий архив… ' : archiveError ? archiveError + ' ' : '') +
    'Сохранено наблюдений матчей: ' + total + '. ' +
    (archive?.day === historyDay && archive.updatedAt ? 'Общий архив обновлён ' + msk(archive.updatedAt,true) + ' МСК. ' :
      'Общий архив за этот день пока не заполнен. ') +
    (archive?.note ? archive.note + ' ' : '') +
    'Время матчей — МСК. История означает «видели в линии», а не результат матча. ' +
    'Фоновый сбор — примерно раз в 10 минут, даже при закрытой панели; возможны задержки планировщика.';
}
function historyCsv() {
  const rows = [['Дата матча (МСК)','Контора','Турнир у конторы','Команда 1','Команда 2','Начало (МСК)',
    'Впервые видели (МСК)','Последний раз видели (МСК)','П1 последние','П2 последние','Был в лайве','Ссылка']];
  for (const book of BOOKMAKERS) for (const e of dayEvents(book)) rows.push([
    historyDay,book.name,(e.names?.length ? e.names : [e.tournament || '']).join(' | '),e.team1,e.team2,
    matchTime(e.start),msk(e.first,true),msk(e.last,true),e.odds?.[0] || '',e.odds?.[1] || '',
    e.liveSeen ? 'да' : '',e.url
  ]);
  const quote = value => {
    let text = String(value ?? '');
    if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g,'""') + '"';
  };
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(quote).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const link = el('a',{href:url,download:'cyberclash-history-' + historyDay + '.csv'});
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
$('bookiesDay').value = historyDay;
$('bookiesDay').addEventListener('change',() => {
  const day = $('bookiesDay').value;
  if (!validDay(day)) { $('bookiesDay').value = historyDay; return; }
  historyDay = day; followToday = day === moscowDay(); archive = null; loadArchive();
});
$('bookiesToday').addEventListener('click',() => {
  followToday = true; historyDay = moscowDay(); archive = null; loadArchive();
});
$('bookiesHistoryCsv').addEventListener('click',historyCsv);

$('bookiesCheck').addEventListener('click', checkAll);
$('bookiesCopy').addEventListener('click', () => window.oneshotPanel?.copy?.(summary()));
$('bookiesCsv').addEventListener('click', download);
document.addEventListener('oneshot:change', render);
document.addEventListener('visibilitychange', wake);
window.addEventListener('focus', wake);
window.addEventListener('online', wake);
window.addEventListener('offline', wake);
render();
checkAll();
