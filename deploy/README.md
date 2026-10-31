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
cd /opt/oneshot-panel && git checkout claude/gracious-sagan-apztcc   # или main, когда вльётся
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

# 4. Сервис
sudo cp deploy/oneshot-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now oneshot-panel
sudo systemctl status oneshot-panel          # «listening on 127.0.0.1:3000»

# 5. nginx + HTTPS
sudo cp deploy/nginx-oneshot-panel.conf /etc/nginx/sites-available/oneshot-panel
sudo ln -s /etc/nginx/sites-available/oneshot-panel /etc/nginx/sites-enabled/
# правь server_name и пути сертификатов под свой домен
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d panel.<твой-домен>
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

## Порядок запуска при буте

oneshot-panel после сети; nginx как обычно. Если панель стоит на одном
сервере с eBot (37.230.228.105) — можно добавить
`After=ebot-cs2-app.service`, но это не обязательно: панель переживает
недоступность eBot и восстанавливается сама.
