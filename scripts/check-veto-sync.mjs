// The oneshot-veto repo is generated from this one (scripts/build-veto-site.mjs).
//   node scripts/check-veto-sync.mjs <path to a oneshot-veto checkout>
// Fails when the checkout differs from what this commit would publish, so a
// hand edit there, or a forgotten rebuild here, is caught before it ships.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (!target) { console.error('usage: check-veto-sync.mjs <oneshot-veto checkout>'); process.exit(2); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(path.join(tmpdir(), 'dist-veto-'));
try {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-veto-site.mjs'), out], { stdio: 'ignore' });
  const diff = spawnDiff(out, path.resolve(target));
  if (diff) { console.error(diff); process.exit(1); }
  console.log('oneshot-veto matches the build of this commit');
} finally { rmSync(out, { recursive: true, force: true }); }

function spawnDiff(a, b) {
  try { execFileSync('diff', ['-rq', '-x', '.git', a, b], { encoding: 'utf8' }); return ''; }
  catch (error) { return String(error.stdout || error.message); }
}
