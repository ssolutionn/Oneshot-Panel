#!/bin/zsh
cd "$(dirname "$0")"
echo "=== OneShot Allstar Studio (Fable 5.1 Ultimate) ==="
echo "Запускаем движок анализа демок и веб-студию..."
node hour4_studio_server.mjs &
SERVER_PID=$!
sleep 1
open "http://127.0.0.1:4952"
echo "Студия запущена! Окно открыто в браузере."
read - "k?Нажми Enter чтобы закрыть сервер..."
kill $SERVER_PID 2>/dev/null
