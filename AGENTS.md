# Заметки для ИИ-агентов (Codex, ChatGPT, Claude)

Oneshot Panel — статическая веб-панель эфирной команды CyberClash.
Четыре вкладки. «Подготовка»: составы и расписание из Google Sheets, 10 вебок
по слотам 01–05 / 06–10, ссылки VDO.Ninja игрокам, статус вебок, OBS
(отправка в открытый OBS или JSON-коллекция 1920×1080). «Вето»: живая
комната вето капитанов, вето карт BO1/2/3/5 с текстом для HLTV и оверлеем,
ссылки капитанам (в артефакте Claude вето остаётся на одной странице).
«Лобби»: турнир FACEIT, оповещения о концах карт и матчей, тексты для
Discord, журнал пауз. «OBS»: подключение и инструкция. «Букмекеры»: наш
турнир в линиях контор.
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
  localStorage (`webcam-desk-source`, `oneshot-webcam-match-v1`,
  `oneshot-stream-ids` — новые ID потоков от кнопки ↻ справа от игрока:
  два нажатия, новый ID `ник_xxxxxx` (`newStreamId`), сообщение игроку
  копируется сразу; ✎ (`data-setid`) — ID, под которым игрок реально
  зашёл (старая ссылка), вручную, сообщение не копируется (`manual`);
  действует, пока в таблице прежний ID, —
  `applyStreamIds`; «вернуть» в строке отменяет), вето,
  копирование, скачивание JSON. Отдаёт `window.oneshotPanel.snapshot()`
  и событие `oneshot:change` для `live.js` и `lobby.js`; сам их не знает
  (в артефакте Claude их нет).
- `live.js` — только сайт: вкладки (Подготовка, Вето, Лобби, OBS, Букмекеры), «Отправить в OBS», «Копировать JSON»,
  вкладку «Вето» (`vetoNavBtn`, `vetoView`: живая комната капитанов `cvLive`,
  затем `#veto` — live.js переносит его туда из «Подготовки», в артефакте он
  остаётся на месте, — затем блок ссылок `captainVeto`),
  вкладку «OBS» (`obsNavBtn` — четвёртая вкладка, `obsView`: форма «Подключение к OBS» и
  пошаговая инструкция `.obs-manual`), статус вебок, живое вето в OBS и ссылка на оверлей.
  localStorage: `oneshot-obs` (режим, код связи, адрес и пароль OBS),
  `oneshot-view`, `oneshot-watch-cams`, `oneshot-veto-live`,
  `oneshot-veto-channel` (отдельный код показа графики, не код управления OBS).
  `obsDialog` — секция вкладки «OBS» с единственной формой подключения
  (`closeObs` — «← К подготовке»);
  оформление формы и подсказок — `assets/obs-connection.css`.
