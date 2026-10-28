// Starting a CS2 dedicated server from the panel, and its settings.
//
// This is the one place in the panel that runs a program, so it is deliberately
// boring: the executable path comes only from the environment, every argument
// comes only from a whitelist below, and nothing a browser sends is ever joined
// into a command line. A map name that is not in the pool is refused, a cvar
// that is not in the table is refused, and a value that is not a number or a
// plain word is refused. There is no «run this command» endpoint.
//
// Pure config building plus one small supervisor; the HTTP side is
// server/cs2-api.js.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The maps the panel's veto pool uses, by their server names. A map outside
// this list cannot be started: it is the difference between «de_mirage» and
// someone handing the server a path.
export const MAPS = {
  Ancient: 'de_ancient', Anubis: 'de_anubis', Cache: 'de_cache', Dust2: 'de_dust2',
  Inferno: 'de_inferno', Mirage: 'de_mirage', Nuke: 'de_nuke', Overpass: 'de_overpass',
  Train: 'de_train', Vertigo: 'de_vertigo', Office: 'cs_office', Italy: 'cs_italy'
};
export const MAP_NAMES = Object.keys(MAPS);

// Cvars the panel may set, each with what it accepts and what it means in the
// interface. `int` takes a range so a typo cannot hand the server an absurd
// value; `bool` takes 0/1; `enum` takes one of a fixed list. Anything else the
// operator wants goes into the cfg file on the server machine by hand.
export const CVARS = {
  mp_maxrounds: { type: 'int', min: 1, max: 60, def: 30, label: 'Раундов всего' },
  mp_roundtime: { type: 'number', min: 0.5, max: 10, def: 1.92, label: 'Время раунда, мин' },
  mp_freezetime: { type: 'int', min: 0, max: 60, def: 20, label: 'Закупка, сек' },
  mp_halftime: { type: 'bool', def: 1, label: 'Смена сторон' },
  mp_overtime_enable: { type: 'bool', def: 1, label: 'Овертаймы' },
  mp_maxmoney: { type: 'int', min: 0, max: 65535, def: 16000, label: 'Максимум денег' },
  mp_startmoney: { type: 'int', min: 0, max: 65535, def: 800, label: 'Стартовые деньги' },
  mp_buytime: { type: 'number', min: 0, max: 120, def: 20, label: 'Время закупа, сек' },
  mp_buy_anywhere: { type: 'bool', def: 0, label: 'Закупка везде' },
  mp_friendlyfire: { type: 'bool', def: 1, label: 'Огонь по своим' },
  mp_solid_teammates: { type: 'bool', def: 1, label: 'Тиммейты твёрдые' },
  mp_teammates_are_enemies: { type: 'bool', def: 0, label: 'Все против всех' },
  mp_forcecamera: { type: 'int', min: 0, max: 2, def: 1, label: 'Камера после смерти' },
  mp_limitteams: { type: 'int', min: 0, max: 10, def: 2, label: 'Разница в составах' },
  mp_autoteambalance: { type: 'bool', def: 1, label: 'Автобаланс' },
  mp_warmuptime: { type: 'int', min: 0, max: 600, def: 300, label: 'Разминка, сек' },
  mp_warmup_end: { type: 'bool', def: 0, label: 'Разминка закончена' },
  sv_cheats: { type: 'bool', def: 0, label: 'Читы (только для теста)' },
  sv_pausable: { type: 'bool', def: 1, label: 'Пауза игроком' },
  sv_alltalk: { type: 'bool', def: 0, label: 'Общий войс' },
  sv_deadtalk: { type: 'bool', def: 1, label: 'Мёртвые говорят' },
  // The log the journal needs: mp_logdetail 3 is what damage lines require.
  mp_logdetail: { type: 'int', min: 0, max: 3, def: 3, label: 'Подробность лога' },
  log: { type: 'bool', def: 1, label: 'Лог включён' }
};

// The command-line switches the panel may pass. Same rule: fixed strings, only
// the value is checked.
const SWITCHES = {
  gameport: { type: 'port', def: 27015 },
  hostport: { type: 'port', def: 27016 },
  clientport: { type: 'port', def: 27005 },
  maxplayers: { type: 'int', min: 2, max: 64, def: 12 }
};

const isPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
// A value that may go on a command line or into a cfg file: letters, digits and
// a few punctuation marks, and nothing that could continue the line.
const isPlainWord = value => /^[A-Za-z0-9_.-]{1,32}$/.test(value);
// A hostname or another quoted cfg string: punctuation is fine, a quote, a
// backslash or a line break is not — none of them may end the string early or
// add a second command to the file.
const isText = value => /^[^"\\\r\n\x00-\x1f\x7f]{0,64}$/u.test(value);

// A settings object from a request → { cvars, map, switches, errors }. Errors
// are in words, so the panel can say what is wrong instead of starting the
// server with half the settings.
export function normalizeSettings(value) {
  const errors = [];
  const raw = value && typeof value === 'object' ? value : {};
  const allowed = new Set(['cvars', 'map', ...Object.keys(SWITCHES), 'hostname', 'rconPassword', 'steamKey']);
  for (const name of Object.keys(raw)) {
    if (!allowed.has(name)) errors.push(`Настройка ${name} не поддерживается панелью.`);
  }
  const cvars = {};
  for (const [name, spec] of Object.entries(CVARS)) {
    const given = raw.cvars?.[name];
    if (given === undefined || given === '' || given === null) continue;
    if (spec.type === 'bool') {
      const flag = given === true || given === 1 || given === '1' || given === 'on';
      const off = given === false || given === 0 || given === '0' || given === 'off';
      if (!flag && !off) { errors.push(`${spec.label}: нужно «включено» или «выключено».`); continue; }
      cvars[name] = flag ? 1 : 0;
    } else if (spec.type === 'enum') {
      const text = String(given);
      if (!spec.values.includes(text)) { errors.push(`${spec.label}: одно из ${spec.values.join(', ')}.`); continue; }
      cvars[name] = text;
    } else {
      const number = Number(given);
      if (!Number.isFinite(number)) { errors.push(`${spec.label}: нужно число.`); continue; }
      if (number < spec.min || number > spec.max) { errors.push(`${spec.label}: от ${spec.min} до ${spec.max}.`); continue; }
      cvars[name] = spec.type === 'int' ? Math.round(number) : number;
    }
  }
  // Unknown cvars are refused, not ignored: a silently dropped setting is the
  // kind of thing that is found out during the broadcast.
  for (const name of Object.keys(raw.cvars || {})) {
    if (!Object.hasOwn(CVARS, name)) errors.push(`Настройка ${name} не поддерживается панелью.`);
  }

  let map = '';
  if (raw.map) {
    const given = String(raw.map).trim();
    // Accept both «Mirage» and «de_mirage».
    const found = Object.entries(MAPS).find(([label, file]) =>
      label.toLowerCase() === given.toLowerCase() || file.toLowerCase() === given.toLowerCase());
    if (!found) errors.push(`Карта ${given} не из пула панели: ${MAP_NAMES.join(', ')}.`);
    else map = found[1];
  }

  const switches = {};
  for (const [name, spec] of Object.entries(SWITCHES)) {
    const given = raw[name];
    if (given === undefined || given === '' || given === null) continue;
    const number = Number(given);
    if (spec.type === 'port') {
      if (!isPort(number)) { errors.push(`Порт ${name}: от 1024 до 65535.`); continue; }
      switches[name] = number;
    } else if (spec.type === 'int') {
      if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
        errors.push(`Игроков: от ${spec.min} до ${spec.max}.`); continue;
      }
      switches[name] = number;
    } else if (spec.type === 'enum') {
      const text = String(given);
      if (!spec.values.includes(text)) { errors.push(`Тикрейт: ${spec.values.join(' или ')}.`); continue; }
      switches[name] = text;
    }
  }

  // Text that ends up in the cfg file: a hostname and an RCON password are the
  // two things an operator types.
  const hostname = raw.hostname !== undefined && raw.hostname !== '' ? String(raw.hostname).trim() : '';
  if (hostname && !isText(hostname)) errors.push('Название сервера: только буквы, цифры и обычная пунктуация, до 64 знаков.');
  const rconPassword = raw.rconPassword !== undefined && raw.rconPassword !== '' ? String(raw.rconPassword) : '';
  if (rconPassword && !/^[A-Za-z0-9_.-]{6,64}$/.test(rconPassword)) {
    errors.push('Пароль RCON: 6–64 знака, латиница, цифры, _ . - (без пробелов и кавычек).');
  }
  const steamKey = raw.steamKey !== undefined && raw.steamKey !== '' ? String(raw.steamKey) : '';
  if (steamKey && !/^[A-F0-9]{32}$/i.test(steamKey)) errors.push('Ключ Steam Web API: 32 шестнадцатеричных знака.');

  return { errors, map, cvars, switches, hostname, rconPassword, steamKey };
}

// The cfg file the server reads. Written from the normalized settings only, so
// every line here has already passed the checks above.
export function buildCfg({ cvars = {}, map = '', hostname = '', rconPassword = '', steamKey = '', logUrl = '' }) {
  const lines = [
    '// Сгенерировано Oneshot Panel. Правки от руки здесь будут перезаписаны:',
    '// настройки задаются во вкладке «Сервер».',
    `hostname "${hostname}"`,
    'sv_lan 0',
    'sv_region 3',
    'sv_visiblemaxplayers 10',
    'mp_teamname_1 ""',
    'mp_teamname_2 ""',
    'mp_autokick 0',
    'sv_kick_players_with_cooldown 0',
    'sv_kick_ban_enabled 0'
  ];
  if (rconPassword) lines.push(`rcon_password "${rconPassword}"`);
  if (steamKey) lines.push(`sv_setsteamaccount "${steamKey}"`);
  // The journal needs both: the log switched on and the address it is posted to.
  lines.push('log on', 'mp_logdetail 3');
  if (logUrl) lines.push(`logaddress_add_http "${logUrl}"`);
  for (const [name, value] of Object.entries(cvars)) lines.push(`${name} ${value}`);
  if (map) lines.push(`map ${map}`);
  return lines.join('\n') + '\n';
}

