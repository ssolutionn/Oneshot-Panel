import { HUB_EVENTS, GAMES, eventUrl, selectHubRoute } from './event-hub-config.js';

const $ = id => document.getElementById(id);
const route = selectHubRoute(location.search);
const hub = $('eventHub'), panel = $('panelApp');
const active = route.view === 'panel';

if (hub && panel) {
  hub.hidden = active;
  panel.hidden = !active;
  const card = (titleText, detailText, badgeText, arrowText) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'hub-card';
    const content = document.createElement('div');
    const title = document.createElement('h2'); title.textContent = titleText;
    const eventMeta = HUB_EVENTS.find(item => item.name === titleText);
    if (eventMeta?.logo) {
      const logo = document.createElement('img'); logo.className = 'hub-event-logo'; logo.src = eventMeta.logo; logo.alt = `${eventMeta.name} logo`;
      logo.addEventListener('error', () => logo.remove(), { once: true });
      content.append(logo);
    }
    content.append(title);
    const detail = document.createElement('p'); detail.textContent = detailText; content.append(detail);
    if (badgeText) {
      const badge = document.createElement('span'); badge.className = 'hub-badge'; badge.textContent = badgeText; content.append(badge);
    }
    const arrow = document.createElement('span'); arrow.className = 'hub-arrow'; arrow.textContent = arrowText;
    button.append(content, arrow);
    return button;
  };

  if (!active) {
    for (const event of HUB_EVENTS) {
      const button = card(event.name, event.description, `${event.games.length} дисциплин`, 'Выбрать →');
      button.addEventListener('click', () => { location.href = eventUrl(event.slug); });
      $('hubEvents').append(button);
    }

    if (route.view === 'setup') {
      $('hubSetupView').hidden = false;
      $('hubSetupTitle').textContent = `${route.event.name} · ${route.game.label}`;
      $('hubBackGames').addEventListener('click', () => { location.href = eventUrl(route.event.slug); });
    } else if (route.event) {
      $('hubGamesView').hidden = false;
      $('hubEventName').textContent = route.event.name;
      $('hubEventDescription').textContent = 'Выбери дисциплину. У каждой свои составы, настройки и эфирные данные.';
      $('hubBackEvents').addEventListener('click', () => { location.href = '/'; });
      for (const id of route.event.games) {
        const game = GAMES.find(item => item.id === id) || { id, label: id, status: 'setup' };
        const ready = game.status === 'ready';
        const button = card(game.label,
          ready ? 'Составы, камеры, OBS и эфирные инструменты.' : 'Отдельная подготовка составов, GSI-статистика и эфирная графика.',
          ready ? 'ПАНЕЛЬ ДОСТУПНА' : 'СКОРО', ready ? 'Открыть →' : 'В разработке');
        button.dataset.status = game.status;
        if (ready) button.addEventListener('click', () => { location.href = eventUrl(route.event.slug, id); });
        $('hubGames').append(button);
      }
    } else {
      $('hubEventsView').hidden = false;
    }
  }
}

if (active) {
  document.documentElement.dataset.event = route.event.slug;
  document.documentElement.dataset.game = route.game.id;
  const button = $('changeEventBtn');
  button?.addEventListener('click', () => { location.href = '/'; });
  const brandSub = document.querySelector('.brand-sub');
  if (brandSub) brandSub.textContent = `${route.event.name} · ${route.game.label}`;
}
