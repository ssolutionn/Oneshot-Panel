// Переключатель события в шапке: список ивентов приходит из event.js
// (window.oneshotEventChoices, его пишет events/event-script.js), выбор хранится
// в cookie — адрес панели не меняется, и на статическом сайте тоже.
const CHOICE_COOKIE = 'oneshot-event';

const choices = () => Array.isArray(globalThis.oneshotEventChoices) ? globalThis.oneshotEventChoices : [];
const currentSlug = () => globalThis.oneshotEvent?.slug || '';

function choose(slug) {
  document.cookie = `${CHOICE_COOKIE}=${encodeURIComponent(slug)}; Max-Age=31536000; Path=/; SameSite=Lax`;
  // «?event=» в адресе сильнее cookie (event.js): убираем его, чтобы выбор остался.
  const url = new URL(location.href);
  url.searchParams.delete('event');
  location.assign(url.href);
}

function openChooser() {
  const list = choices();
  const root = document.createElement('div');
  root.className = 'event-chooser-backdrop';
  root.innerHTML = '<section class="event-chooser" role="dialog" aria-modal="true" aria-labelledby="eventChooserTitle" aria-describedby="eventChooserHint">' +
    '<p class="eyebrow">ONESHOT PANEL</p><h1 id="eventChooserTitle">Выберите событие</h1>' +
    '<p class="muted" id="eventChooserHint">Откройте панель нужного ивента.</p>' +
    '<div class="event-chooser-list"></div>' +
    '<button type="button" class="event-chooser-close text-button">Закрыть</button></section>';
  const box = root.querySelector('.event-chooser-list');
  const closeButton = root.querySelector('.event-chooser-close');
  const opener = document.activeElement;
  const close = () => {
    root.remove();
    document.removeEventListener('keydown', onKey);
    opener?.focus?.({ preventScroll: true });
  };
  const onKey = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  };
  if (list.length) {
    for (const choice of list) {
      const here = choice.slug === currentSlug();
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'event-chooser-option';
      button.textContent = `${choice.name} — ${choice.short || choice.slug}${here ? ' · открыто' : ''}`;
      if (here) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => here ? close() : choose(choice.slug));
      box.append(button);
    }
  } else {
    // event.js не загрузился: пустое окно ничего не объясняет, говорим причину.
    root.querySelector('#eventChooserHint').textContent =
      'Список событий не загрузился. Открой панель через npm start или с сайта — там event.js знает все ивенты.';
  }
  document.body.append(root);
  document.addEventListener('keydown', onKey);
  (box.firstElementChild || closeButton).focus({ preventScroll: true });
  closeButton.addEventListener('click', close);
  root.addEventListener('click', event => { if (event.target === root) close(); });
}

document.addEventListener('DOMContentLoaded', () => {
  const brand = document.querySelector('.brand');
  if (!brand) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'brand-event-button';
  button.textContent = 'Выбрать событие';
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    openChooser();
  });
  brand.append(button);
});