// The argument list, as an array of separate argv entries: spawn runs without a
// shell, so one entry is one argument and no value can continue into the next
// one or start a second command.
export function buildArgs({ switches = {}, map = '', cfgName = 'oneshot' }) {
  const args = ['-game', 'csgo', '-console', '-usercon', '-dedicated',
    '+game_type', '0', '+game_mode', '1'];
  for (const [name, spec] of Object.entries(SWITCHES)) {
    const value = switches[name];
    if (value === undefined) continue;
    args.push(spec.arg || `-${name}`, String(value));
  }
  args.push('+exec', `${cfgName}.cfg`);
  if (map) args.push('+map', map);
  return args;
}

// The supervisor: one server process at a time, its state readable by the panel,
// and its output kept in a file. It never restarts by itself — an operator
// starts and stops it, and a crash is reported, not hidden behind a loop.
export const MAX_OUTPUT = 8 * 1024 * 1024;
export function createLauncher({ env = process.env, spawnImpl = spawn, cwd = '' } = {}) {
  // Where the CS2 dedicated server lives. Without it the panel says so plainly
  // instead of guessing a path.
  const bin = String(env.CS2_SERVER_BIN || '').trim();
  const dir = String(cwd || env.CS2_SERVER_DIR || '').trim();
  const cfgDir = String(env.CS2_CFG_DIR || (dir ? path.join(dir, 'game', 'csgo', 'cfg') : '')).trim();
  let child = null, startedAt = 0, lastExit = null, output = '', outputAt = 0;

  const keepOutput = text => {
    output = (output + text).slice(-MAX_OUTPUT);
    outputAt = Date.now();
  };

  return {
    bin, dir, cfgDir,
    // Is a server under the panel's control right now?
    get running() { return Boolean(child && child.exitCode === null && !child.killed); },
    get startedAt() { return startedAt; },
    get lastExit() { return lastExit; },
    get output() { return output; },
    get outputAt() { return outputAt; },
    status() {
      return { available: Boolean(bin), running: this.running, bin: bin ? path.basename(bin) : '',
        startedAt, lastExit, outputBytes: output.length };
    },
    // Write the cfg where the server reads it. Returns the file name, or an
    // error in words: the panel shows it instead of a stack trace.
    writeCfg(contents, name = 'oneshot') {
      if (!cfgDir) throw new Error('Не задана папка конфигов CS2 (CS2_CFG_DIR или CS2_SERVER_DIR).');
      if (!isPlainWord(name)) throw new Error('Неверное имя конфига.');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(path.join(cfgDir, `${name}.cfg`), contents, { mode: 0o600 });
      return `${name}.cfg`;
    },
    start(settings) {
      if (!bin) throw new Error('Не задан путь к серверу CS2 (переменная CS2_SERVER_BIN).');
      if (this.running) throw new Error('Сервер уже запущен: останови его, чтобы поменять настройки.');
      if (!path.isAbsolute(bin)) throw new Error('CS2_SERVER_BIN должен быть полным путём к srcds.');
      const args = buildArgs(settings);
      const spawned = spawnImpl(bin, args, {
        cwd: dir || undefined,
        // No shell: an argument is an argument, and nothing in it is expanded.
        shell: false, windowsHide: true,
        env: { ...env, CS2_SERVER_BIN: undefined, CS2_RCON_PASSWORD: undefined }
      });
      child = spawned; startedAt = Date.now(); lastExit = null;
      spawned.stdout?.on('data', chunk => keepOutput(String(chunk)));
      spawned.stderr?.on('data', chunk => keepOutput(String(chunk)));
      spawned.on('error', error => { lastExit = { code: null, signal: '', error: error.message, at: Date.now() }; child = null; });
      spawned.on('exit', (code, signal) => {
        lastExit = { code, signal: signal || '', error: '', at: Date.now() };
        if (child === spawned) child = null;
      });
      return { pid: spawned.pid, args };
    },
    // SIGTERM first, and a kill only if the server ignored it: a CS2 server
    // needs a moment to release its ports.
    stop({ force = false } = {}) {
      if (!child) return false;
      try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { return false; }
      if (force) { child = null; }
      return true;
    },
    // One console command on the running server, from the fixed allowlist in
    // cs2-rcon.js's callers. It goes over RCON, not through the child's stdin,
    // because CS2's console does not read piped input reliably.
    get pid() { return child?.pid || 0; }
  };
}
