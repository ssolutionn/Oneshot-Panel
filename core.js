export const DEFAULT_SOURCE = {
  id: '1e__ijBjufD19SWBkSJL177vmmfMh2tdykYQHAS06S8I',
  gid: '1315978454',
  // Schedule (Group Stage) of the organizer's sheet: every day, by date.
  scheduleId: '1GtwcpVnyxY1YOs6ZTrXwJr5mjZqI0QxjLSKjimn9G2o',
  scheduleGid: '815739139',
  // Schedule (Playoffs), read together with the group stage (from 29.10).
  playoffsGid: '1212769715'
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
  // With headers=1 the header row comes back as column labels, so text
  // headers above time or number columns are not dropped as minority type.
  const labels = (result.table.cols || []).map(c => line(c?.label));
  const rows = result.table.rows.map(row => (row.c || []).map(c => line(c?.f ?? c?.v)));
  return labels.some(Boolean) ? [labels, ...rows] : rows;
}

// VDO.Ninja keeps only letters, digits and _ in a stream ID: everything
// else becomes "_" ("Q-Q" publishes as "Q_Q"). Links and the webcam status
// use the ID VDO.Ninja will really have.
export function vdoId(value) {
  return line(value).replace(/[\W]+/g, '_').slice(0, 64);
}

// A bad row (no room, a repeated ID) is skipped and reported in
// teams.skipped: one pasted stand-in must not take every roster down.
export function parseTeams(rows) {
  const teams = [], byName = new Map(), ids = new Set(), skipped = [];
  rows.forEach((row, index) => {
    const v = row.map(line);
    if (!v[0] || !v[1] || !v[3] ||
        !['Основной', 'Запасной', 'Тренер'].includes(v[8])) return;
    // L: the team's VDO.Ninja room password (sheet «Комнаты», column «Пароль»).
    const name = v[1], nick = v[3], id = vdoId(v[4] || nick), room = v[5], password = v[11] || '';
    if (!room) { skipped.push(`строка ${index + 1}: у ${nick} (${name}) не указана комната`); return; }
    if (ids.has(v[0])) { skipped.push(`строка ${index + 1}: повтор ID ${v[0]}`); return; }
    ids.add(v[0]);
    if (!byName.has(name)) {
      const team = { name, room, password, players: [], sourceRow: index + 1 };
      teams.push(team);
      byName.set(name, team);
    }
    byName.get(name).players.push({
      key: v[0], slot: v[2], nick, id, room, password,
      role: v[8], sourceRow: index + 1
    });
  });
  teams.skipped = skipped;
  if (!teams.length) {
    throw new Error('На листе не найден состав. Нужен лист «Все игроки»: ID, команда, слот, ник, ID потока, room, PUSH, VIEW, роль.');
  }
  return teams;
}

const TIME = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/;
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];
const PLAYOFF_STAGES = [
  [/^quarter-?finals?\b/i, 'Четвертьфинал'], [/^semi-?finals?\b/i, 'Полуфинал'],
  [/^3rd place/i, 'Матч за 3 место'], [/^grand final/i, 'Гранд-финал']
];

// The organizer's sheet ("Schedule (Group Stage)", "Schedule (Playoffs)")
// names its columns in a header row; each match row carries its own date.
function organizerColumns(v) {
  const find = test => v.findIndex(c => test(c.toLowerCase()));
  const cols = {
    stage: find(c => c === 'stage'), date: find(c => c === 'date'),
    time: find(c => c.startsWith('msk')),
    team1: find(c => c === 'team 1'), team2: find(c => c === 'team 2')
  };
  return Object.values(cols).every(i => i >= 0) ? cols : null;
}
function organizerDate(text) {
  const m = text.toLowerCase().match(/^([a-z]+)\s+(\d{1,2})$/);
  const month = m ? EN_MONTHS.indexOf(m[1]) : -1;
  return month < 0 ? '' :
    `${m[2].padStart(2, '0')}.${String(month + 1).padStart(2, '0')}`;
}
function organizerStage(text) {
  const group = text.match(/\b([A-H])\d+$/);
  if (group) return { group: group[1], stage: `Группа ${group[1]}` };
  const playoff = PLAYOFF_STAGES.find(([pattern]) => pattern.test(text));
  const number = text.match(/\s(\d+)$/)?.[1];
  return {
    group: '',
    stage: playoff ? playoff[1] + (number ? ` ${number}` : '') : text
  };
}
// "PRIVATE (ex-RUBY)" in the organizer's sheet is "PRIVATE" in the rosters.
const teamName = text => text.replace(/\s*\(ex-[^)]*\)\s*$/i, '');

