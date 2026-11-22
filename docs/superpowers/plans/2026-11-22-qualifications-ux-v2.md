# Квалификации v2 — карточки, свои VDO-ссылки, комната, проверка игроков

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вкладка «Квалификации» сама выдаёт каждому игроку FACEIT ссылку VDO.Ninja (push), ссылку на комнату матча для просмотра всех игроков одной кнопкой, кнопки копирования и отметки «проверен», и выглядит как аккуратные карточки вместо текущего списка.

**Architecture:** Новые чистые функции в `qualifications-data.js` (детерминированные room/stream ID, ссылки, текст для команды, отметки проверки) — покрыты `node:test`. `qualifications-controller.js` рендерит карточки из этих функций; камера игрока = камера из таблицы OneShot, если нашлась, иначе сгенерированная ссылка. `CamWatch` следит только за матчами, которые идут или начнутся в ближайший час. Ключ FACEIT на сайте берётся из секрета хостинга — поле в форме становится необязательным и сворачивается.

**Tech Stack:** vanilla JS (ESM), node:test, CSS-токены `style.css`, VDO.Ninja URL-схема из `core.js`, Cloudflare Pages Functions.

**Spec:** этот файл (ТЗ от пользователя от 22.11.2026, скриншот карточек).

## Global Constraints

- Внешних npm-зависимостей нет и не добавлять. Node >= 22, `npm run check` и `npm test` зелёные.
- CSP ужесточать нельзя: `script-src 'self'`, `style-src 'self'`, `img-src 'self'`, без inline-скриптов и стилей.
- Данные FACEIT/таблицы в DOM — только `textContent`/`setAttribute`/`.value`, никогда `innerHTML`.
- Секреты (`FACEIT_API_KEY`) не попадают в код, логи, URL, `localStorage` и тексты ошибок. «Ключ по умолчанию» = секрет хостинга (`FACEIT_API_KEY` в Cloudflare Pages → Environment variables), а не строка в репозитории.
- Ссылки из внешних данных — только `https:` и ожидаемый хост (`safeQualificationUrl` уже это делает).
- День и ночь: только токены `:root` (`--surface`, `--line`, `--muted`, `--success*`, …), не хардкод цветов.
- 375px без горизонтальной прокрутки; все интерактивные элементы доступны с клавиатуры, `focus-visible` не убирать.
- Тексты интерфейса — русские, как в соседнем коде. Комментарии — короткие «почему».
- `app.js` менять нельзя (его собирает артефакт Claude; правки только через существующий `window.oneshotPanel`).

## Review Focus

Случаи, которые легче всего сломать — каждому соответствует тест в своей задаче:

1. Один и тот же ник в двух командах одного матча — получают разные stream ID (`Ace`, `Ace_2`) и не «видят» чужую камеру; тот же ник в другом матче — тот же ID, но другая комната.
2. Ник с кириллицей, эмодзи, пробелами и точками — VDO оставляет только `[A-Za-z0-9_]`; ID обязан остаться валидным и уникальным.
3. Два прогона подряд (перезагрузка страницы) дают те же ссылки — иначе разосланные ссылки умирают.
4. Матч без состава FACEIT (`FACEIT не отдал состав`) и матч с составом, но без строки в таблице OneShot — ссылки всё равно выдаются.
5. 32 матча × 10 игроков: `CamWatch` не должен поднимать 32 скрытых iframe — только идущие и ближайшие матчи.
6. Отметки «проверен» и поиск не теряют ввод и не стирают введённый connect при перерисовке.

---

### Task 1: VDO-идентификаторы из ника FACEIT

**Files:**
- Modify: `qualifications-data.js`
- Test: `test/qualifications-data.test.js`

**Interfaces:**
- Produces: `qualificationVdo(championshipId, matchId, teams)` → `{ room, players: [{ nickname, id }] }`; `vdoSafeName(text, max = 16)` → `string`.
- `teams` — `[{ name, players: [{ nickname }] }]`. FACEIT `player_id` в генерацию НЕ входит: ID читается как ник игрока. Одинаковый ник в разных командах разводится суффиксом `_2`, `_3`.

- [ ] **Step 1: Написать падающие тесты**

