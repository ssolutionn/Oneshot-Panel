import { readFile, writeFile, mkdir, copyFile, mkdtemp, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SOURCE, decodeGviz, parseTeams, parseSchedule, defaultLineup,
  selectedPlayers, validateMatch, buildObs, safeFilename, personKey,
  playerText, observerText, photoMatches, playerPhoto, teamLogo
} from '../core.js';

const site = 'https://onepanel.netlify.app';
async function sheet(id, gid) {
  const url = new URL('https://docs.google.com/spreadsheets/d/' + id + '/gviz/tq');
  url.search = new URLSearchParams({gid, headers:'1', tqx:'out:json'});
  const response = await fetch(url, {signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error('Google Sheets returned ' + response.status);
  return decodeGviz(await response.text());
}

// Sheet row IDs stay distinct when display names differ only in punctuation.
// A digest also prevents roster keys from becoming path components.
const playerId = player => 'player-' + createHash('sha256').update(player.key, 'utf8').digest('hex');

// Remove only files owned by a prior successful package. In particular, never
// recursively remove --out or its subdirectories: operators may keep notes there.
function packageFiles(manifest) {
  const invalid = () => { throw new Error('Invalid previous package manifest; use a fresh output directory.'); };
  if (!Array.isArray(manifest?.matches) || !manifest.matches.length ||
      !Array.isArray(manifest.players)) invalid();
  const files = new Set([
    'package-manifest.json', 'README.txt', 'verification.json',
    'prepare_local.py', 'prepare_local.ps1', 'PREPARE_WINDOWS.cmd',
    'artwork/background.jpg', 'artwork/cyberclash-logo.png', 'OBS_READY/README-OBS.txt'
  ]);
  for (const match of manifest.matches) {
    if (typeof match?.filename !== 'string' ||
        match.filename !== safeFilename(match.team1, match.team2, match.time, match.stage)) invalid();
    for (const folder of ['OBS_ONLINE', 'OFFLINE_TEMPLATES', 'EMBEDDED_TEMPLATES', 'OBS_READY', 'OBS_LOCAL']) {
      files.add(folder + '/' + match.filename);
    }
    files.add('observer/' + match.filename.replace(/\.json$/, '.txt'));
    files.add('previews/' + match.filename.replace(/\.json$/, '.jpg'));
  }
  const image = name => typeof name === 'string' && /^[\w.-]+\.(png|jpe?g|webp)$/i.test(name);
  for (const player of manifest.players) {
    if (typeof player?.id !== 'string' || !/^[\p{L}\p{N}_-]+$/u.test(player.id) ||
        player.card !== 'cards/' + player.id + '.jpg' || typeof player.team !== 'string') invalid();
    files.add(player.card);
    const team = personKey(player.team);
    if (!team) invalid();
    files.add('player-links/' + team + '.txt');
    if (player.photo) {
      if (!image(player.photo)) invalid();
      files.add('photos/' + player.photo);
    }
    if (player.logo) {
      if (!image(player.logo)) invalid();
      files.add('team-logos/' + player.logo);
    }
  }
  return files;
}

async function publishPackage(destination, staging, generated) {
  let previous;
  try {
    previous = JSON.parse(await readFile(path.join(destination, 'package-manifest.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Validate the whole ownership list before touching an existing package.
  const previousFiles = previous ? packageFiles(previous) : [];
  // Parent directory symlinks must not redirect cleanup or writes outside --out.
  const checked = new Set();
  for (const file of [...previousFiles, ...generated]) {
    for (const relative of [path.dirname(file), file]) {
      if (relative === '.' || checked.has(relative)) continue;
      checked.add(relative);
      try {
        if ((await lstat(path.join(destination, relative))).isSymbolicLink()) {
          throw new Error('Package output contains a symbolic link: ' + relative);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  await mkdir(destination, {recursive:true});
  for (const file of previousFiles) await rm(path.join(destination, file), {force:true});
  for (const file of generated) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), {recursive:true});
    await copyFile(path.join(staging, file), target);
  }
}

export async function buildMatchPackage({
  day = '15.10', output = 'work/match-package', loadSheet = sheet
} = {}) {
  const destination = path.resolve(output);
  await mkdir(path.dirname(destination), {recursive:true});
  const staging = await mkdtemp(path.join(path.dirname(destination), '.oneshot-match-package-'));
  const generated = new Set();
  async function save(file, value) {
    const target = path.join(staging, file);
    await mkdir(path.dirname(target), {recursive:true});
    await writeFile(target, value, 'utf8');
    generated.add(file);
  }
  async function copy(source, file) {
    const target = path.join(staging, file);
    await mkdir(path.dirname(target), {recursive:true});
    await copyFile(source, target);
    generated.add(file);
  }
  try {
    const roster = parseTeams(await loadSheet(DEFAULT_SOURCE.id, DEFAULT_SOURCE.gid));
    const schedule = parseSchedule(await loadSheet(DEFAULT_SOURCE.scheduleId, DEFAULT_SOURCE.scheduleGid));
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
          const id = playerId(p);
          // Same matching as card.js, so the rendered card shows exactly this photo.
          if (photoMatches(catalog, team.name, p.nick).length > 1) throw new Error('Ambiguous photo identity: ' + id);
          const photo = playerPhoto(catalog, team.name, p.nick) || null;
          const logo = teamLogo(logos, team.name) || null;
          players.set(id, {id, team:team.name, nick:p.nick, slot:p.slot,
            card:'cards/' + id + '.jpg', photo, logo});
        }
        await save('player-links/' + personKey(team.name) + '.txt', playerText(team, selected) + '\n');
      }
      const filename = safeFilename(a.name, b.name, match.time, match.stage);
      const online = buildObs(template, a, b, ka, kb, randomUUID, {cardBase:site, includeCards:true});
      const cards = online.sources.filter(s => s.name.startsWith('CARD '));
      if (cards.length !== 10) throw new Error('Expected 10 CARD sources.');
      await save('OBS_ONLINE/' + filename, JSON.stringify(online, null, 2) + '\n');
      const offline = buildObs(template, a, b, ka, kb, randomUUID, {cardBase:site, includeCards:true});
      const embedded = buildObs(template, a, b, ka, kb, randomUUID, {cardBase:site, includeCards:true});
      await save('EMBEDDED_TEMPLATES/' + filename, JSON.stringify(embedded, null, 2) + '\n');
      const ordered = [...pa.map(p => ({...p, team:a.name})), ...pb.map(p => ({...p, team:b.name}))];
      offline.sources.filter(s => s.name.startsWith('CARD ')).forEach((s, i) => {
        const player = players.get(playerId(ordered[i]));
        s.id = 'image_source';
        s.versioned_id = 'image_source';
        s.settings = {file:player.card, unload:false};
      });
      await save('OFFLINE_TEMPLATES/' + filename, JSON.stringify(offline, null, 2) + '\n');
      await save('observer/' + filename.replace(/\.json$/, '.txt'), observerText(a, b, pa, pb) + '\n');
      collections.push({...match, filename, players:ordered.map(playerId)});
    }

    for (const p of players.values()) {
      if (p.photo) await copy(path.join('assets/players', p.photo), 'photos/' + p.photo);
      if (p.logo) await copy(path.join('assets/teams', p.logo), 'team-logos/' + p.logo);
    }
    for (const name of ['prepare_local.py','prepare_local.ps1','PREPARE_WINDOWS.cmd']) {
      await copy(path.join('scripts/match-package', name), name);
    }
    await copy('assets/card/background.jpg', 'artwork/background.jpg');
    await copy('assets/card/cyberclash-logo.png', 'artwork/cyberclash-logo.png');
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
    await publishPackage(destination, staging, generated);
    return result;
  } finally {
    await rm(staging, {recursive:true, force:true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const day = process.argv.find(a => a.startsWith('--day='))?.slice(6) || '15.10';
  const output = process.argv.find(a => a.startsWith('--out='))?.slice(6) || 'work/match-package';
  const result = await buildMatchPackage({day, output});
  const photos = result.players.filter(p => p.photo).length;
  console.log('MATCH_PACKAGE:', JSON.stringify({day, matches:result.matches.length,
    players:result.players.length, photos, fallback:result.players.length - photos,
    output:path.resolve(output)}));
}
