# Размещение Oneshot Panel на своём сайте

Инструкция для владельца сервера и домена oneshot.su.

## Что это

Статический сайт: HTML, JS, CSS и картинки. Бэкенда, базы данных и сборки
нет. Перед публикацией Python-загрузчик сохраняет фотографии HLTV в
assets/players/; браузер карточки загружает их уже с нашего сайта.
Браузер посетителя сам читает Google Sheets
(`https://docs.google.com/.../gviz/tq`), серверу ничего обрабатывать
не нужно.

Нужные файлы (больше ничего из репозитория на сайт не кладётся):

```
index.html  app.js  core.js  theme.js  style.css  card.html  card.js  card.css
live.js  obs.js  vdo.js  lobby.js  faceit.js  obs-bridge.html  obs-bridge.js  veto.html  veto.js  veto.css  veto-room.js  veto-watch.js  bookmakers.js  bookies.js  lan.js  lan-event.js  lan-images.js  cs2.js  assets/
```

- Репозиторий: https://github.com/ssolutionn/Oneshot-Panel,
  ветка `claude/gracious-sagan-apztcc`.
- Готовый архив этих файлов: `oneshot-panel-site.zip` (его передали вместе
  с этой инструкцией; свежую копию можно собрать командами ниже).

Сайт должен открываться **из корня домена или поддомена**
(например, `https://panel.oneshot.su/`), а не из папки
(`oneshot.su/panel/`): пути в коде абсолютные (`/app.js`, `/assets/...`).

## Вариант 1. Свой сервер (nginx), panel.oneshot.su

Сейчас oneshot.su и veto.oneshot.su смотрят на 185.139.70.76, DNS — REG.RU,
почта — Яндекс (MX). Ниже ничего из этого не меняется.

**1. DNS в REG.RU** (Домены → oneshot.su → DNS-серверы и управление зоной):

| Тип | Субдомен | Значение |
| --- | --- | --- |
| A | `panel` | `185.139.70.76` |

**2. Файлы на сервер.** Сайт собирает тот же скрипт, что и хостинги: он докачивает
фото, копирует файлы в `public/` и пишет `public/event.js` — какое это событие
(`EVENT=reu` — ЛАН РЭУ, без него — КиберКлэш; см. «Свой адрес на событие»). Нужны
Node.js и python3.

```sh
sudo git clone --depth 1 -b claude/gracious-sagan-apztcc \
  https://github.com/ssolutionn/Oneshot-Panel.git /opt/oneshot-panel
cd /opt/oneshot-panel
sudo sh scripts/build-site.sh            # для события: sudo EVENT=reu sh scripts/build-site.sh
sudo mkdir -p /var/www/oneshot-panel
sudo cp -R public/. /var/www/oneshot-panel/
```

Или распаковать `oneshot-panel-site.zip` (артефакт CI, в нём уже есть `event.js` КиберКлэша)
в `/var/www/oneshot-panel`.

**3. nginx** — `/etc/nginx/sites-available/panel.oneshot.su`:

