// Серверная часть управления eBot: POST /api/ebot-admin, same-origin (как
// прокси FACEIT в netlify/functions/faceit.mjs). Учётные данные eBot — секреты
// хостинга EBOT_USER / EBOT_PASSWORD (адрес — EBOT_URL, по умолчанию сервер
// Flegma), в ответ, логи и код не попадают. Сам клиент — server/ebot-admin.js
// (createEbotAdmin); браузер eBot не открывает и секретов не видит.
// Действия (JSON-тело запроса):
//   {action: 'commands', matchId} → {commands: [{action, ip?}...]} —
//     кнопки матча из админки; ip — только при EBOT_ADMIN_OPEN=1;
//   {action: 'send', matchId, command, argument?} → {accepted, reply} —
//     команда живому матчу (stop/pauseunpause/forcestart/.../executeCommand);
//   {action: 'catalog'} → {servers, maps} — серверы и карты для формы;
//     только при EBOT_ADMIN_OPEN=1, иначе 403 (адреса серверов не публичны);
//   {action: 'create', teamA, teamB, map, serverId, side?, password?} →
//     {created, id?} — создание матча через формы админки;
//   {action: 'start', matchId, serverId} → {started} — старт матча.
// Если задан EBOT_ADMIN_TOKEN (sha256:<hex>, см. deploy/README.md), каждый
// POST дополнительно обязан нести заголовок x-ebot-token с тем же значением.
import { fromThisSite } from './faceit.mjs';
import { createEbotAdmin, ebotSocketUrl } from '../../server/ebot-admin.js';
import { ebotTarget } from './ebot.mjs';
// Netlify бандлит функцию и инлайнит server/ebot-admin.js, но
// server/vendor/ в деплой функций не попадает: defaultLoadAes (node:fs)
// не найдёт файл. AES берём статической ESM-копией — она бандлится.
import { Aes as AesEsm } from '../../server/vendor/aes-ctr-esm.js';

// Модульный кэш админ-клиента: изолят serverless живёт дольше одного
// запроса, поэтому логин в eBot и сессия переживают запросы — без кэша
// каждый POST логинился бы заново. В ключе длина пароля, а не сам пароль:
// смена учётных данных в env всё же перезаводит клиента.
let adminCache = null; // { key, admin }

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
  const key = target.href + '\n' + user + '\n' + password.length;
  if (adminCache && adminCache.key === key) return { admin: adminCache.admin };
  const admin = createEbotAdmin({ baseUrl: target.href, user, password, socketUrl: ebotSocketUrl(target.href), loadAes: loadAes || (() => Promise.resolve({ Aes: AesEsm })) });
  adminCache = { key, admin };
  return { admin };
};

// ---------- опциональный токен доступа ----------

const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text))));
}

// Сравнение строк одинаковой длины без раннего выхода: node:crypto
// timingSafeEqual на edge недоступен, а дайджесты обеих сторон всегда
// 64 hex-символа, поэтому посимвольное XOR-сравнение константно по времени.
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// EBOT_ADMIN_TOKEN не задан — режим прежний (только same-origin). Задан —
// каждый POST несёт x-ebot-token; в env лежит sha256:<hex> его дайджеста,
// сам токен остаётся только у оператора (как посчитать — deploy/README.md).
export async function checkToken(env, request) {
  const expected = String(env.EBOT_ADMIN_TOKEN || '').trim();
  if (!expected) return true;
  const m = expected.match(/^sha256:([0-9a-f]{64})$/i);
  const wanted = m ? m[1].toLowerCase() : await sha256Hex(expected);
  return sameHex(await sha256Hex(request.headers.get('x-ebot-token') || ''), wanted);
}

const COMMANDS = new Set(['stop', 'stopNoRs', 'passknife', 'forceknife',
  'forceknifeend', 'forcestart', 'stopback', 'pauseunpause', 'streamerready',
  'executeCommand', 'goBackRounds']);
const ALLOWED_ARGUMENT = /^(?:[ -~]{0,200})$/; // RCON-команда/номер раунда, без переводов строк

// Тело — маленький JSON; всё сверх 64 КБ отвергаем до разбора, чтобы чужой
// запрос не расходовал память изолята.
const MAX_BODY_BYTES = 64 * 1024;

async function readBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { oversize: true };
  let text;
  try { text = await request.text(); } catch { return null; }
  if (text.length > MAX_BODY_BYTES) return { oversize: true };
  try { return JSON.parse(text); } catch { return null; }
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
  if (!(await checkToken(env, request))) {
    return Response.json({ error: 'not-allowed', message: 'Нужен верный заголовок x-ebot-token.' }, { status: 401 });
  }
  const body = await readBody(request);
  if (body && body.oversize) {
    return Response.json({ error: 'request', message: 'Тело запроса больше 64 КБ.' }, { status: 413 });
  }
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'request', message: 'Ожидается JSON-запрос.' }, { status: 400 });
  }
  const built = adminFor(env, loadAes);
  if (built.error) return Response.json(built, { status: built.error === 'no-credentials' ? 401 : 500 });
  const matchId = /^\d{1,9}$/.test(String(body.matchId)) ? String(body.matchId) : '';
  const command = typeof body.command === 'string' ? body.command : '';
  const open = String(env.EBOT_ADMIN_OPEN || '') === '1';
  try {
    if (body.action === 'commands') {
      if (!matchId) throw Object.assign(new Error('Номер матча обязателен.'), { status: 400 });
      const { commands } = await built.admin.matchCommands(matchId);
      // ip сервера показываем только «открытым» деплоям: по умолчанию
      // панель за VPN/локальной сетью и адреса наружу не отдаём.
      const shown = commands.map(c => (open ? { action: c.action, ip: c.ip } : { action: c.action }));
      return Response.json({ commands: shown }, { headers: { 'cache-control': 'no-store' } });
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
      // Каталог раскрывает IP серверов — только явным EBOT_ADMIN_OPEN=1.
      if (!open) {
        return Response.json({ error: 'not-allowed', message: 'Каталог серверов eBot закрыт (EBOT_ADMIN_OPEN).' }, { status: 403 });
      }
      return Response.json(await built.admin.catalog(), { headers: { 'cache-control': 'no-store' } });
    }
    if (body.action === 'create') {
      const teamA = str(body.teamA, 25), teamB = str(body.teamB, 25);
      const map = str(body.map, 20), serverId = /^\d{1,5}$/.test(String(body.serverId)) ? String(body.serverId) : '';
      const password = str(body.password, 25);
      if (!teamA || !teamB || !map || !serverId) {
        throw Object.assign(new Error('Команды, карта и сервер обязательны.'), { status: 400 });
      }
      // Пустой пароль не шлём вообще (undefined): eBot сгенерирует свой.
      const result = await built.admin.createMatch({ teamA, teamB, map, serverId, password: password || undefined, side: str(body.side, 10) || 'random' });
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
  EBOT_PASSWORD: globalThis.Netlify?.env?.get?.('EBOT_PASSWORD') || globalThis.process?.env?.EBOT_PASSWORD || '',
  EBOT_ADMIN_TOKEN: globalThis.Netlify?.env?.get?.('EBOT_ADMIN_TOKEN') || globalThis.process?.env?.EBOT_ADMIN_TOKEN || '',
  EBOT_ADMIN_OPEN: globalThis.Netlify?.env?.get?.('EBOT_ADMIN_OPEN') || globalThis.process?.env?.EBOT_ADMIN_OPEN || ''
});

export const config = { path: '/api/ebot-admin' };
