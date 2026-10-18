#!/usr/bin/env python3
"""Build claude-artifact/oneshot-panel.html from the web panel sources.

The web panel (index.html, style.css, core.js, app.js) stays the source of
truth. This script inlines it into one Claude artifact page and swaps only
what the artifact sandbox does not allow:
  - Google Sheets gviz fetch  -> Google Drive connector (xlsx + SheetJS),
    latest sheets cached in the artifact store for the whole crew;
  - <a download>              -> downloads capability, then a normal download;
                                 copying is only a visible backup button;
  - confirm()                 -> two-step reset button;
  - logos                     -> inline data URIs, other /assets paths relative.
Run from the repository root:
  python3 claude-artifact/build_oneshot_artifact.py [--snapshot sheets.json]
--snapshot embeds the last synced sheets (the artifact's panel/sheets
document) so viewers outside the claude.ai viewer still see rosters. That
build goes to claude-artifact/dist/ (git-ignored: the repository is public
and the snapshot holds rosters, rooms and stream IDs).
"""
import base64
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "claude-artifact" / "oneshot-panel.html"


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise SystemExit(f"anchor not found exactly once: {old[:60]!r}")
    return text.replace(old, new)


def cut(text, start, end, new):
    a = text.index(start)
    b = text.index(end, a)
    return text[:a] + new + text[b:]


# ---------- CSS ----------
css = (ROOT / "style.css").read_text(encoding="utf-8")
# Safe areas belong to the artifact wrapper; avoid depending on CSS formatting.
css += ("body{padding-left:env(safe-area-inset-left,0px);"
        "padding-right:env(safe-area-inset-right,0px)}"
        ".toast{bottom:calc(24px + env(safe-area-inset-bottom,0px))}"
        "footer{padding-bottom:max(20px,env(safe-area-inset-bottom,0px))}")
css += ("#pasteArea{min-height:140px}"
        ".artifact-download-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}"
        ".download-note{color:var(--warn-ink)!important;background:var(--warn);border:1px solid var(--warn-line);"
        "border-radius:4px;padding:8px 10px;line-height:1.6}"
        "@media(max-width:800px){.artifact-download-actions .button{flex:1}.artifact-download-actions{grid-column:1/-1}}"
        ".dialog-section{border-top:1px solid var(--line);margin-top:22px}\n")

# ---------- markup ----------
html = (ROOT / "index.html").read_text(encoding="utf-8")
body = html[html.index("<body>") + len("<body>"):html.index("</body>")]
body = body.replace('<script type="module" src="/app.js"></script>', "")
# OBS link, webcam status, veto overlay and the FACEIT lobby need the site's
# own pages and network access; the artifact keeps the JSON download.
body, stripped = re.subn(r"<!-- web-only -->.*?<!-- /web-only -->", "", body, flags=re.S)
if not stripped or "web-only" in body:
    raise SystemExit("web-only markers in index.html are unbalanced")
# Logos travel inside the page: a link opened as a plain tab has no asset host.
for logo in ("oneshot-logo-day.png", "oneshot-logo-night.png"):
    data = base64.b64encode((ROOT / "assets" / logo).read_bytes()).decode()
    body = replace_once(body, f'src="/assets/{logo}"', f'src="data:image/png;base64,{data}"')
# Download: the main button always downloads; access and copy are fallbacks.
body = replace_once(body, '<p id="filenamePreview"></p>',
                    '<p id="filenamePreview"></p>\n          <p id="downloadNote" class="download-note" role="status" hidden></p>')
download_button = '<button class="button" id="downloadBtn" disabled><span aria-hidden="true">↓</span> Скачать JSON</button>'
body = replace_once(body, download_button,
                    '<div class="artifact-download-actions">'
                    '<button class="button" id="downloadAccess" hidden>Разрешить скачивание</button>'
                    '<button class="button" id="copyJsonBtn" hidden>Скопировать JSON</button>'
                    + download_button.replace('class="button"', 'class="button primary"')
                    .replace('Скачать JSON', 'Скачать JSON для OBS') + '</div>')
