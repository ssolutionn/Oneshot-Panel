// The event panel (site only): an address whose event has no sheets
// (events/<slug>/event.json, kind manual — a LAN) gets the tabs «Команды»,
// «Матчи», «Компы» and «Событие». app.js keeps the data (window.oneshotPanel
// .lan / setLan); here it is edited right where it is shown. Names and nicks
// from people go into the page as text only.
import { lanSeatLinks, lanCams, vdoNet, vdoRoomOf, directorUrl, lanId, newLanPrefix, personKey, cardKey, LAN_LIMITS, LAN_SEATS, MATCH_FORMATS } from './core.js';
import { camKey, scanRoom } from './vdo.js';
import { showView, camStatus, sendObs } from './live.js';
import { DEFAULT_TOURNAMENT } from './assets/veto-short-links.js';
import {
  readZip, collectTeams, AssetStore, indexedAssets, normalizeAssets, cardDocs, paletteFrom, DEFAULT_COLORS, ownKey, plateCardUrl } from './lan-event.js';
import { processImage, processPlate, drawCardPreview, drawThumb } from './lan-images.js';

const $ = id => document.getElementById(id);
const panel = () => window.oneshotPanel;
const EVENT = globalThis.oneshotEvent || null;
const random = n => crypto.getRandomValues(new Uint8Array(n));
// A small DOM builder: text is always text.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key.startsWith('data-') || key.startsWith('aria-') || key === 'role') node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children.filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

// ---------- the event's data ----------
// draft: what is being edited (the inputs hold on to its objects); every
// change goes to app.js, which keeps a cleaned copy (debounced while typing).
let draft = structuredClone(panel().lan());
let commitTimer = 0;
function commit(now = false) {
  clearTimeout(commitTimer);
  const run = () => {
    const stored = panel().setLan(draft);
    if (!stored) panel().toast('Браузер не дал сохранить: изменения продержатся до перезагрузки.');
    applyEvent();
    renderSeats();
  };
  if (now) run(); else commitTimer = setTimeout(run, 350);
}
const allIds = () => [...draft.teams.flatMap(t => [t.id, ...t.players.map(p => p.id)]), ...draft.matches.map(m => m.id)];
const newId = () => lanId(random(6), allIds());
const teamOf = id => draft.teams.find(t => t.id === id);
const eventName = () => draft.event.name || EVENT?.name || 'ЛАН';

// Photos and logos: IndexedDB (lan-event.js AssetStore), under ownKey(team or
// player id). Opened only on an event's address (start()).
let store = null, loaded = null;
const logoOf = id => store?.assets.logos[ownKey(id)] || '';
const photoOf = id => store?.assets.photos[ownKey(id)] || '';
// Every change of the pictures goes in turn: two drops at once, or a drop during
// a Drive import, must not save over each other.
let saving = Promise.resolve(true);
function changeAssets(change) {
  const run = saving.then(async () => {
    await loaded;
    const assets = structuredClone(store.assets);
    change(assets);
    return store.save(assets);
  });
  saving = run.catch(() => false);
  return run;
}
// Pictures of older versions move to their team and player once. First those
// kept by bare id (t1, t1p1, x…: what the previous version showed), then those
// kept by team name and nick (the «ЛАН» window) where nothing newer is there.
// In this order an old name key («T1» → t1) can neither beat nor take a team's
// own picture: the bare id t1 is moved away before names are looked at.
async function migrateAssets() {
  const assets = structuredClone(store.assets);
  let moved = false;
  const move = (shelf, from, to) => {
    if (!shelf[from]) return;
    if (!shelf[to]) shelf[to] = shelf[from];
    delete shelf[from];
    moved = true;
  };
  for (const team of draft.teams) {
    move(assets.logos, team.id, ownKey(team.id));
    for (const p of team.players) move(assets.photos, p.id, ownKey(p.id));
  }
  for (const team of draft.teams) {
    move(assets.logos, personKey(team.name), ownKey(team.id));
    for (const p of team.players) move(assets.photos, cardKey(team.name, p.nick), ownKey(p.id));
  }
  if (moved) await store.save(assets);
}
const palette = () => paletteFrom({
  accent: draft.event.accent || EVENT?.colors?.accent, deep: draft.event.deep || EVENT?.colors?.deep, black: draft.event.black || EVENT?.colors?.black
});

// ---------- the event's look on the panel ----------
let appliedName = '';
function applyEvent() {
  const name = eventName();
  $('eventTitle').textContent = name;
  $('eventTitle').hidden = false;
  document.title = `${name} · Oneshot`;
  $('footerNote').textContent = `Веб-панель · ${name} · ЛАН`;
  // Only a name that came from here (or the default) is replaced: one typed by
  // hand in the captains' block survives reloads.
  const tournament = $('cvTournament');
  const auto = ['', DEFAULT_TOURNAMENT, name, appliedName, EVENT?.name].includes(tournament.value);
  if (auto && tournament.value !== name) {
    tournament.value = name;
    tournament.dispatchEvent(new Event('change'));
  }
  appliedName = name;
}
function setStatus(id, text, bad = false) {
  $(id).textContent = text;
  $(id).classList.toggle('bad', bad);
}

