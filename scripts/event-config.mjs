// node scripts/event-config.mjs [slug] > public/event.js
// The event of the address being built (events/event-script.js): the slug given,
// EVENT, or the Cloudflare Pages branch when events/<branch>/ exists; else CyberClash.
import fs from 'node:fs';
import { eventScript, eventSlug } from '../events/event-script.js';

const file = slug => new URL(`../events/${slug}/event.json`, import.meta.url);
const slug = eventSlug({
  slug: process.argv[2] || process.env.EVENT || '',
  branch: process.env.CF_PAGES_BRANCH || process.env.BRANCH || '',
  exists: name => fs.existsSync(file(name))
});
process.stdout.write(eventScript(JSON.parse(fs.readFileSync(file(slug), 'utf8'))));
process.stderr.write(`event.js: ${slug}\n`);
