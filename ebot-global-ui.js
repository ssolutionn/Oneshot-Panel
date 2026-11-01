// «Турнир в цифрах» (только сайт): сводка по завершённым матчам eBot.
// Кнопка «Собрать сводку» в лобби читает архив матчей и страницы статистики
// через прокси /api/ebot (?archived=1 и ?view=), агрегирует их чистым
// модулем ebot-global.js (collectTournament) и рисует таблицы — всё
// только через textContent, данные из eBot не попадают в innerHTML.
import { parseArchivePage, collectTournament, topPlayers, mapSummary } from './ebot-global.js';

const $ = id => document.getElementById(id);

const el = (tag, props = {}, ...children) => {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) for (const [key, value] of Object.entries(dataset)) node.dataset[key] = value;
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
};

// Страницы архива: сервер отдаёт по 12 матчей, страниц немного —
// собираем до четырёх (как у живого eBot сейчас), дальше панель
// скажет, что обрезали.
const MAX_PAGES = 4;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function loadArchive() {
  const matches = [];
  let pages = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchJson('/api/ebot?archived=' + page);
    const html = data && data.page || '';
    const batch = parseArchivePage(html);
    matches.push(...batch);
    pages++;
    if (batch.length < 12) break; // последняя страница
  }
  return { matches, truncated: pages >= MAX_PAGES };
}

async function loadStats(matchId) {
  const data = await fetchJson('/api/ebot?view=' + encodeURIComponent(matchId));
  return data && data.page || '';
}

function note(text) {
  window.dispatchEvent(new CustomEvent('oneshot:lobby-note', { detail: text }));
}

function render(body, stats, truncated) {
  body.replaceChildren();
  const summary = el('div', { className: 'ebot-global-summary' },
    el('span', { className: 'ebot-global-chip', textContent: 'Матчей: ' + stats.matches.played }),
    el('span', { className: 'ebot-global-chip', textContent: 'Раундов: ' + stats.matches.totalRounds }));
  if (stats.failed.length) {
    summary.append(el('span', { className: 'ebot-global-chip', textContent: 'Не собрались: ' + stats.failed.length }));
  }
  if (truncated) {
    summary.append(el('span', { className: 'ebot-global-chip', textContent: 'Первые ' + MAX_PAGES + ' страницы архива' }));
  }
  body.append(summary);

  const players = topPlayers(stats, { limit: 15 });
  if (players.length) {
    body.append(el('h3', { textContent: 'Игроки (топ по K−D)' }));
    const table = el('table', { className: 'ebot-global-table' },
      el('thead', {}, el('tr', {},
        el('th', { className: 'left', textContent: 'Игрок' }),
        el('th', { className: 'left', textContent: 'Команда' }),
        el('th', { textContent: 'М' }),
        el('th', { textContent: 'K' }),
        el('th', { textContent: 'D' }),
        el('th', { textContent: 'A' }),
        el('th', { textContent: 'K−D' }),
        el('th', { textContent: 'Rating' }))),
      el('tbody', {}, ...players.map(p => el('tr', {},
        el('td', { className: 'left', textContent: String(p.nick || '') }),
        el('td', { className: 'left', textContent: String(p.team || '') }),
        el('td', { textContent: String(p.matches ?? '') }),
        el('td', { textContent: String(p.kill ?? '') }),
        el('td', { textContent: String(p.death ?? '') }),
        el('td', { textContent: String(p.assist ?? '') }),
        el('td', { textContent: String(p.diff ?? '') }),
        el('td', { textContent: p.rating === null || p.rating === undefined ? '—' : String(p.rating) })))));
    body.append(table);
  }

  const maps = mapSummary(stats);
  if (maps.length) {
    body.append(el('h3', { textContent: 'Карты' }));
    const box = el('div', { className: 'ebot-stats-map' });
    for (const row of maps) {
      const total = (row.wins || 0) + (row.losses || 0) || 1;
      const pct = Math.round((row.wins || 0) / total * 100);
      box.append(el('div', { className: 'ebot-global-map' },
        el('strong', { textContent: String(row.map || '') }),
        el('span', { className: 'ebot-global-bar', title: 'винрейт ' + pct + '%' },
          // style строкой: el() делает Object.assign, объект в сеттер style
          // молча отбрасывается (пустая полоска) — проверено ревью.
          el('i', { style: 'width:' + pct + '%' })),
        el('span', { textContent: (row.wins || 0) + 'W / ' + (row.losses || 0) + 'L · ' + pct + '%' })));
    }
    body.append(box);
  }

  if (stats.failed.length) {
    body.append(el('p', { className: 'ebot-global-failed',
      textContent: 'Матчи без статистики: ' + stats.failed.join(', ') }));
  }
}

async function collect() {
  const status = $('ebotGlobalStatus');
  const body = $('ebotGlobalBody');
  const btn = $('ebotGlobalBtn');
  btn.disabled = true;
  status.textContent = 'Читаем архив матчей…';
  try {
    const { matches, truncated } = await loadArchive();
    if (!matches.length) {
      status.textContent = 'В архиве eBot пока нет завершённых матчей.';
      body.hidden = true;
      return;
    }
    status.textContent = 'Собираем статистику: ' + matches.length + ' матчей…';
    const stats = await collectTournament(matches, loadStats, {
      onProgress: (done, total) => {
        status.textContent = 'Собираем статистику: матч ' + done + ' из ' + total + '…';
      }
    });
    body.hidden = false;
    render(body, stats, truncated);
    status.textContent = 'Сводка готова: ' + stats.matches.played + ' матчей, '
      + stats.matches.totalRounds + ' раундов.';
    note('eBot: сводка турнира собрана — ' + stats.matches.played + ' матчей.');
  } catch (error) {
    status.textContent = 'Сводка не собралась: ' + (error.message || 'eBot не ответил.');
    body.hidden = true;
  } finally {
    btn.disabled = false;
  }
}

$('ebotGlobalBtn').addEventListener('click', () => { collect(); });