```js
test('stream IDs read as FACEIT nicknames, one room per match', () => {
  const teams = [
    { name: 'Team Alpha', players: [{ nickname: 'Player.One' }, { nickname: 'Ace' }] },
    { name: 'Team Beta', players: [{ nickname: 'Ace' }] }
  ];
  const a = qualificationVdo('champ-1', '1-uuid-a', teams);
  assert.deepEqual(a, qualificationVdo('champ-1', '1-uuid-a', teams)); // reload keeps links
  assert.equal(a.players[0].id, 'PlayerOne');                          // nickname drives the ID
  assert.equal(a.players[1].id, 'Ace');
  assert.equal(a.players[2].id, 'Ace_2');            // same nick, one room: no collision
  assert.match(a.players[2].id, /^[A-Za-z0-9_]{1,64}$/);
  assert.match(a.room, /^[a-z0-9_]{1,64}$/);
  assert.match(a.room, /teamalpha_teambeta/);        // the room says who plays
  assert.notEqual(a.room, qualificationVdo('champ-1', '1-uuid-b', teams).room);
});
test('Cyrillic, emoji and punctuation never break a VDO ID', () => {
  const v = qualificationVdo('c', 'm', [{ name: 'Команда «А»', players: [{ nickname: 'Игрок #7' }, { nickname: '💥boom' }] }]);
  for (const p of v.players) assert.match(p.id, /^[A-Za-z0-9_]{1,64}$/);
  assert.equal(v.players[0].id, 'player7');          // one Latin char is not a readable name
  assert.equal(v.players[1].id, 'boom');
});
```

- [ ] **Step 2: Прогнать — тесты падают**

Run: `node --test test/qualifications-data.test.js`
Expected: FAIL, `qualificationVdo is not defined`.

- [ ] **Step 3: Реализовать**

```js
// VDO keeps only [A-Za-z0-9_] in an ID; a one-letter base reads as noise.
export const vdoSafeName = (text, max = 16) => {
  const base = String(text || '').normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').slice(0, max);
  return base.length >= 2 ? base : (base ? 'player' + base : 'cam');
};
const fnv = text => { let h = 0x811c9dc5; for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
const tail = (text, n) => { let h = fnv(text), out = ''; for (let i = 0; i < n; i++) { out += 'abcdefghijkmnpqrstuvwxyz23456789'[h % 32]; h = Math.floor(h / 32) + fnv(out); } return out; };
// The room name is readable on purpose: the operator sees which match it is.
export function qualificationVdo(championshipId, matchId, teams = []) {
  const prefix = (teams || []).map(team => vdoSafeName(team.name, 12).toLowerCase()).join('_') || 'match';
  const room = `${prefix}_${tail(`${championshipId}|${matchId}`, 6)}`.slice(0, 60);
  const used = new Map();
  const players = [];
  for (const team of teams || []) for (const player of team.players || []) {
    const base = vdoSafeName(player.nickname, 16);
    const seen = (used.get(base.toLowerCase()) || 0) + 1;
    used.set(base.toLowerCase(), seen);
    players.push({ nickname: player.nickname, id: seen === 1 ? base : `${base}_${seen}` });
  }
  return { room, players };
}
```

- [ ] **Step 4: Прогнать — зелёные**, затем `npm run check && npm test`.

---

### Task 2: Ссылки, текст команде и «комната» из чистых функций

**Files:**
- Modify: `qualifications-data.js`, `test/qualifications-data.test.js`

**Interfaces:**
- Consumes: `qualificationVdo` (Task 1)
- Produces: `qualificationPushLink({ id, room, password })`, `qualificationRoomLink(room)`, `qualificationTeamText(teamName, players)`, `qualificationMatchText(teams)` (players — уже с `link`). Каждый блок называет команду, а каждая строка — ник: игрок сразу видит, кто где.

- [ ] **Step 1: Падающие тесты**