body = replace_once(body, '<a class="brand" href="/"', '<a class="brand" href="#webcams"')
settings = '''<dialog id="settingsDialog" aria-labelledby="settingsHeading">
    <form id="settingsForm">
      <div class="dialog-head">
        <h2 id="settingsHeading">Источник данных</h2>
        <button class="icon-button" type="button" id="closeSettings" aria-label="Закрыть">×</button>
      </div>
      <div id="sourceError" class="error-box" role="alert" hidden></div>
      <p>Панель скачивает через твой Google Drive составы (лист «Все игроки») и расписание из таблицы организатора: матчи на сегодня и следующие дни. Последняя версия сохраняется в панели, её видит вся эфирная команда.</p>
      <label>Таблица составов<input id="sourceUrl" type="url" required></label>
      <p class="muted">
        Составы: ID, команда, слот, ник, ID потока, room, PUSH, VIEW, роль.
        Расписание: B — время, C/D — команды, E — группа.
        Таблица организатора:
        <a href="https://docs.google.com/spreadsheets/d/1GtwcpVnyxY1YOs6ZTrXwJr5mjZqI0QxjLSKjimn9G2o/edit" target="_blank" rel="noreferrer">открыть</a>.
      </p>
      <div class="dialog-actions">
        <button type="button" class="button" id="resetSource">Исходная таблица</button>
        <button type="submit" class="button primary">Подключить</button>
      </div>
      <div class="dialog-section">
        <label>Нет доступа к Google Drive? Вставь лист вручную
          <textarea id="pasteArea" spellcheck="false" placeholder="Открой лист «Все игроки», выдели всё (Ctrl+A), скопируй (Ctrl+C) и вставь сюда. Потом так же можно вставить лист «Матчи»."></textarea>
        </label>
        <div class="dialog-actions"><span></span><button type="button" class="button" id="pasteBtn">Загрузить вставленное</button></div>
      </div>
    </form>
  </dialog>'''
body = cut(body, '<dialog id="settingsDialog"', '<dialog id="copyDialog"', settings + "\n\n  ")

# ---------- core.js ----------
# Day/night toggle: inlined first, so the saved mode applies before paint.
theme = (ROOT / "theme.js").read_text(encoding="utf-8")
if '<button id="themeToggle"' not in body:
    raise SystemExit("theme toggle missing from index.html")

core = (ROOT / "core.js").read_text(encoding="utf-8")
core = re.sub(r"^export (const|function) ", r"\1 ", core, flags=re.M)
if "export " in core:
    raise SystemExit("unexpected export left in core.js")

# ---------- app.js ----------
app = (ROOT / "app.js").read_text(encoding="utf-8")
app = app[app.index("const $ = id =>"):]

