# Заметки для ИИ-агентов (Codex, ChatGPT, Claude)

Oneshot Panel — статическая веб-панель эфирной команды CyberClash.
Две вкладки. «Подготовка»: составы и расписание из Google Sheets, 10 вебок
по слотам 01–05 / 06–10, ссылки VDO.Ninja игрокам, статус вебок, OBS
(отправка в открытый OBS или JSON-коллекция 1920×1080) и вето карт
BO1/2/3/5 с текстом для HLTV и оверлеем. «Лобби»: турнир FACEIT, оповещения
о концах карт и матчей, тексты для Discord, журнал пауз.
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
  вето, выбор фото и логотипа для карточки. Покрыта `test/core.test.js`.
- `app.js` — интерфейс «Подготовки»: загрузка таблиц, отрисовка,
  localStorage (`webcam-desk-source`, `oneshot-webcam-match-v1`), вето,
  копирование, скачивание JSON. Отдаёт `window.oneshotPanel.snapshot()`
  и событие `oneshot:change` для `live.js` и `lobby.js`; сам их не знает
  (в артефакте Claude их нет).
- `live.js` — только сайт: вкладки, «Отправить в OBS», «Копировать JSON»,
  форму «Подключение к OBS» рядом с вето, статус вебок, живое вето в OBS и ссылка на оверлей.
  localStorage: `oneshot-obs` (режим, код связи, адрес и пароль OBS),
  `oneshot-view`, `oneshot-watch-cams`, `oneshot-veto-live`,
  `oneshot-veto-channel` (отдельный код показа графики, не код управления OBS).
  `obsDialog` — раскрываемый `details` с единственной формой подключения;
  оформление формы и подсказок — `assets/obs-connection.css`.
- `assets/obs-qr.js` — только сайт: локальное чтение QR камерой/из файла,
  парсер native `obsws://host:port/password`, QR связи телефона с доком.
  QR только заполняет ручные поля; локальный адрес — 127.0.0.1 с портом из QR.
  В режиме «На другом компьютере» один сканер принимает оба QR: QR дока
  даёт код связи, QR OBS — порт и пароль для дока (блок «OBS обсервера»).
  Пароль не включать в URL Oneshot и не логировать содержимое native QR.
  Локальные QR-библиотеки и лицензии — `assets/vendor/`, без npm/CDN.
- `obs.js` — без DOM: клиент obs-websocket v5 (пароль через WebCrypto),
  `applyMatch` переводит импортированную коллекцию на новый матч
  (CAM переименовываются и получают ссылки, CARD создаются под камерой
  или скрываются), `emitVeto` — событие obs-browser `oneshot-veto`.
  Покрыт `test/obs.test.js` (мок obs-websocket на сокетах Node).
- `vdo.js` — скрытые iframe VDO.Ninja. `CamWatch`: зритель
  `?room&scene&view=id1,id2&novideo&noaudio`, кто публикуется (getStreamIDs,
  view-connection). `VdoLink`: канал панели и дока OBS — док публикует
  поток только с данными (`push`), панели его смотрят (`view`); ID потока и
  пароль VDO.Ninja выводятся из кода связи, сообщения запечатаны AES-GCM
  (PBKDF2 от кода). Комната с `&dataonly` на выпущенном VDO.Ninja не
  соединяет — не возвращай её.
- `obs-bridge.html`, `obs-bridge.js` — док для OBS обсервера
  (Пользовательские док-панели браузера, `#k=<код>`): принимает команды
  панели и выполняет их через obs-websocket этого компьютера. Порт и
  пароль OBS может прислать панель (`obs-config`): док берёт только
  127.0.0.1/localhost/[::1] (`loopbackObsUrl` в `obs.js`) и сохраняет их,
  лишь когда OBS их принял. Панель этот пароль не хранит. localStorage
  дока: `oneshot-obs-bridge`.