```js
test('builds VDO links that keep the room and never leak a password into the text', () => {
  assert.equal(qualificationPushLink({ id: 'Ace_abc', room: 'q123' }),
    'https://vdo.ninja/?room=q123&broadcast&do&push=Ace_abc');
  assert.equal(qualificationRoomLink('q123'), 'https://vdo.ninja/?room=q123&list');
  const text = qualificationTeamText('Team A', [{ nickname: 'Ace', link: 'https://vdo.ninja/?room=q1&push=x' }]);
  assert.match(text, /^## Team A\n/);
  assert.match(text, /\*\*Ace\*\* https:\/\/vdo\.ninja\/\?room=q1&push=x/);
  const both = qualificationMatchText([
    { name: 'Team A', players: [{ nickname: 'Ace', link: 'https://vdo.ninja/?room=q1&push=x' }] },
    { name: 'Team B', players: [{ nickname: 'Bee', link: 'https://vdo.ninja/?room=q1&push=y' }] }
  ]);
  assert.match(both, /## Team A[\s\S]*## Team B/);   // each block names its team
  assert.match(both, /\*\*Bee\*\* https:\/\/vdo\.ninja\/\?room=q1&push=y/);
});
```

- [ ] **Step 2: Red.** `node --test test/qualifications-data.test.js` → FAIL.

- [ ] **Step 3: Реализовать** — push-ссылка повторяет формат `core.pushUrl` (тот же текст игроку, что в «Подготовке»), комната — `?room=<room>&list` (список активных потоков комнаты). Экранирование: `encodeURIComponent` для room и id. `qualificationTeamText` — заголовок `## <команда>`, строки `**<ник>** <push>` (тот же контракт, что `playerText` в `core.js`); `qualificationMatchText` — оба блока подряд, чтобы в одном сообщении было видно, кто в какой команде.

- [ ] **Step 4: Green**, `npm test`.

- [ ] **Step 5: Проверить в браузере** (одна ручная проверка, после Task 6): открыть комнату матча, убедиться, что `&list` показывает потоки. Если VDO не поддерживает `&list` — заменить на `?room=<room>` (комната сама показывает доступные потоки) и поправить тест.

---

### Task 3: Камера игрока — из OneShot, иначе сгенерированная

**Files:**
- Modify: `qualifications-controller.js`, `test/qualifications-controller.test.js`

**Interfaces:**
- `matchQualificationPlayers(teams, snapshot, allTeams)` — у каждого игрока теперь `camera` = `{ id, room, password, source: 'oneshot' | 'generated' }` или `null` только при `duplicate-id`/`ambiguous`.
- Новый параметр контроллера `vdoFactory = qualificationVdo` (подменяется в тестах). Генератор обходит команды по порядку, поэтому его ответ сопоставляется с игроком по позиции.

- [ ] **Step 1: Падающий тест**

```js
test('gives every FACEIT player a VDO link even without a OneShot camera', async () => {
  // fixture: команда без строк в таблице, nickname 'Player.One'
  await controller.start();
  const record = controller.state.matches.get('match-1');
  const [team] = record.teams;
  assert.equal(team.players[0].camera.source, 'generated');
  assert.equal(team.players[0].camera.id, 'PlayerOne');      // from the FACEIT nickname
  assert.equal(team.players[0].camera.room, record.room);
});
test('a matched OneShot camera wins over the generated one', async () => { /* source === 'oneshot' */ });
```

- [ ] **Step 2: Red.**

- [ ] **Step 3: Реализовать** в `poll()` после `matchQualificationPlayers`:

```js
const vdo = vdoFactory(state.championshipId, match.id, record.teams);
record.room = vdo.room;
const roster = record.teams.flatMap(t => t.players);
const generated = new Map(roster.map((p, i) => [p, vdo.players[i]?.id]));
for (const team of record.teams) for (const player of team.players) {
  if (!player.camera) player.camera = { id: generated.get(player) || '', room: vdo.room, password: '', source: 'generated' };
  else player.camera.source = 'oneshot';
}
```

- [ ] **Step 4: Green.**

---

### Task 4: Комната и кнопки копирования

**Files:** `qualifications-controller.js`, `test/qualifications-controller.test.js`

