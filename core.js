export const DEFAULT_SOURCE = {
  id: '1e__ijBjufD19SWBkSJL177vmmfMh2tdykYQHAS06S8I',
  gid: '1315978454',
  scheduleId: '1e__ijBjufD19SWBkSJL177vmmfMh2tdykYQHAS06S8I',
  scheduleGid: '1758299905'
};

const line = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();

export function decodeGviz(text) {
  const begin = text.indexOf('{'), end = text.lastIndexOf('}');
  let result;
  try { result = JSON.parse(text.slice(begin, end + 1)); }
  catch {
    throw new Error('Не удалось прочитать ответ Google Sheets. Проверь доступ на просмотр по ссылке.');
  }
  if (result.status !== 'ok' || !Array.isArray(result.table?.rows)) {
    throw new Error('Google Sheets не разрешил чтение. Нужен доступ на просмотр по ссылке.');
  }
  return result.table.rows.map(row => (row.c || []).map(c => line(c?.f ?? c?.v)));
}

export function parseTeams(rows) {
  const teams = [], byName = new Map(), ids = new Set();
  rows.forEach((row, index) => {
    const v = row.map(line);
    if (!v[0] || !v[1] || !v[3] ||
        !['Основной', 'Запасной', 'Тренер'].includes(v[8])) return;
    const name = v[1], nick = v[3], id = v[4] || nick, room = v[5];
    if (!room) throw new Error(`Не указана комната команды ${name}.`);
    if (ids.has(v[0])) throw new Error(`Повтор ID в таблице: ${v[0]}`);
    ids.add(v[0]);
    if (!byName.has(name)) {
      const team = { name, room, players: [], sourceRow: index + 1 };
      teams.push(team);
      byName.set(name, team);
    }
    byName.get(name).players.push({
      key: v[0], slot: v[2], nick, id, room,
      role: v[8], sourceRow: index + 1
    });
  });
  if (!teams.length) {
    throw new Error('На листе не найден состав. Нужен лист «Все игроки»: ID, команда, слот, ник, ID потока, room, PUSH, VIEW, роль.');
  }
  return teams;
}

export function parseSchedule(rows) {
  return rows.flatMap((row, index) => {
    const v = row.map(line);
    const time = v[1]?.match(/^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/);
    if (!v[2] || !v[3] || !time || Number(time[1]) > 23) return [];
    const stage = /^[A-H]$/.test(v[4] || '') ? `Группа ${v[4]}` : v[4] || '';
    return [{
      time: `${time[1].padStart(2, '0')}:${time[2]}`,
      team1: v[2], team2: v[3], group: v[4] || '', stage,
      key: JSON.stringify([index, ...v.slice(1, 5)])
    }];
  });
}

const MONTHS = [/^январ/, /^феврал/, /^март/, /^апрел/, /^ма[йя]$/, /^июн/,
  /^июл/, /^август/, /^сентябр/, /^октябр/, /^ноябр/, /^декабр/];

// Day the schedule sheet is for, from its title ("Матчи 14 октября 2026"
// or "Матчи 14.10"), as "DD.MM"; '' when the sheet does not say.
export function scheduleDay(rows) {
  for (const row of rows.slice(0, 6)) {
    for (const cell of row) {
      const text = line(cell).toLowerCase();
      if (!/матч|расписан|schedule/.test(text)) continue;
      const word = text.match(/(\d{1,2})\s+([а-яё]+)/);
      const month = word ? MONTHS.findIndex(m => m.test(word[2])) : -1;
      const numeric = text.match(/(\d{1,2})\.(\d{1,2})(?!\d)/);
      const [day, mon] = month >= 0 ? [Number(word[1]), month + 1] :
        numeric ? [Number(numeric[1]), Number(numeric[2])] : [0, 0];
      if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
        return `${String(day).padStart(2, '0')}.${String(mon).padStart(2, '0')}`;
      }
    }
  }
  return '';
}

