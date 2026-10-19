# Oneshot Veto — правила для Claude

**Этот репозиторий сгенерирован.** Источник — репозиторий панели
(`ssolutionn/Oneshot-Panel`): `veto.html`, `veto.js`, `veto-room.js`, `server/`,
`functions/`, `assets/veto-*`. Сборка: `node scripts/build-veto-site.mjs <dir>` там.

- Здесь ничего не правь руками: исправление делается в панели, затем пересборка
  и `npm run check:veto-sync -- <путь к этому репо>` в панели.
- Ревью и безопасность — по `CLAUDE.md`, `REVIEW.md` и `SECURITY.md` панели;
  весь код этого репо там относится к **критичному** уровню риска.
- Секреты (`CLOUDFLARE_API_TOKEN`) — только в секретах GitHub, только в шагах деплоя.