DRIVE_HELPERS = r'''const DRIVE = 'Google Drive';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEETJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.mini.min.js';
const CACHE_PATH = 'panel/sheets';
const capCache = {};
function use(name) {
  if (!capCache[name]) {
    const c = window.claude;
    capCache[name] = c && typeof c.use === 'function' ?
      Promise.resolve().then(() => c.use(name)).catch(() => null) :
      Promise.resolve(null);
  }
  return capCache[name];
}
let sheetJs = null;
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!sheetJs) {
    sheetJs = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SHEETJS_URL;
      script.onload = () => window.XLSX ? resolve(window.XLSX) :
        reject(new Error('Модуль чтения таблиц загрузился с ошибкой.'));
      script.onerror = () => {
        script.remove();
        sheetJs = null;
        reject(new Error('Не загрузился модуль чтения таблиц. Проверь сеть и нажми «Обновить».'));
      };
      document.head.append(script);
    });
  }
  return sheetJs;
}
function cellText(value) {
  if (typeof value === 'number' && value > 0 && value < 1) {
    const minutes = Math.round(value * 1440) % 1440;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  return value == null ? '' : String(value);
}
function rowsOf(XLSX, workbook, name) {
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name],
    { header: 1, raw: true, defval: '' }).map(row => row.map(cellText));
  while (rows.length && rows[rows.length - 1].every(cell => !cell.trim())) rows.pop();
  return rows.map(row => {
    let end = row.length;
    while (end && !row[end - 1].trim()) end--;
    return row.slice(0, end);
  });
}
function rosterRows(XLSX, workbook) {
  const names = workbook.SheetNames;
  const parses = name => { try { parseTeams(rowsOf(XLSX, workbook, name)); return true; } catch { return false; } };
  const rosterName = names.find(n => n.trim().toLowerCase() === 'все игроки') || names.find(parses);
  if (!rosterName) {
    throw new Error('В таблице нет листа «Все игроки» с колонками ID, команда, слот, ник, ID потока, room и роль.');
  }
  return rowsOf(XLSX, workbook, rosterName);
}
// The organizer's sheet: every «Schedule (...)» tab, rows carry dates.
// A roster sheet: today's day tab «Матчи ДД.ММ» (or the latest one).
function scheduleData(XLSX, workbook) {
  const names = workbook.SheetNames;
  const organizer = names.filter(n => /^schedule/i.test(n.trim()));
  if (organizer.length) {
    return {
      schedule: organizer.flatMap(n => rowsOf(XLSX, workbook, n)),
      scheduleName: organizer.join(' + ')
    };
  }
  const days = names.filter(n => /^матчи/i.test(n.trim()));
  const name = days.find(n => n.includes(mskToday())) || days[days.length - 1] || '';
  return { schedule: name ? rowsOf(XLSX, workbook, name) : [], scheduleName: name };
}
function payloadBase64(result) {
  let payload = result?.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { /* not JSON */ }
  }
  if (payload && typeof payload.content === 'string') {
    return { b64: payload.content, title: String(payload.title || '') };
  }
  throw new Error('Google Drive вернул файл в неожиданном виде. Попробуй обновить ещё раз.');
}
async function callDrive(mcp, fileId) {
  const input = { fileId, exportMimeType: XLSX_MIME };
  try {
    return await mcp.callTool(DRIVE, 'download_file_content', input, { cache: false });
  } catch (error) {
    if (!error?.retryable) throw error;
    await new Promise(r => setTimeout(r,
      Math.min(Number(error.retryAfterMs) || 700 + Math.random() * 1300, 15000)));
    return mcp.callTool(DRIVE, 'download_file_content', input, { cache: false });
  }
}
function driveErrorText(error) {
  switch (error?.code) {
    case 'no_mcp': case 'not_granted': case 'capability_disabled': case 'capability_removed':
      return 'В этом окне панель не может обратиться к Google Drive. Открой её в claude.ai или вставь лист «Все игроки» через «Источник данных».';
    case 'needs_reauth':
      return 'Google Drive просит войти заново. Переподключи его в claude.ai → Settings → Connectors и нажми «Обновить».';
    case 'server_not_connected': case 'selection_required': case 'server_not_found':
      return 'Google Drive не подключён. Добавь его в claude.ai → Settings → Connectors или вставь лист «Все игроки» через «Источник данных».';
    case 'not_in_manifest': case 'approval_required': case 'consent_required':
      return 'Панели не дали доступ к Google Drive. Нажми «Обновить» и разреши доступ или вставь лист вручную.';
    case 'blocked_by_policy':
      return 'Политика организации не пускает панель в Google Drive. Вставь лист «Все игроки» через «Источник данных».';
    case 'tool_error':
      return 'Google Drive не отдал таблицу. Проверь, что у тебя есть доступ к файлу и ссылка верная.';
    case 'server_unavailable': case 'upstream_error': case 'rate_limited':
      return 'Google Drive долго отвечает. Попробуй обновить ещё раз через минуту.';
    default:
      return error?.message || 'Не удалось обновить составы.';
  }
}
let storeReadOnly = false;
async function saveCache(data) {
  const db = await use('db');
  if (!db || storeReadOnly) return 'local';
  try {
    await db.doc(CACHE_PATH).set({
      roster: JSON.stringify(data.roster), schedule: JSON.stringify(data.schedule),
      scheduleName: data.scheduleName, sourceId: data.sourceId, title: data.title || '',
      origin: data.origin, syncedAt: data.syncedAt
    });
    return 'shared';
  } catch (error) {
    if (error?.code === 'invalid_argument') storeReadOnly = true;
    return 'failed';
  }
}
function snapshotData() {
  const el = document.getElementById('sheetsSnapshot');
  if (!el) return null;
  try {
    const data = cacheData(JSON.parse(el.textContent));
    return data && { ...data, origin: 'snapshot' };
  } catch { return null; }
}
function cacheData(doc) {
  const rows = text => {
    try {
      const value = JSON.parse(text);
      return Array.isArray(value) && value.every(Array.isArray) ?
        value.map(row => row.map(cell => String(cell ?? ''))) : null;
    } catch { return null; }
  };
  const roster = rows(doc?.roster), schedule = rows(doc?.schedule || '[]');
  if (!roster || !schedule || typeof doc.sourceId !== 'string') return null;
  return {
    roster, schedule, scheduleName: String(doc.scheduleName || ''),
    sourceId: doc.sourceId, title: String(doc.title || ''),
    origin: String(doc.origin || ''), syncedAt: Number(doc.syncedAt) || 0
  };
}
'''

