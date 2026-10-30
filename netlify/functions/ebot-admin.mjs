// Серверная часть управления eBot: POST /api/ebot-admin, same-origin (как
// прокси FACEIT в netlify/functions/faceit.mjs). Учётные данные eBot — секреты
// хостинга EBOT_USER / EBOT_PASSWORD (адрес — EBOT_URL, по умолчанию сервер
// Flegma), в ответ, логи и код не попадают. Сам клиент — server/ebot-admin.js
// (createEbotAdmin); браузер eBot не открывает и секретов не видит.
// Действия (JSON-тело запроса):
//   {action: 'commands', matchId} → {commands: [{action, ip, authkey}...]} —
//     кнопки матча из админки (ip/authkey нужны панели только для показа);
//   {action: 'send', matchId, command, argument?} → {accepted, reply} —
//     команда живому матчу (stop/pauseunpause/forcestart/.../executeCommand);
//   {action: 'catalog'} → {servers, maps} — серверы и карты для формы;
//   {action: 'create', teamA, teamB, map, serverId, side?, password?} →
//     {created, id?} — создание матча через форму админки;
//   {action: 'start', matchId, serverId} → {started} — старт матча.
import { fromThisSite } from './faceit.mjs';
import { createEbotAdmin, ebotSocketUrl } from '../../server/ebot-admin.js';
import { ebotTarget } from './ebot.mjs';

// На edge (Cloudflare) нет node:fs/node:vm для defaultLoadAes: свой загрузчик
// передаёт вызывающий (functions/api/ebot-admin.js), иначе — значение по
// умолчанию (локальный server.js и Netlify).
const adminFor = (env, loadAes) => {
  const target = ebotTarget(env.EBOT_URL);
  const user = String(env.EBOT_USER || '').trim();
  const password = String(env.EBOT_PASSWORD || '');
  if (!target) return { error: 'config', message: 'EBOT_URL задан неверно.' };
  if (!user || !password) {
    return { error: 'no-credentials', message: 'Задай секреты EBOT_USER и EBOT_PASSWORD хостинга.' };
  }
  return { admin: createEbotAdmin({ baseUrl: target.href, user, password, socketUrl: ebotSocketUrl(target.href), loadAes: loadAes || undefined }) };
};

const COMMANDS = new Set(['stop', 'stopNoRs', 'passknife', 'forceknife',
  'forceknifeend', 'forcestart', 'stopback', 'pauseunpause', 'streamerready',
  'executeCommand', 'goBackRounds']);
const ALLOWED_ARGUMENT = /^(?:[ -~]{0,200})$/; // RCON-команда/номер раунда, без переводов строк

function readBody(request) {
  return request.json().catch(() => null);
}
function str(value, max = 60) {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : '';
}

export async function proxyEbotAdmin(request, env = {}, loadAes = null) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'not-allowed', message: 'Управление eBot — только POST этого сайта.' }, { status: 400 });
  }
  if (!fromThisSite(request)) {
    return Response.json({ error: 'not-allowed', message: 'Управление eBot доступно только панели.' }, { status: 403 });
  }
  const built = adminFor(env, loadAes);
  if (built.error) return Response.json(built, { status: built.error === 'no-credentials' ? 401 : 500 });
  const body = await readBody(request);
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'request', message: 'Ожидается JSON-запрос.' }, { status: 400 });
  }
  const matchId = /^\d{1,9}$/.test(String(body.matchId)) ? String(body.matchId) : '';
  const command = typeof body.command === 'string' ? body.command : '';
  try {
    if (body.action === 'commands') {
      if (!matchId) throw Object.assign(new Error('Номер матча обязателен.'), { status: 400 });
      const { commands } = await built.admin.matchCommands(matchId);
      return Response.json({ commands: commands.map(c => ({ action: c.action, ip: c.ip })) },
        { headers: { 'cache-control': 'no-store' } });
    }
    if (body.action === 'send') {
      if (!matchId) throw Object.assign(new Error('Номер матча обязателен.'), { status: 400 });
      if (!COMMANDS.has(command)) throw Object.assign(new Error('Неизвестная команда матча.'), { status: 400 });
      const argument = str(body.argument, 200);
      if (body.argument !== undefined && !ALLOWED_ARGUMENT.test(String(body.argument))) {
        throw Object.assign(new Error('Аргумент команды нечитаем.'), { status: 400 });
      }
      const result = await built.admin.sendCommand(matchId, command, argument || undefined);
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    }
    if (body.action === 'catalog') {
      return Response.json(await built.admin.catalog(), { headers: { 'cache-control': 'no-store' } });
    }
    if (body.action === 'create') {
      const teamA = str(body.teamA, 25), teamB = str(body.teamB, 25);
      const map = str(body.map, 20), serverId = /^\d{1,5}$/.test(String(body.serverId)) ? String(body.serverId) : '';
      const password = str(body.password, 25);
      if (!teamA || !teamB || !map || !serverId) {
        throw Object.assign(new Error('Команды, карта и сервер обязательны.'), { status: 400 });
      }
      const result = await built.admin.createMatch({ teamA, teamB, map, serverId, password, side: str(body.side, 10) || 'random' });
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    }
    if (body.action === 'start') {
      if (!matchId) throw Object.assign(new Error('Номер матча обязателен.'), { status: 400 });
      const serverId = /^\d{1,5}$/.test(String(body.serverId)) ? String(body.serverId) : '';
      const result = await built.admin.startMatch(matchId, serverId || undefined);
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    }
    return Response.json({ error: 'request', message: 'Неизвестное действие.' }, { status: 400 });
  } catch (error) {
    // Русский текст ошибки уже для оператора; статусы — из типа ошибки.
    const status = Number(error.status) || 502;
    return Response.json({ error: 'ebot', message: String(error.message || 'eBot не ответил.') }, { status });
  }
}

export default request => proxyEbotAdmin(request, {
  EBOT_URL: globalThis.Netlify?.env?.get?.('EBOT_URL') || globalThis.process?.env?.EBOT_URL || '',
  EBOT_USER: globalThis.Netlify?.env?.get?.('EBOT_USER') || globalThis.process?.env?.EBOT_USER || '',
  EBOT_PASSWORD: globalThis.Netlify?.env?.get?.('EBOT_PASSWORD') || globalThis.process?.env?.EBOT_PASSWORD || ''
});

export const config = { path: '/api/ebot-admin' };