// ---------- «Команды» ----------
let pickTarget = null;
const imageFile = file => file && (/^image\/(png|jpe?g|webp)$/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name || ''));
async function setImage(target, file) {
  if (!imageFile(file)) {
    setStatus('ltStatus', /heic|heif/i.test(`${file?.type} ${file?.name}`) ?
      'HEIC браузер не открывает: на iPhone «Скопировать объект» и вставь в «Файлы» — получится PNG.' : 'Нужна картинка PNG, JPG или WEBP.', true);
    return;
  }
  setStatus('ltStatus', 'Обрабатываем картинку…');
  try {
    const { url, warning } = await processImage(file, target.kind);
    const stored = await changeAssets(assets => { (target.kind === 'logo' ? assets.logos : assets.photos)[ownKey(target.id)] = url; });
    if (!stored) throw new Error('браузеру не хватило места');
    setStatus('ltStatus', warning ? `Готово, но картинка ${warning}: фон останется на карточке.` : 'Готово.', Boolean(warning));
    paintSlots();
    paintLogos();
    paintPreview();
  } catch (error) { setStatus('ltStatus', `Не получилось: ${error.message}.`, true); }
}
async function clearImage(target) {
  await changeAssets(assets => { delete (target.kind === 'logo' ? assets.logos : assets.photos)[ownKey(target.id)]; });
  paintSlots();
  paintLogos();
}
// A logo or photo square: click to choose, drop a file on it, or paste.
function slot(kind, id, label) {
  const button = el('button', {
    type: 'button', class: `lt-slot lt-${kind}`, 'data-slot-kind': kind, 'data-slot-id': id, 'aria-label': label,
    title: `${label}: нажми, перетащи картинку или вставь (Ctrl+V)`,
    onclick: () => { pickTarget = { kind, id }; $('ltImage').click(); },
    ondragover: event => { event.preventDefault(); button.classList.add('drop'); },
    ondragleave: () => button.classList.remove('drop'),
    ondrop: event => { event.preventDefault(); button.classList.remove('drop'); setImage({ kind, id }, event.dataTransfer.files[0]); }
  }, el('canvas', { width: kind === 'logo' ? 176 : 112, height: kind === 'logo' ? 176 : 112 }), el('span', { class: 'lt-slot-empty', text: kind === 'logo' ? 'Лого' : '+ фото' }));
  return el('span', { class: 'lt-slot-wrap' }, button,
    el('button', { type: 'button', class: 'lt-clear', 'aria-label': `Убрать: ${label}`, title: 'Убрать картинку', text: '×', onclick: () => clearImage({ kind, id }) }));
}
async function paintSlots() {
  await loaded;
  for (const button of $('ltGrid').querySelectorAll('[data-slot-kind]')) {
    const { slotKind: kind, slotId: id } = button.dataset;
    const image = kind === 'logo' ? logoOf(id) : photoOf(id);
    const shown = image ? await drawThumb(button.querySelector('canvas'), image, kind === 'photo' ? 'head' : 'contain') : false;
    if (!image) button.querySelector('canvas').getContext('2d').clearRect(0, 0, 999, 999);
    button.classList.toggle('filled', shown);
    button.parentElement.classList.toggle('filled', shown);
  }
}
function playerRow(team, player, index) {
  const nick = el('input', {
    class: 'lt-nick', value: player.nick, maxLength: 40, placeholder: index < LAN_SEATS ? `Игрок ${index + 1}` : 'Запасной',
    spellcheck: false, autocomplete: 'off', 'aria-label': `Ник игрока ${index + 1} в ${team.name || 'команде'}`,
    oninput: () => { player.nick = nick.value; commit(); countPlayers(team.id); },
    onchange: () => commit(true),
    onkeydown: event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const next = nick.closest('li').nextElementSibling?.querySelector('.lt-nick') ||
        nick.closest('li').nextElementSibling?.nextElementSibling?.querySelector('.lt-nick');
      if (next) next.focus(); else addPlayer(team.id);
    }
  });
  return el('li', { class: 'lt-player', 'data-player-id': player.id },
    slot('photo', player.id, `Фото ${player.nick || `игрока ${index + 1}`}`), nick,
    el('button', { type: 'button', class: 'text-button lt-card-btn', text: 'Карточка', title: 'Как игрок выглядит на карточке в OBS',
      onclick: () => openCard(team.id, player.id) }),
    el('button', { type: 'button', class: 'icon-button lt-remove', text: '×', 'aria-label': `Убрать игрока ${player.nick || index + 1}`,
      onclick: () => removePlayer(team.id, player.id) }));
}
function teamCard(team, duplicate) {
  const name = el('input', {
    class: 'lt-name', value: team.name, maxLength: 60, placeholder: 'Название команды', spellcheck: false, autocomplete: 'off',
    'aria-label': 'Название команды',
    oninput: () => { team.name = name.value; commit(); markDuplicates(); },
    onchange: () => commit(true),
    onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); name.closest('.lt-card').querySelector('.lt-nick')?.focus(); } }
  });
  const rows = [];
  team.players.forEach((player, index) => {
    if (index === LAN_SEATS) rows.push(el('li', { class: 'lt-subs', text: 'Запасные' }));
    rows.push(playerRow(team, player, index));
  });

  return el('article', { class: `lt-card${duplicate ? ' dup' : ''}`, 'data-team-id': team.id },
    el('header', { class: 'lt-head' }, slot('logo', team.id, `Логотип ${team.name || 'команды'}`), name,
      el('button', { type: 'button', class: 'icon-button lt-remove', text: '×', 'aria-label': `Удалить команду ${team.name}`,
        title: 'Удалить команду', onclick: () => removeTeam(team.id) })),
    el('p', { class: 'lt-warn', hidden: !duplicate, text: 'Такое название уже есть — эта команда не попадёт в эфир, пока не переименуешь.' }),
    el('ol', { class: 'lt-players' }, ...rows),
    el('footer', { class: 'lt-foot' },
      el('button', { type: 'button', class: 'text-button', text: '+ Игрок', disabled: team.players.length >= LAN_LIMITS.players,
        onclick: () => addPlayer(team.id) }),
      el('span', { class: 'muted lt-count', text: playersText(team) })));
}
function playersText(team) {
  const named = team.players.filter(p => p.nick.trim()).length;
  return `${Math.min(named, LAN_SEATS)} в основе${named > LAN_SEATS ? ` · ${named - LAN_SEATS} запасн.` : ''}`;
}
function countPlayers(teamId) {
  const team = teamOf(teamId), count = $('ltGrid').querySelector(`[data-team-id="${teamId}"] .lt-count`);
  if (team && count) count.textContent = playersText(team);
}
// A name met earlier in the list (app.js skips the later team).
function duplicates() {
  const seen = new Set(), repeated = new Set();
  for (const team of draft.teams) {
    const key = personKey(team.name); // as core.lanTeams compares them
    if (key && seen.has(key)) repeated.add(team.id);
    seen.add(key);
  }
  return repeated;
}
// While a name is typed the cards stay as they are (a redraw would take the focus away).
function markDuplicates() {
  const repeated = duplicates();
  for (const card of $('ltGrid').querySelectorAll('.lt-card')) {
    card.classList.toggle('dup', repeated.has(card.dataset.teamId));
    card.querySelector('.lt-warn').hidden = !repeated.has(card.dataset.teamId);
  }
}
function renderTeams() {
  const repeated = duplicates();
  const cards = draft.teams.map(team => teamCard(team, repeated.has(team.id)));
  $('ltGrid').replaceChildren(...(cards.length ? cards : [el('div', { class: 'lt-empty' },
    el('p', { text: 'Пока нет ни одной команды.' }),
    el('p', { class: 'muted', text: 'Нажми «+ Команда» и впиши название и ники — или загрузи папку с Drive, и всё заполнится само.' }))]));
  $('ltAddTeam').disabled = draft.teams.length >= LAN_LIMITS.teams;
  paintSlots();
}
function addTeam() {
  if (draft.teams.length >= LAN_LIMITS.teams) return;
  const team = { id: newId(), name: '', players: [] };
  draft.teams.push(team);
  for (let i = 0; i < LAN_SEATS; i++) team.players.push({ id: newId(), nick: '' });
  commit(true);
  renderTeams();
  $('ltGrid').querySelector(`[data-team-id="${team.id}"] .lt-name`)?.focus();
}
function addPlayer(teamId) {
  const team = teamOf(teamId);
  if (!team || team.players.length >= LAN_LIMITS.players) return;
  const player = { id: newId(), nick: '' };
  team.players.push(player);
  commit(true);
  renderTeams();
  $('ltGrid').querySelector(`[data-player-id="${player.id}"] .lt-nick`)?.focus();
}
async function removePlayer(teamId, playerId) {
  const team = teamOf(teamId), player = team?.players.find(p => p.id === playerId);
  if (!player) return;
  if ((player.nick || photoOf(playerId)) && !window.confirm(`Убрать игрока ${player.nick || ''} вместе с фото?`)) return;
  team.players = team.players.filter(p => p.id !== playerId);
  commit(true);
  renderTeams();
  if (photoOf(playerId)) await clearImage({ kind: 'photo', id: playerId });
}
async function removeTeam(teamId) {
  const team = teamOf(teamId);
  if (!team) return;
  if ((team.name || team.players.some(p => p.nick)) && !window.confirm(`Удалить команду ${team.name || ''} вместе с игроками, фото и лого?`)) return;
  draft.teams = draft.teams.filter(t => t.id !== teamId);
  for (const m of draft.matches) { if (m.a === teamId) m.a = ''; if (m.b === teamId) m.b = ''; }
  commit(true);
  renderTeams();
  renderMatches();
  await changeAssets(assets => {
    delete assets.logos[ownKey(teamId)];
    for (const p of team.players) delete assets.photos[ownKey(p.id)];
  });
}

