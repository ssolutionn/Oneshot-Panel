// Агрегатор «турнир в цифрах» по матчам eBot (без DOM, без сети): сводка
// по игрокам, картам и матчам. Разбор страниц делают готовые парсеры —
// parseStatsPage/parseTeams из ebot-stats-parse.js; сами страницы приносит
// вызывающий код (fetchMatch в тестах — мок, в панели — прокси /api/ebot
// ?view=<id>), поэтому модуль не знает ни адресов, ни fetch.
// Ники и названия команд возвращаем как есть: UI рендерит их через
// textContent, сырой HTML до сюда не доходит (теги срезаны парсером).

import { parseStatsPage } from './ebot-stats-parse.js';

// Список завершённых матчей со страницы /matchs/archived. Макет другой,
// чем у parseEbotMatches в ebot.js (там список текущих матчей): в архиве
// есть колонки Season и Status и две кнопки-ссылки (Demo и Show), а
// строка опознаётся по тому же якорю id="score-N", но команды — всегда
// соседние ячейки вокруг счёта (флаги в архиве живут ВНУТРИ ячеек команд,
// отдельными ячейками их не делают). Толерантно к отсутствию полей:
// пустая карта/сезон остаются ''.
export function parseArchivePage(html) {
  const matches = [];
  for (const row of (String(html ?? '').match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || [])) {
    const scoreMatch = row.match(/id="score-(\d+)"[^>]*>([\s\S]*?)<\/div>/);
    if (!scoreMatch) continue;
    const cells = (row.match(/<td\b[^>]*>[\s\S]*?<\/td>/g) || []).map(cell => text(cell));
    // Индекс ячейки счёта: команды — её соседи. «-1» пропускает мусорный
    // случай, когда счёт оказался первой ячейкой.
    const scoreIndex = cells.findIndex(cell => /^\d+\s*-\s*\d+$/.test(cell));
    if (scoreIndex < 1) continue;
    const teamA = cells[scoreIndex - 1], teamB = cells[scoreIndex + 1] || '';
    // Карта — единственная de_*-ячейка; счёт — цифры из div#score-N
    // (жирный ноль ведущего счёта ведёт себя как обычная цифра).
    const map = cells.find(cell => /^de_[a-z0-9_]+$/i.test(cell)) || '';
    const numbers = (scoreMatch[2].match(/\d+/g) || []).map(Number);
    matches.push({
      id: scoreMatch[1],
      teamA,
      teamB,
      scoreA: numbers[0] ?? 0,
      scoreB: numbers[1] ?? 0,
      map
    });
  }
  return matches;
}