- `assets/obs-qr.js` — только сайт: локальное чтение QR камерой/из файла,
  парсер native `obsws://host:port/password`, QR связи телефона с доком.
  QR только заполняет ручные поля; локальный адрес — 127.0.0.1 с портом из QR.
  Сканер есть только в режиме «У обсервера» (`obsPairQr` в «Другие
  способы», `obsMore`): QR окна Oneshot даёт код связи, QR OBS — порт и
  пароль (`obsRemoteBox`). В режиме «На этом компьютере» QR нет. Блок «У
  обсервера» для людей без опыта: схема «сайт ⇄ окно Oneshot ⇄ OBS», шаг 1
  — готовое сообщение обсерверу со ссылкой и тремя пунктами
  (`obsDockMessage`, кнопка `copyDockUrl` копирует его), шаг 2 — статус
  (`obsBridgeStatus`), остальное свёрнуто. В текстах для людей док
  называется «окно Oneshot».
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
- `veto.html`, `veto.js`, `veto.css`, `veto-room.js` — сайт вето для
  капитанов (только сайт). По умолчанию на английском, флаги EN/RU в шапке
  (`data-lang`, тексты — `WORDS` в `veto.js`, атрибут `data-i18n`, выбор в
  localStorage `oneshot-veto-lang`). Без `#v=` — форма админа (`#new&a=&b=&f=&m=` от
  кнопки `playerVeto` панели; блок «Настройки вето»: `vtMatch` — матчи из той же таблицы
  расписания, источник панели из `webcam-desk-source`, формат, таймер `vtTimer`):
  четыре ссылки — капитану каждой команды (в ЛС), зрителям (можно публично) и
  админу (`o`, только у нас: как зритель плюс текст для HLTV; у капитанов и
  зрителей HLTV нет). Ссылка короткая (~140 символов):
  `#v=` — base64url байтов: версия 4 (старые v2/v3 поддерживаются), место (a, b, s, o) | формат << 2 | таймер << 4,
  затем байт старта: 0 — монетка (по умолчанию), 1/2 — A/B получает первый пик (BO1: первый бан),
  (`TIMERS`: 5, 3, 7, 10, 15 мин, 0 — без таймера), код комнаты (10),
  отпечатки ключей A и B (10 + 10), секрет капитана (16, только капитанам),
  названия команд. Ключ ECDSA P-256 капитана выводится из секрета
  (`captainKey`, своя арифметика P-256 — `publicPoint`), публичные ключи
  ходят в сообщениях (`p`) и принимаются только по отпечатку
  (`acceptKey`). Ход засчитывается, только если подписан капитаном, чей
  сейчас ход (`verifyLog`), кто бы ни переслал журнал. Монетку бросают
  капитаны в комнате, когда оба на сайте (сами, без кнопок): A —
  `commit` (SHA-256 случайной части, она в localStorage
  `oneshot-veto-coin:<код>`), B — `seed`, A — `reveal`; победитель —
  `(nonce[0] ^ seed[0]) & 1`; заранее не знает никто, включая админа.
  При room.starter = 0/1 монетка и order пропускаются. BO3/BO5 начинает
  назначенная команда; в BO2 — соперник, чтобы первый пик достался выбранной.
  Старые v3 с room.chooser сохраняют выбор order, в том числе при restartRoom.
  Для v3/v4 подписи ходов и конвертов включают все правила комнаты и ключи,
  v2 сохраняет прежний формат подписи.
  Победитель выбирает, кто банит первым; после пика сторону выбирает
  соперник (как в core: `Y CT`). Таймер — только счётчик от выбора
  порядка, без автоходов; отсчёт от min(время хода, когда этот браузер его
  увидел), чтобы спешащие часы соперника его не останавливали (время хода
  проверяется: настоящая дата, по порядку, ±1 мин между устройствами).
  Карты по порядку вето, как в панели: сделанные ходы, пик без стороны,
  остаток пула; переезд карты — анимация FLIP.
  У каждой команды ссылка на HLTV (`assets/teams/hltv.json`, `teamHltv` в
  core.js: только https://www.hltv.org/team/<id>/<slug>, имя без учёта
  регистра и акцентов). «Позвать админа» (`vtCallAdmin`, раз в 30 с): вызов
  едет в сообщениях капитана 2 минуты (`call`), звонит только на админской
  ссылке (`vtAlert`, звук и мигающий заголовок, «Понял» — отвеченные в
  localStorage `oneshot-veto-calls:<код>`); принимается только из свежего
  потока самого капитана и с подписью его ключом. Связь: каждый капитан публикует свой поток
  VDO.Ninja только с данными и смотрит поток соперника, зрители смотрят
  оба и сами ничего не шлют; ID потоков, пароль и ключ AES-GCM выводятся
  из кода комнаты. Капитаны подписывают весь конверт журнала своим ключом:
  присутствие подтверждает либо их отдельный поток, либо подписанный конверт
  через живой обратный data-канал (полю from без подписи не доверять).
  Новому view-iframe даётся 30 с на сигналинг; последующие попытки ждут
  60 и затем до 90 с, чтобы не обрывать медленный сигналинг. После первых данных
  молчащий канал пересоздаётся через 15 с. Ручное переподключение перезапускает
  также push-iframe текущего издателя, не забирая Web Lock у другой вкладки.
  Капитаны рассылают журнал и ключи каждые 2,5 с; чужой журнал принимается,
  только если продолжает свой ход в ход
  (`mergeLog`, сравнение по k/v/at, не по подписи). Другой ход на уже
  виденном шаге — конфликт: остаётся первый, всем видно предупреждение.
  Две вкладки одного капитана подписывают по очереди (`navigator.locks` +
  общий журнал в localStorage). localStorage:
  `oneshot-player-veto` (последние ссылки админа),
  `oneshot-veto-log:<код>`, `oneshot-veto-keys:<код>`, `oneshot-veto-coin:<код>`. Логика покрыта `test/veto-room.test.js`,
  страница — `scripts/qa_veto_site.py` (три отдельных браузера).