REFRESH = r'''async function refresh(options = {}) {
  const request = ++refreshId;
  const source = { ...state.source };
  $('refreshBtn').disabled = true;
  $('refreshBtn').textContent = 'Обновляем…';
  if (!options.quiet) showError('');
  if (!state.template) loadTemplate();
  try {
    const mcp = await use('mcp');
    if (!mcp) throw { code: 'no_mcp' };
    const separate = !!source.scheduleId && source.scheduleId !== source.id;
    const [roster, schedule] = await Promise.allSettled([
      callDrive(mcp, source.id),
      separate ? callDrive(mcp, source.scheduleId) : null
    ]);
    if (request !== refreshId) return;
    if (roster.status !== 'fulfilled') throw roster.reason;
    const file = payloadBase64(roster.value);
    const XLSX = await loadSheetJS();
    const workbook = XLSX.read(file.b64, { type: 'base64' });
    let plan = scheduleData(XLSX, workbook), note = '';
    if (separate) {
      try {
        if (schedule.status !== 'fulfilled') throw schedule.reason;
        plan = scheduleData(XLSX,
          XLSX.read(payloadBase64(schedule.value).b64, { type: 'base64' }));
      } catch {
        note = 'Таблица организатора не открылась — расписание взято из листа «Матчи» таблицы составов.';
      }
    }
    if (request !== refreshId) return;
    const data = {
      roster: rosterRows(XLSX, workbook), ...plan,
      sourceId: source.id, title: file.title, origin: 'drive', syncedAt: Date.now()
    };
    applyData(data);
    if (note) showError(note);
    const saved = await saveCache(data);
    if (!options.quiet) {
      toast('Составы обновлены.' + (saved === 'shared' ? ' Вся команда видит эту версию.' : ''));
    }
  } catch (error) {
    if (request !== refreshId) return;
    markStale(driveErrorText(error));
  } finally {
    if (request === refreshId) {
      $('refreshBtn').disabled = false;
      $('refreshBtn').textContent = '↻ Обновить';
    }
  }
}
function applyData(data) {
  const teams = parseTeams(data.roster);
  const names = teams.map(t => t.name);
  state.cache = data;
  state.teams = teams;
  state.schedule = upcoming(parseSchedule(data.schedule || []), names);
  state.scheduleDay = scheduleDay(data.schedule || []) ||
    scheduleDay([[data.scheduleName || '']]);
  if (!names.includes(state.a)) {
    state.a = names[0];
    state.keysA = [];
  }
  if (!names.includes(state.b) || state.b === state.a) {
    state.b = names.find(n => n !== state.a) || '';
    state.keysB = [];
  }
  state.keysA = reconcileKeys(getTeam('a'), state.keysA);
  state.keysB = reconcileKeys(getTeam('b'), state.keysB);
  syncScheduledSelection();
  state.lastSync = new Date(data.syncedAt || Date.now());
  state.stale = false;
  showError('');
  render();
  renderScheduleDay();
  $('syncTitle').textContent = `${teams.length} команд из таблицы`;
  $('syncDot').className = 'good';
  $('syncTime').textContent =
    'Обновлено ' + state.lastSync.toLocaleTimeString('ru-RU', {
      timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit'
    }) + ' МСК' + (data.origin === 'paste' ? ' · вставлено вручную' :
      data.origin === 'snapshot' ? ' · снимок таблицы' : '');
  if (!data.schedule?.length) {
    showError('Составы загружены. Расписание не найдено — выбери команды, время и стадию вручную.');
  } else if (state.scheduleDay && state.scheduleDay !== mskToday()) {
    showError(`Расписание в таблице на ${state.scheduleDay}, а сегодня ${mskToday()} по МСК. Листа «Матчи ${mskToday()}» пока нет — проверь время и стадию перед экспортом.`);
  }
}
function markStale(message) {
  state.stale = true;
  $('syncDot').className = 'stale';
  $('syncTitle').textContent = state.teams.length ?
    'Данные требуют обновления' : 'Нет связи с таблицей';
  showError(message + (state.lastSync ? ' Показаны ранее загруженные составы.' : ''));
  if (!state.teams.length) {
    $('teamGrid').innerHTML =
      '<div class="empty-panel">Составов пока нет. Нажми «Обновить», чтобы взять их из Google Drive, или вставь лист «Все игроки» через «Источник данных».</div>';
  }
  renderOutput();
  renderVeto();
}
// Signed-out viewers (or a messenger's in-app browser) get neither the
// shared store nor Google Drive: show the snapshot built into the page.
async function useSnapshot() {
  const snapshot = snapshotData();
  if (!snapshot || snapshot.sourceId !== state.source.id) return false;
  try { applyData(snapshot); } catch { return false; }
  if (!await use('mcp')) {
    showError(`Показан снимок таблицы от ${state.lastSync.toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit'
    })} МСК. Живое обновление из Google Drive работает, когда панель открыта внутри claude.ai под аккаунтом с доступом к таблице.`);
  }
  return true;
}
async function connectStore() {
  const db = await use('db');
  if (!db) {
    if (!await useSnapshot() || await use('mcp')) refresh({ quiet: true });
    return;
  }
  let decided = false, pulledStale = false;
  const decide = async () => {
    if (decided) return;
    decided = true;
    if (!state.teams.length && await useSnapshot() && !await use('mcp')) return;
    if (!state.lastSync || state.cache?.origin === 'snapshot') refresh({ quiet: true });
  };
  const timer = setTimeout(decide, 7000);
  try {
    db.doc(CACHE_PATH).onSnapshot(snap => {
      if (!snap.exists) {
        if (!snap.metadata.fromCache) { clearTimeout(timer); decide(); }
        return;
      }
      clearTimeout(timer);
      const data = cacheData(snap.data());
      const newer = data && data.syncedAt > (state.lastSync?.getTime() || 0);
      if (data && data.sourceId === state.source.id && (newer || !state.teams.length)) {
        try {
          applyData(data);
          decided = true;
          // A copy older than an hour may miss today's schedule: pull once.
          if (!pulledStale && Date.now() - data.syncedAt > 3600000) {
            pulledStale = true;
            refresh({ quiet: true });
          }
          return;
        } catch { /* fall through */ }
      }
      decide();
    }, () => { clearTimeout(timer); decide(); });
  } catch {
    clearTimeout(timer);
    decide();
  }
}

'''

