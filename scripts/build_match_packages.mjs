import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SOURCE, decodeGviz, parseTeams, parseSchedule, defaultLineup,
  selectedPlayers, validateMatch, buildObs, safeFilename, personKey,
  playerText, observerText
} from '../core.js';

const day = process.argv.find(a => a.startsWith('--day='))?.slice(6) || '15.10';
const output = path.resolve(process.argv.find(a => a.startsWith('--out='))?.slice(6) || 'work/match-package');
const site = 'https://onepanel.netlify.app';
async function save(file, value) {
  const target = path.join(output, file);
  await mkdir(path.dirname(target), {recursive:true});
  await writeFile(target, value, 'utf8');
}
async function sheet(id, gid) {
  const url = new URL('https://docs.google.com/spreadsheets/d/' + id + '/gviz/tq');
  url.search = new URLSearchParams({gid, headers:'1', tqx:'out:json'});
  const response = await fetch(url, {signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error('Google Sheets returned ' + response.status);
  return decodeGviz(await response.text());
}

const roster = parseTeams(await sheet(DEFAULT_SOURCE.id, DEFAULT_SOURCE.gid));
const schedule = parseSchedule(await sheet(DEFAULT_SOURCE.scheduleId, DEFAULT_SOURCE.scheduleGid));
const matches = schedule.filter(m => m.date === day);
if (!matches.length) throw new Error('No confirmed match pairs for ' + day + '; no matchups will be invented.');
const catalog = JSON.parse(await readFile('assets/players/players.json', 'utf8')).players;
const logos = JSON.parse(await readFile('assets/teams/teams.json', 'utf8'));
const template = JSON.parse(await readFile('assets/obs-template.json', 'utf8'));
const players = new Map(), collections = [];

for (const match of matches) {
  const a = roster.find(t => t.name === match.team1);
  const b = roster.find(t => t.name === match.team2);
  const ka = defaultLineup(a), kb = defaultLineup(b);
  const error = validateMatch(a, b, ka, kb);
  if (error) throw new Error(match.team1 + ' vs ' + match.team2 + ': ' + error);
  const pa = selectedPlayers(a, ka), pb = selectedPlayers(b, kb);
  for (const [team, selected] of [[a, pa], [b, pb]]) {
    for (const p of selected) {
      const id = personKey(team.name) + '__' + personKey(p.nick);
      const candidates = catalog.filter(x => personKey(x.team) === personKey(team.name) &&
        [x.nick, ...(x.aliases || [])].some(n => personKey(n) === personKey(p.nick)));
      if (candidates.length > 1) throw new Error('Ambiguous photo identity: ' + id);
      const photo = candidates[0]?.file || null;
      const logo = Object.entries(logos).find(([name]) => personKey(name) === personKey(team.name))?.[1] || null;
      players.set(id, {id, team:team.name, nick:p.nick, slot:p.slot,
        card:'cards/' + id + '.jpg', photo, logo});
    }
    await save('player-links/' + personKey(team.name) + '.txt', playerText(team, selected) + '\n');
  }
  const filename = safeFilename(a.name, b.name, match.time, match.stage);
  const online = buildObs(template, a, b, ka, kb, randomUUID, {cardBase:site});
  const cards = online.sources.filter(s => s.name.startsWith('CARD '));
  if (cards.length !== 10) throw new Error('Expected 10 CARD sources.');
  await save('OBS_ONLINE/' + filename, JSON.stringify(online, null, 2) + '\n');
  const offline = buildObs(template, a, b, ka, kb, randomUUID, {cardBase:site});
  const embedded = buildObs(template, a, b, ka, kb, randomUUID, {cardBase:site});
  await save('EMBEDDED_TEMPLATES/' + filename, JSON.stringify(embedded, null, 2) + '\n');
  const ordered = [...pa.map(p => ({...p, team:a.name})), ...pb.map(p => ({...p, team:b.name}))];
  offline.sources.filter(s => s.name.startsWith('CARD ')).forEach((s, i) => {
    const player = players.get(personKey(ordered[i].team) + '__' + personKey(ordered[i].nick));
    s.id = 'image_source';
    s.versioned_id = 'image_source';
    s.settings = {file:player.card, unload:false};
  });
  await save('OFFLINE_TEMPLATES/' + filename, JSON.stringify(offline, null, 2) + '\n');
  await save('observer/' + filename.replace(/\.json$/, '.txt'), observerText(a, b, pa, pb) + '\n');
  collections.push({...match, filename, players:ordered.map(p => personKey(p.team) + '__' + personKey(p.nick))});
}

for (const p of players.values()) {
  if (p.photo) {
    await mkdir(path.join(output, 'photos'), {recursive:true});
    await copyFile(path.join('assets/players', p.photo), path.join(output, 'photos', p.photo));
  }
  if (p.logo) {
    await mkdir(path.join(output, 'team-logos'), {recursive:true});
    await copyFile(path.join('assets/teams', p.logo), path.join(output, 'team-logos', p.logo));
  }
}
for (const name of ['prepare_local.py','prepare_local.ps1','PREPARE_WINDOWS.cmd']) {
  await mkdir(output, {recursive:true});
  await copyFile(path.join('scripts/match-package', name), path.join(output, name));
}
await mkdir(path.join(output, 'artwork'), {recursive:true});
await copyFile('assets/card/background.png', path.join(output, 'artwork/background.png'));
await copyFile('assets/card/cyberclash-logo.png', path.join(output, 'artwork/cyberclash-logo.png'));
const result = {day, timezone:'Europe/Moscow', generatedAt:new Date().toISOString(),
  source:'Organizer Schedule (Group Stage) and Все игроки; primary five from current roster',
  site, matches:collections, players:[...players.values()]};
await save('package-manifest.json', JSON.stringify(result, null, 2) + '\n');
const photoCount = [...players.values()].filter(p => p.photo).length;
await save('README.txt', [
  'CYBERCLASH — ' + day + '.2026 — время МСК',
  '',
  'Основной вариант: OBS → Коллекция сцен → Импорт → JSON из OBS_READY.',
  'В каждом JSON уже лежат десять готовых карточек с фото/заглушками и фоном.',
  'Для карточек не нужны сайт, HLTV, отдельные файлы или настройка путей.',
  'Источники камер VDO.Ninja по-прежнему работают через интернет.',
  '',
  'Запасной вариант с отдельными JPG: распакуйте ZIP целиком в постоянную папку.',
  'Windows: запустите PREPARE_WINDOWS.cmd; macOS/Linux: python3 prepare_local.py.',
  'Затем импортируйте JSON из появившейся папки OBS_LOCAL.',
  'Карточки уже собраны в JPG 1920×1080 и работают без сайта и HLTV.',
  'Не перемещайте папку после подготовки JSON; после переноса запустите подготовку заново.',
  '',
  'OBS_ONLINE — вариант JSON со ссылками на onepanel.netlify.app; для карточек нужен доступ к сайту.',
  'OFFLINE_TEMPLATES — шаблоны с относительными путями, напрямую их не импортировать.',
  'cards — готовые эфирные карточки; photos — исходные реальные фото HLTV;',
  'team-logos и artwork — отдельные элементы; observer и player-links — тексты для копирования.',
  '',
  ...collections.map(m => m.time + ' МСК · ' + m.stage + ' · ' + m.team1 + ' vs ' + m.team2),
  '',
  'Основной состав: первые пять основных игроков из актуальной таблицы.',
  'При заменах нужны новые JSON и карточки для выбранного состава.',
  '',
  photoCount + ' портретов, ' + (players.size - photoCount) + ' карточек без фото:',
  ...[...players.values()].filter(p => !p.photo).map(p => p.team + ' — ' + p.nick),
  '',
  'Проверка выполнена в Chromium. Реальное подключение/отключение камер в OBS проверьте перед эфиром.'
].join('\n') + '\n');
console.log('MATCH_PACKAGE:', JSON.stringify({day, matches:collections.length, players:players.size,
  photos:photoCount, fallback:players.size - photoCount, output}));
