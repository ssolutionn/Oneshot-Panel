// LAN mode (site only): teams typed by hand, one fixed webcam per seat.
// app.js keeps the data (window.oneshotPanel.lan / setLan); this file is the
// «ЛАН» dialog with the ten seat links to open on the PCs.
import { lanConfig, parseLanRoster, lanSeatLinks, personKey, cardKey } from './core.js';
import {
  readZip, collectTeams, rosterLine, readAssets, writeAssets, photoOf, logoOf, cardDocs
} from './lan-event.js';
import { processImage, drawCardPreview } from './lan-images.js';

const $ = id => document.getElementById(id);
const panel = () => window.oneshotPanel;

// Short and easy to type by hand: no 0/o, 1/l/i look-alikes.
function newPrefix() {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), b => letters[b % letters.length]).join('');
}
function form() {
  return lanConfig({
    on: $('lanOn').checked, prefix: $('lanPrefix').value.trim(),
    password: $('lanPassword').value, text: $('lanTeams').value
  });
}
function showError(text) {
  $('lanError').textContent = text;
  $('lanError').hidden = !text;
}
function renderSeats() {
  const value = form();
  const items = value.prefix ? lanSeatLinks(value).map(link => {
    const item = document.createElement('li');
    const seat = document.createElement('b');
    seat.textContent = link.seat;
    const url = document.createElement('code');
    url.textContent = link.push;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-icon';
    copy.textContent = '⧉';
    copy.title = `Копировать ссылку места ${link.seat}`;
    copy.setAttribute('aria-label', copy.title);
    copy.addEventListener('click', () => panel().copy(link.push));
    item.append(seat, url, copy);
    return item;
  }) : [Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Ссылки появятся, когда будет префикс: 2–12 латинских букв или цифр.' })];
  $('lanSeats').replaceChildren(...items);
  $('lanCopySeats').disabled = !value.prefix;
}

// ---------- photos and logos from a Drive folder ----------
const logLine = (text, bad) => {
  const item = document.createElement('li');
  item.textContent = text;
  if (bad) item.className = 'bad';
  $('lanImportLog').append(item);
};
function assetsNote() {
  const assets = readAssets();
  const photos = Object.keys(assets.photos).length, logos = Object.keys(assets.logos).length;
  $('lanImportStatus').textContent = photos || logos ?
    `Сохранено в этом браузере: ${photos} фото, ${logos} лого. Карточки в OBS возьмут их отсюда.` :
    'Фото ещё не загружены: карточки будут без фото (с названием команды и ником).';
}
// Lines of the teams box: a team's line is replaced, a new team is appended.
function mergeRosterLines(imported) {
  const lines = $('lanTeams').value.split(/\r?\n/);
  for (const [name, line] of imported) {
    const at = lines.findIndex(l => personKey(l.slice(0, Math.max(0, l.indexOf(':')))) === personKey(name) && l.includes(':'));
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  $('lanTeams').value = lines.filter((l, i) => l.trim() || i < lines.length - 1).join('\n').replace(/^\n+/, '');
}
let importing = false;
async function importFiles(files) {
  if (importing) return;
  importing = true;
  $('lanImportLog').replaceChildren();
  for (const id of ['lanPickZip', 'lanPickFolder', 'lanClearAssets']) $(id).disabled = true;
  try {
    const { teams, problems } = collectTeams(files);
    if (!teams.length) throw new Error('В выбранном нет папок команд с картинками (PNG, JPG, WEBP).');
    const jobs = teams.flatMap(team => [
      ...[...team.players].map(([nick, file]) => ({ team, kind: 'photo', nick, file })),
      ...(team.logo ? [{ team, kind: 'logo', file: team.logo }] : [])
    ]);
    const assets = readAssets();
    for (const team of teams) {
      // A team imported again replaces its earlier photos.
      for (const key of Object.keys(assets.photos)) if (key.startsWith(personKey(team.name) + '|')) delete assets.photos[key];
      delete assets.logos[personKey(team.name)];
    }
    let done = 0;
    const failed = [], warned = [];
    const queue = [...jobs];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const label = `${job.team.name} / ${job.kind === 'logo' ? 'лого' : job.nick}`;
        try {
          const { url, warning } = await processImage(await job.file.blob(), job.kind);
          if (job.kind === 'logo') assets.logos[personKey(job.team.name)] = url;
          else assets.photos[cardKey(job.team.name, job.nick)] = url;
          if (warning) warned.push(`${label}: ${warning}`);
        } catch (error) { failed.push(`${label}: ${error.message} — будет карточка без ${job.kind === 'logo' ? 'лого' : 'фото'}`); }
        $('lanImportStatus').textContent = `Обрабатываем ${++done} из ${jobs.length}…`;
      }
    };
    await Promise.all([worker(), worker()]);
    const stored = writeAssets(assets);
    if (!stored) throw new Error('Браузеру не хватило места для фото: убери лишние фото или лого и повтори.');
    mergeRosterLines(teams.filter(t => t.players.size).map(t => [t.name, `${t.name}: ${rosterLine(t)}`]));
    for (const team of teams) if (!team.logo) warned.push(`${team.name}: нет logo.png — вместо лого будет только название`);
    for (const text of [...problems, ...failed, ...warned]) logLine(text, true);
    for (const team of teams) logLine(`${team.name}: ${team.players.size} фото${team.logo ? ', лого ✓' : ''}`);
    assetsNote();
    showError('');
  } catch (error) {
    showError(error.message);
    assetsNote();
  } finally {
    importing = false;
    for (const id of ['lanPickZip', 'lanPickFolder', 'lanClearAssets']) $(id).disabled = false;
  }
}
// OBS gets every card as one page with its photo inside.
panel().setCardDocs(players => cardDocs(players, readAssets()));
$('lanPickZip').addEventListener('click', () => $('lanZip').click());
$('lanPickFolder').addEventListener('click', () => $('lanFolder').click());
$('lanZip').addEventListener('change', async () => {
  const file = $('lanZip').files[0];
  $('lanZip').value = '';
  if (!file) return;
  try {
    $('lanImportStatus').textContent = 'Открываем архив…';
    const entries = await readZip(await file.arrayBuffer());
    await importFiles(entries);
  } catch (error) { showError(error.message); assetsNote(); }
});
$('lanFolder').addEventListener('change', async () => {
  const files = [...$('lanFolder').files].map(file => ({
    path: file.webkitRelativePath || file.name, size: file.size, blob: async () => file
  }));
  $('lanFolder').value = '';
  if (files.length) await importFiles(files);
});
$('lanClearAssets').addEventListener('click', () => {
  if (!window.confirm('Убрать все загруженные фото и лого из этого браузера?')) return;
  writeAssets({});
  $('lanImportLog').replaceChildren();
  assetsNote();
});
// Every click shows the next player of the list as a card.
let previewAt = -1;
$('lanPreviewCard').addEventListener('click', async () => {
  let teams;
  try { teams = parseLanRoster($('lanTeams').value); } catch (error) { return showError(error.message); }
  showError('');
  const everyone = teams.flatMap(team => team.players.map(player => ({ team, player })));
  previewAt = (previewAt + 1) % everyone.length;
  const { team, player } = everyone[previewAt], assets = readAssets();
  const photo = photoOf(assets, team.name, player.nick), logo = logoOf(assets, team.name);
  $('lanCardPreview').hidden = false;
  try {
    await drawCardPreview($('lanCardPreview'), { team: team.name, nick: player.nick, photo, logo });
    $('lanImportStatus').textContent = `${previewAt + 1} из ${everyone.length}: ${player.nick} (${team.name}) — ${photo ? 'фото есть' : 'фото нет'}, ${logo ? 'лого есть' : 'лого нет'}. Нажми ещё раз — следующий.`;
  } catch (error) { showError('Не удалось нарисовать карточку: ' + error.message); }
});

