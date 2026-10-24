#!/usr/bin/env node
// Пульт проверок: выбирает suites по диффу, запускает их и сводит report.json.
// Один и тот же вход у человека, CI и агента — иначе вердикт гейта ничего не значит.
//
//   npm run verify                     # T0 + T1 по изменениям в рабочем дереве
//   npm run verify -- --base origin/main
//   npm run verify -- --tier T0        # быстро: синтаксис и unit-тесты
//   npm run verify -- --only browser-panel --url http://127.0.0.1:3000
//   npm run verify -- --list
//
// Дочерние процессы пишут в файлы, а не в pipe: в песочнице Windows именованные
// каналы запрещены, а CI это не мешает. Никаких внешних зависимостей.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesAny, normalizePath } from './agent/globs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = path.join(root, 'artifacts', 'agent');
const registry = JSON.parse(readFileSync(path.join(root, 'scripts', 'agent', 'suites.json'), 'utf8'));
const suitesById = registry.suites;

const ENV_SIGNS = [
  [/Cannot find module 'playwright'/, 'playwright не установлен'],
  [/No module named 'playwright'/, 'playwright не установлен'],
  [/Executable doesn't exist/i, 'браузер Playwright не установлен'],
  [/playwright install/i, 'нужен playwright install'],
  [/spawn EPERM/, 'песочница запретила запуск процесса'],
  [/PermissionError.*(?:Temp|tmp)|WinError 5/i, 'нет доступа к файлу: песочница или права'],
  [/ECONNREFUSED|EADDRINUSE/, 'сервер или порт недоступны'],
  [/ModuleNotFoundError|No module named '(?:PIL|websockets)'/i, 'нет python-модуля (pip install)']
];

let captureSeq = 0;

function die(message, code = 2) {
  process.stderr.write(`verify: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    tier: 'T1', only: [], all: false, base: '', json: false, list: false, verbose: false, url: '', dryRun: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const [flag, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    const value = () => (inline !== undefined ? inline : argv[(i += 1)] ?? '');
    switch (flag) {
      case '--tier': opts.tier = String(value()).toUpperCase(); break;
      case '--only': opts.only.push(...String(value()).split(',').map(part => part.trim()).filter(Boolean)); break;
      case '--all': opts.all = true; break;
      case '--changed': break;
      case '--base': opts.base = value(); break;
      case '--url': opts.url = value(); break;
      case '--json': opts.json = true; break;
      case '--list': opts.list = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--verbose': opts.verbose = true; break;
      case '--keep-server': opts.keepServer = true; break;
      case '-h':
      case '--help': usage(); process.exit(0); break;
      default: die(`неизвестный флаг ${raw} (см. --help)`);
    }
  }
  if (!['T0', 'T1', 'T2'].includes(opts.tier)) die(`--tier: ожидается T0, T1 или T2, получено ${opts.tier}`);
  return opts;
}

function usage() {
  process.stdout.write(`Проверки панели: выбор по диффу и машинный отчёт.

  npm run verify [-- --tier T0|T1|T2] [--only id] [--all] [--base ref]
                 [--url http://…] [--json] [--list] [--dry-run] [--verbose]

  T0  синтаксис и unit-тесты, идут всегда
  T1  браузерные сценарии по карте риска (по умолчанию вместе с T0)
  T2  настоящий OBS/VDO/WebKit/Cloudflare — ночной контур, только с --tier T2
`);
}

function capture(cmd, args, dir) {
  const tmp = path.join(dir, '.tmp');
  mkdirSync(tmp, { recursive: true });
  const stem = path.join(tmp, `cap-${process.pid}-${captureSeq++}`);
  const outFile = `${stem}-out.txt`;
  const errFile = `${stem}-err.txt`;
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  const result = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', outFd, errFd] });
  closeSync(outFd);
  closeSync(errFd);
  const text = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  const stderr = existsSync(errFile) ? readFileSync(errFile, 'utf8') : '';
  for (const file of [outFile, errFile]) {
    try { rmSync(file, { force: true }); } catch { /* не мешает вердикту */ }
  }
  return { status: result.status, text, stderr, error: result.error };
}

function changedFiles(base, dir) {
  const files = new Set();
  const add = text => {
    for (const line of String(text || '').split('\n')) {
      const file = normalizePath(line.trim());
      if (file) files.add(file);
    }
  };
  const head = capture('git', ['diff', '--name-only', 'HEAD'], dir);
  if (head.error || head.status === null) return { files: [], git: false };
  add(head.text);
  const untracked = capture('git', ['ls-files', '--others', '--exclude-standard', '--', '.'], dir);
  if (untracked.status === 0) add(untracked.text);
  if (base) {
    const range = capture('git', ['diff', '--name-only', `${base}...HEAD`], dir);
    if (range.status === 0) add(range.text);
  }
  return { files: [...files].sort(), git: true };
}

function findPython() {
  const candidates = [process.env.PYTHON, process.platform === 'win32' ? 'python' : 'python3', 'python3', 'python']
    .filter(Boolean);
  for (const cmd of [...new Set(candidates)]) {
    const probe = spawnSync(cmd, ['-c', 'import sys'], { stdio: 'ignore' });
    if (probe.status === 0) return cmd;
  }
  return '';
}

function importModule(python, name) {
  return spawnSync(python, ['-c', `import ${name}`], { stdio: 'ignore' }).status === 0;
}

async function hasNetwork() {
  if (process.env.AGENT_TESTS_OFFLINE === '1') return false;
  try {
    await fetch('https://vdo.ninja/', { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

function tail(text, lines = 30) {
  const kept = String(text || '').split(/\r?\n/).filter(line => line.trim());
  return kept.slice(-lines).join('\n');
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function classifyEnv(text) {
  for (const [pattern, reason] of ENV_SIGNS) {
    if (pattern.test(text)) return reason;
  }
  return '';
}

function listEvidence(dir) {
  const found = [];
  const walk = (current, depth) => {
    if (depth > 3 || found.length >= 12) return;
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const info = statSync(full);
      if (info.isDirectory()) {
        walk(full, depth + 1);
      } else if (!/\.log$/i.test(name) && name !== 'qa-report.json') {
        found.push(path.relative(root, full).replaceAll('\\', '/'));
      }
    }
  };
  try { walk(dir, 0); } catch { /* каталог мог не появиться */ }
  return found.slice(0, 12);
}

function selectSuites(opts, changed) {
  if (opts.only.length) {
    const unknown = opts.only.filter(id => !suitesById[id]);
    if (unknown.length) die(`--only: нет таких проверок: ${unknown.join(', ')} (см. --list)`);
    const ids = new Set(opts.only);
    return Object.entries(suitesById).filter(([id]) => ids.has(id));
  }
  return Object.entries(suitesById).filter(([, suite]) => {
    if (suite.tier === 'T0') return true;
    if (suite.tier === 'T1') return opts.tier !== 'T0' && (opts.all || changed.some(file => matchesAny(suite.select || [], file)));
    if (suite.tier === 'T2') return opts.tier === 'T2' && (opts.all || changed.some(file => matchesAny(suite.select || [], file)));
    return false;
  });
}

function unmatchedPaths(changed) {
  const runtime = /\.(?:js|mjs|html|css|json)$/i;
  const infra = /^(?:test|docs|\.github|scripts\/agent)\//;
  const candidates = changed.filter(file => runtime.test(file) && !infra.test(file));
  return candidates.filter(file =>
    !Object.values(suitesById).some(suite => (suite.select || []).length && matchesAny(suite.select, file))
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {
      try { child.kill('SIGKILL'); } catch { /* уже мёртв */ }
    }
  }
}

function runProcess(cmd, args, options) {
  return new Promise(resolve => {
    const fd = openSync(options.logPath, 'w');
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: root,
        env: options.env,
        stdio: ['ignore', fd, fd],
        detached: process.platform !== 'win32'
      });
    } catch (error) {
      closeSync(fd);
      resolve({ code: null, timedOut: false, error });
      return;
    }
    closeSync(fd);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1000, options.timeoutMs));
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, error });
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });
}

function parseSpec(text) {
  const scenarios = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    // Node печатает spec, когда есть TTY, и TAP, когда вывод перенаправлен.
    // Понимаем оба: иначе в CI проверка выглядела бы пустой.
    const tap = line.match(/^(not )?ok\s+\d+\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO)\b.*)?$/);
    if (tap) {
      scenarios.push({ id: tap[2].trim(), status: tap[1] ? 'fail' : tap[3] ? 'skip' : 'pass' });
      continue;
    }
    const match = line.match(/^([✔✖﹣↷])\s+(.+?)\s*(?:\(\d+(?:\.\d+)?ms\))?\s*$/);
    if (!match) continue;
    const id = match[2].replace(/\s+#\s+(?:SKIP|TODO).*$/i, '').trim();
    if (!id) continue;
    scenarios.push({ id, status: match[1] === '✔' ? 'pass' : match[1] === '✖' ? 'fail' : 'skip' });
  }
  return scenarios;
}

function expand(value, context) {
  return String(value)
    .replaceAll('{url}', context.url || '')
    .replaceAll('{artifacts}', context.dir)
    .replaceAll('{python}', context.python)
    .replace(/\{env:([A-Z0-9_]+)\}/g, (_, name) => process.env[name] || '');
}

function describe(suite) {
  if (suite.kind === 'node-test') return `node ${suite.files.join(' ')}`;
  if (suite.kind === 'python-qa') return `python ${suite.script} ${(suite.args || []).join(' ')}`;
  return (suite.cmd || []).join(' ');
}

async function runNodeSuite(entry, suite, dir, context) {
  const started = Date.now();
  const failed = [];
  let timedOut = false;
  const logs = [];
  for (const file of suite.files) {
    const remaining = (suite.timeoutMs || 240000) - (Date.now() - started);
    if (remaining <= 0) { timedOut = true; break; }
    const logPath = path.join(dir, `${path.basename(file, '.test.js')}.log`);
    const result = await runProcess(process.execPath, [file], { logPath, env: context.env, timeoutMs: remaining });
    logs.push(logPath);
    const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    if (result.timedOut) {
      timedOut = true;
      entry.reason = `таймаут на ${file}`;
      break;
    }
    if (result.error) {
      entry.status = 'error';
      entry.errorClass = 'env';
      entry.reason = result.error.message;
      break;
    }
    if (result.code !== 0) failed.push(file);
    entry.scenarios.push(...parseSpec(text).map(scenario => ({ ...scenario, file })));
  }
  if (entry.status !== 'error' && timedOut) entry.status = 'error';
  if (entry.status === 'error') {
    entry.durationMs = Date.now() - started;
    return entry;
  }
  if (failed.length) {
    entry.status = 'fail';
    entry.reason = `упали: ${failed.map(file => path.basename(file)).join(', ')}`;
    for (const file of failed) {
      if (!entry.scenarios.some(scenario => scenario.file === file && scenario.status === 'fail')) {
        entry.scenarios.push({ id: path.basename(file), status: 'fail', file });
      }
    }
    entry.error = tail(logs.map(log => (existsSync(log) ? readFileSync(log, 'utf8') : '')).join('\n'));
  }
  entry.durationMs = Date.now() - started;
  return entry;
}

async function runPythonSuite(entry, suite, dir, context) {
  const started = Date.now();
  const reportPath = path.join(dir, 'qa-report.json');
  const logPath = path.join(dir, 'suite.log');
  const args = [
    'scripts/agent/run_qa.py',
    '--report', reportPath,
    '--log', path.join(dir, 'qa-output.log'),
    suite.script,
    ...(suite.args || []).map(arg => expand(arg, { ...context, dir }))
  ];
  const result = await runProcess(context.python, args, { logPath, env: context.env, timeoutMs: suite.timeoutMs });
  entry.durationMs = Date.now() - started;
  const report = readJson(reportPath);
  const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  if (result.timedOut) {
    entry.status = 'error';
    entry.reason = `таймаут ${Math.round((suite.timeoutMs || 0) / 1000)} с`;
  } else if (report) {
    entry.status = report.status;
    entry.scenarios = (report.scenarios || []).map(scenario => ({ ...scenario }));
    entry.error = report.error || '';
    entry.errorClass = report.errorClass || null;
    if (report.status === 'error' && !entry.reason) entry.reason = report.errorClass ? 'ошибка окружения' : 'ошибка сценария';
  } else if (result.code === 0) {
    entry.status = 'pass';
  } else {
    const reason = classifyEnv(text);
    entry.status = reason ? 'error' : 'fail';
    entry.reason = reason || 'сценарий упал без отчёта';
    entry.errorClass = reason ? 'env' : null;
    entry.error = tail(text);
  }
  if (entry.status === 'error' && !entry.errorClass) entry.errorClass = 'env';
  entry.evidence = listEvidence(dir);
  return entry;
}

async function runCommandSuite(entry, suite, dir, context) {
  const started = Date.now();
  const logPath = path.join(dir, 'suite.log');
  const [cmd, ...rest] = (suite.cmd || []).map(arg => expand(arg, { ...context, dir }));
  const result = await runProcess(cmd, rest, { logPath, env: context.env, timeoutMs: suite.timeoutMs });
  entry.durationMs = Date.now() - started;
  const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  if (result.timedOut) {
    entry.status = 'error';
    entry.reason = `таймаут ${Math.round((suite.timeoutMs || 0) / 1000)} с`;
    entry.errorClass = 'env';
  } else if (result.error || result.code !== 0) {
    const reason = classifyEnv(text);
    entry.status = reason ? 'error' : 'fail';
    entry.reason = reason || `код ${result.code}`;
    entry.errorClass = reason ? 'env' : null;
    entry.error = tail(text);
  }
  entry.evidence = listEvidence(dir);
  return entry;
}

function writeIndex(report, file) {
  const lines = [];
  lines.push(`# Проверки ${report.run.id}`, '');
  lines.push(`- режим: ${report.run.tier}${report.selection.all ? ', все проверки' : ', по диффу'}`);
  lines.push(`- изменено файлов: ${report.selection.changed.length}`);
  lines.push(`- итог: ${report.verdict === 'pass' ? 'зелено' : report.verdict === 'fail' ? 'есть провалы' : 'не проверено (окружение)'}`);
  lines.push('');
  lines.push('| проверка | статус | время | сценарии |');
  lines.push('|---|---|---|---|');
  for (const suite of report.suites) {
    const seconds = (suite.durationMs / 1000).toFixed(1);
    lines.push(`| ${suite.id} | ${suite.status} | ${seconds} с | ${suite.scenarios.length} |`);
  }
  const problems = report.suites.filter(suite => suite.status === 'fail' || suite.status === 'error');
  if (problems.length) {
    lines.push('', '## Провалы и ошибки', '');
    for (const suite of problems) {
      lines.push(`### ${suite.id} (${suite.status})`, '');
      if (suite.reason) lines.push(suite.reason, '');
      const failed = suite.scenarios.filter(scenario => scenario.status === 'fail').slice(0, 10);
      for (const scenario of failed) lines.push(`- ${scenario.id}`);
      if (failed.length) lines.push('');
      if (suite.evidence.length) lines.push(`Артефакты: ${suite.evidence.map(item => `\`${item}\``).join(', ')}`, '');
    }
  }
  const skipped = report.suites.filter(suite => suite.status === 'skip');
  if (skipped.length) {
    lines.push('', '## Пропущено', '');
    for (const suite of skipped) lines.push(`- ${suite.id}: ${suite.reason || 'нет причины'}`);
  }
  writeFileSync(file, `${lines.join('\n')}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    for (const [id, suite] of Object.entries(suitesById)) {
      process.stdout.write(`${suite.tier}  ${id.padEnd(24)} ${suite.title}\n`);
    }
    return;
  }

  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const runId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${Math.random().toString(16).slice(2, 6)}`;
  const runDir = path.join(artifactsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  pruneRuns();

  const changedInfo = opts.all ? { files: [], git: true } : changedFiles(opts.base, runDir);
  const changed = changedInfo.files;
  const selected = selectSuites(opts, changed);
  const unmatched = unmatchedPaths(changed);

  const human = line => (opts.json ? process.stderr : process.stdout).write(`${line}\n`);
  if (!changedInfo.git) human('git недоступен: T1 выбрать не из чего, остаётся T0');
  if (!opts.all && changedInfo.git && changed.length === 0) {
    human('изменений нет: выбран только T0, все проверки — с --all');
  }
  human(`Проверки ${runId}: ${opts.tier}${opts.all ? ', все' : ''}, изменено ${changed.length}, выбрано ${selected.length}`);

  if (opts.dryRun) {
    for (const [id, suite] of selected) human(`  ${suite.tier}  ${id}`);
    if (unmatched.length) human(`нет проверок для: ${unmatched.join(', ')}`);
    return;
  }

  const needed = new Set();
  for (const [, suite] of selected) {
    for (const name of [...(suite.needs || []), ...(suite.optionalNeeds || [])]) needed.add(name);
  }
  const python = findPython();
  const deps = { node: true, python: Boolean(python) };
  if (needed.has('playwright')) deps.playwright = Boolean(python) && importModule(python, 'playwright');
  if (needed.has('pillow')) deps.pillow = Boolean(python) && importModule(python, 'PIL');
  if (needed.has('websockets')) deps.websockets = Boolean(python) && importModule(python, 'websockets');
  if (needed.has('obs')) deps.obs = Boolean(process.env.OBS_EXE) && existsSync(process.env.OBS_EXE);
  if (needed.has('network')) deps.network = await hasNetwork();

  const plan = selected.map(([id, suite]) => {
    if (suite.skipUnlessEnv && !process.env[suite.skipUnlessEnv]) {
      return { id, suite, skip: `нет переменной ${suite.skipUnlessEnv}` };
    }
    const missingHard = (suite.needs || []).filter(name => !deps[name]);
    if (missingHard.length) return { id, suite, envError: `нет: ${missingHard.join(', ')}` };
    const missingSoft = (suite.optionalNeeds || []).filter(name => !deps[name]);
    if (missingSoft.length) return { id, suite, skip: `недоступно: ${missingSoft.join(', ')}` };
    return { id, suite };
  });

  const needsServer = plan.some(item => !item.skip && !item.envError && item.suite.kind === 'python-qa' && item.suite.server !== false);
  let server = null;
  let url = opts.url || '';
  let serverError = '';
  if (needsServer && !url) {
    try {
      const port = await freePort();
      const logPath = path.join(runDir, 'server.log');
      const fd = openSync(logPath, 'w');
      const child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', fd, fd],
        detached: process.platform !== 'win32'
      });
      closeSync(fd);
      server = { child, logPath };
      url = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (child.exitCode !== null) break;
        try {
          const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(1500) });
          if (response.ok) { ready = true; break; }
        } catch { /* сервер ещё поднимается */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!ready) {
        serverError = `сервер не поднялся: ${tail(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '', 8)}`;
        killTree(child);
        server = null;
        url = '';
      }
    } catch (error) {
      serverError = `сервер не поднялся: ${error.message}`;
    }
  }

  const stopServer = () => {
    if (server && !opts.keepServer) killTree(server.child);
    server = null;
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { stopServer(); process.exit(130); });
  }

  const startedAt = new Date();
  const suites = [];
  try {
    for (const item of plan) {
      const { id, suite } = item;
      const entry = {
        id,
        title: suite.title,
        tier: suite.tier,
        status: 'pass',
        durationMs: 0,
        scenarios: [],
        evidence: [],
        cmd: describe(suite)
      };
      if (item.skip) {
        entry.status = 'skip';
        entry.reason = item.skip;
        suites.push(entry);
        human(`skip  ${id.padEnd(24)} ${item.skip}`);
        continue;
      }
      if (item.envError) {
        entry.status = 'error';
        entry.errorClass = 'env';
        entry.reason = item.envError;
        suites.push(entry);
        human(`env   ${id.padEnd(24)} ${item.envError}`);
        continue;
      }
      if (serverError && suite.kind === 'python-qa' && suite.server !== false && !opts.url) {
        entry.status = 'error';
        entry.errorClass = 'env';
        entry.reason = serverError;
        suites.push(entry);
        human(`env   ${id.padEnd(24)} ${serverError}`);
        continue;
      }
      const dir = path.join(runDir, id);
      mkdirSync(dir, { recursive: true });
      const context = { python, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, dir, url };
      let result;
      if (suite.kind === 'node-test') result = await runNodeSuite(entry, suite, dir, context);
      else if (suite.kind === 'python-qa') result = await runPythonSuite(entry, suite, dir, context);
      else result = await runCommandSuite(entry, suite, dir, context);
      suites.push(result);
      const suffix = result.status === 'skip' || result.status === 'error' || result.status === 'fail'
        ? ` — ${result.reason || result.error?.split('\n').pop() || ''}` : '';
      human(`${result.status.padEnd(5)} ${id.padEnd(24)} ${(result.durationMs / 1000).toFixed(1)}s${suffix}`);
      if (opts.verbose && result.error) human(result.error);
    }
  } finally {
    stopServer();
  }

  const summary = { pass: 0, fail: 0, skip: 0, error: 0 };
  for (const suite of suites) summary[suite.status] = (summary[suite.status] || 0) + 1;
  const verdict = summary.fail ? 'fail' : summary.error ? 'env' : 'pass';

  const report = {
    version: 1,
    run: {
      id: runId,
      tier: opts.tier,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      command: process.argv.slice(2).join(' ')
    },
    env: {
      node: process.version,
      python: python || null,
      playwright: Boolean(deps.playwright),
      browser: deps.playwright ? 'chromium' : null,
      os: process.platform
    },
    selection: {
      all: opts.all,
      base: opts.base || null,
      changed,
      unmatched,
      selected: selected.map(([id]) => id)
    },
    suites,
    summary,
    verdict
  };

  const reportPath = path.join(runDir, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeIndex(report, path.join(runDir, 'index.md'));

  if (unmatched.length) human(`нет проверок для: ${unmatched.join(', ')} (запусти --all)`);
  human(`итог: ok ${summary.pass} · fail ${summary.fail} · skip ${summary.skip} · env ${summary.error}`);
  human(`отчёт: ${path.relative(root, reportPath).replaceAll('\\', '/')}`);
  if (opts.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  if (summary.fail) process.exitCode = 1;
  else if (summary.error) process.exitCode = 2;
}

function pruneRuns(keep = 12) {
  if (!existsSync(artifactsRoot)) return;
  const runs = readdirSync(artifactsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{8}-\d{6}-[0-9a-f]+$/.test(entry.name))
    .map(entry => entry.name)
    .sort();
  for (const name of runs.slice(0, Math.max(0, runs.length - keep))) {
    try { rmSync(path.join(artifactsRoot, name), { recursive: true, force: true }); } catch { /* не критично */ }
  }
}

main().catch(error => {
  process.stderr.write(`verify: ${error.stack || error.message}\n`);
  process.exit(2);
});