DOWNLOAD = r'''function obsFile() {
  const filename = safeFilename(state.a, state.b,
    $('matchTime').value, $('matchStage').value);
  const text = JSON.stringify(buildObs(state.template,
    getTeam('a'), getTeam('b'), state.keysA, state.keysB, undefined,
    { includeCards: $('includeCards').checked, cameraFrame:state.cameraFrame }), null, 2) + '\n';
  return { filename, text };
}
function downloadNote(text) {
  $('downloadNote').textContent = text;
  $('downloadNote').hidden = !text;
}
// A plain browser tab, or a frame that allows downloads, saves a normal <a download>.
function directDownload(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$('downloadBtn').addEventListener('click', async () => {
  let file;
  try { file = obsFile(); } catch (error) { showError(error.message); return; }
  downloadNote('');
  $('downloadAccess').hidden = $('copyJsonBtn').hidden = true;
  const done = `Скачан ${file.filename}. OBS → Коллекция сцен → Импорт.`;
  // Inside claude.ai the file goes through the downloads capability:
  // Claude shows its own save prompt with the final file name.
  const downloads = await use('downloads');
  if (downloads) {
    try {
      await downloads.save({ filename: file.filename, data: file.text });
      toast(done);
      return;
    } catch (error) {
      if (error?.code === 'declined') { toast('Сохранение отменено'); return; }
      if (error?.code === 'rate_limited') { toast('Окно сохранения уже открыто'); return; }
      // unavailable, not_granted and the like: try a normal download below.
    }
  }
  directDownload(file.filename, file.text);
  if (window.self === window.top) { toast(done); return; }
  // A viewer without the capability may block that download without a sign,
  // so say why and what to do instead of switching to copying.
  const permissions = await use('permissions');
  const access = permissions ?
    await permissions.state('downloads').catch(() => 'unavailable') : 'unavailable';
  $('copyJsonBtn').hidden = false;
  if (access === 'denied') {
    $('downloadAccess').hidden = false;
    downloadNote('Claude запретил панели сохранять файлы. Нажми «Разрешить скачивание», включи Downloads и снова нажми «Скачать JSON».');
  } else {
    downloadNote('Если файл не скачался, это окно Claude не даёт сохранять файлы. Открой панель по ссылке claude.ai/artifact в браузере (Chrome, Safari) — там JSON скачивается. Запасной вариант — «Скопировать JSON».');
  }
});
$('downloadAccess').addEventListener('click', async () => {
  const permissions = await use('permissions');
  try {
    await permissions.manage();
  } catch {
    downloadNote('Открой меню Permissions у артефакта, включи Downloads и снова нажми «Скачать JSON».');
    return;
  }
  if (await permissions.state('downloads') !== 'denied') {
    $('downloadAccess').hidden = true;
    downloadNote('Готово. Нажми «Скачать JSON» ещё раз.');
  }
});
$('copyJsonBtn').addEventListener('click', () => {
  let file;
  try { file = obsFile(); } catch (error) { showError(error.message); return; }
  copy(file.text, `JSON скопирован. Сохрани его как «${file.filename}» и импортируй в OBS.`);
});

'''

