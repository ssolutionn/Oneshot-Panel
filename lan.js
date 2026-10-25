// The event panel (site only): an address whose event has no sheets
// (events/<slug>/event.json, kind manual — a LAN) gets the tabs «Команды»,
// «Матчи», «Компы» and «Событие». app.js keeps the data (window.oneshotPanel
// .lan / setLan); here it is edited right where it is shown. Names and nicks
// from people go into the page as text only.
import { lanSeat, lanSeatLinks, lanCams, vdoNet, vdoRoomOf, vdoStreamId, lanPushes, directorUrl, lanId, newLanPrefix, personKey, cardKey, LAN_LIMITS, LAN_SEATS, MATCH_FORMATS, displayNick, addLanRoster } from './core.js';
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
// A player's own placeholder (instead of the webcam, under their camera in OBS)
// sits with the logos under #plate:<player id> — no team or player key has a colon.
const playerPlateKey = id => `#plate:${id}`;
const shelfOf = (assets, kind) => kind === 'photo' ? assets.photos : assets.logos;
const assetKey = (kind, id) => kind === 'plate' ? playerPlateKey(id) : ownKey(id);
async function setImage(target, file) {
  if (!imageFile(file)) {
    setStatus('ltStatus', /heic|heif/i.test(`${file?.type} ${file?.name}`) ?
      'HEIC браузер не открывает: на iPhone «Скопировать объект» и вставь в «Файлы» — получится PNG.' : 'Нужна картинка PNG, JPG или WEBP.', true);
    return;
  }
  setStatus('ltStatus', 'Обрабатываем картинку…');
  try {
    const { url, warning } = target.kind === 'plate' ? { url: await processPlate(file), warning: '' } : await processImage(file, target.kind);
    const stored = await changeAssets(assets => { shelfOf(assets, target.kind)[assetKey(target.kind, target.id)] = url; });
    if (!stored) throw new Error('браузеру не хватило места');
    setStatus('ltStatus', warning ? `Готово, но картинка ${warning}: фон останется на карточке.` :
      target.kind === 'plate' ? 'Заглушка игрока готова: она встанет под его камеру в OBS — отправь камеры заново.' : 'Готово.', Boolean(warning));
    paintSlots();
    paintLogos();
    paintPreview();
    if (target.kind === 'plate') platesChanged();
  } catch (error) { setStatus('ltStatus', `Не получилось: ${error.message}.`, true); }
}
async function clearImage(target) {
  await changeAssets(assets => { delete shelfOf(assets, target.kind)[assetKey(target.kind, target.id)]; });
  paintSlots();
  paintLogos();
  if (target.kind === 'plate') platesChanged();
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
  }, el('canvas', { width: kind === 'logo' ? 176 : kind === 'plate' ? 160 : 112, height: kind === 'logo' ? 176 : kind === 'plate' ? 90 : 112 }),
  el('span', { class: 'lt-slot-empty', text: { logo: 'Лого', photo: '+ фото', plate: 'заглушка' }[kind] }));
  return el('span', { class: 'lt-slot-wrap' }, button,
    el('button', { type: 'button', class: 'lt-clear', 'aria-label': `Убрать: ${label}`, title: 'Убрать картинку', text: '×', onclick: () => clearImage({ kind, id }) }));
}
async function paintSlots() {
  await loaded;
  for (const button of $('ltGrid').querySelectorAll('[data-slot-kind]')) {
    const { slotKind: kind, slotId: id } = button.dataset;
    const image = kind === 'logo' ? logoOf(id) : kind === 'plate' ? playerPlate(id) : photoOf(id);
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
    slot('plate', player.id, `Заглушка вместо вебки ${player.nick || `игрока ${index + 1}`}`),
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
    el('p', { class: 'muted', text: 'Нажми «+ Команда» и впиши название и ники, вставь список строкой на команду — или загрузи папку с Drive, и всё заполнится само.' }))]));
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
// «Вписать списком»: one line per team («Команда» или «Команда: ник1, ник2, …»)
// joins the cards that are already there; a name that is taken stays untouched,
// so its logo, photos and lineup survive. The lines that did not fit are told here.
function addRoster() {
  const text = $('ltBulk').value;
  if (!text.trim()) return setStatus('ltStatus', 'Впиши хотя бы одну строку — «Команда» или «Команда: ник1, ник2, …».', true);
  let result;
  try { result = addLanRoster(draft.teams, text, newId); }
  catch (error) { return setStatus('ltStatus', error.message, true); }
  const { added, skipped } = result;
  const notes = skipped.length ?
    ` Пропущено: ${skipped.slice(0, 4).join('; ')}${skipped.length > 4 ? ` и ещё ${skipped.length - 4}` : ''}.` : '';
  if (!added.teams) return setStatus('ltStatus', `Новых команд нет.${notes}`, Boolean(skipped.length));
  draft.teams = result.teams;
  commit(true);
  $('ltBulk').value = '';
  renderTeams();
  renderMatches(); // the new names are choices in «Матчи»
  setStatus('ltStatus', added.players ?
    `Добавлено команд: ${added.teams}, игроков: ${added.players}.${notes}` :
    `Добавлено команд: ${added.teams} — ники игроков можно вписать в карточках.${notes}`, Boolean(skipped.length));
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
// Typing in a seat's «Ник» must not rebuild the grid under the cursor: the
// panel's change event comes back here while the field is still focused.
let seatNickTyping = false;
// Two seats on one stream: VDO.Ninja keeps two rooms apart by the room's
// password hash, so the same ID clashes in one room always and in two rooms
// when the passwords are the same. A hand-set ID counts as it really is.
function seatClash(lan) {
  if (!lan.prefix) return false;
  const seats = lanSeatLinks(lan);
  for (let i = 0; i < seats.length; i++) for (let j = i + 1; j < seats.length; j++) {
    if (seats[i].id !== seats[j].id) continue;
    if (seats[i].room === seats[j].room || seats[i].password === seats[j].password) return true;
  }
  return false;
}
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
  // VDO.Ninja tuning: 720p/30/H.264/5000 by default, low latency everywhere.
  // The mode decides «Только локальная сеть»; online never asks for it.
  const net = vdoNet(lan.net);
  fill('seatsNetMode', net.mode);
  fill('seatsNetQuality', net.quality);
  fill('seatsNetFps', String(net.fps));
  fill('seatsNetCodec', net.codec);
  fill('seatsNetBitrate', String(net.bitrate));
  if (document.activeElement !== $('seatsNetLowlatency')) $('seatsNetLowlatency').checked = net.lowlatency;
  if (document.activeElement !== $('seatsNetLanonly')) $('seatsNetLanonly').checked = net.lanonly;
  $('seatsNetLanonly').disabled = net.mode !== 'lan';
  const ownPush = (sd, i) => Boolean(lan.pushes?.[sd]?.[i]);
  const own = ['a', 'b'].some(sd => Array.from({ length: LAN_SEATS }, (_, i) => ownPush(sd, i)).some(Boolean));
  $('seatsNote').textContent = (lan.cams ? 'Комнаты, пароли и ID меняют ссылки компов и камер в OBS: после смены открой новые ссылки на местах и скачай JSON заново.' :
    'Префикс и пароль меняют ссылки всех десяти компов: после смены открой новые ссылки на местах.') +
    ' ✎ у места — ID, под которым реально вещает его комп (после push= в его ссылке); пусто в окне — обычный.' +
    (own ? ' Свой ID «Найти компы» не трогает.' : '');
  $('seatsClash').hidden = !seatClash(lan);
  const snapshot = panel().snapshot();
  const cams = camStatus();
  const links = lan.prefix ? lanSeatLinks(lan) : [];
  const columns = ['a', 'b'].map((side, s) => el('div', { class: 'seat-column' },
    el('h3', { text: `${side.toUpperCase()} · ${(s ? snapshot.b : snapshot.a)?.name || (s ? 'вторая команда' : 'первая команда')}` }),
    ...Array.from({ length: LAN_SEATS }, (_, i) => {
      const link = links[s * LAN_SEATS + i];
      const cam = seatCamState(cams, link);
      const seated = (s ? snapshot.playersB : snapshot.playersA)?.[i];
      const state = seatCamLabel(cam, Boolean(plateImage(side, seated?.playerId)));
      const who = displayNick(seated) || '';
      const nick = panel().camNick(side, i);
      const seatName = link?.seat || `${side.toUpperCase()}${i + 1}`;
      return el('div', { class: 'seat-card', 'data-seat-cam': cam,
        ...(lan.cams ? { 'data-seat': `${side}${i}`, tabIndex: 0 } : {}),
        ...(ownPush(side, i) ? { 'data-seat-push': 'own' } : {}) },
        ...(lan.cams ? [el('span', { class: 'seat-grip', draggable: true, title: 'Перетащи на другое место этой команды (или Alt+↑/↓), чтобы поменять компы местами', text: '⠿' })] : []),
        el('b', { class: 'seat-name', text: link?.seat || `${side.toUpperCase()}${i + 1}` }),
        el('i', { class: 'seat-dot', 'aria-hidden': 'true' }),
        el('input', {
          type: 'text', class: 'seat-nick', value: nick, maxLength: 40, spellcheck: false, autocomplete: 'off',
          placeholder: who || 'ник вебки', 'aria-label': `Ник вебки места ${seatName}`,
          title: who ? `Кто сидит: ${who}` : 'Место свободно',
          oninput: event => {
            seatNickTyping = true;
            try { panel().setCamNick(side, i, event.target.value); } finally { seatNickTyping = false; }
          }
        }),
        el('span', { class: 'seat-state', text: state }),
        el('code', { class: 'seat-link', text: link?.push || '' }),
        el('button', { type: 'button', class: 'copy-icon seat-push', text: '✎',
          title: ownPush(side, i) ? `ID места ${seatName} задан вручную (${link?.id}) — нажми, чтобы поменять` :
            `ID, под которым вещает комп места ${seatName} (после push= в его ссылке)`,
          'aria-label': ownPush(side, i) ? `ID места ${seatName} задан вручную (${link?.id}) — изменить` :
            `Указать ID потока места ${seatName} вручную`,
          onclick: () => panel().editSeatPush(side, i) }),
        el('button', { type: 'button', class: 'copy-icon', text: '⧉', title: `Копировать ссылку места ${link?.seat || ''}`,
          'aria-label': `Копировать ссылку места ${link?.seat || ''}`, disabled: !link, onclick: () => panel().copy(link.push) }),
        el('button', { type: 'button', class: 'link-button seat-frame', text: 'Кадр', 'data-seat-frame': `${side}${i}`,
          title: `Поворот, сдвиг и зум вебки места ${link?.seat || ''}`, disabled: !link, onclick: () => panel().editSeatCamera(side, i) }));
    })));
  $('seatGrid').replaceChildren(...columns);
  paintSeatCam();
}
// What the watcher (live.js) says about the seat's stream: its room and ID.
function seatCamState(cams, link) {
  const key = link && camKey(link.room, link.id);
  return !cams.on || !link ? 'none' : cams.live.has(key) ? 'live' : cams.checking.has(key) ? 'wait' :
    cams.recent.has(key) ? 'recent' : 'off';
}
const seatCamLabel = (cam, plate) =>
  ({ live: 'В ЭФИРЕ', recent: plate ? 'БЫЛА НЕДАВНО · в OBS заглушка' : 'БЫЛА НЕДАВНО',
    off: plate ? 'НЕТ ВЕБКИ · в OBS заглушка' : 'НЕТ ВЕБКИ', wait: 'ПРОВЕРЯЕМ…', none: 'статус выключен' })[cam];