// A Drive folder: a folder per team, «nick.png» per player and logo.png.
const logLine = (text, bad) => $('ltLog').append(el('li', { class: bad ? 'bad' : '', text }));
let importing = false;
async function importFiles(files) {
  if (importing) return;
  importing = true;
  $('ltLog').replaceChildren();
  for (const id of ['ltPickZip', 'ltPickFolder']) $(id).disabled = true;
  try {
    await loaded;
    const { teams, problems } = collectTeams(files);
    if (!teams.length) throw new Error('В выбранном нет папок команд с картинками (PNG, JPG, WEBP).');
    const made = { logos: {}, photos: {} }, jobs = [], failed = [], warned = [];
    for (const found of teams) {
      let team = draft.teams.find(t => personKey(t.name) === personKey(found.name));
      if (!team) {
        if (draft.teams.length >= LAN_LIMITS.teams) { failed.push(`${found.name}: больше ${LAN_LIMITS.teams} команд не помещается`); continue; }
        team = { id: newId(), name: found.name, players: [] };
        draft.teams.push(team);
      }
      if (found.logo) jobs.push({ label: `${team.name} / лого`, kind: 'logo', id: team.id, file: found.logo });
      else warned.push(`${team.name}: нет logo.png — вместо лого будет только название`);
      for (const [nick, file] of found.players) {
        let player = team.players.find(p => personKey(p.nick) === personKey(nick)) || team.players.find(p => !p.nick);
        if (!player) {
          if (team.players.length >= LAN_LIMITS.players) { failed.push(`${team.name} / ${nick}: в команде уже ${LAN_LIMITS.players} игроков`); continue; }
          player = { id: newId(), nick };
          team.players.push(player);
        }
        player.nick = nick;
        jobs.push({ label: `${team.name} / ${nick}`, kind: 'photo', id: player.id, file });
      }
    }
    let done = 0;
    const queue = [...jobs];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          const { url, warning } = await processImage(await job.file.blob(), job.kind);
          (job.kind === 'logo' ? made.logos : made.photos)[ownKey(job.id)] = url;
          if (warning) warned.push(`${job.label}: ${warning}`);
        } catch (error) { failed.push(`${job.label}: ${error.message} — карточка будет без картинки`); }
        setStatus('ltStatus', `Обрабатываем ${++done} из ${jobs.length}…`);
      }
    };
    await Promise.all([worker(), worker()]);
    // Only the pictures made here are added: what changed meanwhile stays.
    if (!await changeAssets(assets => { Object.assign(assets.logos, made.logos); Object.assign(assets.photos, made.photos); })) {
      throw new Error('Браузеру не хватило места для фото.');
    }
    commit(true);
    renderTeams();
    for (const text of [...problems, ...failed, ...warned]) logLine(text, true);
    for (const found of teams) logLine(`${found.name}: ${found.players.size} фото${found.logo ? ', лого ✓' : ''}`);
    setStatus('ltStatus', `Загружено: ${teams.length} ${teams.length === 1 ? 'команда' : 'команд(ы)'}, ${jobs.length} картинок.`);
    paintLogos();
  } catch (error) {
    setStatus('ltStatus', error.message, true);
  } finally {
    importing = false;
    for (const id of ['ltPickZip', 'ltPickFolder']) $(id).disabled = false;
  }
}

