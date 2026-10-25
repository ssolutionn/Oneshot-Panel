// The events on disk: every events/<slug>/event.json, templates aside. One place
// reads that folder, so the local server and the site build list the same events
// — the chooser in the header shows exactly what can be opened (event.js).
import fs from 'node:fs';
import path from 'node:path';

export function readManifest(dir, slug) {
  return JSON.parse(fs.readFileSync(path.join(dir, slug, 'event.json'), 'utf8'));
}

// Sorted by folder, so the chooser's order does not depend on the file system.
export function readManifests(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'event.json')))
    .map(entry => entry.name)
    .sort()
    .map(name => readManifest(dir, name));
}

export const eventFolderExists = (dir, slug) => fs.existsSync(path.join(dir, slug, 'event.json'));
