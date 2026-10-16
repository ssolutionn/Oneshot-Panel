// Public observations only. Match days and all displayed times use Moscow.
import {BOOKMAKERS, isCyberClash} from '../bookmakers.js';
export const moscowDay = (ms = Date.now()) => new Date(ms + 10800000).toISOString().slice(0, 10);
export const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
  Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10) === day;
const text = (value, limit = 300) => typeof value === 'string' ? value.slice(0,limit) : '';
const stamp = value => Number.isFinite(value) && value > 0 && value < 4102444800000 ? value : 0;
const prices = values => [0,1].map(i => Number.isFinite(values?.[i]) && values[i] > 1 && values[i] < 100000 ? values[i] : null);
export function publicEvent(id, source) {
  const book = BOOKMAKERS.find(b => b.id === id);
  if (!book || !source || !text(source.id) || !text(source.team1) || !text(source.team2) || !isCyberClash(source.tournament)) return null;
  let url = book.page;
  try {
    const u = new URL(source.url);
    if (u.protocol === 'https:' && !u.username && !u.password && u.hostname === new URL(book.page).hostname && !u.search && !u.hash) url = u.href;
  } catch { /* use the public bookmaker homepage */ }
  return {
    id:text(source.id,200), team1:text(source.team1), team2:text(source.team2),
    tournament:text(source.tournament), start:stamp(source.start) || null,
    odds:prices(source.odds), url, live:source.live === true,
    liveOffered:source.liveOffered === true
  };
}
export const emptyDay = day => ({version:1, day, startedAt:0, updatedAt:0, books:{}});
export function normalizeDay(value, day) {
  if (!validDay(day) || value?.version !== 1 || value.day !== day || !value.books || typeof value.books !== 'object') throw Error('Неверный формат истории');
  const out = emptyDay(day);
  out.startedAt = stamp(value.startedAt); out.updatedAt = stamp(value.updatedAt);
  for (const book of BOOKMAKERS) {
    const row = value.books[book.id];
    if (!row || !Array.isArray(row.events) || row.events.length > 500) continue;
    out.books[book.id] = {
      checkedAt:stamp(row.checkedAt), status:['ok','partial','error'].includes(row.status) ? row.status : 'error',
      coverage:row.coverage === 'line-and-live' ? 'line-and-live' : 'prematch',
      events:row.events.map(e => {
        const clean = publicEvent(book.id,e);
        if (!clean || (clean.start && moscowDay(clean.start) !== day)) return null;
        return {...clean, first:stamp(e.first), last:stamp(e.last),
          open:prices(e.open), liveSeen:e.liveSeen === true,
          names:Array.isArray(e.names) ? [...new Set(e.names.filter(n => typeof n === 'string' && isCyberClash(n)).map(n => text(n)))].slice(0,20) : [clean.tournament]};
      }).filter(Boolean)
    };
  }
  return out;
}
// Empty and failed reads update the check, never delete previously observed matches.
export function mergeDay(previous, observation, now = Date.now()) {
  const out = normalizeDay(previous, previous.day);
  const book = BOOKMAKERS.find(b => b.id === observation?.id);
  if (!book || typeof observation.ok !== 'boolean' || !Array.isArray(observation.events)) throw Error('Неверное наблюдение');
  const old = out.books[book.id] || {events:[]};
  const events = new Map(old.events.map(e => [e.id,e]));
  if (observation.ok) for (const raw of observation.events) {
    const e = publicEvent(book.id, raw);
    if (!e || (e.start ? moscowDay(e.start) : moscowDay(now)) !== out.day) continue;
    const kept = events.get(e.id);
    const at = stamp(observation.checkedAt) || now;
    // Do not let late older observations replace more recent odds.
    if (kept && kept.last > at) continue;
    events.set(e.id, {...e, first:kept?.first || at, last:at,
      open:kept?.open?.some(Boolean) ? kept.open : e.odds,
      liveSeen:!!(kept?.liveSeen || e.live),
      names:[...new Set([...(kept?.names || []),e.tournament])].slice(0,20)});
  }
  const at = stamp(observation.checkedAt) || now;
  out.books[book.id] = {
    checkedAt:Math.max(old.checkedAt || 0,at),
    status:old.checkedAt > at ? old.status : !observation.ok ? 'error' : observation.errors?.length ? 'partial' : 'ok',
    coverage:observation.coverage === 'line-and-live' ? 'line-and-live' : 'prematch',
    events:[...events.values()].sort((a,b) => (a.start || 0)-(b.start || 0) || a.id.localeCompare(b.id))
  };
  out.startedAt = out.startedAt ? Math.min(out.startedAt,at) : at;
  out.updatedAt = Math.max(out.updatedAt,at);
  return out;
}
