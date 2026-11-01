// Доступ к публичным медиа eBot (сборка Flegma на 37.230.228.105): GOTV-демки
// (записи карт матча) и текстовые экспорты статистики. Только сервер и
// функции хостинга, как server/ebot-admin.js, никогда браузер: адрес eBot
// приходит из env через targetHref и пересобирается здесь, из
// пользовательского запроса в URL не попадает ничего. Куки сессии, если
// интеграция их держит, приходят с её fetchImpl — сам модуль заголовков
// не добавляет: маршруты ниже публичны, sfGuard не проверяется.
//
// Маршруты сверены с исходниками ebot-inspect (routing.yml + actions) и
// живыми GET-пробами (только чтение, ноябрь 2026): демка — именованный
// маршрут matchs_demo, /matchs/demo/:id с model Maps, т.е. id КАРТЫ матча
// (MapsTable), не матча; нет карты — 404, не-цифры — 500 (требование \d+).
// Экспортных именованных маршрутов в routing.yml НЕТ: действия достижимы
// только через generic-маршрут symfony /:module/:action/*, поэтому URL —
// /matchs/<action>/<id>. На живой сборке все четыре экспорта отвечают 500:
// код действий зовёт getRoute()->getObject(), а generic-маршрут — sfRoute
// без getObject (PHP fatal). Модуль строит канонический URL и честно
// возвращает русскую ошибку; экспорты заработают, когда на eBot добавят
// именованные sfDoctrineRoute-маршруты (по строке на действие).

const HTTP_TIMEOUT_MS = 30_000; // экспорт до 10 МБ — длиннее страницы списка (12 с в ebot.mjs)

// Тело экспорта читаем стримом и не длиннее 10 МБ: таблице панели
// мегабайтные дампы не нужны, а память серверного изолята ограничена.
export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
const TOO_BIG = 'Экспорт eBot больше 10 МБ.';

// renderText у symfony отдаёт text/html даже для JSON, поэтому принимаем
// текстовые и JSON типы; бинарные ответы (демка, архив) — ошибка.
const EXPORT_TYPES = new Set([
  'text/csv', 'text/plain', 'text/html', 'application/json', 'application/csv'
]);

// ---------- адрес eBot и идентификаторы ----------

// Как ebotTarget в netlify/functions/ebot.mjs (тот же принцип: адрес — из
// env, без userinfo, query и фрагмента; префикс пути не поддерживаем —
// pathname маршрута пишется целиком, как в прокси списка). Ошибки здесь —
// русские исключения: функция хостинга превратит их в ответ оператору.
function ebotMediaTarget(targetHref) {
  let url;
  try { url = new URL(String(targetHref ?? '').trim()); }
  catch { throw new Error('Адрес eBot задан неверно.'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Адрес eBot задан неверно.');
  }
  return url;
}

// Идентификаторы eBot — только цифры (1–9 знаков, как view/heatmap в
// ebot.mjs): из аргументов в URL eBot не попадает больше ничего.
const ID_RE = /^\d{1,9}$/;

function requireId(value, message) {
  const id = String(value ?? '');
  if (!ID_RE.test(id)) throw new Error(message);
  return id;
}

// ---------- экспорты статистики ----------

// kind лишь выбирает готовое имя action и сам в URL не попадает: любые
// обходные значения («../../», «constructor») отбрасывает белый список.
const EXPORT_ACTIONS = new Map([
  ['players', 'exportPlayers'],
  ['rounds', 'exportRounds'],
  ['kills', 'exportKills'],
  ['estats', 'exportEstats']
]);
// Toornament-экспорт (executeExport, /matchs/toornament/export/:id) сюда
// не входит: он не отдаёт данные, а проталкивает результат матча в
// Toornament по ключу плагина — на живом eBot всегда {"status":false}.

export function ebotExportKinds() {
  // Свежий массив: вызывающий не может испортить белый список модуля.
  return [...EXPORT_ACTIONS.keys()];
}

export function ebotExportUrl(targetHref, matchId, kind) {
  const action = EXPORT_ACTIONS.get(kind);
  if (!action) throw new Error('Неизвестный вид экспорта eBot.');
  const id = requireId(matchId, 'Номер матча eBot — только цифры.');
  const target = ebotMediaTarget(targetHref);
  target.pathname = '/matchs/' + action + '/' + id;
  return target.href;
}

export async function ebotExport({ targetHref, matchId, kind, fetchImpl = globalThis.fetch }) {
  const url = ebotExportUrl(targetHref, matchId, kind);
  let response;
  try {
    // Редиректы просим следовать: на закрытой установке переход на /login
    // закончится HTML-страницей, которую отвергнет проверка content-type.
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
  } catch {
    throw new Error('eBot не ответил на запрос экспорта.');
  }
  if (!response.ok) {
    // 500 живой сборки (см. шапку) виден оператору кодом, без тела eBot.
    throw new Error(`eBot ответил ошибкой на экспорт (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!EXPORT_TYPES.has(contentType.split(';')[0].trim().toLowerCase())) {
    throw new Error('eBot вернул экспорт не в текстовом виде.');
  }
  return { text: await readExportText(response), contentType };
}

// Стримом с подсчётом байт: в памяти копятся только принятые куски (не
// больше лимита), при превышении чтение отменяется — хвост не качается.
async function readExportText(response) {
  if (!response.body) {
    // Ответ без стрима (такого у eBot не бывает) — тело уже целиком у
    // окружения, лимит проверяем по длине текста.
    const whole = await response.text();
    if (whole.length > MAX_EXPORT_BYTES) throw new Error(TOO_BIG);
    return whole;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EXPORT_BYTES) throw new Error(TOO_BIG);
      chunks.push(value);
    }
  } finally {
    // При ошибке останавливает загрузку остатка; после полного прочтения
    // cancel закрытого потока безвреден.
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// ---------- демки (GOTV-записи) ----------

// id КАРТЫ, не матча: маршрут matchs_demo объявлен с model Maps, и сам
// eBot зовёт url_for("matchs_demo", $map). Номера карт — таблица «Demos»
// страницы матча (/matchs/view, колонка #ID); записи нет — eBot отдаст
// пустой 200, карты нет — 404. Наличие демки решает сервер, модуль
// не гадает и статус наверх не подменяет.
export function ebotDemoUrl(targetHref, mapId) {
  const id = requireId(mapId, 'Номер карты eBot — только цифры.');
  const target = ebotMediaTarget(targetHref);
  target.pathname = '/matchs/demo/' + id;
  return target.href;
}

export async function ebotDemo({ targetHref, mapId, fetchImpl = globalThis.fetch }) {
  const url = ebotDemoUrl(targetHref, mapId);
  try {
    // Тело не читаем: демка в десятки МБ идёт стримом дальше, в ответ
    // интеграции. Таймаута нет: законная долгая загрузка не должна
    // обрываться на середине файла.
    return await fetchImpl(url, { method: 'GET', redirect: 'follow' });
  } catch {
    throw new Error('eBot не отдал демку.');
  }
}
