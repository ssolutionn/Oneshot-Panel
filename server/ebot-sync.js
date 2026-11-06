// Синхронизация составов: eBot берёт составы из ПАНЕЛИ (таблица), а не из
// своей базы. Чистые функции без запросов: module ничего не отправляет сам —
// он превращает снимок панели ({a: team, b: team} из
// window.oneshotPanel.snapshot()) в список ДАННЫХ для интеграции; создаёт
// команды и матч уже ebot-admin.js (createMatch) по этим полям.
// Команда панели: {name, players: [{nick, role: «Основной»/«Запасной»/
// «Тренер», key, …}]} — core.js parseTeams/lanTeams.

const line = value => String(value ?? '').trim();
const nickKey = value => line(value).toLowerCase();

// Состав команды панели для eBot: только «Основной» (не больше 5 — столько
// слотов в матче), «Запасной» и «Тренер» — отдельными списками, в eBot они
// в матче не играют (тренеров панель использует для мьюта в TeamSpeak).
// Ошибки по-русски: команда без названия, пустые ники, дубли ников.
export function panelTeamToEbot(team) {
  if (!team || typeof team !== 'object') {
    throw new Error('Команда не передана.');
  }
  const name = line(team.name);
  if (!name) throw new Error('У команды нет названия.');
  const players = Array.isArray(team.players) ? team.players : [];
  const seen = new Set(), main = [], substitutes = [], coaches = [];
  for (const p of players) {
    const nick = line(p?.nick);
    if (!nick) throw new Error(`«${name}»: у игрока пустой ник.`);
    const key = nickKey(nick);
    if (seen.has(key)) throw new Error(`«${name}»: ник «${nick}» повторяется.`);
    seen.add(key);
    if (p.role === 'Тренер') coaches.push({ nick });
    else if (p.role === 'Запасной') substitutes.push({ nick });
    else if (p.role === 'Основной') main.push({ nick });
  }
  if (!main.length) throw new Error(`«${name}»: нет игроков роли «Основной».`);
  return {
    name,
    // Пять играющих — как слоты слева/справа в матче eBot.
    players: main.slice(0, 5),
    substitutes,
    coaches,
  };
}

// Одна команда: есть ли уже такая в eBot (по имени без учёта регистра)?
// ebotTeams — список команд eBot вида [{id, name}, …] (интеграция читает его
// из админки). Ничего не отправляет: reuse — взять существующий id, create —
// поля для формы создания.
export function syncTeamToEbot({ panelTeam, ebotTeams }) {
  const team = panelTeamToEbot(panelTeam);
  const existing = (Array.isArray(ebotTeams) ? ebotTeams : [])
    .find(t => t && nickKey(t.name) === nickKey(team.name));
  if (existing) {
    return { action: 'reuse', id: existing.id, name: team.name };
  }
  // Поля формы создания команды: интеграция отправляет их сама.
  return {
    action: 'create',
    name: team.name,
    fields: { name: team.name, players: team.players.map(p => p.nick) },
  };
}

// Матч целиком: [{type:'team', action, team, ebotId?}, …] для обеих команд и
// в конце {type:'match', fields} — поля для ebot-admin.createMatch.
// Чистая функция: никаких запросов. Названия и составы обеих команд уже
// проверены panelTeamToEbot; одинаковые команды в матче не допускаем.
export function syncMatch({ panelSnapshot, ebotTeams }) {
  if (!panelSnapshot || typeof panelSnapshot !== 'object' ||
      !panelSnapshot.a || !panelSnapshot.b) {
    throw new Error('Снимок панели не содержит две команды.');
  }
  const a = panelTeamToEbot(panelSnapshot.a);
  const b = panelTeamToEbot(panelSnapshot.b);
  if (nickKey(a.name) === nickKey(b.name)) {
    throw new Error('В матче одна и та же команда.');
  }
  const teams = (Array.isArray(ebotTeams) ? ebotTeams : []);
  const actions = [a, b].map(team => {
    const existing = teams.find(t => t && nickKey(t.name) === nickKey(team.name));
    return existing
      ? { type: 'team', action: 'reuse', team, ebotId: existing.id }
      : { type: 'team', action: 'create', team, fields: { name: team.name, players: team.players.map(p => p.nick) } };
  });
  // Имена команд для формы матча: panelTeamToEbot уже проверил их.
  actions.push({
    type: 'match',
    fields: { teamA: a.name, teamB: b.name },
  });
  return actions;
}