// live.js asks VDO.Ninja again every second and tells us through «oneshot:cams»:
// the badges change in place, without rebuilding the grid, so a nick being
// typed or a seat being dragged survives the update.
function paintSeatCam() {
  const lan = panel().lan();
  const cams = camStatus(), snapshot = panel().snapshot();
  let live = 0;
  $('seatGrid').querySelectorAll('.seat-column').forEach((column, s) => {
    const side = s ? 'b' : 'a';
    column.querySelectorAll('.seat-card').forEach((card, i) => {
      const plate = Boolean(plateImage(side, (s ? snapshot.playersB : snapshot.playersA)?.[i]?.playerId));
      const cam = seatCamState(cams, lanSeat(lan, side, i));
      if (cam === 'live') live++;
      if (card.dataset.seatCam !== cam) card.dataset.seatCam = cam;
      const label = card.querySelector('.seat-state');
      const text = seatCamLabel(cam, plate);
      if (label && label.textContent !== text) label.textContent = text;
    });
  });
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
  // A pasted seat link gives its push=; a bare ID stays as typed. VDO's
  // placeholder keys ("undefined"/"null") are not IDs and are dropped here.
  const list = id => $(id).value.split(/[\s,;]+/).filter(Boolean).map(vdoStreamId).filter(Boolean);
  const cams = lanCams({
    rooms, passwords: [$('seatsPasswordA').value, $('seatsPasswordB').value],
    ids: list('seatsIds'), idsB: list('seatsIdsB').length ? list('seatsIdsB') : undefined
  });
  if (list('seatsIdsB').length && !cams?.idsB && list('seatsIdsB').join() !== list('seatsIds').join()) {
    renderSeats(); return panel().toast('ID компов B: пять разных, латиница, цифры, _ (или пусто — как у A).');
  }
  if (JSON.stringify(cams) === JSON.stringify(lan.cams)) return;
  if (!cams) { renderSeats(); return panel().toast('Нужны две разные комнаты и пять разных ID компов: латиница, цифры, _.'); }
  if (!window.confirm('Поменяются ссылки компов и камер в OBS: старые вкладки на местах перестанут попадать в эфир.' +
    dropPushes(lan) + ' Продолжить?')) { renderSeats(); return; }
  const idsChanged = JSON.stringify([lan.cams?.rooms, lan.cams?.ids, lan.cams?.idsB || null]) !==
    JSON.stringify([cams.rooms, cams.ids, cams.idsB || null]);
  draft.cams = cams;
  draft.pushes = null;
  commit(true);
  panel().toast('Готово: открой новые ссылки на компах и скачай JSON для OBS заново.');
  if (idsChanged) checkTypedIds(cams);
}
// A typed ID that no PC streams right now: the seat would be empty in OBS.
// The save already happened (the PCs may start later); say it in words and
// leave the note until the next successful check or «Найти компы».
async function checkTypedIds(cams) {
  const box = $('seatsMissing');
  if (!box || !cams) return;
  try {
    const found = await Promise.all([0, 1].map(i => scanRoom(cams.rooms[i], cams.passwords[i], { wait: 8000 })));
    const now = panel().lan();
    if (!now.cams || JSON.stringify(now.cams) !== JSON.stringify(cams)) return;
    const missing = lanSeatLinks(now).filter(seat => {
      const room = cams.rooms.indexOf(seat.room);
      return room >= 0 && !found[room].includes(seat.id);
    }).map(seat => `${seat.room}/${seat.id}`);
    if (!missing.length) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = `Сейчас не стримят: ${missing.join(', ')}. Запусти ссылки на компах или исправь ID — иначе эти места в OBS будут пустыми.`;
    panel().toast(`Не в эфире: ${missing.join(', ')}`, 7000);
  } catch { /* the scan is a hint, not a save blocker */ }
}
// Two seats of one side swap their PCs: the room stays the side's, the camera
// frame and a hand-set ID follow the PC. The players keep their slots; this is
// how the operator fixes the order «Найти компы» guessed after the scan.
function swapSeats(side, from, to) {
  const lan = panel().lan();
  if (!lan.cams || from === to || from < 0 || to < 0 || from >= LAN_SEATS || to >= LAN_SEATS) return;
  const ids = [...(side === 'a' ? lan.cams.ids : lan.cams.idsB || lan.cams.ids)];
  [ids[from], ids[to]] = [ids[to], ids[from]];
  const cams = { ...lan.cams, [side === 'a' ? 'ids' : 'idsB']: ids };
  if (side === 'b' && !lan.cams.idsB) cams.idsB = [...ids];
  const next = lanCams(cams);
  if (!next) return;
  // A hand-set ID belongs to the PC: it travels with the webcam.
  const pushes = { a: Array(LAN_SEATS).fill(null), b: Array(LAN_SEATS).fill(null), ...(lan.pushes || {}) };
  const list = Array.from({ length: LAN_SEATS }, (_, i) => pushes[side]?.[i] || null);
  [list[from], list[to]] = [list[to], list[from]];
  pushes[side] = list;
  draft.cams = next;
  draft.pushes = lanPushes(pushes) ? pushes : null;
  commit(true);
  const target = $('seatGrid').querySelector(`.seat-card[data-seat="${side}${to}"]`);
  if (target) {
    target.classList.add('swapped');
    target.focus({ preventScroll: true });
    setTimeout(() => target.classList.remove('swapped'), 420);
  }
  panel().toast(`${side.toUpperCase()}${from + 1} ⇄ ${side.toUpperCase()}${to + 1}: компы поменялись местами. Отправь камеры в OBS заново.`);
}
// VDO tuning in «Компы»: the preset is 720p/30/H.264/5000, low latency on.
// LAN also keeps the media on the local network; online always clears lanonly.
function changeNet() {
  const lan = panel().lan();
  const mode = $('seatsNetMode').value === 'lan' ? 'lan' : 'online';
  const net = vdoNet({
    mode,
    quality: $('seatsNetQuality').value,
    fps: Number($('seatsNetFps').value),
    codec: $('seatsNetCodec').value,
    bitrate: Number($('seatsNetBitrate').value),
    lowlatency: $('seatsNetLowlatency').checked,
    lanonly: mode === 'lan' ? $('seatsNetLanonly').checked : false
  });
  if (String(net.bitrate) !== $('seatsNetBitrate').value) {
    panel().toast(`Битрейт: 1000–50000 кбит/с — оставлен ${net.bitrate}.`);
  }
  if (JSON.stringify(net) === JSON.stringify(vdoNet(lan.net))) {
    $('seatsNetBitrate').value = String(net.bitrate);
    return;
  }
  draft.net = net;
  commit(true);
  renderSeats();
  $('seatsNetBitrate').value = String(net.bitrate);
  panel().toast(net.mode === 'lan' ?
    `ЛАН: ${net.quality}p/${net.fps}, минимальная задержка и только локальная сеть. Открой новые ссылки на компах и отправь камеры в OBS заново.` :
    `Онлайн: ${net.quality}p/${net.fps}, ${net.codec.toUpperCase()}, ${net.bitrate} кбит/с; локальная сеть выключена. Открой новые ссылки и отправь камеры в OBS заново.`);
}
function netModeChanged() {
  const lanMode = $('seatsNetMode').value === 'lan';
  $('seatsNetLowlatency').checked = true;
  $('seatsNetLanonly').checked = lanMode;
  $('seatsNetLanonly').disabled = !lanMode;
  changeNet();
}
// Drag a seat by its ⠿ handle (or Alt+↑/↓). Only the handle starts a drag, so
// the nick field and the buttons keep working; members of one side only.
function initSeatDrag() {
  const grid = $('seatGrid');
  let from = null;
  const clear = () => {
    from = null;
    grid.querySelectorAll('.seat-card.dragging,.seat-card.drop')
      .forEach(card => card.classList.remove('dragging', 'drop'));
  };
  grid.addEventListener('dragstart', event => {
    const grip = event.target.closest?.('.seat-grip');
    const card = grip?.closest('.seat-card');
    if (!card?.dataset.seat) { event.preventDefault(); return; }
    from = { side: card.dataset.seat[0], index: Number(card.dataset.seat.slice(1)) };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.seat);
    card.classList.add('dragging');
  });
  grid.addEventListener('dragover', event => {
    const card = event.target.closest?.('.seat-card');
    if (!card?.dataset.seat || !from || card.dataset.seat[0] !== from.side ||
        card.dataset.seat === `${from.side}${from.index}`) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    card.classList.add('drop');
  });
  grid.addEventListener('dragleave', event => {
    const card = event.target.closest?.('.seat-card');
    if (card && !card.contains(event.relatedTarget)) card.classList.remove('drop');
  });
  grid.addEventListener('drop', event => {
    const card = event.target.closest?.('.seat-card');
    if (!card?.dataset.seat || !from || card.dataset.seat[0] !== from.side) return clear();
    event.preventDefault();
    const to = Number(card.dataset.seat.slice(1));
    const { side, index } = from;
    clear();
    if (index !== to) swapSeats(side, index, to);
  });
  grid.addEventListener('dragend', clear);
  grid.addEventListener('keydown', event => {
    const card = event.target.closest?.('.seat-card');
    if (!card?.dataset.seat || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    if (event.target !== card && !event.target.classList?.contains('seat-grip')) return;
    const side = card.dataset.seat[0], index = Number(card.dataset.seat.slice(1));
    const to = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= LAN_SEATS) return;
    event.preventDefault();
    swapSeats(side, index, to);
  });
}