- `faceit.js` — без DOM: разбор ссылки турнира, сводка матча, события
  (карта, матч, отмена, PAUSED), тексты «GG» и «Next xx:MM», клиент Data API
  с переходом на прокси `/api/faceit` при CORS. Покрыт `test/live.test.js`.
- `lobby.js` — вкладка «Лобби»: опрос турнира каждые 20 с, звук, уведомления
  браузера, бейдж вкладки, ручной таймер тех. паузы, журнал. localStorage:
  `oneshot-lobby` (ссылка, ключ, шаблоны, задержка), `oneshot-lobby-log`.
- `netlify/functions/faceit.mjs` — прокси FACEIT для браузера (только пути
  лобби, ключ приходит от админа и дальше не хранится); `server.js`
  отдаёт его же на `/api/faceit`.
- `assets/veto-overlay/` — анимированный оверлей вето (Codex): `overlay.html`
  берёт начальный снимок из `#s=`, живые снимки — по отдельному зашифрованному
  каналу VDO.Ninja (`&r=` в фрагменте URL). Панель публикует, источник смотрит
  и подтверждает `veto-received`; повторы каждые 2,5 с восстанавливают состояние
  после reload. Нативное событие `oneshot-veto` оставлено для совместимости,
  но успешный vendor request не доказывает доставку в браузер. `?preview=1` —
  демо. Свой README и `scripts/qa_veto_overlay.py` (нужен WebGL).
- `card.html`, `card.js`, `card.css` — карточка игрока 1920×1080
  (`/card.html?team=…&nick=…`): фон `assets/card/background.jpg`, логотип CyberClash и логотип
  команды, ник, фото HLTV из `assets/players/players.json`. В OBS JSON
  добавляется под каждой камерой только при включённом includeCards
  (`CARD NN | Команда | Ник`); фото и логотип `card.js` выбирает через
  `playerPhoto`/`teamLogo` из `core.js` (их же использует
  `scripts/build_match_packages.mjs`). Оформление — токены `--card-*`.
  Фото крупно по центру; при отсутствии/ошибке фото — эмблема команды
  и ник по центру. Совпадение ника в другой команде не даёт фото.
- `scripts/build_match_packages.mjs` и `scripts/render_match_cards.py` —
  эфирный пакет по дате из живых таблиц: готовые CARD внутри JSON, JPG,
  исходные фото и переносимые локальные коллекции. Workflow
  `.github/workflows/match-package.yml` проверяет все встроенные карточки
  без сети. Веб-CSP не меняется: data-документы находятся только в OBS JSON.
- `scripts/fetch_player_photos.py` — скачивает фото HLTV из
  `players.json` (поле `photo`) в `assets/players/` и заполняет `file`.
  Netlify запускает его с `--allow-missing` до копирования сайта: ошибки
  отдельных фото дают заглушку; веб-страница не обращается к HLTV.
  Проверенные файлы фото и заполненные file хранятся в Git: нельзя
  публиковать каталог с пустыми file при наличии подготовленных фото.
- `server.js` — локальный статический сервер. Отдаёт только файлы из
  `publicFiles` и `assets/`: новый файл в корне добавь в `publicFiles`.
- `DEPLOY.md` — размещение на своём сервере (nginx) или домене; при смене
  списка файлов сайта или заголовков обнови и его.
- `netlify.toml` — хостинг на Netlify, те же заголовки безопасности, что в
  `server.js` (тест сверяет, что они совпадают). Сборка пишет коммит в
  `build.txt`; `check.yml` ждёт его перед проверкой опубликованного сайта.
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
- `scripts/qa_browser.py` — 25 браузерных сценариев (Python Playwright +
  Chromium), VDO.Ninja в них заглушён. `scripts/qa_player_cards.py`
  проверяет все записи подготовленного каталога и 10 CARD-ссылок
  скачанного JSON; `test/photos_test.py` — загрузчик. `scripts/qa_live.py` —
  8 сценариев сайта: настройка OBS рядом с вето, вкладки, статус вебок, OBS напрямую и через док,
  копирование JSON, оверлей вето, лобби FACEIT (Sheets, VDO.Ninja,
  obs-websocket и FACEIT подменены, время лобби ускорено).
  `scripts/qa_obs_runtime.py` / workflow «OBS runtime regression» проверяет
  официальный OBS с настоящим CEF и VDO.Ninja: ручные ходы, подтверждение,
  анимации и восстановление после reload; только Sheets подменены.
  Матрица Chromium / мобильный WebKit проверяет касания, доступность меню,
  порядок ходов, PICK до стороны соперника и задержку десайдера. На CI у CEF
  отключён GPU из-за нестабильности виртуального драйвера; WebGL проверяется
  отдельно через qa_veto_overlay.py.

