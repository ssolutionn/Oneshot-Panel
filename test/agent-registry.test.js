// Реестр проверок — единственный список того, что вообще проверяется.
// Тест держит его в согласии с файлами: новый test/*.test.js или qa_*.py,
// забытый в реестре, роняет `npm test`, а не проходит молча.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesAny, matchesGlob } from '../scripts/agent/globs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(path.join(root, 'scripts', 'agent', 'suites.json'), 'utf8'));
const suites = registry.suites;
const entries = Object.entries(suites);

const TIERS = new Set(['T0', 'T1', 'T2']);
const KINDS = new Set(['command', 'node-test', 'python-qa']);
const NEEDS = new Set(['node', 'python', 'playwright', 'pillow', 'websockets', 'obs', 'network']);
const SOFT_ONLY = new Set(['obs', 'network']);
const KEYS = new Set([
  'title', 'tier', 'kind', 'cmd', 'files', 'script', 'args', 'needs', 'optionalNeeds',
  'timeoutMs', 'server', 'select', 'skipUnlessEnv'
]);

test('реестр: схема, ключи и ссылки на файлы', () => {
  assert.equal(registry.version, 1, 'версия реестра — 1');
  assert.equal(typeof registry.meta?.test, 'string');
  assert.ok(existsSync(path.join(root, registry.meta.test)), 'файл теста реестра существует');
  assert.ok(existsSync(path.join(root, registry.meta.runner)), 'пульт существует');
  assert.ok(entries.length >= 10, 'в реестре есть проверки');

  for (const [id, suite] of entries) {
    assert.match(id, /^[a-z0-9-]+$/, `id ${id}`);
    assert.ok(suite.title && typeof suite.title === 'string', `${id}: title`);
    assert.ok(TIERS.has(suite.tier), `${id}: tier`);
    assert.ok(KINDS.has(suite.kind), `${id}: kind`);
    assert.ok(Number.isInteger(suite.timeoutMs) && suite.timeoutMs > 0, `${id}: timeoutMs`);
    assert.ok(Array.isArray(suite.select), `${id}: select — массив`);
    for (const key of Object.keys(suite)) assert.ok(KEYS.has(key), `${id}: неизвестный ключ ${key}`);
    for (const name of suite.needs || []) {
      assert.ok(NEEDS.has(name), `${id}: неизвестная потребность ${name}`);
      assert.ok(!SOFT_ONLY.has(name), `${id}: ${name} — только в optionalNeeds`);
    }
    for (const name of suite.optionalNeeds || []) {
      assert.ok(NEEDS.has(name), `${id}: неизвестная необязательная потребность ${name}`);
    }
    if (suite.tier !== 'T0') assert.ok(suite.select.length > 0, `${id}: T1/T2 без select не выберется по диффу`);
    for (const pattern of suite.select) assert.doesNotThrow(() => matchesGlob(pattern, ''), `${id}: глоб ${pattern}`);

    if (suite.kind === 'node-test') {
      assert.ok(Array.isArray(suite.files) && suite.files.length > 0, `${id}: files`);
      for (const file of suite.files) {
        assert.ok(file.endsWith('.test.js'), `${id}: ${file} — не test-файл`);
        assert.ok(existsSync(path.join(root, file)), `${id}: нет файла ${file}`);
      }
      assert.equal(suite.cmd, undefined, `${id}: node-test собирает команду сам`);
    }
    if (suite.kind === 'python-qa') {
      assert.ok(suite.script?.endsWith('.py'), `${id}: script`);
      assert.ok(existsSync(path.join(root, suite.script)), `${id}: нет сценария ${suite.script}`);
      assert.ok(Array.isArray(suite.args), `${id}: args`);
      assert.equal(typeof suite.server, 'boolean', `${id}: server — true/false`);
    }
    if (suite.kind === 'command') {
      assert.ok(Array.isArray(suite.cmd) && suite.cmd.length > 0, `${id}: cmd`);
      assert.ok(suite.cmd.every(part => typeof part === 'string' && part.length > 0), `${id}: cmd — строки`);
    }
    const placeholders = [
      ...(suite.cmd || []), ...(suite.args || []), suite.script || ''
    ].join(' ').match(/\{[^}]+\}/g) || [];
    for (const placeholder of placeholders) {
      assert.ok(
        ['{python}', '{url}', '{artifacts}'].includes(placeholder) || /^\{env:[A-Z0-9_]+\}$/.test(placeholder),
        `${id}: неизвестная подстановка ${placeholder}`
      );
    }
  }

  const ranks = entries.map(([, suite]) => ['T0', 'T1', 'T2'].indexOf(suite.tier));
  for (let i = 1; i < ranks.length; i += 1) {
    assert.ok(ranks[i] >= ranks[i - 1], 'порядок реестра: сначала T0, потом T1, потом T2');
  }
});