// ---------- placeholders: a side's picture under its cameras in OBS ----------
// A player's own placeholder («Команды», next to the photo) wins over the side's.
const PLATE = { a: '#plate-a', b: '#plate-b' };
const sidePlate = side => store?.assets.logos[PLATE[side]] || '';
const playerPlate = id => (id && store?.assets.logos[playerPlateKey(id)]) || '';
const plateImage = (side, playerId = '') => playerPlate(playerId) || sidePlate(side);
// «Кадр» (app.js) shows this picture inside the frame while the webcam is absent.
panel().setPlateImages?.(plateImage);
const plateDocs = new Map();
function plateDoc(side, playerId = '') {
  const image = plateImage(side, playerId);
  if (!image) return '';
  if (!plateDocs.has(image)) plateDocs.set(image, plateCardUrl(image));
  return plateDocs.get(image);
}
// Whether any player of the event has a placeholder of their own.
const anyPlayerPlate = () => Object.keys(store?.assets.logos || {}).some(key => key.startsWith('#plate:'));
function platesChanged() {
  // Pages of pictures no longer used are dropped; the ones in use are made again.
  const used = new Set(Object.entries(store?.assets.logos || {}).filter(([key]) => key.startsWith('#plate')).map(([, url]) => url));
  for (const image of plateDocs.keys()) if (!used.has(image)) plateDocs.delete(image);
  panel().setPlates(plateDoc, anyPlayerPlate);
  renderSeats();
}
let plateSide = 'a';
function paintPlates() {
  const lan = panel().lan();
  for (const [side, suffix] of [['a', 'A'], ['b', 'B']]) {
    const image = sidePlate(side);
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
    paintPlates();
    platesChanged();
    panel().toast(`Заглушка команды ${side.toUpperCase()} готова: отправь камеры в OBS.`);
  } catch (error) { panel().toast(`Заглушка не загрузилась: ${error.message}.`); }
}
async function clearPlate(side) {
  await changeAssets(assets => { delete assets.logos[PLATE[side]]; });
  paintPlates();
  platesChanged();
}