SETTINGS = r'''function sheetId(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Вставь ссылку на Google Sheets.'); }
  const match = url.pathname.match(/^\/spreadsheets\/d\/([\w-]{20,100})(?:\/|$)/);
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' ||
      url.username || url.password || !match) {
    throw new Error('Вставь ссылку на Google Sheets.');
  }
  return match[1];
}
function parseTSV(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const src = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
function sourceError(text) {
  $('sourceError').textContent = text;
  $('sourceError').hidden = !text;
}
$('settingsBtn').addEventListener('click', () => {
  $('sourceUrl').value = `https://docs.google.com/spreadsheets/d/${state.source.id}/edit`;
  sourceError('');
  $('settingsDialog').showModal();
});
$('closeSettings').addEventListener('click', () => $('settingsDialog').close());
$('closeCopy').addEventListener('click', () => $('copyDialog').close());
$('resetSource').addEventListener('click', () => {
  $('sourceUrl').value = `https://docs.google.com/spreadsheets/d/${DEFAULT_SOURCE.id}/edit`;
});
$('settingsForm').addEventListener('submit', event => {
  event.preventDefault();
  let id;
  try { id = sheetId($('sourceUrl').value.trim()); }
  catch (error) { sourceError(error.message); return; }
  $('settingsDialog').close();
  if (id !== state.source.id) {
    state.source = { ...DEFAULT_SOURCE, id, scheduleId: id };
    const stored = writeStorage('webcam-desk-source', state.source);
    Object.assign(state, {
      teams: [], schedule: [], scheduleDay: '', lastSync: null, cache: null,
      a: '', b: '', keysA: [], keysB: [], matchKey: ''
    });
    renderScheduleDay();
    updateSourceLinks();
    $('teamGrid').innerHTML = '<div class="empty-panel">Загружаем составы…</div>';
    renderOutput();
    renderVeto();
    if (!stored) toast('Источник подключён. Браузер не разрешил запомнить его для следующего открытия.');
  }
  refresh();
});
$('pasteBtn').addEventListener('click', () => {
  const text = $('pasteArea').value;
  if (!text.trim()) { sourceError('Сначала вставь лист из таблицы.'); return; }
  const rows = parseTSV(text);
  let data = null, what = '';
  try {
    const teams = parseTeams(rows);
    data = { roster: rows, schedule: state.cache?.schedule || [], scheduleName: state.cache?.scheduleName || '' };
    what = `Загружено команд: ${teams.length}.`;
  } catch (rosterError) {
    const matches = parseSchedule(rows);
    if (matches.length && state.cache?.roster) {
      data = { roster: state.cache.roster, schedule: rows, scheduleName: '' };
      what = `Расписание: ${matches.length} матч(а/ей).`;
    } else if (matches.length) {
      sourceError('Сначала вставь лист «Все игроки», потом расписание.');
      return;
    } else {
      sourceError(rosterError.message);
      return;
    }
  }
  Object.assign(data, { sourceId: state.source.id, title: '', origin: 'paste', syncedAt: Date.now() });
  try { applyData(data); } catch (error) { sourceError(error.message); return; }
  $('pasteArea').value = '';
  $('settingsDialog').close();
  saveCache(data).then(saved =>
    toast(what + (saved === 'shared' ? ' Вся команда видит эту версию.' : '')));
});

'''

