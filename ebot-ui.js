// Lobby block «Матчи eBot» (site only): reads the eBot match list through
// this site's /api/ebot proxy every 20 s while the tab is open and visible,
// shows the running matches with score, map and status, and notes score and
// status changes in the lobby journal (oneshot:lobby-note), like the
// bookmakers' lines do. The eBot server itself is never opened by the
// browser; everything from eBot renders as text.
import { EBOT_PROXY, parseEbotMatches, isLive, ebotEvents, ebotStatusLine } from './ebot.js';

const $ = id => document.getElementById(id);
const STORE = 'oneshot-ebot';
const POLL = 20000, REPEAT = 20000, REPEAT_LIMIT = 3;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
};
function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not kept */ }
}

const state = { matches: [], updatedAt: 0, on: read(STORE, true), seen: {}, repeats: 0, timer: 0, busy: false };
if (!state.on) $('ebotWatch').checked = false;
$('ebotWatch').addEventListener('change', () => {
  state.on = $('ebotWatch').checked;
  write(STORE, state.on);
  if (state.on) { render(); check(); }
  else { clearTimeout(state.timer); setStatus('Следование выключено.'); }
});

function setStatus(text) { $('ebotStatus').textContent = text; }

function render() {
  const box = $('ebotMatches');
  box.replaceChildren();
  const shown = state.matches.filter(isLive);
  if (!state.matches.length) {
    box.append(el('div', { className: 'empty-panel', textContent: state.updatedAt ?
      'eBot не показывает матчей в списке.' : 'Здесь появятся матчи, которые ведёт eBot.' }));
    return;
  }
  for (const match of shown.length ? shown : state.matches.slice(0, 1)) {
    box.append(matchCard(match));
  }
  setStatus(ebotStatusLine(state.matches, state.updatedAt));
}

// Everything that came from the eBot page is textContent, never innerHTML.
// The card reuses the lobby's .lobby-match look (FACEIT cards).
function matchCard(match) {
  const live = isLive(match);
  const done = !live && /Finished/i.test(match.status);
  return el('div', { className: 'lobby-match' + (live ? ' live' : done ? ' done' : ''), dataset: { match: match.id } },
    el('div', { className: 'lm-top' },
      el('span', { className: 'lm-status', textContent: live ? match.status : 'Завершён' })),
    el('div', { className: 'lm-teams' },
      el('span', { className: 'lm-team', textContent: match.teamA }),
      el('b', { className: 'lm-score', textContent: `${match.scoreA} : ${match.scoreB}` }),
      el('span', { className: 'lm-team right', textContent: match.teamB })),
    el('div', { className: 'lm-meta', textContent: [match.map, `матч #${match.id}`].filter(Boolean).join(' · ') }));
}

async function check() {
  if (state.busy || !state.on) return;
  state.busy = true;
  try {
    const response = await fetch(EBOT_PROXY, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const body = await response.json();
    if (typeof body.page !== 'string') throw new Error('формат');
    const matches = parseEbotMatches(body.page);
    // The first read of each match id is a note, so a panel opened late
    // still announces the running match once (per browser, per match).
    const fresh = matches.filter(m => !state.seen[m.id]);
    const events = ebotEvents(state.matches, matches);
    for (const m of matches) state.seen[m.id] = 1;
    state.matches = matches;
    state.updatedAt = Date.now();
    state.repeats = 0;
    render();
    for (const event of fresh.length ? events.filter(e => e.type === 'start') : events) {
      window.dispatchEvent(new CustomEvent('oneshot:lobby-note', { detail: event.text }));
    }
  } catch (error) {
    if (++state.repeats <= REPEAT_LIMIT) {
      setStatus(`eBot не отвечает (${state.repeats}). Проверяем ещё раз.`);
    } else {
      setStatus('eBot недоступен. Проверь сервер eBot.');
    }
  } finally {
    state.busy = false;
    if (state.on) state.timer = setTimeout(check, state.repeats ? REPEAT : POLL);
  }
}

const wake = () => {
  if (!state.on) return;
  clearTimeout(state.timer);
  if (!document.hidden) check();
};
document.addEventListener('visibilitychange', wake);
window.addEventListener('focus', wake);
window.addEventListener('online', wake);
render();
check();
