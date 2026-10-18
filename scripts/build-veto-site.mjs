// The captains' veto as a site of its own (published from the oneshot-veto
// repo): only the veto pages and the assets they use — no panel files, no
// roster sheet, no panel address, so players never learn where the panel is.
//   node scripts/build-veto-site.mjs [out]   (default: dist-veto)
// The copy is generated: change the veto here, rebuild, push the result.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(root, process.argv[2] || 'dist-veto');
const from = file => path.join(root, file);
const to = file => path.join(out, file);

function replaceOnce(text, find, replace, file) {
  if (text.split(find).length !== 2) throw new Error(`${file}: expected exactly one «${find.slice(0, 60)}»`);
  return text.replace(find, () => replace);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// Pages: the veto at the site's root, and /veto.html for links made before.
const page = await readFile(from('veto.html'), 'utf8');
await writeFile(to('index.html'), page);
await writeFile(to('veto.html'), page);
for (const file of ['veto.js', 'veto.css', 'veto-room.js', 'vdo.js']) await cp(from(file), to(file));

// core.js without the roster sheet (stream IDs, room passwords) and without
// the panel's address. The organizer's schedule (public) stays for the form.
let core = await readFile(from('core.js'), 'utf8');
core = core.replace(/^ {2}id: '[^']*',\n {2}gid: '[^']*',\n/m, match => {
  if (!match) throw new Error('core.js: roster source not found');
  return "  id: '',\n  gid: '',\n";
});
if (/^ {2}id: '[^']+'/m.test(core)) throw new Error('core.js: roster sheet id is still there');
core = replaceOnce(core, "export const DEFAULT_CARD_BASE = 'https://oneshot-panel.pages.dev';",
  "export const DEFAULT_CARD_BASE = '';", 'core.js');
await writeFile(to('core.js'), core);

// Only the assets the veto page loads.
const assets = [
  'assets/favicon-night.png', 'assets/card/cyberclash-logo.png',
  'assets/veto-backdrop.jpg', 'assets/veto-appearance.js',
  'assets/veto-relay-protocol.js', 'assets/veto-relay-client.js', 'assets/veto-relay-links.js',
  'assets/fonts/Oswald-Variable.ttf', 'assets/fonts/OFL-Oswald.txt',
  'assets/maps/LICENSE.txt', 'assets/maps/README.md', 'assets/flags', 'assets/teams'
];
for (const map of await readdir(from('assets/maps'))) if (map.endsWith('.jpg')) assets.push(`assets/maps/${map}`);
for (const asset of assets) {
  await mkdir(path.dirname(to(asset)), { recursive: true });
  await cp(from(asset), to(asset), { recursive: true });
}

// The same protocol on Workers (Durable Objects) and an optional Node host.
for (const file of ['server/veto-relay-api.js', 'server/veto-relay-cloudflare.js',
  'server/veto-relay-file.js', 'server/veto-relay-node.mjs', 'functions/api/veto-relay.js']) {
  await mkdir(path.dirname(to(file)), {recursive:true});
  await cp(from(file), to(file));
}
await cp(from('server/veto-relay-worker-entry.js'), to('worker.js'));
await mkdir(to('.github/workflows'), {recursive:true});
await cp(from('server/veto-deploy-cloudflare.yml'), to('.github/workflows/deploy-cloudflare.yml'));
await mkdir(to('scripts'), {recursive:true});
await cp(from('scripts/verify_veto_deployment.py'), to('scripts/verify_deployment.py'));

// Cloudflare Pages headers: the veto needs Google Sheets (the schedule) and
// VDO.Ninja frames only.
await writeFile(to('_headers'), `/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://docs.google.com https://oneshot-veto.cyberclash.workers.dev; frame-src https://vdo.ninja https://cdn-backup.vdo.ninja; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
`);

// Cloudflare Workers (static assets, the dashboard's default for a Git
// repository): the files at the root are the site; .assetsignore keeps the
// config and the README out of it. Pages works too (output directory /).
await cp(from('server/veto-relay-wrangler.jsonc'), to('wrangler.jsonc'));
await writeFile(to('.assetsignore'), '.git\n.github/\nscripts/\n.assetsignore\nwrangler.jsonc\nREADME.md\nworker.js\nserver/\nfunctions/\npackage.json\nRELAY.md\n');
await cp(from('server/RELAY.md'), to('RELAY.md'));
await writeFile(to('package.json'), JSON.stringify({private:true,type:'module',engines:{node:'>=22'},scripts:{relay:'node server/veto-relay-node.mjs'}},null,2)+'\n');

await writeFile(to('README.md'), `# Oneshot · captains' veto

The CyberClash captains' map veto as a site of its own: personal signed links
for both captains, a coin tossed in the room, spectators and an admin view with
the HLTV text. English by default, Russian with the flag.

**Generated — do not edit here.** The source lives in the panel repository
(\`veto.html\`, \`veto.js\`, \`veto-room.js\`, …); \`node scripts/build-veto-site.mjs\`
there rebuilds this copy without any panel files or roster data.

## Publish (Cloudflare)

The included **Deploy veto to Cloudflare** GitHub Actions workflow publishes
both the Worker relay and Pages on a push to \`main\`. Configure the two
repository credentials described in \`RELAY.md\`; no credentials belong in
the site files. The workflow verifies public assets and relay health after
deployment. A missing credential is an explicit failed check.

Alternatively, using the Cloudflare Git integration:

Workers & Pages → Create → Import a repository → this one. \`wrangler.jsonc\`
serves the files as static assets (\`.assetsignore\` leaves the config out);
turn the \`workers.dev\` address on in Settings → Domains & Routes. As Pages:
no build command, output directory \`/\`. \`_headers\` sets the security headers.

Every push to \`main\` should go live by itself. Settings → Builds: production
branch \`main\`, no build command, deploy command \`npx wrangler deploy\`
(\`wrangler versions upload\` would only upload a version with 0 % traffic).
A push that shows no new row in Deployments means the Cloudflare GitHub app
does not see this repository: Settings → Builds → Git repository → Manage.

VDO rooms work on any static host. Server rooms need the relay described in
\`RELAY.md\`: deploy this Worker's Durable Objects first; Pages forwards only
\`/api/veto-relay\` to that Worker. For a future server use Node >=22 and the
same HTTP protocol. A static file server alone cannot synchronize clients.
`);

// Nothing of the panel may leak into the copy.
async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else yield full;
  }
}
for await (const file of files(out)) {
  if (!/\.(html|js|css|json|md|txt)$|_headers$/.test(file)) continue;
  const text = await readFile(file, 'utf8');
  for (const secret of ['1e__ijBjufD19SWBkSJL177vmmfMh2tdykYQHAS06S8I', 'oneshot-panel.pages.dev', '1315978454']) {
    if (text.includes(secret)) throw new Error(`${path.relative(out, file)} still contains ${secret}`);
  }
}
console.log(`veto site written to ${path.relative(root, out) || out}`);
