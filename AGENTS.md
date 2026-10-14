# Заметки для ИИ-агентов (Codex, ChatGPT, Claude)

Oneshot Panel — статическая веб-панель эфирной команды CyberClash.
Читает составы и расписание из Google Sheets, раскладывает 10 вебок
по слотам 01–05 / 06–10, отдаёт ссылки VDO.Ninja игрокам, JSON-коллекцию
сцен OBS (1920×1080) и вето карт BO1/2/3/5 с текстом для HLTV.
Подробности для людей — в README.md.

## Карта файлов

- `index.html` — вся разметка, одна страница.
- `style.css` — токены тем и читаемые правила оформления панели.
  Цвета только через токены на `:root`. Ночной набор токенов записан
  дважды (в `@media (prefers-color-scheme: dark)` и в
  `:root[data-theme=dark]…,:root[data-mode=dark]`) — меняй оба.
- `theme.js` — день/ночь. Обычный скрипт в `<head>` до CSS, чтобы не было
  вспышки; выбор в localStorage `oneshot-theme`, атрибут `data-mode`.
- `core.js` — чистая логика без DOM: разбор ответа gviz, составы, ссылки
  VDO.Ninja, тексты для копирования, имя файла, сборка OBS JSON, правила
  вето. Покрыта `test/core.test.js`.
- `app.js` — интерфейс: загрузка таблиц, отрисовка, localStorage
  (`webcam-desk-source`, `oneshot-webcam-match-v1`), вето, копирование,
  скачивание JSON.
- `server.js` — локальный статический сервер. Отдаёт только файлы из
  `publicFiles` и `assets/`: новый файл в корне добавь в `publicFiles`.
- `DEPLOY.md` — размещение на своём сервере (nginx) или домене; при смене
  списка файлов сайта или заголовков обнови и его.
- `netlify.toml` — хостинг на Netlify, те же заголовки безопасности, что в
  `server.js` (тест сверяет, что они совпадают).
- `assets/` — `obs-template.json` (оригинальный шаблон OBS, не
  переформатировать), `oneshot-logo-day.png` / `oneshot-logo-night.png`,
  `favicon.png`. Карты `assets/maps/*.jpg` — локальные миниатюры; происхождение и
  лицензия в этом каталоге. Панель скрывает битые картинки.
- `claude-artifact/build_oneshot_artifact.py` — собирает
  `claude-artifact/oneshot-panel.html` (версия для артефакта Claude) из тех
  же файлов с точечными заменами. После правок `index.html`, `app.js`,
  `core.js`, `style.css` или `theme.js` пересобери. Если скрипт падает
  на `replace_once`/`cut`, исходный кусок изменился — поправь замену в
  скрипте, а не обходи её.
- `claude-artifact/index.html` — старая версия «Webcam Desk», не трогать.
- `scripts/qa_browser.py` — 24 браузерных сценария (Python Playwright +
  Chromium).

## Команды

```sh
npm run check        # синтаксис
npm test             # 23 теста (node:test)
PORT=3000 node server.js
python3 scripts/qa_browser.py --url http://127.0.0.1:3000 --chromium /path/to/chrome
python3 claude-artifact/build_oneshot_artifact.py
```

Node.js >= 22. Внешних npm-зависимостей нет и не добавлять: сборки нет,
Netlify публикует корень как есть.

## Что нельзя ломать

Эти форматы используют в эфире, тесты проверяют их дословно.

- Текст игрокам: заголовок `## Команда` и строки
  `**Ник** https://vdo.ninja/?room=<room>&broadcast&do&push=<id>`.
- Текст обсерверу: только порядок слотов `N. Команда — Ник`, без ссылок.
- Имя JSON без пробелов: `16-00_Группа-B_КомандаA_vs_КомандаB.json`.
- OBS JSON: сцены «Игрок 1–10» и «Матрица», камеры вписаны в 1920×1080,
  поворот 0, без обрезки, новые UUID при каждом экспорте; источники
  называются `CAM NN | Команда | Ник`.
- Вето как на veto.oneshot.su. Пул: Ancient, Anubis, Cache, Dust2,
  Inferno, Mirage, Nuke. Текст HLTV строками вида `X removed Map`,
  `X pick Map (Y CT)` или `(Y T)` — сторона соперника, последняя —
  `Map was left over`.
- CSP: `script-src 'self'`, `style-src 'self'`, `img-src 'self'`. Никаких
  inline-скриптов, CDN, Google Fonts и `data:`-картинок в веб-версии.
  `connect-src` разрешает только `https://docs.google.com`.

## Редизайн

Разметку и стили можно менять свободно, но сохраняй `id` и
`data-`атрибуты: на них завязаны `app.js` и браузерные тесты.

- id: sidebarSource themeToggle webcams syncDot syncTitle syncTime
  refreshBtn settingsBtn errorBox scheduleLabel matchSelect matchTime
  matchStage swapBtn teamGrid exportBar exportHint filenamePreview
  downloadBtn tabObserver tabPlayers outputPanel previewLabel copyAllBtn
  output copyFoot veto vetoHeading vetoFormat vetoFirst vetoStatus
  sideChoice sideLabel chooseCT chooseT cancelSide mapGrid vetoUndo
  vetoReset autoCopyVeto vetoHint copyVeto vetoOutput settingsDialog
  settingsForm settingsHeading closeSettings sourceError sourceUrl
  sourceGid scheduleUrl scheduleGid resetSource copyDialog copyHeading
  closeCopy manualCopy toast
- data-атрибуты (их ставит `app.js`): data-copy-team data-map data-player
  data-reset data-slot data-team data-view
- Карточки команд, строки игроков и карты вето рисует `app.js`
  (классы `team-card`, `player-row`, `map-card` и т. п.) — их вид
  меняется в `style.css`.
- Оба режима, день и ночь, должны остаться; на ширине 375px не должно
  быть горизонтальной прокрутки (это проверяет тест).

## Данные

- Составы: https://docs.google.com/spreadsheets/d/1e__ijBjufD19SWBkSJL177vmmfMh2tdykYQHAS06S8I/edit,
  лист игроков GID 1315978454 (A ID, B команда, C слот, D ник, E ID потока,
  F room, I роль). Таблица должна быть открыта на просмотр по ссылке.
- Расписание: таблица организатора
  https://docs.google.com/spreadsheets/d/1GtwcpVnyxY1YOs6ZTrXwJr5mjZqI0QxjLSKjimn9G2o/edit,
  лист «Schedule (Group Stage)» GID 815739139 (колонки по заголовкам:
  Stage, Date, MSK, Team 1, Team 2; у каждой строки своя дата).
  Старый дневной лист «Матчи ДД.ММ» (B время, C/D команды, E группа)
  тоже разбирается: `parseSchedule` различает форматы по заголовку.
- Логотипы команд: `assets/teams/teams.json` (название → файл) и PNG
  рядом; `scripts/extract_team_logos.py` достаёт их из таблицы
  организатора (.xlsx).
- Снимки таблицы не коммитить: `claude-artifact/data/` и
  `claude-artifact/dist/` в `.gitignore`.