// Two layouts: the organizer's sheet (found by its header row, dated rows)
// and a day sheet «Матчи ДД.ММ» (B time, C/D teams, E group; no dates).
export function parseSchedule(rows) {
  // The key names the match, not its row: a row inserted above it in the
  // sheet must not reset a veto in progress. Identical rows get a counter.
  const seen = new Map();
  let cols = null;
  return rows.flatMap(row => {
    const v = row.map(line);
    const header = organizerColumns(v);
    if (header) { cols = header; return []; }
    const match = cols ? {
      date: organizerDate(v[cols.date] || ''), time: v[cols.time] || '',
      team1: teamName(v[cols.team1] || ''), team2: teamName(v[cols.team2] || ''),
      ...organizerStage(v[cols.stage] || '')
    } : {
      date: '', time: v[1] || '', team1: v[2] || '', team2: v[3] || '',
      group: v[4] || '',
      stage: /^[A-H]$/.test(v[4] || '') ? `Группа ${v[4]}` : v[4] || ''
    };
    const time = match.time.match(TIME);
    if (!match.team1 || !match.team2 || !time || Number(time[1]) > 23) return [];
    match.time = `${time[1].padStart(2, '0')}:${time[2]}`;
    const fields = [match.date, match.time, match.team1, match.team2, match.stage];
    const id = JSON.stringify(fields);
    const repeat = seen.get(id) || 0;
    seen.set(id, repeat + 1);
    return [{ ...match, key: JSON.stringify([...fields, repeat]) }];
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
  // A seat's stream is its room and ID: a LAN's two rooms may both have a pc1
  // (REU: team1 and team2). Players from a table keep IDs unique across rooms.
  if (new Set([...pa, ...pb].map(p => p.seat ? `${p.room}/${p.id}` : p.id)).size !== 10) {
    return 'У каждого из десяти игроков должен быть свой ID видеопотока.';
  }
  return '';
}

// &transparent and &cleanoutput: until the player connects the camera shows
// nothing, so the player card under it (card.html) stays visible.
// A team's room password: without it VDO.Ninja finds none of the room's
// streams, so players of one team cannot open another team's cameras.
function roomPassword(x) {
  return x?.password ? `&password=${encodeURIComponent(x.password)}` : '';
}
export function viewUrl(p) {
  const codec = p.net?.mode === 'lan' ? vdoNet(p.net).codec : 'h264';
  return `https://vdo.ninja/?view=${encodeURIComponent(p.id)}&solo=1&room=${encodeURIComponent(p.room)}${roomPassword(p)}&codec=${codec}&cleanoutput&transparent${netQuery(p.net, 'view')}`;
}
export function pushUrl(p) {
  return `https://vdo.ninja/?room=${encodeURIComponent(p.room)}${roomPassword(p)}&broadcast&do&push=${encodeURIComponent(p.id)}${netQuery(p.net, 'push')}`;
}
// A LAN's VDO.Ninja tuning («Компы», mode «ЛАН»): the seats' PCs send 1080p or
// 720p at a set frame rate, OBS asks for a codec and bitrate; lowlatency drops
// the jitter buffer and audio processing on both ends, and with lanonly both
// ends use only local addresses (no relay over the internet; viewers off this
// network see nothing). Online: the links stay as they were.
export const VDO_NET_DEFAULT = { mode: 'online', quality: '1080', fps: 30, codec: 'h264', bitrate: 8000, lowlatency: true, lanonly: true };
export function vdoNet(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    mode: v.mode === 'lan' ? 'lan' : 'online',
    quality: v.quality === '720' ? '720' : '1080',
    fps: [24, 30, 60].includes(v.fps) ? v.fps : VDO_NET_DEFAULT.fps,
    codec: ['h264', 'vp8', 'vp9'].includes(v.codec) ? v.codec : VDO_NET_DEFAULT.codec,
    bitrate: Number.isInteger(v.bitrate) && v.bitrate >= 1000 && v.bitrate <= 50000 ? v.bitrate : VDO_NET_DEFAULT.bitrate,
    lowlatency: v.lowlatency !== false,
    lanonly: v.lanonly !== false
  };
}
function netQuery(net, side) {
  if (!net || net.mode !== 'lan') return '';
  const n = vdoNet(net);
  return (side === 'push' ? `&quality=${n.quality === '720' ? 1 : 0}&fps=${n.fps}` : `&videobitrate=${n.bitrate}`) +
    (n.lowlatency ? '&lowlatency' : '') + (n.lanonly ? '&lanonly' : '');
}
export function directorUrl(team) {
  return `https://vdo.ninja/?director=${encodeURIComponent(team.room)}${roomPassword(team)}`;
}
export const DEFAULT_CAMERA_FRAME = 'inner43';
export const CAMERA_FRAMES = {
  // Key kept for saved settings: fields 300 px left/right and 36 px top/bottom.
  inner43: { x:300, y:36, width:1320, height:1008 },
  full43: { x:240, y:0, width:1440, height:1080 },
  wide: { x:0, y:0, width:1920, height:1080 },
  // A square crop is centered on the 1920×1080 canvas. OBS can place this
  // source anywhere later without stretching it.
  square: { x:420, y:0, width:1080, height:1080 },
  // The same frames with the camera 20 px larger on every side: a margin past
  // the frame's edge, so a webcam that does not quite fill it shows no stripes.
  inner43_over20: { x:280, y:16, width:1360, height:1048 },
  full43_over20: { x:220, y:-20, width:1480, height:1120 },
  wide_over20: { x:-20, y:-20, width:1960, height:1120 },
  square_over20: { x:400, y:-20, width:1120, height:1120 },
  // The whole canvas, but the video keeps its own proportions: it reaches the
  // top and bottom edges, a 4:3 webcam leaves the sides empty. Nothing is cut.
  height: { x:0, y:0, width:1920, height:1080, fit:'contain' }
};
const fitOf = frame => cameraFrame(frame).fit === 'contain' ? 'contain' : 'cover';
export function cameraFrame(value = DEFAULT_CAMERA_FRAME) {
  return { ...CAMERA_FRAMES[typeof value==='string' && Object.hasOwn(CAMERA_FRAMES,value) ? value : DEFAULT_CAMERA_FRAME] };
}
export function normalizeCamera(value) {
  const percent = number => Number.isFinite(number) ? Math.max(0,Math.min(100,number)) : 50;
  return {rotation:[0,90,180,270].includes(value?.rotation) ? value.rotation : 0,
    panX:percent(value?.panX),panY:percent(value?.panY),
    zoom:Number.isFinite(value?.zoom) ? Math.round(Math.max(1,Math.min(3,value.zoom))*100)/100 : 1};
}
// VDO's supported cover/base64css URL options and style iframe message use
// this same CSS. Only normalized numbers enter it. Pan follows screen axes
// after rotation, rather than making "left" move up on a sideways camera.
export function cameraCss(value, fit = 'cover') {
  const c=normalizeCamera(value);
  let x=c.panX,y=c.panY;
  if(c.rotation===90)[x,y]=[y,100-x];
  else if(c.rotation===180)[x,y]=[100-x,100-y];
  else if(c.rotation===270)[x,y]=[100-y,x];
  return 'html,body{background:transparent!important;}video{object-fit:'+(fit==='contain' ? 'contain' : 'cover')+'!important;object-position:'+x+'% '+y+'%!important;scale:'+c.zoom+'!important;transform-origin:'+x+'% '+y+'%!important;}';
}
// &scale=100: VDO.Ninja asks for the camera's full resolution instead of one
// sized to the page, which in OBS could come out lower for some sources.
export function cameraViewUrl(player, frame = DEFAULT_CAMERA_FRAME) {
  const c=normalizeCamera(player?.camera),fit=fitOf(frame);
  return viewUrl(player)+(fit==='cover' ? '&cover' : '')+'&scale=100'+(c.panX===50 && c.panY===50 && c.zoom===1 ? '' :
    '&b64css='+encodeURIComponent(btoa(cameraCss(c,fit))));
}
export function cameraGeometry(player, frame = DEFAULT_CAMERA_FRAME) {
  const rect=cameraFrame(frame),{rotation}=normalizeCamera(player?.camera);
  const quarter=rotation===90 || rotation===270;
  if (frame === 'square') return {
    rotation,
    x: rect.x + (rotation === 90 || rotation === 180 ? rect.width : 0),
    y: rect.y + (rotation === 180 || rotation === 270 ? rect.height : 0),
    width: rect.width, height: rect.height
  };
  return {rotation,
    x:rect.x+(rotation===90 || rotation===180 ? rect.width : 0),
    y:rect.y+(rotation===180 || rotation===270 ? rect.height : 0),
    width:quarter ? rect.height : rect.width,
    height:quarter ? rect.width : rect.height};
}
// A fresh stream ID for one player when their link leaked: nick letters
// (VDO.Ninja keeps only letters, digits and _) plus 6 random characters.
export function newStreamId(nick, random = n => crypto.getRandomValues(new Uint8Array(n))) {
  const base = line(nick).normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'cam';
  const tail = [...random(6)].map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  return `${base}_${tail}`;
}
// New IDs live in the browser until someone writes them into the sheet
// (column E). saved: { [player.key]: { id, was, manual? } } — manual: the ID
// the player really joined with, typed by hand. An entry counts only
// while the sheet still has the ID it replaced; once the sheet holds the
// new ID, or anything else, the sheet wins and the entry is dropped.
export function applyStreamIds(teams, saved) {
  const kept = {};
  const entries = saved && typeof saved === 'object' ? saved : {};
  const result = teams.map(team => ({
    ...team,
    players: team.players.map(p => {
      const entry = Object.hasOwn(entries, p.key) ? entries[p.key] : null;
      if (!entry || typeof entry.id !== 'string' || !/^\w{1,64}$/.test(entry.id) ||
          entry.was !== p.id || entry.id === p.id) return p;
      kept[p.key] = { id: entry.id, was: entry.was, ...(entry.manual ? { manual: true } : {}) };
      return { ...p, id: entry.id, sheetId: p.id, ...(entry.manual ? { manualId: true } : {}) };
    })
  }));
  return { teams: result, saved: kept };
}
// LAN: no sheets, and a camera belongs to a seat (one PC), not to a player.
// Seat streams are fixed for the whole event: <prefix>a1…a5 for the first
// team's seats, <prefix>b1…b5 for the second's; the room is the prefix. Or the
// event names its own (`cams`): a room per side and the PCs' stream IDs, the
// same in both rooms (REU: rooms team1 and team2, PCs pc1…pc5).
// Teams are typed by hand, one per line: «Команда: ник1, ник2, …». The
// first five nicks play, the rest are substitutes.
export const LAN_SEATS = 5;
// The event's own look: a name (captain links, texts) and three colours for the
// cards; empty = the CyberClash defaults of the card page.
const HEX6 = /^#[0-9a-f]{6}$/i;
export function eventProfile(value) {
  const v = value && typeof value === 'object' ? value : {};
  const color = x => typeof x === 'string' && HEX6.test(x) ? x.toLowerCase() : '';
  return {
    name: typeof v.name === 'string' ? line(v.name).slice(0, 60) : '',
    accent: color(v.accent), deep: color(v.deep), black: color(v.black)
  };
}
// The event's data, edited on the panel. Teams and players keep a stable id, so
// a renamed team keeps its logo, photos and lineups. Older versions kept the
// teams as text («Команда: ник1, ник2, …»); that text becomes teams once.
const LAN_ID = /^[a-z0-9]{1,16}$/;
export const LAN_LIMITS = Object.freeze({ teams: 32, players: 12, matches: 40 });
export const MATCH_FORMATS = ['BO1', 'BO2', 'BO3', 'BO5'];
function lanTeamsOf(value) {
  const ids = new Set();
  const fresh = id => typeof id === 'string' && LAN_ID.test(id) && !ids.has(id) && Boolean(ids.add(id));
  return (Array.isArray(value) ? value : []).filter(t => t && typeof t === 'object' && fresh(t.id))
    .slice(0, LAN_LIMITS.teams).map(t => ({
      id: t.id, name: typeof t.name === 'string' ? line(t.name).slice(0, 60) : '',
      players: (Array.isArray(t.players) ? t.players : []).filter(p => p && typeof p === 'object' && fresh(p.id))
        .slice(0, LAN_LIMITS.players).map(p => ({ id: p.id, nick: typeof p.nick === 'string' ? line(p.nick).slice(0, 40) : '' }))
    }));
}
function lanMatchesOf(value, teams) {
  const teamIds = new Set(teams.map(t => t.id)), ids = new Set();
  return (Array.isArray(value) ? value : []).filter(m => m && typeof m === 'object' &&
    typeof m.id === 'string' && LAN_ID.test(m.id) && !ids.has(m.id) && Boolean(ids.add(m.id)))
    .slice(0, LAN_LIMITS.matches).map(m => ({
      id: m.id,
      time: typeof m.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(m.time) ? m.time : '',
      stage: typeof m.stage === 'string' ? line(m.stage).slice(0, 100) : '',
      a: teamIds.has(m.a) ? m.a : '', b: teamIds.has(m.b) && m.b !== m.a ? m.b : '',
      format: MATCH_FORMATS.includes(m.format) ? m.format : 'BO3'
    }));
}
// The old text roster as teams, with ids t1, t1p1… (nothing typed: none).
function teamsFromText(text) {
  try {
    return parseLanRoster(text).map((team, i) => ({
      id: `t${i + 1}`, name: team.name, players: team.players.map((p, j) => ({ id: `t${i + 1}p${j + 1}`, nick: p.nick }))
    }));
  } catch { return []; }
}
// Rooms and stream IDs as VDO.Ninja keeps them: letters, digits and _.
export const VDO_NAME = /^[A-Za-z0-9_]{1,40}$/;
// The event's own rooms and PCs, or null (then the prefix makes them): two
// different rooms, five different PCs, a password per room (may be empty).
// The second room's PCs (idsB) may have their own names; none = the same.
export function lanCams(value) {
  const v = value && typeof value === 'object' ? value : {};
  const names = (list, size) => Array.isArray(list) && list.length === size && list.every(x => typeof x === 'string' && VDO_NAME.test(x)) &&
    new Set(list).size === size ? [...list] : null;
  const rooms = names(v.rooms, 2), ids = names(v.ids, LAN_SEATS), idsB = names(v.idsB, LAN_SEATS);
  if (!rooms || !ids) return null;
  const passwords = [0, 1].map(i => typeof v.passwords?.[i] === 'string' ? line(v.passwords[i]).slice(0, 40) : '');
  return { rooms, ids, ...(idsB && idsB.join() !== ids.join() ? { idsB } : {}), passwords };
}
// A room typed or pasted: its name, or a VDO.Ninja link (a director's, a
// guest's) with the room and, when there is one, its password.
export function vdoRoomOf(text) {
  const value = line(text);
  if (VDO_NAME.test(value)) return { room: value, password: null };
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || !/(^|\.)vdo\.ninja$/.test(url.hostname)) return null;
  const q = url.searchParams, room = q.get('director') || q.get('dir') || q.get('room') || q.get('r') || '';
  if (!VDO_NAME.test(room)) return null;
  const password = q.get('password') ?? q.get('pw') ?? q.get('p');
  return { room, password: password === null ? null : line(password).slice(0, 40) };
}
export function lanConfig(value) {
  const v = value && typeof value === 'object' ? value : {};
  const prefix = typeof v.prefix === 'string' && /^[a-z0-9]{2,12}$/.test(v.prefix) ? v.prefix : '';
  const password = typeof v.password === 'string' ? line(v.password).slice(0, 40) : '';
  const teams = Array.isArray(v.teams) ? lanTeamsOf(v.teams) : lanTeamsOf(teamsFromText(typeof v.text === 'string' ? v.text.slice(0, 20000) : ''));
  return { on: v.on === true && Boolean(prefix), prefix, password, cams: lanCams(v.cams), net: vdoNet(v.net), teams, matches: lanMatchesOf(v.matches, teams), event: eventProfile(v.event) };
}
// A new id for a team, player or match; random bytes from the caller.
export function lanId(bytes, taken = []) {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  const id = 'x' + Array.from(bytes, b => letters[b % letters.length]).join('').slice(0, 10);
  return taken.includes(id) ? id + taken.length.toString(36) : id;
}
// Short and easy to type by hand on a seat's PC: no 0/o, 1/l/i look-alikes.
export function newLanPrefix(bytes) {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(bytes, b => letters[b % letters.length]).join('').slice(0, 12).padEnd(2, 'a');
}
// The teams as the panel uses them (like parseTeams for the sheets): a team
// without a name and a player without a nick are not ready yet; a name already
// taken is skipped. Keys use the ids, so renaming changes no lineup. «Taken»
// is by personKey, as cards are (cardKey): «a.b» and «ab» would share a card.
export function lanTeams(lan) {
  const teams = [], skipped = [], names = new Set();
  for (const team of lan.teams) {
    if (!team.name) continue;
    const key = personKey(team.name);
    if (!key) { skipped.push(`команда ${team.name}: в названии нужны буквы или цифры`); continue; }
    if (names.has(key)) { skipped.push(`команда ${team.name} уже есть`); continue; }
    names.add(key);
    const nicks = new Set(), players = [];
    for (const p of team.players) {
      if (!p.nick) continue;
      const nick = personKey(p.nick);
      if (!nick) { skipped.push(`${team.name}: в нике ${p.nick} нужны буквы или цифры`); continue; }
      if (nicks.has(nick)) { skipped.push(`${team.name}: ник ${p.nick} повторяется`); continue; }
      nicks.add(nick);
      players.push({
        key: JSON.stringify(['lan', team.id, p.id]), playerId: p.id, slot: '', nick: p.nick, id: '', room: '', password: '',
        role: players.length < LAN_SEATS ? 'Основной' : 'Запасной'
      });
    }
    teams.push({ name: team.name, teamId: team.id, room: '', password: '', players });
  }
  teams.skipped = skipped;
  return teams;
}
// The event's matches in the shape of the sheets schedule (the match picker
// takes both); a match waits until both of its teams are chosen.
export function lanSchedule(lan) {
  const name = Object.fromEntries(lan.teams.map(t => [t.id, t.name]));
  return lan.matches.filter(m => name[m.a] && name[m.b]).map(m => ({
    date: '', time: m.time, team1: name[m.a], team2: name[m.b], stage: m.stage, format: m.format,
    matchId: m.id, key: JSON.stringify(['lan-match', m.id])
  }));
}
export function parseLanRoster(text) {
  const teams = [], skipped = [], names = new Set();
  String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
    const row = line(raw);
    if (!row || row.startsWith('#')) return;
    const at = row.indexOf(':');
    const name = at > 0 ? line(row.slice(0, at)) : '';
    const nicks = at > 0 ? row.slice(at + 1).split(',').map(line).filter(Boolean) : [];
    if (!name || !nicks.length) {
      skipped.push(`строка ${index + 1}: нужно «Команда: ник1, ник2, …»`);
      return;
    }
    if (name.length > 60 || names.has(name.toLowerCase())) {
      skipped.push(`строка ${index + 1}: ${name.length > 60 ? 'слишком длинное название' : `команда ${name} уже есть`}`);
      return;
    }
    names.add(name.toLowerCase());
    const seen = new Set(), players = [];
    for (const nick of nicks) {
      if (nick.length > 40 || seen.has(nick.toLowerCase())) {
        skipped.push(`${name}: ${nick.length > 40 ? 'слишком длинный ник' : `ник ${nick} повторяется`}`);
        continue;
      }
      seen.add(nick.toLowerCase());
      players.push({
        key: JSON.stringify(['lan', name, nick]), slot: '', nick, id: '', room: '', password: '',
        role: players.length < LAN_SEATS ? 'Основной' : 'Запасной', sourceRow: index + 1
      });
    }
    teams.push({ name, room: '', password: '', players, sourceRow: index + 1 });
  });
  teams.skipped = skipped;
  if (!teams.length) throw new Error('Добавь команды в окне «ЛАН»: одна строка — «Команда: ник1, ник2, …».');
  return teams;
}
export function lanSeatId(prefix, side, index) {
  return vdoId(`${prefix}${side}${index + 1}`);
}
// Where seat `index` of a side streams: its room, the room's password, its ID.
export function lanSeat(lan, side, index) {
  const s = side === 'b' ? 1 : 0;
  const net = lan.net?.mode === 'lan' ? { net: vdoNet(lan.net) } : {};
  if (lan.cams) return { room: lan.cams.rooms[s], password: lan.cams.passwords[s], id: (s && lan.cams.idsB || lan.cams.ids)[index], ...net };
  return { room: lan.prefix, password: lan.password || '', id: lanSeatId(lan.prefix, side, index), ...net };
}
// The team as it sits this match: players picked for its seats get that
// seat's stream; everyone else has none.
export function seatTeam(team, side, keys, lan) {
  if (!team) return team;
  const { room, password } = lanSeat(lan, side, 0);
  return {
    ...team, room, password,
    players: team.players.map(p => {
      const i = keys.indexOf(p.key);
      return i >= 0 && i < LAN_SEATS ?
        { ...p, ...lanSeat(lan, side, i), seat: `${side.toUpperCase()}${i + 1}` } :
        { ...p, id: '', room, password, seat: '' };
    })
  };
}
// The ten links to open once on the seats' PCs.
export function lanSeatLinks(lan) {
  return ['a', 'b'].flatMap(side => Array.from({ length: LAN_SEATS }, (_, i) => {
    const seat = lanSeat(lan, side, i);
    return { seat: `${side.toUpperCase()}${i + 1}`, ...seat, push: pushUrl(seat), view: viewUrl(seat) };
  }));
}

