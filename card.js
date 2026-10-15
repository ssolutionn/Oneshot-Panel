import { personKey } from './core.js';

// Every exported CARD source points to this page on the panel's own origin.
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const team = (params.get('team') || '').trim();
const nick = (params.get('nick') || '').trim();
const TIMEOUT = 4500;
const safeFile = file =>
  typeof file === 'string' && /^[\w.-]+\.(png|jpe?g|webp)$/i.test(file);

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
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(path, { signal: controller.signal, cache: 'no-cache' });
    return response.ok ? await response.json() : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}
function show(img, src) {
  return new Promise(resolve => {
    let timer;
    const finish = ok => {
      clearTimeout(timer);
      img.removeEventListener('load', loaded);
      img.removeEventListener('error', failed);
      img.hidden = !ok;
      resolve(ok);
    };
    const loaded = () => finish(img.naturalWidth > 0);
    const failed = () => finish(false);
    img.addEventListener('load', loaded);
    img.addEventListener('error', failed);
    timer = setTimeout(failed, TIMEOUT);
    img.src = src;
  });
}
function logoFile(logos) {
  if (!logos || typeof logos !== 'object') return '';
  const found = Object.entries(logos).find(([name, file]) =>
    personKey(name) === personKey(team) && safeFile(file));
  return found ? found[1] : '';
}
function photoFile(manifest) {
  const players = Array.isArray(manifest?.players) ? manifest.players : [];
  const key = personKey(nick);
  if (!key) return '';
  // Match identity before considering file availability. A namesake in another
  // team must never supply a photo when this player's own photo is missing.
  const matches = players.filter(p => p && typeof p === 'object' &&
    (!team || personKey(p.team) === personKey(team)) &&
    [p.nick, ...(Array.isArray(p.aliases) ? p.aliases : [])]
      .some(name => personKey(name) === key));
  return matches.length === 1 && safeFile(matches[0].file) ? matches[0].file : '';
}
async function render() {
  $('cardTeam').textContent = team;
  $('cardNick').textContent = nick || 'Игрок';
  document.title = `${nick || 'Игрок'}${team ? ` · ${team}` : ''} · Oneshot Panel`;
  fitNick();
  const artwork = Promise.all([
    show($('cardBackground'), '/assets/card/background.png'),
    show($('tournamentLogo'), '/assets/card/cyberclash-logo.png')
  ]);
  const [logos, manifest] = await Promise.all([
    json('/assets/teams/teams.json'), json('/assets/players/players.json')
  ]);
  const logo = logoFile(logos), photo = photoFile(manifest);
  const photoShown = photo ? await show($('cardPhoto'), `/assets/players/${photo}`) : false;
  document.body.dataset.layout = photoShown ? 'photo' : 'no-photo';
  const jobs = [artwork];
  if (logo) {
    if (photoShown) jobs.push(show($('cardLogo').querySelector('img'),
      `/assets/teams/${logo}`).then(ok => { $('cardLogo').hidden = !ok; }));
    else jobs.push(show($('cardEmblem'), `/assets/teams/${logo}`));
  }
  fitNick();
  await Promise.all(jobs);
  document.body.dataset.photo = photoShown ? photo : 'none';
  document.body.dataset.ready = 'true';
}

fitStage();
addEventListener('resize', fitStage);
render();