// The card of a player as OBS will show it.
function cardDialog() {
  let dialog = $('ltCardDialog');
  if (dialog) return dialog;
  dialog = el('dialog', { id: 'ltCardDialog', class: 'lt-card-dialog', 'aria-labelledby': 'ltCardHeading' },
    el('div', { class: 'dialog-head' }, el('h2', { id: 'ltCardHeading', text: 'Карточка в OBS' }),
      el('button', { type: 'button', class: 'icon-button', text: '×', 'aria-label': 'Закрыть', onclick: () => dialog.close() })),
    el('canvas', { id: 'ltCardCanvas', class: 'lan-preview', width: 960, height: 540, role: 'img', 'aria-label': 'Карточка игрока' }),
    el('p', { id: 'ltCardCaption', class: 'muted' }),
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'button', text: '← Предыдущий', onclick: () => stepCard(-1) }),
      el('button', { type: 'button', class: 'button', text: 'Следующий →', onclick: () => stepCard(1) })));
  document.body.append(dialog);
  return dialog;
}
let cardAt = null;
const everyone = () => draft.teams.flatMap(t => t.players.filter(p => p.nick).map(p => ({ team: t, player: p })));
async function showCard() {
  const list = everyone();
  const at = list.findIndex(x => x.player.id === cardAt);
  const { team, player } = list[Math.max(0, at)] || {};
  if (!player) return;
  cardAt = player.id;
  const photo = photoOf(player.id), logo = logoOf(team.id);
  await drawCardPreview($('ltCardCanvas'), { team: team.name, nick: player.nick, photo, logo, colors: palette() });
  $('ltCardCaption').textContent = `${player.nick} (${team.name || 'без названия'}) — ${photo ? 'фото есть' : 'фото нет'}, ${logo ? 'лого есть' : 'лого нет'}.`;
}
function openCard(teamId, playerId) {
  const player = teamOf(teamId)?.players.find(p => p.id === playerId);
  if (!player?.nick) return setStatus('ltStatus', 'Сначала впиши ник — карточка показывает его.', true);
  cardAt = playerId;
  cardDialog().showModal();
  showCard();
}
function stepCard(step) {
  const list = everyone();
  const at = list.findIndex(x => x.player.id === cardAt);
  cardAt = list[(at + step + list.length) % list.length]?.player.id ?? null;
  showCard();
}

// Logos of the teams in «Эфир» (app.js leaves a place for them).
async function paintLogos() {
  await loaded;
  for (const box of document.querySelectorAll('#teamGrid [data-lan-logo]')) {
    const logo = logoOf(box.dataset.lanLogo);
    if (!logo) continue;
    let canvas = box.querySelector('canvas');
    if (!canvas) { canvas = el('canvas', { width: 68, height: 68 }); box.replaceChildren(canvas); box.classList.add('has-logo'); }
    drawThumb(canvas, logo);
  }
}

