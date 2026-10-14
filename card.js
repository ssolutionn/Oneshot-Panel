import { personKey } from './core.js';

// /card.html?team=Команда&nick=Ник: the OBS JSON puts one under each camera.
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const team = (params.get('team') || '').trim();
const nick = (params.get('nick') || '').trim();
const safeFile = file =>
  typeof file === 'string' && /^[\w.-]+\.(png|jpe?g|webp)$/i.test(file);

function fitStage() {
  document.documentElement.style.setProperty('--scale',
    String(Math.min(innerWidth / 1920, innerHeight / 1080) || 1));
}
// Long nicks shrink until they fit the left column (860px).
function fitNick() {
  const el = $('cardNick');
  const width = el.parentElement.clientWidth;
  let size = 168;
  el.classList.remove('is-long');
  el.style.fontSize = `${size}px`;
  while (el.scrollWidth > width && size > 60) {
    size -= 4;
    el.style.fontSize = `${size}px`;
  }
  el.classList.toggle('is-long', el.scrollWidth > width);
}
async function json(path) {
  try {
    const response = await fetch(path);
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
function show(img, src) {
  return new Promise(resolve => {
    img.addEventListener('load', () => { img.hidden = false; resolve(true); }, { once: true });
    img.addEventListener('error', () => { img.remove(); resolve(false); }, { once: true });
    img.src = src;
  });
}
// assets/teams/teams.json: name → file, same as the panel.
function logoFile(logos) {
  if (!logos || typeof logos !== 'object') return '';
  const key = personKey(team);
  const file = logos[team] ?? Object.entries(logos)
    .find(([name]) => personKey(name) === key)?.[1];
  return safeFile(file) ? file : '';
}
// assets/players/players.json: HLTV bodyshots, "file" is set once downloaded.
// Same nick in two teams → the card's team wins.
function photoFile(manifest) {
  const players = Array.isArray(manifest?.players) ? manifest.players : [];
  const key = personKey(nick);
  const matches = players.filter(p => safeFile(p?.file) &&
    [p.nick, ...(Array.isArray(p.aliases) ? p.aliases : [])]
      .some(name => personKey(name) === key));
  const found = matches.find(p => personKey(p.team) === personKey(team)) ||
    (matches.length === 1 ? matches[0] : null);
  return found ? found.file : '';
}

async function render() {
  $('cardTeam').textContent = team;
  $('cardNick').textContent = nick || 'Игрок';
  document.title = `${nick || 'Игрок'}${team ? ` · ${team}` : ''} · Oneshot Panel`;
  fitNick();
  const [logos, manifest] = await Promise.all([
    json('/assets/teams/teams.json'), json('/assets/players/players.json')
  ]);
  const logo = logoFile(logos), photo = photoFile(manifest);
  const jobs = [];
  if (logo) {
    jobs.push(show($('cardLogo').querySelector('img'), `/assets/teams/${logo}`)
      .then(ok => { $('cardLogo').hidden = !ok; }));
  }
  const photoShown = photo ?
    await show($('cardPhoto'), `/assets/players/${photo}`) : false;
  if (!photoShown && logo) jobs.push(show($('cardEmblem'), `/assets/teams/${logo}`));
  await Promise.all(jobs);
  document.body.dataset.photo = photoShown ? photo : 'none';
  document.body.dataset.ready = 'true';
}

fitStage();
addEventListener('resize', fitStage);
render();