// «Найти компы»: a seat keeps its ID while that PC streams; only a seat whose
// PC is silent takes a stream no seat has yet. Nothing ever moves to another
// seat: a stray webcam left on in the room must not shift pc3 onto seat 4.
// A seat given its own ID (✎) is left alone: that is the operator's fix for
// the very case this guess can get wrong.
function seatsFromScan(found, base, effective, pinned = []) {
  const next = [...base], spare = found.filter(id => !effective.includes(id));
  for (let i = 0; i < next.length && spare.length; i++) {
    if (pinned[i] || found.includes(effective[i])) continue;
    next[i] = spare.shift();
  }
  return { ids: next, spare };
}
// A new prefix or room tells about other streams: an ID typed by hand belonged
// to the old ones, so it goes with them (that is the confirm's business).
function dropPushes(lan) {
  const count = ['a', 'b'].reduce((n, sd) => n + (lan.pushes?.[sd] || []).filter(Boolean).length, 0);
  return count ? ` Вместе с ними сбросятся ID, заданные вручную: ${count}.` : '';
}
async function scanCams() {
  const lan = panel().lan();
  if (!lan.cams) return;
  $('seatsScan').disabled = true;
  if ($('seatsMissing')) $('seatsMissing').hidden = true;
  $('seatsNote').textContent = `Ищем компы в комнатах ${lan.cams.rooms.join(' и ')}… до 12 секунд.`;
  try {
    const found = await Promise.all([0, 1].map(i => scanRoom(lan.cams.rooms[i], lan.cams.passwords[i])));
    if (!found[0].length && !found[1].length) {
      return panel().toast('В комнатах никого: на компах должна быть открыта ссылка места и нажат «Start».');
    }
    const effective = side => Array.from({ length: LAN_SEATS }, (_, i) => lanSeat(lan, side, i).id);
    const pinned = side => Array.from({ length: LAN_SEATS }, (_, i) => Boolean(lan.pushes?.[side]?.[i]));
    const a = seatsFromScan(found[0], lan.cams.ids, effective('a'), pinned('a'));
    const b = seatsFromScan(found[1], lan.cams.idsB || lan.cams.ids, effective('b'), pinned('b'));
    const cams = lanCams({ ...lan.cams, ids: a.ids, idsB: b.ids });
    if (cams && JSON.stringify(cams) !== JSON.stringify(lan.cams)) { draft.cams = cams; commit(true); }
    const spare = [...a.spare.map(id => `${lan.cams.rooms[0]}/${id}`), ...b.spare.map(id => `${lan.cams.rooms[1]}/${id}`)];
    const kept = ['a', 'b'].flatMap(side => Array.from({ length: LAN_SEATS },
      (_, i) => pinned(side)[i] ? `${side.toUpperCase()}${i + 1} (${lanSeat(lan, side, i).id})` : '')).filter(Boolean);
    panel().toast(lan.cams.rooms.map((room, i) => `${room}: ${found[i].join(', ') || 'никого'}`).join(' · ') +
      (spare.length ? ` · лишние потоки, на места не ставлю: ${spare.join(', ')}` : '') +
      (kept.length ? ` · свой ID не трогаю: ${kept.join(', ')}` : ''));
  } finally {
    $('seatsScan').disabled = false;
    renderSeats();
  }
}
function changeSeats(prefix, password) {
  const lan = panel().lan();
  if (prefix === lan.prefix && password === lan.password) return;
  if (!/^[a-z0-9]{2,12}$/.test(prefix)) { renderSeats(); return panel().toast('Префикс: 2–12 латинских букв или цифр.'); }
  if (!window.confirm('Поменяются ссылки всех десяти компов: старые вкладки на местах перестанут попадать в эфир.' +
    dropPushes(lan) + ' Продолжить?')) { renderSeats(); return; }
  draft.prefix = prefix;
  draft.password = password;
  draft.pushes = null;
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
  panel().setPlates(plateDoc, anyPlayerPlate);
  paintPlates();
  renderSeats();
  paintLogos();
  paintPreview();
}