VETO_RESET = r'''let resetArmed = 0;
$('vetoReset').addEventListener('click', () => {
  if (!resetArmed) {
    $('vetoReset').textContent = 'Точно сбросить?';
    resetArmed = setTimeout(() => {
      resetArmed = 0;
      $('vetoReset').textContent = 'Сбросить вето';
    }, 4000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = 0;
  $('vetoReset').textContent = 'Сбросить вето';
  state.veto.actions = [];
  state.pending = null;
  renderVeto();
  persist();
});
'''

app = cut(app, "async function sheetRows(", "function reconcileKeys(", "")
app = cut(app, "async function refresh() {", "function mskToday(", REFRESH)
app = cut(app, "function exportObsFile() {", "function fillSource(source) {", DOWNLOAD)
app = replace_once(app, "  $('exportRecovery').disabled = $('downloadBtn').disabled;\n", "")
app = cut(app, "function fillSource(source) {", "document.querySelectorAll('.brand img').forEach(dropBrokenImage);", SETTINGS)
app = cut(app, "$('vetoReset').addEventListener('click', () => {", "$('vetoFormat').addEventListener('change', () => {", VETO_RESET)
app = replace_once(app, "async function copy(text) {", "async function copy(text, message = 'Скопировано в буфер обмена') {")
app = replace_once(app, "toast('Скопировано в буфер обмена');", "toast(message);")
app = replace_once(app, "if (ok) return toast('Скопировано');", "if (ok) return toast(message);")
# Team logos: the manifest and its files go inline, like the maps below.
logo_manifest = json.loads((ROOT / "assets" / "teams" / "teams.json").read_text(encoding="utf-8"))
logo_files = {}
for logo_file in sorted(set(logo_manifest.values())):
    logo_files[logo_file] = "data:image/png;base64," + base64.b64encode(
        (ROOT / "assets" / "teams" / logo_file).read_bytes()).decode()
