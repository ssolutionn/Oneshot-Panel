// Каркас серверной части админки eBot (POST /api/ebot-admin). План, реализация
// — следующим шагом:
// - принимает только POST с JSON {action, matchId, command, ...}: список
//   команд матча, отправка команды (пауза/стоп/…), создание и старт матча;
// - same-origin проверка как в netlify/functions/faceit.mjs (fromThisSite),
//   чужие сайты и запросы без доказательства своего origin не обслуживаются;
// - учётные данные eBot — секреты хостинга EBOT_USER / EBOT_PASSWORD, в
//   ответ, логи и код не попадают;
// - клиент к админке — server/ebot-admin.js (createEbotAdmin), ошибки
//   логина отдаются как обычный JSON без тела страницы eBot.
export default async () => Response.json(
  { error: 'not-implemented', message: 'Управление eBot ещё не подключено.' },
  { status: 501 }
);

export const config = { path: '/api/ebot-admin' };
