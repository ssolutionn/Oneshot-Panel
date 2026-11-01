// Клиент TeamSpeak 3 ServerQuery поверх node:net, без зависимостей.
// Одно подключение на операцию: connect → welcome → login → use → команда → quit.
// Мьют тренера случается раз в раунд, частота низкая — висячих сессий не держим.
// Пароль ServerQuery не логируем и в тексты ошибок не включаем.
import net from 'node:net';

const DUP = 2561; // «клиент уже в группе / уже не в группе» — для нас это успех

// Экранирование аргументов ServerQuery: пробел → \s, / → \p, \ → \\.
export function tsEscape(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('/', '\\p')
    .replaceAll(' ', '\\s');
}

// Обратное преобразование; неизвестная последовательность остаётся как есть.
export function tsUnescape(value) {
  return String(value ?? '').replace(/\\(.)/g, (_, ch) =>
    ch === 's' ? ' ' : ch === 'p' ? '/' : ch === '\\' ? '\\' : '\\' + ch);
}

// Параметры одной записи «k=v k=v»; пробелы в значениях приходят как \s,
// поэтому сплит по сырой строке безопасен. Слова без «=» пропускаем.
export function parseParams(part) {
  const out = {};
  for (const token of String(part ?? '').split(' ')) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    out[token.slice(0, eq)] = tsUnescape(token.slice(eq + 1));
  }
  return out;
}

// Ответ clientlist/servergrouplist: построчно, записи через |, параметры k=v.
// Толерантно к пропущенным полям и пустым строкам.
export function parseRows(lines) {
  const rows = [];
  for (const line of lines || []) {
    for (const part of String(line).split('|')) {
      if (!part) continue;
      const params = parseParams(part);
      if (Object.keys(params).length) rows.push(params);
    }
  }
  return rows;
}

// Строка «error id=N msg=...» — конец ответа команды. Реальный TS бывает
// экранирует пробелы в msg, бывает нет, поэтому msg берём до конца строки.
export function parseErrorLine(line) {
  const text = String(line ?? '');
  const at = text.indexOf('msg=');
  return {
    id: Number(parseParams(text.slice(0, at >= 0 ? at : text.length)).id) || 0,
    msg: at >= 0 ? tsUnescape(text.slice(at + 4)) : '',
  };
}

// Одно TCP-соединение ServerQuery: ждёт приветствие, потом ответы на команды.
function createConnection({ netImpl, host, port, connectTimeoutMs, commandTimeoutMs, log }) {
  const socket = netImpl.connect({ host, port });
  let buffer = '', current = null, waiter = null, dead = null, timer = null;
  // closePromise: quit ждёт полного закрытия — висячих сессий не остаётся.
  let closedResolve;
  const closedPromise = new Promise(resolve => { closedResolve = resolve; });

  function fail(error) {
    if (dead) return;
    dead = error;
    clearTimeout(timer);
    socket.destroy();
    if (waiter) { const w = waiter; waiter = null; w.reject(error); }
    if (current) { const c = current; current = null; c.reject(error); }
  }

  function armTimer(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => fail(new Error('TeamSpeak не ответил (таймаут).')), ms);
  }

  const handleLine = line => {
    if (!line || line.startsWith('notify')) return; // уведомления игнорируем
    if (line.startsWith('error')) {
      clearTimeout(timer);
      const c = current; current = null;
      if (c) c.resolve({ ...parseErrorLine(line), data: c.data });
      return;
    }
    if (waiter) {
      // До приветствия никакие команды не отправляются.
      if (line.startsWith('Welcome to the TeamSpeak')) {
        const w = waiter; waiter = null; clearTimeout(timer); w.resolve();
      }
      return;
    }
    if (current) current.data.push(line);
  };

  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, nl).replace(/\r$/, ''));
      buffer = buffer.slice(nl + 1);
    }
  });
  socket.on('error', error => fail(new Error(error.code === 'ECONNREFUSED'
    ? 'TeamSpeak недоступен: сервер выключен или порт закрыт.'
    : 'Ошибка соединения с TeamSpeak.')));
  socket.on('close', () => { closedResolve(); fail(new Error('TeamSpeak закрыл соединение.')); });
  socket.on('timeout', () => fail(new Error('TeamSpeak не ответил (таймаут).')));

  // Таймер закрывает и подключение, и ожидание приветствия.
  const ready = new Promise((resolve, reject) => {
    waiter = { resolve, reject };
    armTimer(connectTimeoutMs);
  });

  const command = cmd => {
    if (dead) return Promise.reject(dead);
    return new Promise((resolve, reject) => {
      current = { resolve, reject, data: [] };
      armTimer(commandTimeoutMs);
      // В лог идёт только имя команды: у login в аргументах пароль.
      log(`ts → ${cmd.split(' ')[0]}`);
      socket.write(cmd + '\n');
    });
  };

  // Завершаем сессию и ждём закрытия; страховочный таймаут рвёт сокет,
  // если сервер не закрывает соединение по quit.
  const quit = () => {
    if (dead) return closedPromise;
    try { socket.end('quit\n'); } catch { socket.destroy(); }
    setTimeout(() => socket.destroy(), commandTimeoutMs).unref();
    return closedPromise;
  };

  return { ready, command, quit };
}

