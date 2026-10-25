// The event of an address, for the page: event.js sets window.oneshotEvent and
// data-kind/data-event on <html> before the first paint, so an event's address
// never shows another event's tabs (CSS and the panel read them). The manifest
// holds no secrets; the page gets only what it shows.
//
// The page carries every event of the panel and picks one at the first paint:
// ?event=<slug>, then the chooser's cookie, then the event this address is
// (EVENT, the Pages branch, else CyberClash). So the chooser in the header
// works on a static host as well as on the local server, and the address stays.
import { MODULES, loadEvent } from './schema.js';

const SLUG = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const DEFAULT_EVENT = 'cyberclash';
// The chooser's choice, read here and set by event-chooser.js.
export const CHOICE_COOKIE = 'oneshot-event';

// Which event an address is: the slug asked for, else a folder named like the
// branch being built (Cloudflare Pages: branch reu → events/reu), else CyberClash.
export function eventSlug({ slug = '', branch = '', exists = () => false } = {}) {
  if (slug) {
    if (!SLUG.test(slug) || !exists(slug)) throw new Error(`Нет события ${slug}: нужна папка events/${slug}/ с event.json`);
    return slug;
  }
  return SLUG.test(branch) && exists(branch) ? branch : DEFAULT_EVENT;
}

// What the page gets of an event: the title, the tabs, the look, the veto and
// the cameras — no sheets, no e-mail.
const pageOf = event => ({
  slug: event.slug, name: event.name, short: event.short, kind: event.kind,
  modules: Object.fromEntries(MODULES.map(m => [m.id, event.modules[m.id]])),
  colors: event.brand.colors, veto: event.veto, cameras: event.cameras
});

// event.js: the chooser's list, every event's page, and the few lines that pick
// one. defaultSlug is the event of this address, used until a choice is made.
export function eventsScript(manifests, { defaultSlug = DEFAULT_EVENT } = {}) {
  const pages = manifests.map(manifest => pageOf(loadEvent(manifest)));
  const choices = pages.map(({ slug, name, short }) => ({ slug, name, short }));
  const bySlug = Object.fromEntries(pages.map(page => [page.slug, page]));
  const fallback = bySlug[defaultSlug] ? defaultSlug : pages[0]?.slug || '';
  return `window.oneshotEventChoices=Object.freeze(${JSON.stringify(choices)});` +
    `window.oneshotEvents=Object.freeze(${JSON.stringify(bySlug)});` +
    picker(fallback) + '\n';
}

// Plain script, no eval (the CSP allows no inline and no eval): the address
// picks the event and <html> says which one before the first paint. Only the
// events in the list count, so a stray ?event=constructor is not an event.
function picker(fallback) {
  return '(function(){' +
    'var all=window.oneshotEvents||{};' +
    'var known=function(name){return name&&Object.hasOwn(all,name)?all[name]:null;};' +
    'var page=null;' +
    // ?event= is an explicit link: it wins over the cookie the chooser sets.
    'try{page=known(new URLSearchParams(location.search).get("event")||"");}catch(error){}' +
    `if(!page){try{var found=document.cookie.match(/(?:^|;\\s*)${CHOICE_COOKIE}=([^;]+)/);` +
    'page=found?known(decodeURIComponent(found[1])):null;}catch(error){}}' +
    `page=page||known(${JSON.stringify(fallback)});` +
    'if(!page)return;' +
    'window.oneshotEvent=Object.freeze(page);' +
    'var dataset=document.documentElement.dataset;' +
    'dataset.event=page.slug;dataset.kind=page.kind;' +
    '})();';
}
