// LAN mode (site only): teams typed by hand, one fixed webcam per seat.
// app.js keeps the data (window.oneshotPanel.lan / setLan); this file is the
// «ЛАН» dialog with the ten seat links to open on the PCs.
import { lanConfig, parseLanRoster, lanSeatLinks } from './core.js';

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

$('lanBtn').addEventListener('click', () => {
  const current = panel().lan();
  $('lanOn').checked = current.on;
  $('lanPrefix').value = current.prefix || newPrefix();
  $('lanPassword').value = current.password;
  $('lanTeams').value = current.text;
  showError('');
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