// Выполняет команду и превращает «error id=N msg=…» в русскую ошибку.
// 2561 (дубликат состава группы) по желанию считается успехом.
async function run(conn, cmd, { duplicateOk = false } = {}) {
  const res = await conn.command(cmd);
  if (res.id !== 0 && !(res.id === DUP && duplicateOk)) {
    throw new Error(`TeamSpeak отклонил команду ${cmd.split(' ')[0]} (id=${res.id}, msg=${res.msg}).`);
  }
  return res.data;
}

export function createTeamspeak({
  host = '127.0.0.1', port = 10011, login, password,
  usePort = 9987, muteGroupName = 'Oneshot Muted',
  connectTimeoutMs = 10_000, commandTimeoutMs = 10_000,
  netImpl, log = () => {},
} = {}) {
  const impl = netImpl || net;
  let sgid = null; // кэш id группы мьюта, живёт в этом объекте

  const withSession = async fn => {
    if (!login) throw new Error('Логин ServerQuery не задан (переменная TS_QUERY_LOGIN).');
    if (!password) throw new Error('Пароль ServerQuery не задан (переменная TS_QUERY_PASSWORD).');
    const conn = createConnection({ netImpl: impl, host, port, connectTimeoutMs, commandTimeoutMs, log });
    await conn.ready;
    try {
      const auth = await conn.command(`login ${tsEscape(login)} ${tsEscape(password)}`);
      if (auth.id !== 0) throw new Error(`TeamSpeak отклонил логин (id=${auth.id}).`);
      const used = await conn.command(`use port=${usePort}`);
      if (used.id !== 0) throw new Error(`TeamSpeak отклонил команду use (id=${used.id}, msg=${used.msg}).`);
      return await fn(conn);
    } finally {
      await conn.quit(); // сессию не держим: каждая операция — своё подключение
    }
  };

  // Ищет группу мьюта в servergrouplist; нет — создаёт и запоминает sgid.
  const obtainSgid = async conn => {
    if (sgid != null) return sgid;
    const wanted = muteGroupName.trim().toLowerCase();
    const rows = parseRows(await run(conn, 'servergrouplist'));
    const found = rows.find(r => String(r.name ?? '').trim().toLowerCase() === wanted);
    if (found && found.sgid != null) return (sgid = Number(found.sgid));
    const made = parseParams((await run(conn, `servergroupadd name=${tsEscape(muteGroupName)}`))[0] || '');
    if (made.sgid == null) throw new Error('TeamSpeak не вернул id созданной группы мьюта.');
    return (sgid = Number(made.sgid));
  };

  const norm = s => String(s ?? '').trim().toLowerCase();

  // Общий путь мьюта и анмьюта: clientlist → сопоставление ников → группа.
  const groupClients = async (nicks, commandName) => {
    const list = (Array.isArray(nicks) ? nicks : [nicks])
      .map(n => String(n ?? '').trim()).filter(Boolean);
    if (!list.length) return { muted: [], missed: [] };
    return withSession(async conn => {
      const group = await obtainSgid(conn);
      const rows = parseRows(await run(conn, 'clientlist'));
      // Один и тот же ник бывает у нескольких подключённых (два окна):
      // мьютим ВСЕХ с этим ником, а не последнего в списке (находка
      // аудита — Map перезаписывал первого).
      const byNick = new Map();
      for (const r of rows) {
        const nick = r.nickname ?? r.client_nickname;
        if (nick == null) continue;
        const key = norm(nick);
        if (!byNick.has(key)) byNick.set(key, []);
        byNick.get(key).push(r);
      }
      const muted = [], missed = [];
      for (const nick of list) {
        const found = byNick.get(norm(nick));
        if (!found || !found.length) { missed.push(nick); continue; } // не зашёл в TS
        for (const row of found) {
          const dbId = Number(row.client_database_id);
          if (!dbId) continue;
          // Дубликат (уже в группе / уже не в группе) — молча успех.
          await run(conn, `${commandName} sgid=${group} cldbid=${dbId}`, { duplicateOk: true });
          muted.push({ nick: row.nickname ?? row.client_nickname, clId: Number(row.clid) || null, dbId });
        }
      }
      return { muted, missed };
    });
  };

  return {
    muteClients: nicks => groupClients(nicks, 'servergroupaddclient'),
    unmuteClients: nicks => groupClients(nicks, 'servergroupdelclient'),

    // Группа мьюта сама НЕ меняет talk power: канал тренера должен иметь
    // needed talk power > talk power группы, чтобы группа реально заглушала.
    ensureMuteGroup: () => withSession(obtainSgid),

    // «Кто онлайн» для интеграции: сопоставление ников панели и TS.
    clientList: () => withSession(async conn =>
      parseRows(await run(conn, 'clientlist')).map(r => ({
        clId: Number(r.clid) || null,
        cid: Number(r.cid) || null,
        nick: r.nickname ?? r.client_nickname ?? '',
        dbId: Number(r.client_database_id) || null,
      }))),
  };
}