- [ ] **Step 1: Падающие тесты** на кнопки: клик по `[data-q-copy-push]` пишет push-ссылку игрока; клик по `[data-q-copy-team="0"]` пишет текст половины команды; клик по `[data-q-copy-all]` пишет `qualificationMatchText` — обе команды с никами в строках, чтобы в чате сразу было видно, кто где; клик по `[data-q-copy-room]` пишет ссылку комнаты; клик по `[data-q-open-room]` открывает комнату (`window.open` подменяется). Буфер подменяется фейком `{ writeText: async text => calls.push(text) }`.

- [ ] **Step 2: Red.**

- [ ] **Step 3: Реализовать** — делегирование одним `clickHandler` на `root` (как сейчас для камер), ветки по `dataset`; после копирования `safeText(status, 'Ссылка скопирована.')`, при ошибке — `'Не удалось скопировать.'`.

- [ ] **Step 4: Green.**

---

### Task 5: Отметки «проверен» с сохранением

**Files:** `qualifications-data.js` (чистый key/parse), `qualifications-controller.js`, тесты.

- [ ] **Step 1: Падающие тесты**: `checkedKey(championshipId, matchId, player)` стабилен; ключом служит FACEIT `player_id`, а при его отсутствии — ник (в FACEIT-составе бывают записи без id); `readChecked(json)` отбрасывает мусор и чужие ключи; контроллер: чекбокс ставит отметку, переживает «перерисовку» (повторный `poll()`), счётчик у команды «3/5».

- [ ] **Step 2: Red → реализация → Green.** localStorage `oneshot-qualifications-checked`, только id, никаких ссылок и ключей. Ограничить 500 записями (обрезать старые).

---

### Task 6: Карточки — разметка и CSS

**Files:** `qualifications-controller.js` (render), `style.css`, `index.html` (тулбар), `test/qualifications-controller.test.js` (структурные проверки)

- [ ] **Step 1: Падающие тесты на разметку** (fake DOM-узлы с `createElement`/`append`/`dataset`): карточка содержит `data-state` (`live`/`soon`/`done`), у игрока статус-точку `data-cam` (`online`/`checking`/`off`), кнопки `data-q-copy-push`, чекбокс `data-q-verify`; пустой результат → `.qualifications-empty`.

- [ ] **Step 2: Разметка карточки**

```html
<article class="qcard" data-state="live" data-match-id="…">
  <header class="qcard-top"><span class="qchip">идёт</span><span class="qscore">2 : 0</span></header>
  <h3 class="qcard-title">Team A <span class="qvs">vs</span> Team B</h3>
  <div class="qteams">
    <section class="qteam"><h4>Team A <span class="qcount">3/5</span></h4><ul>…
      <li data-cam="online"><span class="qdot"></span><span class="qnick">nick</span>
        <span class="qacts"><button data-q-copy-push="f1" aria-label="Ссылка VDO для Ace">Ссылка</button>
        <label class="qverify"><input type="checkbox" data-q-verify="f1"> ок</label></span></li>
    </ul></section></div>
  <footer class="qcard-foot">
    <button data-q-open-room>Комната ↗</button><button data-q-copy-room>Ссылка на комнату</button>
    <button data-q-copy-team="0">Ссылки A</button><button data-q-copy-team="1">Ссылки B</button>
    <button data-q-copy-all>Все ссылки</button><a class="qlink" href="…" rel="noopener">FACEIT</a>
    <input class="qconnect" maxlength="256" aria-label="CS2 connect"> <button data-q-copy-connect>Копировать connect</button>
  </footer>
</article>
```

- [ ] **Step 3: CSS** — только токены: `.qcard` (`--surface`, `1px solid var(--line)`, радиус 10-12px, тень `--panel-shadow`), живой матч — левая линия `--success` и точка-пульс (`prefers-reduced-motion` — без анимации), `.qdot[data-cam=online]` зелёный, `checking` — `--muted`, `off` — приглушённый. Сетка `repeat(auto-fill, minmax(min(100%,360px), 1fr))`. Кнопки — компактные, `min-height: 32px`, на 375px — полная ширина футера в две строки.

- [ ] **Step 4: Тулбар** в `index.html`: поиск `qualificationsSearch` (по команде и нику) и чипы «Все / Идут / Скоро / Завершены» (`data-q-filter`). Фильтрация в `render()` по `state.search`/`state.filter`, без запросов к FACEIT.