// ---------- «Матчи» ----------
const TEMPLATE = ['Полуфинал 1', 'Полуфинал 2', 'Финал'];
function teamSelect(match, side) {
  const select = el('select', { class: 'em-team', 'aria-label': side === 'a' ? 'Первая команда' : 'Вторая команда',
    onchange: () => { match[side] = select.value; commit(true); renderMatches(); } },
  el('option', { value: '', text: 'команда' }),
  ...draft.teams.filter(t => t.name).map(t => el('option', { value: t.id, text: t.name, selected: match[side] === t.id, disabled: match[side === 'a' ? 'b' : 'a'] === t.id })));
  return select;
}
function renderMatches() {
  const live = panel().snapshot().matchKey;
  const rows = draft.matches.map((match, index) => {
    const isLive = live === JSON.stringify(['lan-match', match.id]);
    const ready = Boolean(teamOf(match.a)?.name && teamOf(match.b)?.name);
    const time = el('input', { type: 'time', class: 'em-time', value: match.time, 'aria-label': 'Время',
      onchange: () => { match.time = time.value; commit(true); } });
    const stage = el('input', { class: 'em-stage', value: match.stage, maxLength: 100, placeholder: 'Стадия', 'aria-label': 'Стадия',
      oninput: () => { match.stage = stage.value; commit(); }, onchange: () => commit(true) });
    const format = el('select', { class: 'em-format', 'aria-label': 'Формат',
      onchange: () => { match.format = format.value; commit(true); } },
    ...MATCH_FORMATS.map(f => el('option', { value: f, text: f, selected: match.format === f })));
    return el('li', { class: `em-row${isLive ? ' live' : ''}`, 'data-match-id': match.id },
      el('span', { class: 'em-index', text: String(index + 1) }), time, stage,
      el('span', { class: 'em-teams' }, teamSelect(match, 'a'), el('span', { class: 'em-vs', text: 'vs' }), teamSelect(match, 'b')),
      format,
      isLive ? el('span', { class: 'em-live', text: '● В эфире' }) :
        el('button', { type: 'button', class: 'button small primary', text: '▶ В эфир', disabled: !ready,
          title: ready ? 'Сделать текущим матчем во вкладке «Эфир»' : 'Выбери обе команды', onclick: () => goLive(match.id) }),
      el('button', { type: 'button', class: 'icon-button lt-remove', text: '×', 'aria-label': `Удалить матч ${index + 1}`,
        onclick: () => { draft.matches = draft.matches.filter(m => m.id !== match.id); commit(true); renderMatches(); } }));
  });
  $('lmList').replaceChildren(...(rows.length ? rows : [el('li', { class: 'lt-empty' },
    el('p', { text: 'Матчей пока нет.' }),
    el('p', { class: 'muted', text: '«2 полуфинала + финал» создаст сетку на четыре команды; «+ Матч» — по одному.' }))]));
  $('lmAdd').disabled = draft.matches.length >= LAN_LIMITS.matches;
}
function addMatch(stage = '', a = '', b = '') {
  if (draft.matches.length >= LAN_LIMITS.matches) return null;
  const match = { id: newId(), time: '', stage, a, b, format: EVENT?.veto?.format || 'BO3' };
  draft.matches.push(match);
  return match;
}
function goLive(matchId) {
  commit(true);
  const key = JSON.stringify(['lan-match', matchId]);
  const select = $('matchSelect');
  if (![...select.options].some(o => o.value === key)) return panel().toast('Матч не готов: выбери обе команды.');
  select.value = key;
  select.dispatchEvent(new Event('change'));
  showView('prep', true);
  panel().toast('Матч в эфире: рассади игроков по компам и отправь в OBS.');
}
// ---------- «Компы» ----------
function renderSeats() {
  const lan = panel().lan();
  const fill = (id, value) => { if (document.activeElement !== $(id)) $(id).value = value; };
  fill('seatsPrefix', lan.prefix);
  fill('seatsPassword', lan.password);
  // The event's own rooms (REU: team1, team2 and pc1…pc5) or the prefix.
  $('seatsPrefixBox').hidden = Boolean(lan.cams);
  $('seatsRoomsBox').hidden = !lan.cams;
  if (lan.cams) {
    fill('seatsRoomA', lan.cams.rooms[0]); fill('seatsRoomB', lan.cams.rooms[1]);
    fill('seatsPasswordA', lan.cams.passwords[0]); fill('seatsPasswordB', lan.cams.passwords[1]);
    fill('seatsIds', lan.cams.ids.join(', '));
    fill('seatsIdsB', lan.cams.idsB?.join(', ') || '');
    // Each room's director link, to open the room in VDO.Ninja.
    for (const [i, suffix] of [[0, 'A'], [1, 'B']]) {
      const url = directorUrl({ room: lan.cams.rooms[i], password: lan.cams.passwords[i] });
      $(`seatsDirector${suffix}`).href = url;
      $(`seatsDirector${suffix}`).textContent = url;
    }
  }
  // Online or one local network: on a LAN the links carry VDO.Ninja's tuning.
  const net = vdoNet(lan.net);
  fill('seatsNetMode', net.mode);
  fill('seatsNetQuality', net.quality);
  fill('seatsNetBitrate', String(net.bitrate));
  fill('seatsNetFps', String(net.fps));
  fill('seatsNetCodec', net.codec);
  $('seatsNetLowlatency').checked = net.lowlatency;
  $('seatsNetLanonly').checked = net.lanonly;
  $('seatsNetLan').hidden = net.mode !== 'lan';
  $('seatsNote').textContent = lan.cams ? 'Комнаты, пароли и ID меняют ссылки компов и камер в OBS: после смены открой новые ссылки на местах и скачай JSON заново.' :
    'Префикс и пароль меняют ссылки всех десяти компов: после смены открой новые ссылки на местах.';
  $('seatsClash').hidden = !lan.cams || lan.cams.passwords[0] !== lan.cams.passwords[1] ||
    !(lan.cams.idsB || lan.cams.ids).some(id => lan.cams.ids.includes(id));
  const snapshot = panel().snapshot();
  const cams = camStatus();
  const links = lan.prefix ? lanSeatLinks(lan) : [];
  let live = 0;
  const columns = ['a', 'b'].map((side, s) => el('div', { class: 'seat-column' },
    el('h3', { text: `${side.toUpperCase()} · ${(s ? snapshot.b : snapshot.a)?.name || (s ? 'вторая команда' : 'первая команда')}` }),
    ...Array.from({ length: LAN_SEATS }, (_, i) => {
      const link = links[s * LAN_SEATS + i];
      const key = link && camKey(link.room, link.id);
      const cam = !cams.on || !link ? 'none' : cams.live.has(key) ? 'live' : cams.checking.has(key) ? 'wait' : 'off';
      const plate = Boolean(plateImage(side));
      const state = { live: 'В ЭФИРЕ', off: plate ? 'НЕТ ВЕБКИ · в OBS заглушка' : 'НЕТ ВЕБКИ', wait: 'ПРОВЕРЯЕМ…', none: 'статус выключен' }[cam];
      if (cam === 'live') live++;
      const who = (s ? snapshot.playersB : snapshot.playersA)?.[i]?.nick || '';
      // With the event's own rooms a PC can move to another seat of its side:
      // drag the card (or Alt+↑/↓) — the cards swap their PCs.
      const movable = Boolean(lan.cams);
      return el('div', { class: 'seat-card', 'data-seat-cam': cam, 'data-seat': `${side}${i}`,
        ...(movable ? {
          draggable: true, tabIndex: 0, title: 'Перетащи на другое место этой команды (или Alt+↑/↓), чтобы поменять компы местами',
          ondragstart: event => { dragSeat = { side, index: i }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', `${side}${i}`); },
          ondragend: () => { dragSeat = null; document.querySelectorAll('.seat-card.drop').forEach(card => card.classList.remove('drop')); },
          ondragover: event => { if (dragSeat?.side === side && dragSeat.index !== i) { event.preventDefault(); event.currentTarget.classList.add('drop'); } },
          ondragleave: event => event.currentTarget.classList.remove('drop'),
          ondrop: event => { event.preventDefault(); event.currentTarget.classList.remove('drop'); if (dragSeat?.side === side) swapSeats(side, dragSeat.index, i); },
          onkeydown: event => {
            if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || event.target !== event.currentTarget) return;
            const to = i + (event.key === 'ArrowUp' ? -1 : 1);
            if (to < 0 || to >= LAN_SEATS) return;
            event.preventDefault();
            swapSeats(side, i, to);
            document.querySelector(`.seat-card[data-seat="${side}${to}"]`)?.focus();
          }
        } : {}) },
        el('b', { class: 'seat-name', text: link?.seat || `${side.toUpperCase()}${i + 1}` }),
        el('i', { class: 'seat-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'seat-who', text: who || 'место свободно' }),
        el('span', { class: 'seat-state', text: state }),
        el('code', { class: 'seat-link', text: link?.push || '' }),
        el('button', { type: 'button', class: 'copy-icon', text: '⧉', title: `Копировать ссылку места ${link?.seat || ''}`,
          'aria-label': `Копировать ссылку места ${link?.seat || ''}`, disabled: !link, onclick: () => panel().copy(link.push) }),
        el('button', { type: 'button', class: 'link-button seat-frame', text: 'Кадр', 'data-seat-frame': `${side}${i}`,
          title: `Поворот, сдвиг и зум вебки места ${link?.seat || ''}`, disabled: !link, onclick: () => panel().editSeatCamera(side, i) }));
    })));
  $('seatGrid').replaceChildren(...columns);
  const watching = $('watchCams')?.checked;
  $('seatsWatch').setAttribute('aria-pressed', String(Boolean(watching)));
  $('seatsWatch').textContent = watching ? `Вебки: ${live} из 10 в эфире` : 'Следить за вебками';
  $('seatsDot').dataset.kind = watching ? (live === 10 ? 'good' : live ? 'wait' : 'bad') : '';
}
function changeCams() {
  const lan = panel().lan();
  // A pasted director link gives the room and, when it has one, the password.
  const rooms = [['seatsRoomA', 'seatsPasswordA'], ['seatsRoomB', 'seatsPasswordB']].map(([room, password]) => {
    const found = vdoRoomOf($(room).value);
    if (found?.password !== null && found?.password !== undefined) $(password).value = found.password;
    if (found) $(room).value = found.room;
    return found?.room || '';
  });
  const list = id => $(id).value.split(/[\s,;]+/).filter(Boolean).map(seatIdOf);
  const cams = lanCams({
    rooms, passwords: [$('seatsPasswordA').value, $('seatsPasswordB').value],
    ids: list('seatsIds'), idsB: list('seatsIdsB').length ? list('seatsIdsB') : undefined
  });
  if (list('seatsIdsB').length && !cams?.idsB && list('seatsIdsB').join() !== list('seatsIds').join()) {
    renderSeats(); return panel().toast('ID компов B: пять разных, латиница, цифры, _ (или пусто — как у A).');
  }
  if (JSON.stringify(cams) === JSON.stringify(lan.cams)) return;
  if (!cams) { renderSeats(); return panel().toast('Нужны две разные комнаты и пять разных ID компов: латиница, цифры, _.'); }
  if (!window.confirm('Поменяются ссылки компов и камер в OBS: старые вкладки на местах перестанут попадать в эфир. Продолжить?')) { renderSeats(); return; }
  draft.cams = cams;
  commit(true);
  panel().toast('Готово: открой новые ссылки на компах и скачай JSON для OBS заново.');
  checkTypedIds(cams);
}
// Two seats of one side swap their PCs (room stays the side's): who sits where
// and each PC's «Кадр» follow the PC, the tabs on the PCs stay as they are.
let dragSeat = null;
function swapSeats(side, from, to) {
  const lan = panel().lan();
  if (!lan.cams || from === to) return;
  const key = side === 'a' ? 'ids' : 'idsB';
  const ids = [...(side === 'a' ? lan.cams.ids : lan.cams.idsB || lan.cams.ids)];
  [ids[from], ids[to]] = [ids[to], ids[from]];
  const cams = lanCams({ ...lan.cams, idsB: lan.cams.idsB || lan.cams.ids, [key]: ids });
  if (!cams) return;
  draft.cams = cams;
  commit(true);
  const label = side.toUpperCase();
  panel().toast(`${label}${from + 1} ⇄ ${label}${to + 1}: теперь ${ids[from]} — место ${label}${from + 1}, ${ids[to]} — место ${label}${to + 1}. Отправь камеры в OBS заново.`);
}
// A pasted seat link instead of an ID: its push= is the PC's ID.
function seatIdOf(text) {
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' && /(^|\.)vdo\.ninja$/.test(url.hostname)) return url.searchParams.get('push') || url.searchParams.get('id') || text;
  } catch { /* not a link: the ID itself */ }
  return text;
}
// Typed IDs that no PC streams right now: a seat with such an ID shows nothing
// in OBS. Said after the change, so a typo is caught before the broadcast.
async function checkTypedIds(cams) {
  const found = await Promise.all([0, 1].map(i => scanRoom(cams.rooms[i], cams.passwords[i], { wait: 8000 })));
  const now = panel().lan().cams;
  if (JSON.stringify(now) !== JSON.stringify(cams)) return;
  const missing = [[0, cams.ids], [1, cams.idsB || cams.ids]].flatMap(([i, ids]) =>
    ids.filter(id => !found[i].includes(id)).map(id => `${cams.rooms[i]}/${id}`));
  if (missing.length) panel().toast(`Сейчас не стримят: ${missing.join(', ')}. Проверь ID (или «Найти компы»), иначе эти места в OBS пустые.`);
}
function changeNet() {
  const lan = panel().lan();
  const net = vdoNet({
    mode: $('seatsNetMode').value, quality: $('seatsNetQuality').value,
    fps: Number($('seatsNetFps').value), codec: $('seatsNetCodec').value,
    bitrate: Number($('seatsNetBitrate').value), lowlatency: $('seatsNetLowlatency').checked, lanonly: $('seatsNetLanonly').checked
  });
  if (JSON.stringify(net) === JSON.stringify(vdoNet(lan.net))) return;
  if (String(net.bitrate) !== $('seatsNetBitrate').value) panel().toast('Битрейт: от 1000 до 50000 кбит/с — оставлен ' + net.bitrate + '.');
  const links = net.mode === 'lan' || vdoNet(lan.net).mode === 'lan';
  if (links && !window.confirm('Поменяются ссылки компов и камер в OBS: открой новые ссылки на местах и отправь камеры в OBS заново. Продолжить?')) { renderSeats(); return; }
  draft.net = net;
  commit(true);
  panel().toast(net.mode === 'lan' ? 'ЛАН: открой новые ссылки на компах и отправь камеры в OBS.' : 'Онлайн: ссылки компов снова обычные — открой их на местах.');
}

// ---------- placeholders: a side's picture under its cameras in OBS ----------
const PLATE = { a: '#plate-a', b: '#plate-b' };
const plateImage = side => store?.assets.logos[PLATE[side]] || '';
const plateDocs = new Map();
function plateDoc(side) {
  const image = plateImage(side);
  if (!image) return '';
  if (!plateDocs.has(image)) { plateDocs.clear(); plateDocs.set(image, plateCardUrl(image)); }
  return plateDocs.get(image);
}
let plateSide = 'a';
function paintPlates() {
  const lan = panel().lan();
  for (const [side, suffix] of [['a', 'A'], ['b', 'B']]) {
    const image = plateImage(side);
    $(`seatsPlateName${suffix}`).textContent = `Команда ${suffix}${lan.cams ? ` · ${lan.cams.rooms[side === 'a' ? 0 : 1]}` : ''}${image ? '' : ' · нет картинки'}`;
    $(`seatsPlateClear${suffix}`).disabled = !image;
    const canvas = $(`seatsPlate${suffix}`);
    if (image) drawThumb(canvas, image, 'contain');
    else canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }
}
async function setPlate(side, file) {
  if (!imageFile(file)) return panel().toast('Нужна картинка PNG, JPG или WEBP.');
  try {
    const url = await processPlate(file);
    if (!await changeAssets(assets => { assets.logos[PLATE[side]] = url; })) throw new Error('браузеру не хватило места');
    panel().setPlates(plateDoc);
    paintPlates();
    renderSeats();
    panel().toast(`Заглушка команды ${side.toUpperCase()} готова: отправь камеры в OBS.`);
  } catch (error) { panel().toast(`Заглушка не загрузилась: ${error.message}.`); }
}
async function clearPlate(side) {
  await changeAssets(assets => { delete assets.logos[PLATE[side]]; });
  panel().setPlates(plateDoc);
  paintPlates();
  renderSeats();
}

// «Найти компы»: a seat keeps its ID while that PC streams; only a seat whose
// PC is silent takes a stream no seat has yet. Nothing ever moves to another
// seat: a stray webcam left on in the room must not shift pc3 onto seat 4.
function seatsFromScan(found, old) {
  const next = [...old], spare = found.filter(id => !old.includes(id));
  for (let i = 0; i < next.length && spare.length; i++) if (!found.includes(next[i])) next[i] = spare.shift();
  return { ids: next, spare };
}
async function scanCams() {
  const lan = panel().lan();
  if (!lan.cams) return;
  $('seatsScan').disabled = true;
  $('seatsNote').textContent = `Ищем компы в комнатах ${lan.cams.rooms.join(' и ')}… до 12 секунд.`;
  try {
    const found = await Promise.all([0, 1].map(i => scanRoom(lan.cams.rooms[i], lan.cams.passwords[i])));
    if (!found[0].length && !found[1].length) {
      return panel().toast('В комнатах никого: на компах должна быть открыта ссылка места и нажат «Start».');
    }
    const a = seatsFromScan(found[0], lan.cams.ids), b = seatsFromScan(found[1], lan.cams.idsB || lan.cams.ids);
    const cams = lanCams({ ...lan.cams, ids: a.ids, idsB: b.ids });
    if (cams && JSON.stringify(cams) !== JSON.stringify(lan.cams)) { draft.cams = cams; commit(true); }
    const spare = [...a.spare.map(id => `${lan.cams.rooms[0]}/${id}`), ...b.spare.map(id => `${lan.cams.rooms[1]}/${id}`)];
    // A seat no PC streams to keeps its ID, but is named: OBS shows nothing there.
    const empty = [['A', a.ids, found[0]], ['B', b.ids, found[1]]].flatMap(([side, ids, live]) =>
      ids.map((id, i) => live.includes(id) ? '' : `${side}${i + 1}`).filter(Boolean));
    panel().toast(lan.cams.rooms.map((room, i) => `${room}: ${found[i].join(', ') || 'никого'}`).join(' · ') +
      (empty.length ? ` · без вебки: ${empty.join(', ')}` : '') +
      (spare.length ? ` · лишние потоки, на места не ставлю: ${spare.join(', ')}` : '') +
      ' · порядок мест можно поправить перетаскиванием.');
  } finally {
    $('seatsScan').disabled = false;
    renderSeats();
  }
}
function changeSeats(prefix, password) {
  const lan = panel().lan();
  if (prefix === lan.prefix && password === lan.password) return;
  if (!/^[a-z0-9]{2,12}$/.test(prefix)) { renderSeats(); return panel().toast('Префикс: 2–12 латинских букв или цифр.'); }
  if (!window.confirm('Поменяются ссылки всех десяти компов: старые вкладки на местах перестанут попадать в эфир. Продолжить?')) { renderSeats(); return; }
  draft.prefix = prefix;
  draft.password = password;
  commit(true);
  panel().toast('Готово: открой новые ссылки мест на компах.');
}

// ---------- «Событие» ----------
const COLORS = [['accent', 'evAccent'], ['deep', 'evDeep'], ['black', 'evBlack']];
function fillEvent() {
  $('evName').value = draft.event.name;
  $('evName').placeholder = EVENT?.name || 'Название события';
  for (const [key, id] of COLORS) $(id).value = draft.event[key] || EVENT?.colors?.[key] || DEFAULT_COLORS[key];
}
async function paintPreview() {
  await loaded;
  const sample = everyone().find(x => photoOf(x.player.id)) || everyone()[0];
  await drawCardPreview($('evPreview'), {
    team: sample?.team.name || 'Команда', nick: sample?.player.nick || 'Игрок',
    photo: sample ? photoOf(sample.player.id) : '', logo: sample ? logoOf(sample.team.id) : '', colors: palette()
  });
}
function exportEvent() {
  const { on, ...lan } = panel().lan();
  const file = { format: 'oneshot-event', v: 1, event: EVENT?.slug || '', saved: new Date().toISOString(), lan, assets: store.assets };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
  const link = el('a', { href: url, download: `${EVENT?.slug || 'event'}-${new Date().toISOString().slice(0, 10)}.oneshot.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  setStatus('evStatus', `Файл скачан: ${lan.teams.length} команд, ${Object.keys(store.assets.photos).length} фото, ${lan.matches.length} матчей.`);
}
async function importEvent(file) {
  try {
    if (!file || file.size > 60 * 1024 * 1024) throw new Error('нужен файл события до 60 МБ');
    const data = JSON.parse(await file.text());
    if (data?.format !== 'oneshot-event' || data.v !== 1 || !data.lan || typeof data.lan !== 'object') throw new Error('это не файл события Oneshot');
    const assets = normalizeAssets(data.assets);
    const teams = Array.isArray(data.lan.teams) ? data.lan.teams.length : 0;
    if (!window.confirm(`Заменить событие в этом браузере? В файле: ${teams} команд, ${Object.keys(assets.photos).length} фото. Текущие команды, фото и матчи пропадут.`)) return;
    if (!await changeAssets(shelf => { shelf.logos = assets.logos; shelf.photos = assets.photos; })) throw new Error('браузеру не хватило места для фото');
    draft = structuredClone({ ...data.lan, on: true });
    commit(true);
    draft = structuredClone(panel().lan()); // what app.js kept: checked and cleaned
    await saving;
    await migrateAssets(); // a file saved by an older version
    renderAll();
    setStatus('evStatus', `Событие загружено: ${draft.teams.length} команд, ${Object.keys(store.assets.photos).length} фото.`);
  } catch (error) { setStatus('evStatus', `Не загрузилось: ${error.message}.`, true); }
}
async function clearEvent() {
  if (!window.confirm('Очистить событие в этом браузере: все команды, фото, лого и матчи? Ссылки компов останутся.')) return;
  draft.teams = [];
  draft.matches = [];
  commit(true);
  await changeAssets(assets => { assets.logos = {}; assets.photos = {}; });
  renderAll();
  setStatus('evStatus', 'Событие очищено.');
}

function renderAll() {
  fillEvent();
  renderTeams();
  renderMatches();
  panel().setPlates(plateDoc);
  paintPlates();
  renderSeats();
  paintLogos();
  paintPreview();
}

// ---------- wiring ----------
function start() {
  store = new AssetStore({ db: globalThis.indexedDB ? indexedAssets() : null });
  loaded = store.load().then(migrateAssets).then(() => { renderTeams(); paintLogos(); paintPreview(); panel().setPlates(plateDoc); paintPlates(); });
  // OBS gets every card as one page with its photo inside.
  panel().setCardDocs(players => cardDocs(players, store.assets, palette()));
  $('ltAddTeam').addEventListener('click', addTeam);
  $('ltPickZip').addEventListener('click', () => $('ltZip').click());
  $('ltPickFolder').addEventListener('click', () => $('ltFolder').click());
  $('ltZip').addEventListener('change', async () => {
    const file = $('ltZip').files[0];
    $('ltZip').value = '';
    if (!file) return;
    try {
      setStatus('ltStatus', 'Открываем архив…');
      await importFiles(await readZip(await file.arrayBuffer()));
    } catch (error) { setStatus('ltStatus', error.message, true); }
  });
  $('ltFolder').addEventListener('change', async () => {
    const files = [...$('ltFolder').files].map(file => ({ path: file.webkitRelativePath || file.name, size: file.size, blob: async () => file }));
    $('ltFolder').value = '';
    if (files.length) await importFiles(files);
  });
  $('ltImage').addEventListener('change', () => {
    const file = $('ltImage').files[0];
    $('ltImage').value = '';
    if (file && pickTarget) setImage(pickTarget, file);
  });
  // Ctrl+V on a focused logo or photo square.
  document.addEventListener('paste', event => {
    const target = document.activeElement?.closest?.('[data-slot-kind]');
    const file = [...(event.clipboardData?.files || [])][0];
    if (!target || !file) return;
    event.preventDefault();
    setImage({ kind: target.dataset.slotKind, id: target.dataset.slotId }, file);
  });

  $('lmAdd').addEventListener('click', () => { addMatch(); commit(true); renderMatches(); });
  $('lmTemplate').addEventListener('click', () => {
    if (draft.matches.length && !window.confirm('Добавить полуфиналы и финал к уже записанным матчам?')) return;
    const named = draft.teams.filter(t => t.name);
    TEMPLATE.forEach((stage, i) => addMatch(stage, i < 2 ? named[i * 2]?.id || '' : '', i < 2 ? named[i * 2 + 1]?.id || '' : ''));
    commit(true);
    renderMatches();
  });

  $('seatsWatch').addEventListener('click', () => { $('watchCams').click(); renderSeats(); });
  $('seatsCopyAll').addEventListener('click', () => {
    const lan = panel().lan();
    if (lan.prefix) panel().copy(lanSeatLinks(lan).map(link => `${link.seat}: ${link.push}`).join('\n'));
  });
  $('seatsPrefix').addEventListener('change', () => changeSeats($('seatsPrefix').value.trim().toLowerCase(), panel().lan().password));
  $('seatsPassword').addEventListener('change', () => changeSeats(panel().lan().prefix, $('seatsPassword').value));
  $('seatsNewPrefix').addEventListener('click', () => changeSeats(newLanPrefix(random(4)), panel().lan().password));
  for (const id of ['seatsRoomA', 'seatsRoomB', 'seatsPasswordA', 'seatsPasswordB', 'seatsIds', 'seatsIdsB']) $(id).addEventListener('change', changeCams);
  $('seatsScan').addEventListener('click', scanCams);
  for (const id of ['seatsNetMode', 'seatsNetQuality', 'seatsNetFps', 'seatsNetCodec', 'seatsNetBitrate', 'seatsNetLowlatency', 'seatsNetLanonly']) $(id).addEventListener('change', changeNet);
  for (const suffix of ['A', 'B']) $(`seatsDirectorCopy${suffix}`).addEventListener('click', () => {
    const url = $(`seatsDirector${suffix}`).href;
    if (url) panel().copy(url);
  });
  for (const [side, suffix] of [['a', 'A'], ['b', 'B']]) {
    $(`seatsPlatePick${suffix}`).addEventListener('click', () => { plateSide = side; $('seatsPlateFile').click(); });
    $(`seatsPlateClear${suffix}`).addEventListener('click', () => clearPlate(side));
  }
  $('seatsPlateFile').addEventListener('change', () => {
    const file = $('seatsPlateFile').files[0];
    $('seatsPlateFile').value = '';
    if (file) setPlate(plateSide, file);
  });
  // The ten webcams (or the match on air, when there is one) straight into OBS.
  $('seatsSendObs').addEventListener('click', () => sendObs());
  // Webcam dots in «Эфир» (live.js) are the seats' too.
  document.addEventListener('oneshot:cams', () => { if (!$('seatsView').hidden) renderSeats(); });

  $('evName').addEventListener('input', () => { draft.event.name = $('evName').value; commit(); });
  for (const [key, id] of COLORS) $(id).addEventListener('input', () => {
    draft.event[key] = $(id).value.toLowerCase() === (EVENT?.colors?.[key] || DEFAULT_COLORS[key]) ? '' : $(id).value;
    commit();
    paintPreview();
  });
  $('evColorsReset').addEventListener('click', () => {
    for (const [key] of COLORS) draft.event[key] = '';
    commit(true);
    fillEvent();
    paintPreview();
  });
  $('evExport').addEventListener('click', exportEvent);
  $('evImport').addEventListener('click', () => $('evFile').click());
  $('evFile').addEventListener('change', () => { const file = $('evFile').files[0]; $('evFile').value = ''; if (file) importEvent(file); });
  $('evClear').addEventListener('click', clearEvent);

  document.addEventListener('oneshot:change', () => { paintLogos(); if (!$('seatsView').hidden) renderSeats(); });
  document.addEventListener('oneshot:view', event => {
    if (event.detail === 'matches') renderMatches();
    if (event.detail === 'seats') renderSeats();
    if (event.detail === 'event') paintPreview();
  });
  applyEvent();
  renderAll();
}
if (EVENT?.kind === 'manual') start();
