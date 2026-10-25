// node scripts/event-config.mjs [slug] > public/event.js
// The events of the site and the event this address is (events/event-script.js):
// the slug given, EVENT, or the Cloudflare Pages branch when events/<branch>/
// exists; else CyberClash. The page picks one by ?event= and the chooser's
// cookie, so one static site can open any event and the address stays.
//
// node scripts/event-config.mjs --file event.js — the same file for the folder
// itself (`npm run event`): a plain static server over the repository then opens
// the panel with its chooser too. That copy is always the default event.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EVENT, eventsScript, eventSlug } from '../events/event-script.js';
import { readManifests } from '../events/manifests.js';

const flags = process.argv.slice(2);
const at = flags.indexOf('--file');
const target = at === -1 ? '' : flags[at + 1] || '';
if (at !== -1 && !target) {
  process.stderr.write('--file: нужен путь к файлу\n');
  process.exit(1);
}
const exists = name => fs.existsSync(new URL(`../events/${name}/event.json`, import.meta.url));
const slug = target ? DEFAULT_EVENT : eventSlug({
  slug: flags.find(flag => !flag.startsWith('--')) || process.env.EVENT || '',
  branch: process.env.CF_PAGES_BRANCH || process.env.BRANCH || '',
  exists
});
const code = eventsScript(readManifests(fileURLToPath(new URL('../events/', import.meta.url))), { defaultSlug: slug });
if (target) fs.writeFileSync(target, code);
else process.stdout.write(code);
process.stderr.write(`event.js: ${slug}${target ? ' → ' + target : ''}\n`);