- [ ] **Step 5:** `npm run check && npm test`, затем браузерный смоук (см. Task 9).

---

### Task 7: CamWatch только для актуальных матчей

**Files:** `qualifications-controller.js`, тест.

- [ ] **Step 1: Падающий тест**: из трёх матчей (finished, live, upcoming +3 ч) `watchFactory` получает группы только для live; upcoming +30 мин тоже попадает.

- [ ] **Step 2: Реализовать** `isWatched(record, now)`: `match.live` ИЛИ (`status === 'SCHEDULED'` и `scheduledAt - now < 60*60*1000`). Группы строятся по `record.room` (одна комната на матч).

- [ ] **Step 3: Green.** Проверить, что при смене чемпионата watcher останавливается (существующий тест).

---

### Task 8: Ключ FACEIT — секрет хостинга, поле сворачивается

**Files:** `index.html`, `style.css` (мелочь), `test/server.test.js` не трогать.

- [ ] **Step 1:** Поле `qualificationsKey` обернуть в `<details class="qkey-more"><summary>Свой API-ключ (необязательно)</summary>…` с подписью «На сайте ключ уже настроен в секретах Cloudflare Pages (`FACEIT_API_KEY`); поле нужно только для локальной проверки».
- [ ] **Step 2:** Проверить `functions/api/faceit.js` читает `context.env.FACEIT_API_KEY` (обёртка `proxyFaceit`); если переменная не задана — сообщение об ошибке уже понятное.
- [ ] **Step 3:** Пользовательское действие (вне кода): Cloudflare Pages → Settings → Environment variables → добавить секрет `FACEIT_API_KEY` для Production и Preview, redeploy.

---

### Task 9: Документация, артефакт, полная проверка

- [ ] **Step 1:** Обновить абзац в `AGENTS.md` про вкладку (генерированные ссылки, комната, отметки, хранение `oneshot-qualifications-checked`, ключ — секрет хостинга).
- [ ] **Step 2:** `python3 claude-artifact/build_oneshot_artifact.py` (вкладка web-only, но сборка должна остаться зелёной).
- [ ] **Step 3:** `npm run check && npm test && git diff --check`.
- [ ] **Step 4:** Браузерный смоук на локальном сервере с подменённым `/api/faceit` (как в прошлом цикле): карточки, копирование, комната, отметки, 375px без прокрутки, день/ночь.
- [ ] **Step 5:** Коммиты по задачам, пуш в `claude/gracious-sagan-apztcc` после зелёных проверок.

---

## Кто это делает

- **Реализация:** я, в этом worktree, по задачам 1→9 с TDD (тест падает → код → тест зелёный → коммит). Причина: 80% работы — один файл `qualifications-controller.js` (render/poll) и один CSS; параллельные агенты на одних файлах дадут конфликты.
- **Ревью после реализации:** два агента параллельно — (а) логика контроллера/данных и тесты, (б) дизайн в браузере (карточки, 375px, день/ночь, доступность) — по тому же образцу, что в прошлом цикле.
- **Действие пользователя:** добавить `FACEIT_API_KEY` в переменные Cloudflare Pages (Task 8, шаг 3) — это единственное, что я не могу сделать за вас.

## Что ещё пригодится (сверх запрошенного)

- **Поиск и фильтры** (Task 6) — 32 карточки иначе не листаются.
- **Отметки «проверен»** (Task 5) — прямая цель вкладки: видеть, кого из команды уже проверили.
- **«Все ссылки» одной кнопкой** (Task 4) — тот же текст игрокам, что в «Подготовке» (`## Команда` + строки `**Ник** <push>`), но сразу на обе команды: по заголовку и нику в строке игрок видит, кто где. Отдельные кнопки «Ссылки A» и «Ссылки B» — когда пишут в личку одной команде.
- **Слежение только за актуальными матчами** (Task 7) — иначе десятки скрытых iframe.
- Сознательно **не делаем**: отдельные пароли комнат квалификаций (публичные, генерируется на клиенте — иллюзия защиты), хранение ключа в `localStorage` (запрещено правилами проекта), отправку сообщений игрокам автоматически (только копирование).
