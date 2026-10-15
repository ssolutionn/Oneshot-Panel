import { MAP_POOL, validateVeto } from './core.js';
import { VETO_EVENT } from './obs.js';

// State: { teams: [A, B], logos: [file, file], format, first, actions, pending }.
const $ = id => document.getElementById(id);
const safeFile = file => typeof file === 'string' && /^[\w.-]+\.(png|jpe?g|webp)$/i.test(file);

function fitStage() {
  document.documentElement.style.setProperty('--scale',
    String(Math.min(innerWidth / 1920, innerHeight / 1080) || 1));
}
function team(box, name, logo) {
  box.querySelector('b').textContent = name;
  const plate = box.querySelector('.veto-logo'), img = plate.querySelector('img');
  plate.hidden = !safeFile(logo);
  if (safeFile(logo)) {
    img.onerror = () => { plate.hidden = true; };
    img.src = `/assets/teams/${logo}`;
  }
}
function tile(map, kind, label, detail) {
  const item = document.createElement('li');
  item.className = `veto-map ${kind}`;
  item.dataset.map = map;
  const img = document.createElement('img');
  img.alt = '';
  img.src = `/assets/maps/${map}.jpg`;
  img.onerror = () => img.remove();
  const name = document.createElement('span');
  name.className = 'veto-name';
  name.textContent = map;
  const tag = document.createElement('span');
  tag.className = 'veto-label';
  tag.textContent = label;
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    tag.append(small);
  }
  item.append(img, name, tag);
  return item;
}

export function render(state) {
  let remaining;
  const teams = Array.isArray(state?.teams) ? state.teams.map(t => String(t || '')) : [];
  try {
    if (teams.length !== 2 || !teams[0] || !teams[1]) throw new Error('teams');
    remaining = validateVeto(state.actions, state.format, state.first);
  } catch {
    $('stage').hidden = true;
    return false;
  }
  team($('teamA'), teams[0], state.logos?.[0]);
  team($('teamB'), teams[1], state.logos?.[1]);
  $('vetoFormat').textContent = state.format;
  const finished = state.actions.length === 6;
  const tiles = state.actions.map(a => a.type === 'ban' ?
    tile(a.map, 'ban', 'BAN', teams[a.team]) :
    tile(a.map, 'pick', `PICK · ${teams[a.team]}`, `${teams[1 - a.team]} ${a.side}`));
  for (const map of MAP_POOL.filter(m => remaining.includes(m))) {
    if (finished) tiles.push(tile(map, 'decider', 'DECIDER'));
    else if (map === state.pending) tiles.push(tile(map, 'pick pending', 'PICK', 'выбор стороны…'));
    else tiles.push(tile(map, 'idle', '—'));
  }
  $('vetoMaps').replaceChildren(...tiles);
  $('stage').hidden = false;
  return true;
}

function fromHash() {
  const packed = new URLSearchParams(location.hash.slice(1)).get('s');
  if (!packed) return null;
  try {
    const text = atob(packed.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(text, c => c.charCodeAt(0))));
  } catch { return null; }
}

fitStage();
addEventListener('resize', fitStage);
addEventListener(VETO_EVENT, event => render(event.detail));
addEventListener('hashchange', () => render(fromHash()));
render(fromHash());
document.body.dataset.ready = 'true';