// The card page lives on the panel's own site; the artifact has no site of
// its own, so its JSON points at the public panel.
export const DEFAULT_CARD_BASE = 'https://oneshot-panel.pages.dev';
export function cardUrl(p, base = DEFAULT_CARD_BASE) {
  const url = new URL('/card.html', base);
  url.searchParams.set('team', line(p.team));
  url.searchParams.set('nick', line(p.nick));
  return url.href;
}
// Matches a roster nick or team to assets/players and assets/teams:
// case, spaces and punctuation do not count ("Nuclear TigeRES" = "nuclear-tigeres").
export function personKey(value) {
  return line(value).normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
// One card per player of a match: the key of a ready-made card page (LAN).
export const cardKey = (team, nick) => personKey(team) + '|' + personKey(nick);
// A ready card is only ever a data: page; anything else in its place is ignored.
// A card page that shows nothing (an OBS browser source is transparent): the
// card of a seat whose side has no placeholder while the other side has one.
export const BLANK_CARD = 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>-</title>');
export const readyCard = (docs, key) => {
  const doc = docs?.[key];
  return typeof doc === 'string' && doc.startsWith('data:text/html;charset=utf-8,') ? doc : '';
};
// card.js and scripts/build_match_packages.mjs pick the same files.
// A file name from the catalogs never leaves its assets folder.
const assetFile = file =>
  typeof file === 'string' && /^[\w.-]+\.(png|jpe?g|webp)$/i.test(file);
// Entries of assets/players/players.json for one player: nick or alias, in the
// same team when one is given. Identity comes before file availability: a
// namesake in another team never supplies a photo when this one has none.
export function photoMatches(players, team, nick) {
  const key = personKey(nick);
  if (!key || !Array.isArray(players)) return [];
  return players.filter(p => p && typeof p === 'object' &&
    (!line(team) || personKey(p.team) === personKey(team)) &&
    [p.nick, ...(Array.isArray(p.aliases) ? p.aliases : [])]
      .some(name => personKey(name) === key));
}
export function playerPhoto(players, team, nick) {
  const matches = photoMatches(players, team, nick);
  return matches.length === 1 && assetFile(matches[0].file) ? matches[0].file : '';
}
// assets/teams/teams.json maps a team name to its logo file.
export function teamLogo(logos, team) {
  if (!logos || typeof logos !== 'object') return '';
  const found = Object.entries(logos).find(([name, file]) =>
    personKey(name) === personKey(team) && assetFile(file));
  return found ? found[1] : '';
}
// The team's HLTV page (assets/teams/hltv.json: name → URL); only
// https://www.hltv.org/team/<id>/<slug> addresses are taken.
export function teamHltv(pages, team) {
  if (!pages || typeof pages !== 'object') return '';
  // Accents do not count either here: «Honved» finds «Honvéd».
  const key = value => personKey(String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, ''));
  const found = Object.entries(pages).find(([name, url]) => key(name) === key(team) &&
    typeof url === 'string' && /^https:\/\/www\.hltv\.org\/team\/\d+\/[a-z0-9-]+$/.test(url));
  return found ? found[1] : '';
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
// One player's line, the same as in the team text: for a direct message.
export function playerLine(p) {
  return `**${markdown(p.nick)}** ${pushUrl(p)}`;
}
export function playerText(team, players) {
  return `## ${markdown(team.name)}\nOpen your link and turn on your camera.\n\n` +
    players.filter(Boolean).map(playerLine).join('\n');
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
  // No spaces: parts are joined by "_", spaces inside a part become "-".
  const safe = value => {
    const clean = line(value).normalize('NFC')
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
      .replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+/, '');
    let result = '';
    for (const char of clean) {
      if (new TextEncoder().encode(result + char).length > 70) break;
      result += char;
    }
    return result.replace(/[-.]+$/g, '') || 'Матч';
  };
  return `${time.replace(':', '-')}_${safe(stage)}_${safe(a)}_vs_${safe(b)}.json`;
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

function sceneUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID is absent in some embedded browsers and HTTP LAN previews;
  // getRandomValues is available there and still produces a proper v4 UUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
export function buildObs(template, a, b, ka, kb,
                         uuidFn = sceneUuid,
                         { cardBase = DEFAULT_CARD_BASE, includeCards = false, cameraFrame: frame = DEFAULT_CAMERA_FRAME, cardDocs = {} } = {}) {
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
    const cardSource = includeCards ? structuredClone(byId.get(item.source_uuid)) : null;
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
    const geometry=cameraGeometry(p,frame);
    Object.assign(browser.settings, {
      url: cameraViewUrl(p,frame), width:geometry.width, height:geometry.height
    });
    const slot = String(i + 1).padStart(2, '0');
    names.set(browser.name, `CAM ${slot} | ${p.team} | ${p.nick}`);
    fitItem(item,geometry.x,geometry.y,geometry.width,geometry.height);
    item.rot=geometry.rotation;

    if (includeCards) {
      // The player card sits right under the camera: it is seen whenever
      // VDO.Ninja has no video (not connected yet, or dropped).
      // A ready page (a LAN card, a placeholder) is made the frame's size, so it
      // fills the frame; the site's card page stays 1920×1080 inside it.
      const doc = readyCard(cardDocs, cardKey(p.team, p.nick)), area = cameraFrame(frame);
      Object.assign(cardSource, {
        uuid: uuidFn(), name: `CARD ${slot} | ${p.team} | ${p.nick}`,
        settings: { url: doc || cardUrl(p, cardBase), width: doc ? area.width : 1920, height: doc ? area.height : 1080 },
        muted: true
      });
      d.sources.push(cardSource);
      byId.set(cardSource.uuid, cardSource);
      const cardItem = {
        ...structuredClone(item), name: cardSource.name,
        source_uuid: cardSource.uuid, visible: true,
        id: Math.max(...scene.settings.items.map(it => Number(it.id) || 0)) + 1
      };
      const rect=cameraFrame(frame);
      fitItem(cardItem,rect.x,rect.y,rect.width,rect.height);
      scene.settings.items.splice(scene.settings.items.indexOf(item), 0, cardItem);
    }
  });

  const matrix = byName.get('Матрица');
  if (matrix?.id !== 'scene' || !Array.isArray(matrix.settings?.items)) {
    throw new Error('В шаблоне отсутствует сцена «Матрица».');
  }
  for (const item of matrix.settings.items) {
    const scene = byId.get(item.source_uuid);
    const slot = /^Игрок (\d+)$/.exec(scene?.name || '');
    if (!slot) continue;
    const tile = matrixTile(Number(slot[1]) - 1);
    if (tile) fitItem(item, tile.x, tile.y, tile.width, tile.height);
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

// «Матрица»: 1–8 in a 480×270 grid on top; 9 and 10 the same size, each in the
// middle of the bottom half it used to fill (a larger 9 and 10 looked like a
// zoom when the picture switched to them).
export function matrixTile(index) {
  if (!Number.isInteger(index) || index < 0 || index > 9) return null;
  return index < 8 ? { x: (index % 4) * 480, y: Math.floor(index / 4) * 270, width: 480, height: 270 } :
    { x: 240 + (index - 8) * 960, y: 675, width: 480, height: 270 };
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