app = replace_once(app, "fetch('/assets/teams/teams.json')",
                   "Promise.resolve({ok:true,json:async()=>(" + json.dumps(logo_manifest, ensure_ascii=False) + ")})")
app = replace_once(app, "`/assets/teams/${file}`", "ARTIFACT_LOGOS[file]")
app = "const ARTIFACT_LOGOS = " + json.dumps(logo_files) + ";\n" + app
# Keep the exported artifact self-contained; its URL has no /assets host.
template_json = (ROOT / "assets" / "obs-template.json").read_text(encoding="utf-8").strip()
json.loads(template_json)  # Validate without rewriting the canonical template.
template_json = template_json.replace("</", "<\\/")
app = replace_once(app, "fetch('/assets/obs-template.json', { signal: AbortSignal.timeout(12000) })",
                   "Promise.resolve({ok:true,json:async()=>(" + template_json + ")})")
app = replace_once(app, "  pending: null, sheetTeams: [], streamIds: {}, regenAsk: '', exporting: false\n};",
                   "  pending: null, sheetTeams: [], streamIds: {}, regenAsk: '', exporting: false, cache: null\n};")
# The artifact has no asset directory; only the artifact embeds these files.
map_images = {}
for map_name in ("Ancient", "Anubis", "Cache", "Dust2", "Inferno", "Mirage", "Nuke"):
    image_file = ROOT / "assets" / "maps" / (map_name + ".jpg")
    map_images[map_name] = "data:image/jpeg;base64," + base64.b64encode(image_file.read_bytes()).decode()
app = replace_once(app, 'src="/assets/maps/${map}.jpg"', 'src="${ARTIFACT_MAPS[map]}"')
app = "const ARTIFACT_MAPS = " + json.dumps(map_images) + ";\n" + app
if not app.rstrip().endswith("refresh();"):
    raise SystemExit("unexpected app.js ending")
app = app.rstrip()[:-len("refresh();")] + """use('downloads');
connectStore();
"""
for banned in ["confirm(", "/gviz/"]:
    if banned in app:
        raise SystemExit(f"artifact-incompatible code left: {banned}")

snapshot_tag = ""
if "--snapshot" in sys.argv:
    doc = json.loads(Path(sys.argv[sys.argv.index("--snapshot") + 1]).read_text(encoding="utf-8"))
    doc = doc.get("data", doc)
    keep = {k: doc[k] for k in ("roster", "schedule", "scheduleName", "sourceId", "title", "syncedAt") if k in doc}
    for key in ("roster", "schedule"):
        rows = json.loads(keep[key])
        while rows and not any(str(c).strip() for c in rows[-1]):
            rows.pop()
        keep[key] = json.dumps([r[:max([i + 1 for i, c in enumerate(r) if str(c).strip()] or [0])] for r in rows],
                               ensure_ascii=False)
    snapshot_tag = ('<script type="application/json" id="sheetsSnapshot">' +
                    json.dumps(keep, ensure_ascii=False).replace("</", "<\\/") + "</script>\n")

favicon, favicon_night = ("data:image/png;base64," + base64.b64encode((ROOT / "assets" / name).read_bytes()).decode()
                           for name in ("favicon.png", "favicon-night.png"))
page = f'''<title>Oneshot Panel</title>
<link rel="icon" href="{favicon}">
<link rel="icon" href="{favicon_night}" media="(prefers-color-scheme: dark)">
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Вебки игроков CyberClash, коллекции сцен OBS и вето для HLTV.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=swap">
<!-- Built from the web panel by claude-artifact/build_oneshot_artifact.py; edit the web panel, then rebuild. -->
<script>
{theme}</script>
<style>
/* Oneshot look: black header, red accent; day and night tokens come from style.css. */
{css}</style>
{body.strip()}
{snapshot_tag}<script>
'use strict';
{core}
{DRIVE_HELPERS}
{app}</script>
'''
out = ROOT / "claude-artifact" / "dist" / "oneshot-panel.html" if snapshot_tag else OUT
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(page, encoding="utf-8")
print(f"wrote {out.relative_to(ROOT)} ({len(page.encode())} bytes)")