## Команды

```sh
npm run check        # синтаксис
npm test             # 52 теста (node:test)
PORT=3000 node server.js
python3 scripts/qa_browser.py --url http://127.0.0.1:3000 --chromium /path/to/chrome
python3 scripts/qa_live.py --url http://127.0.0.1:3000 --chromium /path/to/chrome
python3 claude-artifact/build_oneshot_artifact.py
```

Node.js >= 22. Внешних npm-зависимостей нет и не добавлять. Компиляции нет:
Netlify проверяет локальные фото, докачивает недостающие и копирует сайт в public/.

## Что нельзя ломать

Эти форматы используют в эфире, тесты проверяют их дословно.

- Текст игрокам: заголовок `## Команда` и строки
  `**Ник** https://vdo.ninja/?room=<room>&broadcast&do&push=<id>`.
- Текст обсерверу: только порядок слотов `N. Команда — Ник`, без ссылок.
- Имя JSON без пробелов: `16-00_Группа-B_КомандаA_vs_КомандаB.json`.
- OBS JSON: сцены «Игрок 1–10» и «Матрица», камеры вписаны в 1920×1080,
  поворот 0, без обрезки, новые UUID при каждом экспорте; источники
  называются `CAM NN | Команда | Ник`. По умолчанию экспорт без карточек.
  Галочка includeCards добавляет прямо под камерой источник браузера
  `CARD NN | Команда | Ник` с card.html сайта панели (в артефакте —
  https://onepanel.netlify.app). Выбор не сохраняется в localStorage.
  Ссылка камеры
  заканчивается на `&cleanoutput&transparent`: без видео VDO.Ninja
  прозрачен, и видна карточка.
- Вето как на veto.oneshot.su. Пул: Ancient, Anubis, Cache, Dust2,
  Inferno, Mirage, Nuke. Текст HLTV строками вида `X removed Map`,
  `X pick Map (Y CT)` или `(Y T)` — сторона соперника, последняя —
  `Map was left over`.
- «Отправить в OBS» меняет только сцены «Игрок 1–10» уже импортированной
  коллекции; нет сцены — понятная ошибка до первого изменения. Имена
  источников те же, что в JSON.
- Сообщения моста (запечатаны): `apply {id, title, match}`, `veto {id,
  state}`, `hello {id}`, `obs-config {id, url, password}` от панели; `result {id, ok, error|summary}` и
  `presence {ok, obs}` от дока.
- Код показа вето не даёт управлять OBS: нельзя переиспользовать код дока
  или включать пароль OBS в URL источника. Сообщения показа: `veto-state {id,
  state}`, `veto-received {id}`. Зелёный статус вето — только после подтверждения
  текущего id от источника; статус дока не означает, что графика добавлена.
- Порядок карточек панели: завершённые ходы, pending-пик, затем остаток пула.
  PICK виден до выбора стороны; side по-прежнему относится к сопернику.
  Задержка десайдера 1500 мс — только показ, без изменения core.js/текста HLTV.
  Новые URL layout=strip&crop=1 дают 1920×400; старые strip URL — прежние
  1920×1080 с прозрачным верхом. Для OBS ниже плашки остаётся место под камеры.
- Снимок вето для оверлея: `{version: 1, teams, format, first, actions,
  pending, stage}` — контракт `window.vetoOverlay.setState`.
- CSP: `script-src 'self'`, `style-src 'self'`, `img-src 'self'`. Никаких
  inline-скриптов, CDN, Google Fonts и `data:`-картинок в веб-версии.
  `connect-src`: `'self'`, `https://docs.google.com`, `https://open.faceit.com`,
  `ws://127.0.0.1:*`, `ws://localhost:*` (OBS на этом компьютере);
  `frame-src https://vdo.ninja`.
- Разметка только для сайта обёрнута в `<!-- web-only -->…<!-- /web-only -->`:
  сборщик артефакта вырезает её. Новое для сайта в index.html — туда же.

## Редизайн

Разметку и стили можно менять свободно, но сохраняй `id` и
`data-`атрибуты: на них завязаны `app.js` и браузерные тесты.

- id: sidebarSource themeToggle webcams syncDot syncTitle syncTime
  refreshBtn settingsBtn errorBox scheduleLabel matchSelect matchTime
  matchStage swapBtn teamGrid exportBar exportHint filenamePreview
  downloadBtn includeCards tabObserver tabPlayers outputPanel previewLabel copyAllBtn
  output copyFoot veto vetoHeading vetoFormat vetoFirst vetoStatus
  sideChoice sideLabel chooseCT chooseT cancelSide mapGrid vetoUndo
  vetoReset autoCopyVeto vetoHint copyVeto vetoOutput settingsDialog
  settingsForm settingsHeading closeSettings sourceError sourceUrl
  sourceGid scheduleUrl scheduleGid resetSource copyDialog copyHeading
  closeCopy manualCopy toast
- id сайта (`live.js`, `lobby.js`, `obs-bridge.js`): viewPrep viewLobby
  lobbyBadge prepView lobbyView camSummary watchCams camTotal sendObsBtn
  copyJsonBtn obsNavBtn obsSetupBtn obsDot obsState vetoLive vetoLiveStatus vetoLayout copyOverlay
  obsDialog obsForm closeObs vetoBroadcast overlaySizeHint obsBridgeFields obsDockUrl copyDockUrl obsCode
  newObsCode obsRemotePort obsRemotePassword sendObsConfig obsRemoteResult
  obsDirectFields obsUrl obsPassword obsTestResult testObs
  saveObs notifyBtn soundBtn lobbyForm faceitUrl faceitKey lobbyStart
  lobbyStatus lobbyError lobbyAlert lobbyAlertText lobbyAck lobbyMatches
  nextDelay copyThanks msgThanks nextMatch copyNext msgNext tplThanks
  tplNext resetTemplates copyJournal lobbyLog; док: dockPanel dockPanelDot
  dockObs dockObsDot dockForm dockCode dockUrl dockPassword dockLog
- data-атрибуты (их ставит `app.js`): data-copy-team data-map data-player
  data-reset data-slot data-team data-view; `live.js`: data-cam (live, off,
  wait, none) на `.player-row`; `lobby.js`: data-match data-pause data-side
  data-resume data-since
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
- Фото игроков: `assets/players/players.json` — команда, ник, `aliases`,
  ссылка HLTV, `photo` (img-cdn.hltv.org/playerbodyshot, w=400) и `file`.
  Ссылки на фото собраны со страниц HLTV (лист «Teams (Group Stage)»
  таблицы организатора даёт ссылки на профили). hltv.org закрыт
  Cloudflare: страницы читаются только через браузерный сервис, а сами
  картинки с img-cdn.hltv.org качаются обычным запросом.
- FACEIT: ссылка на турнир `faceit.com/<lang>/championship/<uuid>/…`,
  Data API v4 с client-side ключом админа. Матчи турнира приходят списками
  ongoing/upcoming/past; `results`/`detailed_results` считают карты, счёт
  раундов — `/matches/{id}/stats` после матча. Тех. пауз в API нет (статус
  PAUSED ловится, если FACEIT его ставит); ручной таймер — в лобби.
- Снимки таблицы не коммитить: `claude-artifact/data/` и
  `claude-artifact/dist/` в `.gitignore`.