- Читаемые капитанские адреса — `/<турнир>_<команда>#k=<22 символа>`:
  `assets/veto-short-links.js` шифрует исходный `#v=` AES-GCM, ключ остаётся
  во фрагменте; `assets/veto-short-protocol.js` задаёт формат. Endpoint
  `/api/veto-link` хранит неизменяемый зашифрованный документ по SHA-256
  ключа без автоматического срока действия. Cloudflare использует тот же
  класс DO в отдельном пространстве имён `short:`; Node — каталог `links/`.
  Две формы (`vtTournament`, `cvTournament`) вызывают `friendlyCaptainLinks`;
  отказ сервиса оставляет обычные ссылки. Открытие — `resolveRoomLink`;
  проверенный зашифрованный документ кешируется для перезагрузки без API.
  `functions/[vetoSlug].js` и Worker отдают `veto.html` по красивому пути.
  Старые `#v=` ссылки и админская/зрительская ссылки остаются совместимыми.
- Сайт вето — отдельный репозиторий `ssolutionn/Oneshot-Veto` (Cloudflare
  Pages, без сборки, https://oneshot-veto.pages.dev/ — каждый пуш в main
  выходит сам; старый Worker oneshot-veto.cyberclash.workers.dev оставлен
  для уже разосланных ссылок): его содержимое генерирует `node scripts/build-veto-site.mjs`
  (в `dist-veto/`, не коммитится): страницы вето (`index.html` = `veto.html`),
  `veto*.js`, `vdo.js`, `core.js` без таблицы составов (id/gid пустые) и без
  адреса панели, нужные ассеты и `_headers`. Скрипт падает, если в копию
  попал ID таблицы или адрес панели (`test/veto-site.test.js`). Игроки видят
  только адрес сайта вето. После правок вето: пересобрать и запушить копию
  в `oneshot-veto` (main).
  `server/veto-deploy-cloudflare.yml` генерируется в workflow отдельного сайта:
  Worker/Durable Objects → Pages → проверка публичных файлов/CSP/health
  (`scripts/verify_veto_deployment.py`, в копии `scripts/verify_deployment.py`).
  Требует Cloudflare secret/variable в Oneshot-Veto; значения в код не писать.
  Pages использует service binding `VETO_RELAY_SERVICE` к Worker `oneshot-veto`.
  В edge fetch допустимы `redirect: 'manual'/'follow'`; `'error'` не поддерживается.
