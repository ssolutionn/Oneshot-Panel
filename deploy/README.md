# Своё размещение панели «с нуля» (без Netlify/Cloudflare)

Один процесс Node отдаёт и сайт, и все API (eBot, FACEIT, букмекеры,
вето-реле). Внешних npm-зависимостей нет, компиляции нет.

Файлы здесь: `oneshot-panel.service` (systemd), `nginx-oneshot-panel.conf`
(nginx + HTTPS). Секреты — в `/etc/oneshot-panel.env`, не в юните.

## Установка (Ubuntu 22.04/24.04, как у eBot)

```sh
# 1. Node.js >= 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

# 2. Код
sudo useradd -r -s /usr/sbin/nologin oneshot || true
sudo git clone https://github.com/ssolutionn/Oneshot-Panel.git /opt/oneshot-panel
cd /opt/oneshot-panel && git checkout feat/ebot-admin   # ветка с eBot-фичей (потом вольётся в main)
sudo chown -R oneshot:oneshot /opt/oneshot-panel
sudo -u oneshot npm test          # 276 тестов должны быть зелёными

# 3. Секреты (не коммитить!)
sudo tee /etc/oneshot-panel.env >/dev/null <<'EOF'
EBOT_URL=http://37.230.228.105/
EBOT_USER=<логин админки eBot, лучше судья>
EBOT_PASSWORD=<пароль>
FACEIT_API_KEY=<client-side ключ, для лобби без ручного ввода>
EOF
sudo chmod 600 /etc/oneshot-panel.env && sudo chown root:oneshot /etc/oneshot-panel.env
# и в юните раскомментируй EnvironmentFile=/etc/oneshot-panel.env
```

Опциональные переменные для управления eBot (`/api/ebot-admin`):

- `EBOT_ADMIN_TOKEN` — закрывает управление eBot паролем-токеном: каждый POST
  обязан нести заголовок `x-ebot-token: <токен>`. Сравнение не зависит от
  времени ответа, поэтому длина токена роли не играет. В env хранится
  sha256-дайджест, сам токен остаётся только у вас:

  ```sh
  TOKEN=$(openssl rand -hex 16)
  echo "x-ebot-token: $TOKEN"      # это покажете операторам
  # это в env:
  echo "sha256:$(printf '%s' "$TOKEN" | openssl dgst -sha256 -r | cut -d' ' -f1)"
  # в /etc/oneshot-panel.env добавьте строку:
  # EBOT_ADMIN_TOKEN=sha256:<64 hex-символа из команды выше>
  ```

  Если переменной нет — управление доступно любому, кто прошёл
  same-origin-проверку. curl может подделать заголовок Sec-Fetch-Site, так
  что панель, торчащая в интернет без токена, отдаст управление eBot
  любому. Ставьте токен, если панель видна больше, чем VPN/локальная сеть.
- `EBOT_ADMIN_OPEN=1` — раскрыть каталог `catalog` (адреса серверов) и `ip`
  в кнопках `commands`. По умолчанию закрыто: список серверов/IP наружу не
  отдаётся даже операторам панели. Локальный/VPN-деплой может включить.

## 4. Сервис

```sh
sudo cp deploy/oneshot-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now oneshot-panel
sudo systemctl status oneshot-panel          # «listening on 127.0.0.1:3000»
```

## 5. nginx + HTTPS

```sh
sudo cp deploy/nginx-oneshot-panel.conf /etc/nginx/sites-available/oneshot-panel
sudo ln -s /etc/nginx/sites-available/oneshot-panel /etc/nginx/sites-enabled/
# правь server_name и пути сертификатов под свой домен
# Сначала dry-run (конфиг ещё без живого сертификата — nginx -t не пройдёт,
# certbot сам вставит пути и сделает их живыми):
sudo certbot --nginx -d panel.<твой-домен> --dry-run || true
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d panel.<твой-домен>
sudo nginx -t && sudo systemctl reload nginx
```

DNS: A-запись `panel` → IP этого сервера.

## Проверка после установки

| Что | Как |
|---|---|
| Сайт | `https://panel.<домен>/` открывается, вкладки переключаются |
| Монитор eBot | вкладка «Лобби» → блок «Матчи eBot» живой |
| Управление eBot | на живом матче есть кнопки «Пауза» и т.д.; `curl -X POST https://panel.<домен>/api/ebot-admin` без Origin → 403 |
| Лобби FACEIT | вставить ссылку турнира — матчи подтянутся |
| Обновление | `cd /opt/oneshot-panel && sudo -u oneshot git pull && sudo systemctl restart oneshot-panel` |

## Вкладка «Сервер» (CS2) за nginx

Бэкенд CS2-журнала (`server/cs2-api.js`) принимает только этот компьютер:
loopback-адрес и заголовок Host `localhost`/`127.0.0.1` (защита от DNS
rebinding). Через nginx с обычным `proxy_set_header Host $host` (в нашем
конфиге так) запросы вкладки придут с Host `panel.<домен>` — гейт их не
пропустит. Два рабочих варианта:

1. в `/etc/oneshot-panel.env` задать `CS2_ALLOW_REMOTE=1` и `CS2_LOG_TOKEN`
   (тогда панель и лог-эндпоинт пускают чужие адреса, но каждый запрос
   обязан нести токен);
2. либо добавить в nginx отдельный `location /api/cs2-` с
   `proxy_set_header Host localhost` (подходит, когда панель и CS2 на одном
   сервере; остальное оставьте как есть).

## Порядок запуска при буте

oneshot-panel после сети; nginx как обычно. Если панель стоит на одном
сервере с eBot (37.230.228.105) — можно добавить
`After=ebot-cs2-app.service`, но это не обязательно: панель переживает
недоступность eBot и восстанавливается сама.