export function defaultLineup(team) {
  return team?.players.filter(p => p.role === 'Основной')
    .slice(0, 5).map(p => p.key) || [];
}
export function lineupCandidates(team) { return team?.players || []; }
export function roleSuffix(p) {
  return p.role === 'Тренер' ? ' (тренер)' :
    p.role === 'Запасной' ? ' (запасной)' : '';
}
export function selectedPlayers(team, keys) {
  return keys.map(key => team?.players.find(p => p.key === key) || null);
}
export function validatePlayers(players) {
  if (players.length !== 5 || players.some(p => !p)) {
    return 'Выбери ровно пять игроков в команде.';
  }
  if (new Set(players.map(p => p.key)).size !== 5) {
    return 'Один игрок выбран несколько раз.';
  }
  if (players.some(p => !p.room || !p.id)) {
    return 'У игрока не указан ID потока или room.';
  }
  if (new Set(players.map(p => p.id)).size !== 5) {
    return 'Повторяется ID видеопотока.';
  }
  return '';
}
export function validateMatch(a, b, ka, kb) {
  if (!a || !b) return 'Выбери две команды.';
  if (a.name === b.name) return 'Выбери разные команды.';
  const pa = selectedPlayers(a, ka), pb = selectedPlayers(b, kb);
  const error = validatePlayers(pa) || validatePlayers(pb);
  if (error) return error;
  if (new Set([...pa, ...pb].map(p => p.key)).size !== 10) {
    return 'Один игрок выбран в обеих командах.';
  }
  if (new Set([...pa, ...pb].map(p => p.id)).size !== 10) {
    return 'У каждого из десяти игроков должен быть свой ID видеопотока.';
  }
  return '';
}

export function viewUrl(p) {
  return `https://vdo.ninja/?view=${encodeURIComponent(p.id)}&solo=1&room=${encodeURIComponent(p.room)}&codec=h264`;
}
export function pushUrl(p) {
  return `https://vdo.ninja/?room=${encodeURIComponent(p.room)}&broadcast&do&push=${encodeURIComponent(p.id)}`;
}
export function directorUrl(team) {
  return `https://vdo.ninja/?director=${encodeURIComponent(team.room)}`;
}
// Slot order only: the observer gets the cameras from the OBS JSON.
export function observerText(a, b, pa, pb) {
  const slot = (p, i) => `${i + 1}. ${i < 5 ? a.name : b.name} — ${p.nick}`;
  return `${a.name} — ${b.name}\n\n` +
    pa.map((p, i) => slot(p, i)).join('\n') + '\n\n' +
    pb.map((p, i) => slot(p, i + 5)).join('\n');
}
function markdown(value) {
  return line(value).replace(/[\\[\]*_~`<>#!()]/g, '\\$&');
}
export function playerText(team, players) {
  return `## ${markdown(team.name)}\nOpen your link and turn on your camera.\n\n` +
    players.filter(Boolean).map(p =>
      `**${markdown(p.nick)}** ${pushUrl(p)}`
    ).join('\n');
}

export function validateMetadata(time, stage) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return 'Укажи время матча в формате ЧЧ:ММ.';
  }
  if (!line(stage)) return 'Укажи стадию матча для имени файла.';
  return '';
}
export function safeFilename(a, b, time, stage) {
  const error = validateMetadata(time, stage);
  if (error) throw new Error(error);
  const safe = value => {
    const clean = line(value).normalize('NFC')
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-');
    let result = '';
    for (const char of clean) {
      if (new TextEncoder().encode(result + char).length > 70) break;
      result += char;
    }
    return result.replace(/[. ]+$/g, '') || 'Матч';
  };
  return `${time.replace(':', '-')} _ ${safe(stage)} _ ${safe(a)} vs ${safe(b)}.json`;
}

function fitItem(item, x = 0, y = 0, width = 1920, height = 1080) {
  Object.assign(item, {
    rot: 0, align: 5,
    pos: { x, y },
    pos_rel: { x: (x - 960) / 540, y: (y - 540) / 540 },
    scale: { x: 1, y: 1 },
    scale_rel: { x: 1, y: 1 },
    scale_ref: { x: 1920, y: 1080 },
    bounds_type: 2, bounds_align: 0, bounds_crop: false,
    bounds: { x: width, y: height },
    bounds_rel: { x: width / 540, y: height / 540 },
    crop_left: 0, crop_right: 0, crop_top: 0, crop_bottom: 0
  });
}