test('реестр: node-тесты и qa-сценарии учтены ровно один раз', () => {
  const testDir = path.join(root, 'test');
  const nodeTests = readdirSync(testDir).filter(name => name.endsWith('.test.js'));
  const nodeCovered = new Map();
  for (const [id, suite] of entries) {
    for (const file of suite.files || []) {
      const name = path.basename(file);
      nodeCovered.set(name, [...(nodeCovered.get(name) || []), id]);
    }
  }
  for (const name of nodeTests) {
    if (name === path.basename(registry.meta.test)) continue;
    assert.equal(nodeCovered.get(name)?.length, 1, `${name}: ровно в одной проверке, сейчас ${JSON.stringify(nodeCovered.get(name) || [])}`);
  }
  assert.ok(existsSync(path.join(root, registry.meta.test)), 'тест реестра в meta');

  const scriptsDir = path.join(root, 'scripts');
  const qaScripts = readdirSync(scriptsDir).filter(name => /^qa_.*\.py$/.test(name));
  const qaCovered = new Map();
  for (const [id, suite] of entries) {
    const found = new Set();
    if (suite.script) found.add(path.basename(suite.script));
    for (const part of suite.cmd || []) {
      const match = String(part).match(/scripts\/(qa_[^/]+\.py)$/);
      if (match) found.add(match[1]);
    }
    for (const name of found) qaCovered.set(name, [...(qaCovered.get(name) || []), id]);
  }
  for (const name of qaScripts) {
    assert.equal(qaCovered.get(name)?.length, 1, `${name}: ровно в одной проверке, сейчас ${JSON.stringify(qaCovered.get(name) || [])}`);
  }

  const pythonTests = readdirSync(testDir).filter(name => name.endsWith('_test.py'));
  const commands = entries.map(([, suite]) => [...(suite.cmd || []), ...(suite.args || [])].join(' ')).join(' ');
  for (const name of pythonTests) {
    assert.ok(commands.includes(name), `${name}: нет проверки с этим unittest`);
  }
});

test('реестр: каждый файл сайта покрыт хотя бы одной проверкой', () => {
  const source = readFileSync(path.join(root, 'server.js'), 'utf8');
  const block = source.match(/const publicFiles = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, 'в server.js не найден publicFiles');
  const files = [...block[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(files.length >= 20, `файлов сайта: ${files.length}`);
  const selects = entries.flatMap(([, suite]) => suite.select || []);
  const missed = files.filter(file => !matchesAny(selects, file));
  assert.deepEqual(missed, [], 'новый файл сайта надо добавить в select какой-нибудь проверки');
});

test('реестр: `npm run verify` ведёт в пульт', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.verify, 'node scripts/agent-test.mjs');
});

test('глобы: `*` не переходит через сегмент, `**` переходит', () => {
  assert.equal(matchesGlob('veto*.js', 'veto-room.js'), true);
  assert.equal(matchesGlob('veto*.js', 'assets/veto-room.js'), false);
  assert.equal(matchesGlob('assets/veto-*', 'assets/veto-short-links.js'), true);
  assert.equal(matchesGlob('assets/**', 'assets/veto-overlay/overlay.html'), true);
  assert.equal(matchesGlob('**/*.test.js', 'test/core.test.js'), true);
  assert.equal(matchesGlob('test/*.test.js', 'test/fixtures/core.test.js'), false);
  assert.equal(matchesAny(['core.js', 'veto*.js'], 'veto-room.js'), true);
});
