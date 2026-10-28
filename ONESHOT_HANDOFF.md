# Oneshot Panel: handoff для новой нейросети

Этот файл описывает актуальное состояние проекта, последние ветки, вебкамерный контур, синхронизацию с компьютером обсервера, Dota LAN, GSI и SHUD.

## Проект

- Путь: `/Users/nikita/Agents/Oneshot-Panel`
- Репозиторий: `ssolutionn/Oneshot-Panel`
- Текущая ветка: `claude/gracious-sagan-apztcc`
- HEAD на момент handoff: `81e029f`
- Основной фокус: Dota LAN и вебкамеры внутри панели обсервера.

## Что уже реализовано

- Команды, игроки, фотографии и логотипы.
- VDO.Ninja вебкамеры.
- Фиксированные физические места A1–A5 и B1–B5.
- OBS JSON и live-подключение через OBS WebSocket.
- Окно Oneshot на компьютере обсервера.
- Передача команд с панели оператора на компьютер обсервера.
- Передача карточек игроков частями через OBS bridge.
- Повторная отправка отсутствующих карточек.
- LAN-матчи и назначение игроков на места.
- Квадратные OBS-источники 1080×1080.
- CS2-журнал, SteamID, статистика, архивы и launcher.
- Event manifests и отдельный профиль Dota LAN.

## Вебкамерный поток

### Компьютер оператора

Оператор:

1. Заполняет команды и игроков.
2. Загружает фотографии и логотипы.
3. Выбирает матч.
4. Назначает игроков на физические места.
5. Нажимает отправку в OBS.

### Компьютер обсервера

На компьютере обсервера:

1. Открывается окно Oneshot.
2. Оно подключается к локальному OBS.
3. Панель отправляет защищённую команду.
4. Мост применяет камеры и карточки.
5. OBS показывает источники локально.

Основные сообщения моста:

- `apply-camera`
- `apply-camera-zoom`
- `apply`
- `cards-have`
- `have`
- `blob`
- `result`
- `presence`
- `hello`
- `obs-config`

Код управления OBS и код показа veto разделены. Пароль OBS нельзя помещать в URL. Карточки не должны попадать в публичные URL.

## Физические места и камеры

- Первая команда: A1–A5.
- Вторая команда: B1–B5.
- Всего: десять камер.
- Поток принадлежит месту, а не игроку.
- Игрок вручную назначается на место.
- Для Dota LAN GSI не нужен.

## Квадратная геометрия OBS

В `core.js` функция `cameraGeometry()` должна совпадать с `slotPlan()` из `obs.js`.

Для `square` используется размер 1080×1080 и компенсация позиции при `align: 5`, то есть при top-left alignment:

| Поворот | X | Y | Ширина | Высота |
|---:|---:|---:|---:|---:|
| 0° | 420 | 0 | 1080 | 1080 |
| 90° | 1500 | 0 | 1080 | 1080 |
| 180° | 1500 | 1080 | 1080 | 1080 |
| 270° | 420 | 1080 | 1080 | 1080 |

Старые форматы `inner43`, `full43` и `wide` нельзя менять.

## Dota LAN event

Файл шаблона:

`events/_templates/dota-lan.json`

Включённые модули:

- `teams`
- `matches`
- `cameras`
- `seats`
- `obs`
- `settings`

Отключены:

- `veto`
- `server`
- `lobby`
- `bookmakers`

Кадр по умолчанию: `square`.

`cs2.js` обязан скрывать вкладку CS2 server, если `event.modules.server` выключен.

## Dota GSI

Dota GSI пока не подключён к рабочему вебкамерному процессу.

Рассматриваемые поля будущего parser:

- `provider`
- `map`
- `player`
- `hero`
- `player.team2`
- `player.team3`
- `hero.team2`
- `hero.team3`
- `selected_unit`
- SteamID и имя игрока

Не подключать эвристику по `selected_unit` без реального observer JSON. GSI должен сначала получить parser tests и проверки отсутствующих полей.

GSI понадобится позже для live-статуса, героя или автоматического сопоставления. Автообсервинг сейчас не реализовывать.

## SHUD

Прямого порта из панели в SHUD пока нет.

Нет следующих компонентов:

- SHUD adapter.
- SHUD JSON exporter.
- SHUD API или WebSocket integration.
- Импорт SHUD templates.
- Кнопка «Экспорт в SHUD».
- Маппинг Oneshot team/player/logo/photo/SteamID в формат SHUD.

Сейчас есть собственные OBS JSON, OBS bridge, VDO.Ninja, карточки и CS2 data formats.

Для SHUD сначала нужен хотя бы один реальный материал:

- SHUD import file.
- SHUD export file.
- API documentation.
- Версия SHUD.
- Описание способа подключения.

