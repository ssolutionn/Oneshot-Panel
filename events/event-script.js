// The event of an address, for the page: event.js sets window.oneshotEvent and
// data-kind/data-event on <html> before the first paint, so an event's address
// never shows another event's tabs (CSS and the panel read them). The manifest
// holds no secrets; the page gets only what it shows.
import { MODULES, loadEvent } from './schema.js';

const SLUG = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const DEFAULT_EVENT = 'cyberclash';

// Which event an address is: the slug asked for, else a folder named like the
// branch being built (Cloudflare Pages: branch reu → events/reu), else CyberClash.
export function eventSlug({ slug = '', branch = '', exists = () => false } = {}) {
  if (slug) {
    if (!SLUG.test(slug) || !exists(slug)) throw new Error(`Нет события ${slug}: нужна папка events/${slug}/ с event.json`);
    return slug;
  }
  return SLUG.test(branch) && exists(branch) ? branch : DEFAULT_EVENT;
}

export function eventScript(manifest) {
  const event = loadEvent(manifest);
  const page = {
    slug: event.slug, name: event.name, short: event.short, kind: event.kind,
    modules: Object.fromEntries(MODULES.map(m => [m.id, event.modules[m.id]])),
    colors: event.brand.colors, veto: event.veto, cameras: event.cameras
  };
  const root = 'document.documentElement.dataset';
  return `window.oneshotEvent=Object.freeze(${JSON.stringify(page)});` +
    `${root}.event=${JSON.stringify(event.slug)};${root}.kind=${JSON.stringify(event.kind)};\n`;
}