export function buildObs(template, a, b, ka, kb,
                         uuidFn = () => crypto.randomUUID()) {
  const error = validateMatch(a, b, ka, kb);
  if (error) throw new Error(error);
  if (!Array.isArray(template?.sources)) {
    throw new Error('Некорректный шаблон OBS.');
  }
  const d = structuredClone(template);
  const byId = new Map(d.sources.map(s => [s.uuid, s]));
  const byName = new Map(d.sources.map(s => [s.name, s]));
  const used = new Set(), names = new Map();
  const players = [
    ...selectedPlayers(a, ka).map(p => ({ ...p, team: a.name })),
    ...selectedPlayers(b, kb).map(p => ({ ...p, team: b.name }))
  ];
  players.forEach((p, i) => {
    const scene = byName.get(`Игрок ${i + 1}`);
    if (scene?.id !== 'scene' ||
        !Array.isArray(scene.settings?.items)) {
      throw new Error(`В шаблоне отсутствует сцена игрока ${i + 1}.`);
    }
    const items = scene.settings.items.filter(it =>
      byId.get(it.source_uuid)?.id === 'browser_source'
    );
    if (items.length !== 1) {
      throw new Error('В сцене игрока должен быть ровно один источник браузера.');
    }
    const item = items[0];
    let browser = byId.get(item.source_uuid);
    if (used.has(browser.uuid)) {
      browser = structuredClone(browser);
      browser.uuid = uuidFn();
      browser.name = `Камера слота ${i + 1}`;
      d.sources.push(browser);
      byId.set(browser.uuid, browser);
    }
    used.add(browser.uuid);
    item.source_uuid = browser.uuid;
    item.name = browser.name;
    Object.assign(browser.settings, {
      url: viewUrl(p), width: 1920, height: 1080
    });
    names.set(browser.name,
      `CAM ${String(i + 1).padStart(2, '0')} | ${p.team} | ${p.nick}`);
    fitItem(item);
  });

  for (const item of byName.get('Матрица')?.settings?.items || []) {
    const scene = byId.get(item.source_uuid);
    const slot = /^Игрок (\d+)$/.exec(scene?.name || '');
    if (!slot) continue;
    const index = Number(slot[1]) - 1;
    if (index >= 0 && index < 8) {
      fitItem(item, (index % 4) * 480,
        Math.floor(index / 4) * 270, 480, 270);
    }
    if (index === 8 || index === 9) {
      fitItem(item, (index - 8) * 960, 540, 960, 540);
    }
  }

  const uuidMap = new Map(d.sources.map(s => [s.uuid, uuidFn()]));
  function remap(value) {
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value)
        .map(([k, v]) => [k, remap(v)]));
    }
    return typeof value === 'string' ?
      uuidMap.get(value) || names.get(value) || value : value;
  }
  d.name = `${a.name} vs ${b.name}`;
  d.resolution = { x: 1920, y: 1080 };
  return remap(d);
}

export const MAP_POOL = [
  'Ancient', 'Anubis', 'Cache', 'Dust2', 'Inferno', 'Mirage', 'Nuke'
];
export const VETO_RULES = {
  BO1: ['ban', 'ban', 'ban', 'ban', 'ban', 'ban'],
  BO2: ['ban', 'ban', 'ban', 'ban', 'ban', 'pick'],
  BO3: ['ban', 'ban', 'pick', 'pick', 'ban', 'ban'],
  BO5: ['ban', 'ban', 'pick', 'pick', 'pick', 'pick']
};

export function validateVeto(actions, format, first) {
  if (!Object.hasOwn(VETO_RULES, format) ||
      ![0, 1].includes(first) ||
      !Array.isArray(actions) || actions.length > 6) {
    throw new Error('Некорректное вето.');
  }
  const used = new Set();
  for (const [i, action] of actions.entries()) {
    if (!MAP_POOL.includes(action.map) || used.has(action.map) ||
        action.type !== VETO_RULES[format][i] ||
        action.team !== (first + i) % 2 ||
        (action.type === 'pick' &&
          !['CT', 'T'].includes(action.side))) {
      throw new Error('Нарушен порядок вето.');
    }
    used.add(action.map);
  }
  return MAP_POOL.filter(map => !used.has(map));
}
export function appendVeto(actions, format, first, map, side) {
  const available = validateVeto(actions, format, first);
  const type = VETO_RULES[format][actions.length];
  if (!type || !available.includes(map)) {
    throw new Error('Эта карта уже выбрана или вето завершено.');
  }
  const result = [...actions, {
    map, type, team: (first + actions.length) % 2,
    ...(type === 'pick' ? { side } : {})
  }];
  validateVeto(result, format, first);
  return result;
}
export function vetoText(teams, actions, format = 'BO3', first = 0) {
  const remaining = validateVeto(actions, format, first);
  if (teams.length !== 2 || !teams.every(t => line(t)) ||
      teams[0] === teams[1]) {
    throw new Error('Для вето нужны две разные команды.');
  }
  const lines = actions.map(action => action.type === 'ban' ?
    `${line(teams[action.team])} removed ${action.map}` :
    `${line(teams[action.team])} pick ${action.map} (${line(teams[1 - action.team])} ${action.side})`);
  if (actions.length === 6) lines.push(`${remaining[0]} was left over`);
  return lines.join('\n');
}