// Сводка турнира по списку матчей. Для каждого матча {id} зовёт
// fetchMatch(id) → HTML /matchs/view/:id, прогоняет parseStatsPage и
// складывает игроков/карты/итог. Отказ одного матча (fetchMatch бросил
// или вернул не-строку) не роняет остальные: id попадает в failed.
// Ошибку fetchMatch перехватываем обеими фазами — синхронный бросок и
// отклонённый промис: интеграцию не должно волновать, какой она была.
// Внешних запросов модуль не делает — только переданный fetchMatch.
export async function collectTournament(matches, fetchMatch, { onProgress } = {}) {
  const players = new Map();
  const maps = new Map();
  let totalRounds = 0, played = 0;
  const failed = [];
  const list = (matches || []);
  let done = 0;

  for (const match of list) {
    const id = match?.id;
    if (id === undefined || id === null) continue;
    let html;
    try {
      html = await fetchMatch(id);
      if (typeof html !== 'string') throw new Error(`не строка: ${typeof html}`);
    } catch {
      failed.push(id);
      continue;
    }
    done++;
    if (typeof onProgress === 'function') {
      try { onProgress(done, list.length); } catch { /* прогресс не роняет сборку */ }
    }
    // parseStatsPage внутри уже прогоняет parseTeams и отдаёт пары
    // команд из заголовка «Match #N - A vs B».
    const { players: rows, teams } = parseStatsPage(html);
    played++;
    const scoreA = Number(match.scoreA) || 0;
    const scoreB = Number(match.scoreB) || 0;
    totalRounds += scoreA + scoreB;

    // ---- игроки: суммы по никам, последняя команда, средний rating ----
    // Ника нет — строку пропускаем (parseStatsPage такие уже не отдаёт).
    for (const row of rows) {
      if (!row.nick) continue;
      const current = players.get(row.nick) || {
        nick: row.nick, kill: 0, death: 0, assist: 0,
        ratingSum: 0, ratingMatches: 0, matches: 0, team: ''
      };
      current.kill += numberOr(row.kill);
      current.death += numberOr(row.death);
      current.assist += numberOr(row.assist);
      current.matches++;
      // Rating в eBot — колонка «K/D Rate»: считаем среднее только по
      // матчам, где поле числовое (оно может отсутствовать в старых eBot).
      if (typeof row.kd === 'number') {
        current.ratingSum += row.kd;
        current.ratingMatches++;
      }
      // «Последняя команда»: список уже отсортирован по убыванию id
      // (интеграция сортирует) либо приходим в хронологическом порядке —
      // просто перезаписываем, последнее слово остаётся за поздним матчем.
      current.team = row.team || current.team;
      players.set(row.nick, current);
    }

    // ---- карты: победы/поражения команд и винрейт ----
    if (match.map) {
      const mapStat = maps.get(match.map) || {
        map: match.map, matches: 0, wins: new Map(), losses: new Map()
      };
      mapStat.matches++;
      // Победа — у кого счёт больше; равный счёт не записываем никому
      // (овертайм-ничьей в MR12-матче не бывает, но не врём и про неё).
      const winner = scoreA > scoreB ? 0 : scoreB > scoreA ? 1 : -1;
      if (winner >= 0) {
        // Название команды — из заголовка страницы матча (parseTeams),
        // а не из списка: в архиве команды иногда пустые/обрезанные.
        const team = teams[winner];
        const loser = teams[1 - winner];
        if (team) bump(mapStat.wins, team);
        if (loser) bump(mapStat.losses, loser);
      }
      maps.set(match.map, mapStat);
    }
  }

  // Карточки карт без внутренних Map: плоские объекты для UI.
  const mapRows = [...maps.values()].map(stat => ({
    map: stat.map,
    matches: stat.matches,
    teams: [...new Set([...stat.wins.keys(), ...stat.losses.keys()])].map(team => ({
      team,
      wins: stat.wins.get(team) || 0,
      losses: stat.losses.get(team) || 0,
      winrate: winrate(stat.wins.get(team) || 0, stat.losses.get(team) || 0)
    })).sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses) || (b.wins - a.wins))
  })).sort((a, b) => b.matches - a.matches || (a.map < b.map ? -1 : 1));

  // K-D и средний rating досчитываем один раз после всех матчей.
  const playerRows = [...players.values()].map(player => ({
    ...player,
    diff: player.kill - player.death,
    rating: player.ratingMatches ? round2(player.ratingSum / player.ratingMatches) : null
  }));
  deleteField(playerRows, 'ratingSum');
  deleteField(playerRows, 'ratingMatches');

  return { players: playerRows, maps: mapRows, matches: { played, totalRounds }, failed };
}

// Топ игроков по K-D, затем по kills (стабильно при равенстве — по нику,
// чтобы два прогона не расходились). limit по умолчанию 10.
export function topPlayers(stats, { limit = 10 } = {}) {
  const rows = (stats?.players || []).slice();
  rows.sort((a, b) =>
    (b.diff ?? 0) - (a.diff ?? 0) ||
    (b.kill ?? 0) - (a.kill ?? 0) ||
    String(a.nick).localeCompare(String(b.nick)));
  return rows.slice(0, Math.max(0, limit));
}

// Таблица карт: строки сводки как есть (mapSummary ничего не считает —
// всё уже посчитано в collectTournament, здесь только форма для UI).
export function mapSummary(stats) {
  return (stats?.maps || []).slice();
}

function bump(counter, team) {
  counter.set(team, (counter.get(team) || 0) + 1);
}

function numberOr(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function winrate(wins, losses) {
  const total = wins + losses;
  return total ? round2(wins / total) : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function deleteField(rows, field) {
  for (const row of rows) delete row[field];
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#039': "'" };
function text(html) {
  return html.replace(/<[^>]*>/g, ' ')
    .replace(/&([a-z#0-9]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, ' ').trim();
}