$('lanBtn').addEventListener('click', () => {
  const current = panel().lan();
  $('lanOn').checked = current.on;
  $('lanPrefix').value = current.prefix || newPrefix();
  $('lanPassword').value = current.password;
  $('lanTeams').value = current.text;
  showError('');
  $('lanImportLog').replaceChildren();
  assetsNote();
  renderSeats();
  $('lanDialog').showModal();
});
$('closeLan').addEventListener('click', () => $('lanDialog').close());
// Only what VDO.Ninja keeps in a stream ID, in lower case.
$('lanPrefix').addEventListener('input', () => {
  const clean = $('lanPrefix').value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (clean !== $('lanPrefix').value) $('lanPrefix').value = clean;
  renderSeats();
});
$('lanPassword').addEventListener('input', renderSeats);
$('lanNewPrefix').addEventListener('click', () => {
  if (panel().lan().on && !window.confirm('Поменяются все 10 ссылок мест — их придётся заново открыть на компах. Продолжить?')) return;
  $('lanPrefix').value = newPrefix();
  renderSeats();
});
$('lanCopySeats').addEventListener('click', () => {
  const value = form();
  if (value.prefix) panel().copy(lanSeatLinks(value).map(link => `${link.seat} ${link.push}`).join('\n'));
});
$('lanForm').addEventListener('submit', event => {
  event.preventDefault();
  const value = form();
  if ($('lanOn').checked) {
    if (!value.prefix) return showError('Префикс: 2–12 латинских букв или цифр.');
    try { parseLanRoster(value.text); } catch (error) { return showError(error.message); }
  }
  showError('');
  $('lanDialog').close();
  const stored = panel().setLan(value);
  panel().toast(!stored ? 'Сохранено до перезагрузки: браузер не разрешил запомнить настройки.' :
    value.on ? 'ЛАН: команды обновлены. Рассадку выбери в карточках команд.' : 'Режим ЛАН выключен: составы снова из таблицы.');
});