```nginx
server {
    listen 80;
    server_name panel.oneshot.su;
    root /var/www/oneshot-panel;
    index index.html;

    # Те же заголовки, что в _headers (Cloudflare), netlify.toml и server.js.
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://docs.google.com https://open.faceit.com https://oneshot-veto.pages.dev https://oneshot-veto.cyberclash.workers.dev ws://127.0.0.1:* ws://localhost:*; frame-src https://vdo.ninja https://cdn-backup.vdo.ninja; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Permissions-Policy "camera=(self), microphone=(), geolocation=(), payment=(), usb=()" always;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

```sh
sudo ln -s /etc/nginx/sites-available/panel.oneshot.su /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d panel.oneshot.su   # HTTPS от Let's Encrypt
```

Если на сервере не nginx, а другой веб-сервер — подойдёт любой, который
отдаёт статику; важны заголовки выше (их же сверяет `test/server.test.js` для
трёх хостингов). Прокси FACEIT, букмекеры и вето-relay — функции хостинга: на
голой статике их нет (для них — `node server.js` за nginx).

**4. Обновление** (когда в репозитории появились правки):

```sh
cd /opt/oneshot-panel && sudo git pull
sudo sh scripts/build-site.sh            # для события — с тем же EVENT=…
sudo cp -R public/. /var/www/oneshot-panel/
```

## Вариант 2. Оставить Netlify, только домен

Панель уже работает на https://onepanel.netlify.app и обновляется сама
после каждого изменения в репозитории. В Netlify домен `panel.oneshot.su`
уже добавлен и ждёт DNS. Нужны две записи в REG.RU:

| Тип | Субдомен | Значение |
| --- | --- | --- |
| TXT | `subdomain-owner-verification` | `5ccfcd546e508a963c7d237e9f693e6b` |
| CNAME | `panel` | `onepanel.netlify.app` |

`build.txt` в корне сайта на Netlify и Cloudflare — коммит сборки для проверки в
GitHub Actions; на свой сервер его копировать не нужно.

HTTPS Netlify выпустит сам после того, как записи появятся. Netlify DNS
(перенос NS-серверов) **не включать**: перестанут работать veto.oneshot.su
и почта.

Выбрать нужно один вариант: для своего сервера у `panel` запись A,
для Netlify — CNAME.

## Вариант 3. Cloudflare Pages (бесплатно, 500 сборок в месяц)

Сборка та же, что на Netlify: `scripts/build-site.sh` копирует сайт в
`public/`, на Cloudflare добавляет туда `_headers` (те же заголовки
безопасности) и пишет коммит в `build.txt`. Прокси FACEIT —
`functions/api/faceit.js` (та же логика, что в
`netlify/functions/faceit.mjs`), линии букмекеров —
`functions/api/bookmakers.js` (`netlify/functions/bookmakers.mjs`).
Настраивать ничего, кроме полей ниже, не нужно.

1. dash.cloudflare.com → **Workers & Pages** → **Create** → вкладка
   **Pages** → **Connect to Git** (Import an existing Git repository).
   Нужен именно Pages, а не Worker.
2. Подключить GitHub, выбрать `ssolutionn/Oneshot-Panel`.
3. Настройки сборки:

   | Поле | Значение |
   | --- | --- |
   | Project name | `onepanel` → адрес `https://onepanel.pages.dev` (если имя занято — другое) |
   | Production branch | `claude/gracious-sagan-apztcc` |
   | Framework preset | None |
   | Build command | `sh scripts/build-site.sh` |
   | Build output directory | `public` |
   | Root directory | пусто |

   Переменные окружения не нужны. Для лобби FACEIT без ввода ключа:
   Settings → Variables and Secrets → Add → Type **Secret**, имя
   `FACEIT_API_KEY`, значение — client-side ключ, затем Redeploy.
4. **Save and Deploy**. Через пару минут открыть
   `https://<project>.pages.dev/build.txt` — там коммит сборки.
5. Проверка: на сайте открываются вкладки, `/api/faceit` отвечает
   `{"error":"Not allowed"}` на запрос без ключа (это нормально).
6. GitHub → Settings → Secrets and variables → Actions → **Variables** →
   `PUBLISHED_URL` = `https://<project>.pages.dev`. Тогда `check.yml`
   проверяет опубликованный сайт на Cloudflare, а не на Netlify.
7. Чтобы не тратить сборки на чужие ветки: Settings → Builds → Branch
   control → Preview branches: None (или только нужные).

### Свой адрес на событие

Пока панель не умеет `/e/<событие>/` (docs/ARCHITECTURE.md), событие получает свой
адрес той же сборки: ветка с его slug → `https://<slug>.<project>.pages.dev`. Сборка
(`scripts/build-site.sh` → `scripts/event-config.mjs`) смотрит на ветку Cloudflare
(`CF_PAGES_BRANCH`): есть папка `events/<ветка>/event.json` — сайт становится этим
событием (`public/event.js`), нет — КиберКлэшем. Событие без таблиц (`kind: manual`)
открывается сразу панелью события: «Команды», «Матчи», «Эфир», «Вето», «Сервер»,
«Компы», «OBS», «Событие». У каждого адреса своё хранилище браузера: команды, фото,
кадры камер и настройки OBS одного события не смешиваются с другим.

`public/event.js` несёт все ивенты из `events/*/event.json`: кнопка «Выбрать событие» в
шапке открывает любой из них на том же адресе (выбор — в cookie `oneshot-event`), а
ветка задаёт только то, какое событие открыто по умолчанию. Переключаться между ивентами
можно и на сайте, не заводя второй адрес; свой адрес на событие остаётся удобным, когда
у него отдельные зрители или свой домен.