// ---------- wiring ----------
function start() {
  store = new AssetStore({ db: globalThis.indexedDB ? indexedAssets() : null });
  loaded = store.load().then(migrateAssets).then(() => { renderTeams(); paintLogos(); paintPreview(); panel().setPlates(plateDoc, anyPlayerPlate); paintPlates(); });
  // OBS gets every card as one page with its photo inside.
  panel().setCardDocs(players => cardDocs(players, store.assets, palette()));
  $('ltAddTeam').addEventListener('click', addTeam);
  $('ltBulkAdd').addEventListener('click', addRoster);
  // Ctrl+Enter (Cmd+Enter on a Mac) adds the list without reaching for the button.
  $('ltBulk').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); addRoster(); }
  });
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
  $('seatsNetMode').addEventListener('change', netModeChanged);
  for (const id of ['seatsNetQuality', 'seatsNetFps', 'seatsNetCodec', 'seatsNetBitrate', 'seatsNetLowlatency', 'seatsNetLanonly'])
    $(id).addEventListener('change', changeNet);
  initSeatDrag();
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
  // Webcam dots in «Эфир» (live.js) are the seats' too: live.js re-asks
  // VDO.Ninja every second and the badges follow in place.
  document.addEventListener('oneshot:cams', () => {
    if (!$('seatsView').hidden) paintSeatCam();
  });

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

  document.addEventListener('oneshot:change', () => {
    paintLogos();
    if (!seatNickTyping && !$('seatsView').hidden) renderSeats();
  });
  document.addEventListener('oneshot:view', event => {
    if (event.detail === 'matches') renderMatches();
    if (event.detail === 'seats') renderSeats();
    if (event.detail === 'event') paintPreview();
  });
  applyEvent();
  renderAll();
}
if (EVENT?.kind === 'manual') start();
