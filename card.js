import { playerPhoto, teamLogo } from './core.js';

// Every exported CARD source points to this page on the panel's own origin.
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const team = (params.get('team') || '').trim();
const nick = (params.get('nick') || '').trim();
// Images: how long data-ready waits for them. Catalogs: a slow venue network
// must not lose the photo and logo lookup.
const TIMEOUT = 4500;
const DATA_TIMEOUT = 10000;

function fitStage() {
  document.documentElement.style.setProperty('--scale',
    String(Math.min(innerWidth / 1920, innerHeight / 1080) || 1));
}
function fitNick() {
  const el = $('cardNick');
  const width = el.parentElement.clientWidth;
  let size = document.body.dataset.layout === 'photo' ? 160 : 224;
  el.classList.remove('is-long');
  el.style.fontSize = `${size}px`;
  while (el.scrollWidth > width && size > 52) {
    size -= 4;
    el.style.fontSize = `${size}px`;
  }
  el.classList.toggle('is-long', el.scrollWidth > width);
}
async function json(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DATA_TIMEOUT);
  try {
    const response = await fetch(path, { signal: controller.signal, cache: 'no-cache' });
    return response.ok ? await response.json() : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}
// Resolves false after TIMEOUT so the layout is decided and data-ready set,
// but a late image still appears (box is what gets hidden) and calls late().
function show(img, src, box = img, late = () => {}) {
  return new Promise(resolve => {
    let waiting = true;
    const timer = setTimeout(() => { waiting = false; resolve(false); }, TIMEOUT);
    const finish = ok => {
      clearTimeout(timer);
      box.hidden = !ok;
      if (waiting) resolve(ok);
      else if (ok) late();
    };
    img.addEventListener('load', () => finish(img.naturalWidth > 0), { once: true });
    img.addEventListener('error', () => finish(false), { once: true });
    img.src = src;
  });
}
async function render() {
  $('cardTeam').textContent = team;
  $('cardNick').textContent = nick || 'Игрок';
  document.title = `${nick || 'Игрок'}${team ? ` · ${team}` : ''} · Oneshot Panel`;
  fitNick();
  const artwork = Promise.all([
    show($('cardBackground'), '/assets/card/background.jpg'),
    show($('tournamentLogo'), '/assets/card/cyberclash-logo.png')
  ]);
  const [logos, manifest] = await Promise.all([
    json('/assets/teams/teams.json'), json('/assets/players/players.json')
  ]);
  const logo = teamLogo(logos, team);
  const photo = playerPhoto(manifest?.players, team, nick);
  const smallLogo = () => show($('cardLogo').querySelector('img'),
    `/assets/teams/${logo}`, $('cardLogo'));
  const layout = photoShown => {
    document.body.dataset.layout = photoShown ? 'photo' : 'no-photo';
    document.body.dataset.photo = photoShown ? photo : 'none';
    fitNick();
  };
  // A photo that arrives after the timeout still gets the portrait layout.
  const latePhoto = () => {
    layout(true);
    if (logo) smallLogo();
  };
  const photoShown = photo ? await show($('cardPhoto'),
    `/assets/players/${photo}`, $('cardPhoto'), latePhoto) : false;
  layout(photoShown);
  const jobs = [artwork];
  if (logo) jobs.push(photoShown ? smallLogo() : show($('cardEmblem'), `/assets/teams/${logo}`));
  await Promise.all(jobs);
  document.body.dataset.ready = 'true';
}

fitStage();
addEventListener('resize', fitStage);
render();
