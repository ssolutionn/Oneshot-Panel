// `npm run check`: node --check on every .js/.mjs file of the project, so a new
// file can't be forgotten in a hand-kept list. Skips generated and vendored dirs.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set(['node_modules', '.git', 'artifacts', 'public', 'dist-veto', '.wrangler', '.veto-relay-data']);
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:m?js)$/.test(entry.name)) files.push(full);
  }
})(root);

let failed = 0;
for (const file of files.sort()) {
  // stdio: inherit, без pipe: в песочнице Windows именованные каналы запрещены,
  // и захват stderr превращал бы каждую проверку в ложное «✗ undefined».
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) { failed++; console.error(`✗ ${path.relative(root, file)}`); }
}
console.log(`${files.length - failed}/${files.length} files pass node --check`);
process.exit(failed ? 1 : 0);