- Блок панели «Вето для капитанов» (`live.js`, только сайт, `captainVeto`):
  формат (как у вето панели, пока не изменён здесь), таймер, язык сообщений
  капитанам (English по умолчанию) → четыре ссылки для текущего матча
  (`createRoom` из `veto-room.js`) на сайт вето (`VETO_SITE`,
  https://oneshot-veto.pages.dev/, поле `cvSite` меняет); админская — отдельно,
  «Открыть вето ↗». localStorage `oneshot-captain-veto` (таймер, язык, адрес
  сайта, последние ссылки на 6 ч).
- Живая комната во вкладке «Вето» (`live.js` + `veto-watch.js`, только
  сайт): панель смотрит комнату последних ссылок (6 ч, при смене матча
  не отключается — вставлять ничего не надо) или вставленную ссылку любой
  комнаты, сделанной не в панели (`cvWatchLink` в свёрнутом `cvWatchMore`;
  секрет капитана отбрасывается, хранится только админская ссылка) как
  админская ссылка: два скрытых view-iframe VDO.Ninja на потоки капитанов,
  только слушает; первый сигналинг ждёт 30 с, повторные попытки — 60/90 с, потерю уже работающего
  viewer определяет через 15 с.
  Кто online (по потоку, не по from), монетка, ходы со
  временем, таймер, «Позвать админа» (баннер `cvAlert`, звук, бейдж
  `vetoBadge`, мигающий title, уведомление браузера, если разрешено).
  HLTV в панели нет — ссылки HLTV для игроков на сайте вето. Галочка
  `cvSync`: каждый новый ход капитанов → `window.oneshotPanel.setVeto` (в
  порядке команд панели, ⇄ учитывается; другой матч — не переносится) →
  вето панели и оверлей. Ручная правка в панели держится до следующего
  хода; «Сбросить вето» панели снимает `cvSync` (иначе комната вернёт
  ходы). Состояние галочки запоминается для комнаты (`syncOff`).
  `cvRestart` «↺ Начать вето заново» — новая комната с теми же командами,
  форматом, таймером и сайтом, новые ссылки (`captainVeto`), вето панели с
  нуля: ходы капитанов не отменяются, старая комната просто брошена.
  localStorage `oneshot-veto-watch` (вставленная комната, проверенный
  журнал, отвеченные вызовы, `syncOff`).
- `veto-watch.js` — `RoomWatch` (проверка подписей и `mergeLog` из
  `veto-room.js`, присутствие, вызовы; транспорт подменяется в тестах),
  `adminRoom`, `roomToPanel`, `roomMoves`. Покрыт `test/veto-watch.test.js`.
- `bookmakers.js` — без DOM: публичные линии лицензированных БК, где
  есть открытый JSON/HTML без входа и капчи: Фонбет, PARI, Bettery и 24bet
  (одна платформа, `showEvents`, skId 29086, свои хосты и scopeMarket), Леон
  (`leon.ru/api-ext/betline-exports/esports`, ссылка — только leon.ru), OLIMPBET (`api/v4/0/{line|live}/…vids[]=112:`),
  Марафон (HTML страницы CS2), Бетсити (`ad.betcity.ru/d/{off|on_air}/events…ids_sp=73`). Парсеры оставляют только CyberClash,
  `findMatch` сопоставляет команды без акцентов и суффиксов в любом
  порядке. Winline — публичный бинарный WebSocket прематча, отдельный
  модуль `assets/bookmaker-winline.js`: gzip, словарь 16, снимок 3,
  подписка только lang/AA==/data/WINLINE/getdate, без учётной записи.
  На Cloudflare используется HTTP Upgrade. Повреждённые/неизвестные
  пакеты дают ошибку, не пустой турнир. Реальные сжатые фикстуры —
  `test/fixtures/bookmakers/winline-*.base64`, тесты — `test/winline.test.js`.
  Балтбет — полная JSON-линия `events.baltbet.ru/api/prematch/sport/25/events?offset=all`,
  публичный appSource UniRu, только CS2 и CyberClash; размеры дополнительных
  коэффициентов подписаны именно как дополнительные, не общим числом рынков.
  Спортбет — `bthm-server.sportbet.ru/events.table`, фиксированный slug
  `esport-counter-strike`, прематч и лайв; валидная пустая таблица отличается
  от ошибки источника. Реальный ответ был пуст; положительный тест явно
  использует синтетические названия на реальном формате другого спорта.
  `MANUAL` — пять ещё не подключённых контор, всегда явно отмечены;
  не считать их отсутствием линии. Подробности — `BOOKMAKERS_STATUS.md`.
- `netlify/functions/bookmakers.mjs` — `/api/bookmakers?id=<бк>`: сервер
  сам ходит в фиксированные адреса линий (из запроса берётся только id),
  зеркала по очереди, линия и лайв отдельно; отдаёт только CyberClash.
  Обёртки: `functions/api/bookmakers.js` (Cloudflare), `server.js`.
- `assets/bookmaker-transport.js` — ограниченные чтения и WebSocket Upgrade:
  дедлайн не зависит от поддержки AbortSignal, поздние ответы закрываются.
  Проверен на зависшем fetch и теле ответа в `test/bookmaker-transport.test.js`.
- `bookies.js` — только сайт: блок «Наш турнир у букмекеров» в своей вкладке
  «Букмекеры» (`bookiesNavBtn`, `bookiesView`; `bookies`, `bookiesCheck`, `bookiesCopy`, `bookiesCsv`,
  `bookiesTable`, `bookiesStatus`):
  раз в минуту, с возобновлением после скрытия вкладки/потери сети; строки — все 16 лицензированных БК (автоматические и
  `MANUAL` со ссылкой), столбцы — матчи ближайшего дня; кэфы текстом, ссылка
  отдельной ↗ (блокировщики рекламы прячут ссылки на БК вместе с текстом);
  в клетке ещё другие рынки ленты (`markets`: фора по нашей первой команде,
  тотал [Б, М]; `marketText`), размер линии (`size`: исходов или рынков,
  как считает БК) и лайв (сейчас / был / заявлен — `liveOffered`);
  название турнира так, как его пишет контора (`.bk-tournament` под конторой, в
  подсказке клетки, в «Сводке», в CSV — «Турнир у конторы» и в журнале), без
  «правильного» для сравнения;
  новая линия — запись в журнал лобби (`oneshot:lobby-note`). «Сводка» —
  текст для чата, «CSV» — все линии недели (открытие и текущие кэфы).
  localStorage: `oneshot-bookies` (`lines` — линии недели, `checked` —
  когда БК проверяли в этом браузере).
  Блок `bookiesHistoryTable` показывает общий архив и локальные наблюдения за
  выбранный `bookiesDay` (МСК). Общий архив — ветка `bookmaker-history`,
  `days/YYYY-MM-DD.json`; читает `/api/bookmakers?history=YYYY-MM-DD`.
  `assets/bookmaker-history.js` проверяет и объединяет только публичные поля;
  workflow `bookmaker-history.yml` собирает ответы API Cloudflare раз в 10 мин
  (`scripts/read_bookmaker_observations.py`, `collect_bookmaker_history.mjs`).
  Сайт не принимает записи. Пустой/неуспешный ответ не удаляет виденные матчи;
  отсутствие наблюдений не является отсутствием линии. Старый CSV недели остаётся.
- `faceit.js` — без DOM: разбор ссылки турнира, сводка матча, события
  (карта, матч, отмена, PAUSED), тексты «GG» и «Next xx:MM», клиент Data API.
  Пока карта идёт, FACEIT кладёт в results.score раунды этой карты
  (`rounds`), а счёт по картам берётся из detailed_results. По раундам:
  один тихий «мап-поинт» и одно «карта взята» на карту (MR12, овертайм до 4
  из 6 — `mapWon`), решающая карта — сразу «матч закончился»; `sent` хранит
  уже сказанное, повторов нет. Клиент Data API
  с переходом на прокси `/api/faceit` при CORS. Покрыт `test/live.test.js`.
- `lobby.js` — вкладка «Лобби»: опрос турнира и/или комнат матчей
  (`parseFaceitTargets`; каждый запрос отдельно, отказ одного не роняет
  остальные) каждые 20 с, звук, уведомления
  браузера, бейдж вкладки, ручной таймер тех. паузы, журнал. localStorage:
  `oneshot-lobby` (ссылка, ключ, шаблоны, задержка), `oneshot-lobby-log`.
- `netlify/functions/faceit.mjs` — прокси FACEIT для браузера (только пути
  лобби). Ключ админа из заголовка идёт в FACEIT и не хранится; без него
  `proxyFaceit` берёт ключ сайта из секрета хостинга `FACEIT_API_KEY`
  (только для `Sec-Fetch-Site: same-origin`, в ответ не попадает). Ключ
  в репозиторий и в код не класть. `server.js` отдаёт тот же прокси на
  `/api/faceit` (ключ сайта — переменная окружения).
- `assets/veto-overlay/` — анимированный оверлей вето (Codex): `overlay.html`
  берёт начальный снимок из `#s=`, живые снимки — по отдельному зашифрованному
  каналу VDO.Ninja (`&r=` в фрагменте URL). Панель публикует, источник смотрит
  и подтверждает `veto-received`; повторы каждые 2,5 с восстанавливают состояние,
  а отсутствие подтверждений 15 с пересоздаёт уже работавший VDO-канал
  с обеих сторон; новому соединению даётся 30 с, повторным попыткам — 60/90 с.
  Нативное событие `oneshot-veto` оставлено для совместимости,
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
- `scripts/build-site.sh` — единая сборка для Netlify, Cloudflare Pages и
  CI: копирует файлы `publicFiles` и `assets/` в `public/`, на Cloudflare
  (`CF_PAGES`) добавляет `_headers`, пишет коммит в `build.txt`
  (`COMMIT_REF` или `CF_PAGES_COMMIT_SHA`). Новый файл в корне — в
  `publicFiles` и в строку `cp` скрипта (тест сверяет).
- `netlify.toml` — хостинг на Netlify (`sh scripts/build-site.sh`), те же
  заголовки безопасности, что в `server.js`. `_headers` — они же для
  Cloudflare Pages; `functions/api/faceit.js` — прокси FACEIT как Pages
  Function (обёртка над `netlify/functions/faceit.mjs`). Тест сверяет
  заголовки всех трёх. `check.yml` ждёт `build.txt` на сайте
  `vars.PUBLISHED_URL` (иначе oneshot-panel.pages.dev) перед проверкой.
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
- `scripts/qa_browser.py` — 29 браузерных сценариев (Python Playwright +
  Chromium), VDO.Ninja в них заглушён. `scripts/qa_player_cards.py`
  проверяет все записи подготовленного каталога и 10 CARD-ссылок
  скачанного JSON; `test/photos_test.py` — загрузчик. `scripts/qa_live.py` —
  10 сценариев сайта: вкладка OBS с инструкцией, вкладки, статус вебок, OBS напрямую и через док,
  копирование JSON, оверлей вето, лобби FACEIT (Sheets, VDO.Ninja,
  obs-websocket и FACEIT подменены, время лобби ускорено).
  `scripts/qa_veto_site.py` — 13 сценариев сайта вето капитанов (английский
  по умолчанию и флаг RU, HLTV только у админа, порядок карт, «Позвать
  админа», вкладка «Вето» панели следит за капитанами): ссылки,
  монетка, BO3/BO1 (клавиатурой)/BO5 в отдельных браузерах, reload и
  поздний зритель, подделка хода и присутствия зрителем, переподписанный
  ход капитана, две вкладки капитана, конец 5 минут, HTML в названиях,
  375px. Workflow «Veto site regression» гоняет его в Chromium и WebKit и
  с настоящим VDO.Ninja (`--real-vdo`).
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
npm test             # тесты node:test
PORT=3000 node server.js
python3 scripts/qa_browser.py --url http://127.0.0.1:3000 --chromium /path/to/chrome
python3 scripts/qa_live.py --url http://127.0.0.1:3000 --chromium /path/to/chrome
python3 scripts/qa_veto_site.py --url http://127.0.0.1:3000 --chromium /path/to/chrome
python3 claude-artifact/build_oneshot_artifact.py
```

Node.js >= 22. Внешних npm-зависимостей нет и не добавлять. Компиляции нет:
Netlify проверяет локальные фото, докачивает недостающие и копирует сайт в public/.

## Что нельзя ломать

Эти форматы используют в эфире, тесты проверяют их дословно.

- Текст игрокам: заголовок `## Команда` и строки
  `**Ник** https://vdo.ninja/?room=<room>&broadcast&do&push=<id>`
  (с паролем команды: `?room=<room>&password=<pw>&broadcast&do&push=<id>`).
- Текст обсерверу: только порядок слотов `N. Команда — Ник`, без ссылок.
- Имя JSON без пробелов: `16-00_Группа-B_КомандаA_vs_КомандаB.json`.
- OBS JSON: сцены «Игрок 1–10» и «Матрица», холст 1920×1080,
  по умолчанию видео заполняет внутреннюю рамку 1296×972 (312,54)
  с обрезкой краёв. core.cameraGeometry и obs.slotPlan должны совпадать:
  поворот 0/90/180/270, при 90/270 viewport переставляет ширину и высоту.
  Новые UUID при каждом экспорте; источники
  называются `CAM NN | Команда | Ник`. По умолчанию экспорт без карточек.
  Галочка includeCards добавляет прямо под камерой источник браузера
  `CARD NN | Команда | Ник` с card.html сайта панели (в артефакте —
  https://oneshot-panel.pages.dev). Выбор не сохраняется в localStorage.
  Ссылка камеры содержит `&cleanoutput&transparent&cover`; числовые
  сдвиг и зум 1–3 задаёт b64css. CSS scale не заменяет transform VDO. darkmode — только preview. Без видео VDO.Ninja прозрачен, и видна карточка.
  CARD остаётся без поворота и вписывается в ту же рамку.
  Подложка assets/camera/oneshot-preview.png — только предпросмотр панели,
  её нельзя добавлять в OBS. notifications.js/notification-worker.js —
  уведомления открытой панели, без кеша/fetch/Push. Клик фокусирует панель.
  «Кадр» хранится в oneshot-camera-settings-v1 по источнику/GID/player.key,
  пресет — oneshot-camera-frame-v1. Матрица сохраняет прежние плитки.
  Доказательство геометрии — scripts/qa_camera_obs.py, настоящий OBS/CEF;
  браузерные сценарии — scripts/qa_camera.py.
- Вето как на veto.oneshot.su. Пул: Ancient, Anubis, Cache, Dust2,
  Inferno, Mirage, Nuke. Текст HLTV строками вида `X removed Map`,
  `X pick Map (Y CT)` или `(Y T)` — сторона соперника, последняя —
  `Map was left over`.
- «Отправить в OBS» меняет только сцены «Игрок 1–10» уже импортированной
  коллекции; нет сцены — понятная ошибка до первого изменения. Имена
  источников те же, что в JSON.
- Сообщения моста (запечатаны): `apply-camera {id, title, match}` включает
  cameraFrame и настройки camera игроков. Старое `apply` сохраняет
  прежние full-frame/contain/поворот 0 через legacyCamera; новый отправитель
  показывает понятную ошибку обновления, если старый док не знает
  apply-camera. Другие сообщения: `veto {id,
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
  vetoNavBtn vetoBadge vetoView bookiesNavBtn bookiesView cvLive cvLiveState cvAlert cvAlertText
  cvAlertOk cvLiveEmpty cvRoom cvTeam0 cvTeam1 cvClock cvStage cvMoves
  cvCopyResult cvRestart cvSync cvSyncNote cvWatchMore cvWatchLink cvWatchGo cvWatchStop cvAdminOpen
  lobbyBadge prepView lobbyView obsView obsTabDot camSummary watchCams camTotal sendObsBtn
  copyJsonBtn obsNavBtn obsSetupBtn obsDot obsState vetoLive vetoLiveStatus vetoLayout copyOverlay
  obsDialog obsForm closeObs vetoBroadcast overlaySizeHint obsBridgeFields obsDockUrl copyDockUrl obsCode
  newObsCode obsRemotePort obsRemotePassword sendObsConfig obsRemoteResult
  obsBridgeStatus obsCodeInput applyObsCode shareDockUrl obsDockMessage
  obsRemoteBox obsMore playerVeto captainVeto cvFormat cvTimer cvLang cvCreate
  cvStatus cvSite cvLinks cvNameA cvNameB cvMsgA cvMsgB cvMsgS cvMsgO cvOpen bookies bookiesCheck bookiesTable
  bookiesStatus bookiesCopy bookiesCsv
  obsDirectFields obsUrl obsPassword obsTestResult testObs
  saveObs notifyBtn soundBtn lobbyForm faceitUrl faceitKey lobbyStart
  lobbyStatus lobbyError lobbyAlert lobbyAlertText lobbyAck lobbyMatches
  nextDelay copyThanks msgThanks nextMatch copyNext msgNext tplThanks
  tplNext resetTemplates copyJournal lobbyLog; док: dockPanel dockPanelDot
  dockObs dockObsDot dockForm dockCode dockUrl dockPassword dockLog
- data-атрибуты (их ставит `app.js`): data-regen data-unregen data-setid (id
  regen-a-0…regen-b-4) data-copy-team data-map data-player
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
  F room, I роль, L пароль комнаты). Таблица должна быть открыта на просмотр по ссылке.
  ID потока проходит `vdoId`: всё, кроме букв, цифр и `_`, становится `_`, как
  делает сам VDO.Ninja («Q-Q» публикуется как «Q_Q»).
  Пароль комнаты (лист «Комнаты», колонка «Пароль») панель добавляет как
  `&password=` во все ссылки команды: игрокам, OBS, директору, статусу
  вебок. Без пароля ссылки прежние (`pushUrl`/`viewUrl`/`directorUrl`).
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

## Серверный транспорт вето

- При создании комнаты cvTransport / vtTransport выбирает VDO.Ninja или сервер.
  Старые ссылки без via/relay остаются VDO. Новые сохраняют endpoint в #v=…
  &via=server&relay=…; не менять байты версии 2 и секреты капитанов.
- assets/veto-relay-protocol.js / client.js / links.js: подпись издателя,
  строгий зашифрованный конверт, HTTP-повтор раз в секунду, восстановление
  снимка; сохранённый старый пакет не означает, что капитан онлайн.
- server/veto-relay-api.js: один контракт для Cloudflare и Node.
  Cloudflare — SQLite Durable Objects (server/veto-relay-cloudflare.js);
  Pages-прокси functions/api/veto-relay.js имеет фиксированный upstream,
  без URL назначения от пользователя. Node — закрытый каталог, атомарная
  запись, один процесс (veto-relay-node.mjs / veto-relay-file.js).
- Это ограниченная запись подписанного шифротекста только на
  /api/veto-relay. Остальной сайт не получает произвольного API записи.
  OBS-пароли и приватные ключи на relay не отправлять.
- Живая графика OBS может идти через этот сервер, но использует отдельный
  display-код. Нельзя давать ему права капитана или управления OBS.
  VDO камер и удалённый мост управления OBS этим переключателем не меняются.
- Подробная публикация и перенос: server/RELAY.md. Генератор отдельного
  сайта переносит серверные адаптеры и wrangler migration вместе с UI.
  Статический Pages без Worker/Durable Object не является backend.
- Проверки: test/veto-relay.test.js, qa_veto_site.py --server (Chromium /
  WebKit), qa_veto_relay_overlay.py, qa_veto_relay_cloudflare.py (настоящий
  локальный workerd). Старый режим VDO тоже должен проходить.