| Адрес | Ветка | Событие |
| --- | --- | --- |
| `oneshot-panel.pages.dev` | `claude/gracious-sagan-apztcc` | CyberClash (таблицы) |
| `reu.oneshot-panel.pages.dev` | `reu` | ЛАН РЭУ им. Плеханова (`events/reu/`) |

Новое событие: скопируй `events/_templates/lan.json` в `events/<slug>/event.json`
(slug — латиница, цифры и дефис, он же имя ветки), впиши название, проверь `npm test`
(тест проверяет каждую папку событий) и запушь ветку `<slug>` с тем же коммитом.

- Ветка события — тот же коммит, что и основная: выкладка = один пуш во все,
  `git push origin <commit>:claude/gracious-sagan-apztcc <commit>:reu`.
  Своих правок в ветке события нет.
- Если в Branch control превью выключены, ветку события надо добавить
  в Preview branches → Custom branches, иначе адрес не появится.
- Локально событие выбирает переменная: `EVENT=reu npm start` (с журналом CS2 —
  `CS2_JOURNAL=1 EVENT=reu npm start`); без неё — КиберКлэш.
- Событие закончилось — ветку удалить; ссылки на старый адрес перестанут работать.

Cloudflare открывает `card.html`, `obs-bridge.html`, `veto.html` и `overlay.html`
и без `.html` (перенаправляет `/card.html?…` на `/card?…`); ссылки с
`.html` в OBS продолжают работать.

Новый адрес — новые ссылки: док в OBS, ссылку на оверлей вето и
коллекцию OBS JSON с карточками нужно один раз взять с нового сайта.
Чтобы адрес больше не менялся при смене хостинга, лучше подключить
`panel.oneshot.su`: в Cloudflare Pages → Custom domains → добавить
`panel.oneshot.su`, а в REG.RU — CNAME `panel` → `<project>.pages.dev`
(вместо записи для Netlify; NS-серверы не переносить).

## Что нужно от Google Sheets

Обе таблицы должны быть открыты «Все, у кого есть ссылка» — **Читатель**:

- составы: https://docs.google.com/spreadsheets/d/1e__ijBjufD19SWBkSJL177vmmfMh2tdykYQHAS06S8I/edit
- организатор (расписание): https://docs.google.com/spreadsheets/d/1GtwcpVnyxY1YOs6ZTrXwJr5mjZqI0QxjLSKjimn9G2o/edit

Редактирование по ссылке не нужно и небезопасно: адрес таблицы составов
виден в коде страницы, а в ней комнаты и ID для ссылок VDO.Ninja.

## Проверка после размещения

Открыть `https://panel.oneshot.su/`:

- в шапке логотип Oneshot, справа зелёная точка «Таблица турнира»;
- под шапкой «16 команд из таблицы · Обновлено ЧЧ:ММ МСК»;
- в «Матч по расписанию» — матчи на сегодня и следующие дни;
- в консоли браузера нет ошибок CSP;
- `https://panel.oneshot.su/card.html?team=Lavked&nick=jakekeS` — карточка
  игрока с логотипом Lavked (её OBS открывает под каждой камерой);
- `https://panel.oneshot.su/obs-bridge.html` — док для OBS открывается;
- вкладка «Лобби» на своём сервере ходит в FACEIT напрямую из браузера.
  Прокси `/api/faceit` есть только на Netlify и в `server.js`: если FACEIT
  перестанет пускать браузер (CORS), на nginx лобби не заработает —
  тогда оставить сайт на Netlify или запускать `node server.js` за nginx.

### Проверка карточек перед эфиром

- В журнале подготовки фото видны числа загруженных фото и заглушек.
- `/card.html?team=PRIVATE&nick=maeggi` — яркая карточка без фото.
- Карточка игрока с подготовленным полем file в players.json показывает
  портрет по центру и логотип CyberClash сверху справа.
- У нового скачанного OBS JSON все десять CARD-ссылок ведут на ваш домен.
- Проверьте в OBS подключение/отключение VDO.Ninja: карточка находится
  под камерой и видна, когда источник камеры прозрачен.
