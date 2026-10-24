// Переключатель события в шапке. Выбор хранится в cookie, адрес панели не меняется.
const choices = globalThis.oneshotEventChoices || [];
const openChooser = () => {
  const root = document.createElement('div');
  root.className = 'event-chooser-backdrop';
  root.innerHTML = '<section class="event-chooser" role="dialog" aria-labelledby="eventChooserTitle"><p class="eyebrow">ONESHOT PANEL</p><h1 id="eventChooserTitle">Выберите событие</h1><p class="muted">Откройте панель нужного ивента.</p><div class="event-chooser-list"></div></section>';
  const list = root.querySelector('.event-chooser-list');
  for (const event of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'event-chooser-option';
    button.textContent = `${event.name} — ${event.short || event.slug}`;
    button.addEventListener('click', () => {
      document.cookie = `oneshot-event=${encodeURIComponent(event.slug)}; Max-Age=31536000; Path=/; SameSite=Lax`;
      location.reload();
    });
    list.append(button);
  }
  document.body.append(root);
  root.addEventListener('click', event => { if (event.target === root) root.remove(); });
};
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
