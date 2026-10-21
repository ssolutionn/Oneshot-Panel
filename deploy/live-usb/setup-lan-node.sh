#!/bin/bash
# ==============================================================================
# ONESHOT LAN BOX: Автоматический установщик серверного окружения для LAN-ивентов
# Поддерживается: Ubuntu 22.04 / 24.04 LTS, Debian 12
# ==============================================================================

set -e

echo "=========================================================="
echo "      ONESHOT PANEL: Инициализация LAN-сервера           "
echo "=========================================================="

# 1. Проверка прав root
if [ "$EUID" -ne 0 ]; then
  echo "[-] Ошибка: Запусти скрипт с правами root (sudo ./setup-lan-node.sh)"
  exit 1
fi

# 2. Обновление пакетов и установка зависимостей
echo "[+] Обновление системных пакетов..."
apt update && apt upgrade -y
apt install -y curl git ufw jq python3-pip python3-playwright

# 3. Установка Node.js v22 (согласно AGENTS.md проекта)
echo "[+] Установка Node.js v22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 4. Установка Docker и Docker Compose (для CS2 Dedicated Server)
echo "[+] Установка Docker и Docker Compose..."
apt install -y docker.io docker-compose-v2
systemctl enable --now docker

# 5. Настройка рабочей директории панели
INSTALL_DIR="/opt/oneshot-panel"
echo "[+] Установка Oneshot Panel в ${INSTALL_DIR}..."
mkdir -p ${INSTALL_DIR}

# Если мы запускаем из папки репозитория, копируем файлы, иначе качаем
if [ -f "server.js" ]; then
  cp -r . ${INSTALL_DIR}/
else
  echo "[+] Клонирование актуальной версии Oneshot Panel..."
  git clone https://github.com/ssolutionn/Oneshot-Panel.git ${INSTALL_DIR}
fi

cd ${INSTALL_DIR}

# 6. Установка прав и генерация токена CS2
mkdir -p .cs2-data
chmod 700 .cs2-data

# 7. Настройка Фаервола (UFW)
echo "[+] Настройка сетевого экрана (UFW)..."
ufw allow 22/tcp
ufw allow 3000/tcp   # Порт Oneshot Panel
ufw allow 27015/tcp  # CS2 RCON / TCP
ufw allow 27015/udp  # CS2 Game Port
ufw --force enable

# 8. Создание Systemd сервиса для автозапуска панели с поддержкой CS2 журнала
echo "[+] Создание службы автозапуска Oneshot Panel (Systemd)..."
cat << 'EOF' > /etc/systemd/system/oneshot-panel.service
[Unit]
Description=Oneshot Panel & CS2 Referee Journal
After=network.target docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/oneshot-panel
Environment=PORT=3000
Environment=HOST=0.0.0.0
Environment=CS2_JOURNAL=1
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable oneshot-panel.service
systemctl restart oneshot-panel.service

# 9. Вывод информации о готовности
LOCAL_IP=$(hostname -I | awk '{print $1}')
echo "=========================================================="
echo " [✓] LAN-СЕРВЕР ONESHOT УСПЕШНО РАЗВЕРНУТ!"
echo "=========================================================="
echo " Веб-панель доступна по адресу:"
echo "   -> http://${LOCAL_IP}:3000"
echo "   -> http://localhost:3000"
echo ""
echo " Команды управления:"
echo "   - Статус панели:  sudo systemctl status oneshot-panel"
echo "   - Логи панели:    sudo journalctl -u oneshot-panel -f"
echo "=========================================================="