После этого делать отдельный `shud-adapter.js` и тесты. Не смешивать SHUD с `core.js`, пока формат не подтверждён.

## Важные файлы

### Вебкамеры и OBS

- `core.js`
- `app.js`
- `live.js`
- `obs.js`
- `obs-bridge.html`
- `obs-bridge.js`
- `vdo.js`
- `index.html`
- `style.css`

### LAN и карточки

- `lan.js`
- `lan-event.js`
- `lan-images.js`
- `card.html`
- `card.js`
- `card.css`
- `events/schema.js`
- `events/_templates/dota-lan.json`

### CS2

- `cs2.js`
- `server/cs2-api.js`
- `server/cs2-log.js`
- `server/cs2-rcon.js`
- `server/cs2-launch.js`
- `server/cs2-roster.js`
- `server/cs2-stats.js`
- `server/cs2-archive.js`

## Последние коммиты

- `81e029f` Merge branch `claude/gracious-sagan-apztcc`.
- `726db09` Update tournament interface and Dota LAN configuration.
- `1e38be2` Add CS2 stats module.
- `24bf78d` Add CS2 stats module.
- `834aac3` Give a LAN its own event panel.
- `2f2dbc6` DEPLOY: an address per tournament.
- `30683c5` Fix review findings in LAN mode, CS2 journal and CI.
- `efbb413` Foundation for many events.
- `b769436` Add event profile for LAN.
- `90c08af` Harden the CS2 journal.
- `7641f1a` Add the CS2 server tab.

## Ветки

Основная рабочая ветка:

- `claude/gracious-sagan-apztcc`

Также присутствуют:

- `fix/review-batch`
- `fix/review-batch-2026-10`
- `origin/reu`
- `origin/codex/camera-validation-results`
- `origin/codex/optional-player-cards`
- `origin/codex/obs-qr-autofill`
- `origin/codex/cyberclash-player-cards`
- `origin/codex/matchday-player-packages`
- `origin/codex/package-reliability-2026-10-16`
- `origin/codex/allow-vdo-backup`

Не удалять и не перезаписывать незакоммиченные изменения без отдельной проверки.

## Текущий git status на момент handoff

Изменены:

- `DEPLOY.md`
- `README.md`
- `cs2.js`
- `index.html`
- `scripts/qa_cs2.py`
- `server/cs2-api.js`
- `server/cs2-launch.js`
- `style.css`
- `test/cs2-launch.test.js`

## Проверки

Последнее подтверждённое состояние:

- `npm run check`: 99/99 файлов.
- `npm test`: 252/252 теста.
- `node --test test/camera.test.js`: 5/5.
- `python3 scripts/qa_lan.py`: PASS.
- `git diff --check`: clean.

Ограничение: отдельный реальный OBS screenshot regression именно для square на всех четырёх поворотах пока не добавлен. Unit-тесты геометрию проверяют.

## Ошибка предыдущего webcam ZIP

Архив `oneshot-webcams-20261024-162440.zip` был собран как неполный пакет. Из него исключили файлы, но оставили тесты и импорты, которые на них ссылаются.

Из-за этого отсутствовали или ломались импорты:

- `veto-room.js`
- `faceit.js`
- `netlify/functions/bookmakers.mjs`
- `assets/bookmaker-winline.js`

Результат: syntax pass, но 68 из 74 тестов.

Этот архив нельзя считать standalone рабочей сборкой.

Правильные варианты:

1. Архивировать полный проект целиком.
2. Или делать настоящий минимальный пакет, удалив все несвязанные тесты и исправив импорты.
3. После распаковки проверять архив отдельно командами `npm run check` и `npm test`.

Проверка `npm run check:veto-sync` требует отдельный checkout `oneshot-veto`:

```text
npm run check:veto-sync -- <path-to-oneshot-veto>
```

Это внешняя зависимость проверки, а не ошибка основной панели.

## Правила продолжения

Если задача про вебкамеры:

- не трогать CS2 без необходимости;
- не подключать GSI без реального JSON;
- не делать автообсервинг;
- проверять panel → obs-bridge → OBS;
- проверять `cardRefs` и повторную отправку карточек;
- после изменений запускать `npm run check`, `npm test` и `python3 scripts/qa_lan.py`;
- для ZIP либо включать весь проект, либо проверять минимальный пакет после распаковки.

Если задача про SHUD:

- сначала получить реальный SHUD import/export или документацию;
- определить формат;
- сделать отдельный adapter;
- добавить тесты;
- не заявлять готовую интеграцию до успешного импорта тестового файла.

Если задача про Dota GSI:

- принять полный сырой observer JSON;
- удалить auth token и секреты;
- сохранить поля provider/map/player/hero/team2/team3/selected_unit;
- сначала написать parser tests;
- только потом подключать live status.
