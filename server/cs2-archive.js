import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export function safeName(value, fallback = 'unknown') {
  const text = String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return (text || fallback).slice(0, 40);
}
const stamp = at => {
  const date = new Date(at);
  const part = (n, width = 2) => String(n).padStart(width, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
};
export function fileName({ map = '', at = Date.now(), seq = 0 } = {}) {
  const base = `${stamp(at)}_${safeName(map)}`;
  return seq > 0 ? `${base}-${seq}.jsonl` : `${base}.jsonl`;
}

export const DEFAULT_LIMIT = 400;
export const DEFAULT_BYTES = 2 * 1024 * 1024 * 1024;

export class Archive {
  constructor({ dir, limit = DEFAULT_LIMIT, maxBytes = DEFAULT_BYTES } = {}) {
    Object.assign(this, { dir: dir || '', limit, maxBytes, file: '', game: -1, bytes: 0, openedAt: 0 });
  }
  get enabled() { return Boolean(this.dir); }

  open(game, map = '') {
    if (!this.enabled || game === this.game) return this.file;
    try {
      this.close();
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const at = Date.now();
      let name = fileName({ map, at, seq: 0 });
      let full = path.join(this.dir, name);
      let seq = 0;
      while (true) {
        try {
          statSync(full);
          seq++;
          name = fileName({ map, at, seq });
          full = path.join(this.dir, name);
        } catch { break; }
      }
      this.file = full;
      this.game = game; this.bytes = 0; this.openedAt = at;
      this.head({ type: 'archive', version: 1, game, map, at });
      this.prune();
      return this.file;
    } catch { this.close(); return ''; }
  }
  head(value) { return this.write({ ...value, seq: 0 }); }
  write(value) {
    if (!this.file) return false;
    try {
      const line = JSON.stringify(value) + '\n';
      this.bytes += Buffer.byteLength(line);
      appendFileSync(this.file, line, { mode: 0o600 });
      return true;
    } catch { return false; }
  }
  keepRaw(game, map, text) {
    if (!this.enabled) return 0;
    this.open(game, map);
    let kept = 0;
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      if (this.write({ type: 'raw', game, line })) kept++;
    }
    return kept;
  }
  close() {
    this.file = '';
    this.game = -1;
  }
  list() {
    if (!this.enabled) return [];
    try {
      return readdirSync(this.dir)
        .filter(name => name.endsWith('.jsonl'))
        .map(name => {
          const full = path.join(this.dir, name);
          const stats = statSync(full);
          const map = name.replace(/\.jsonl$/, '').split('_').slice(1).join('_');
          return { name, map, bytes: stats.size, mtime: stats.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { return []; }
  }
  read(name) {
    if (!this.enabled || !/^[\w.-]{1,80}\.jsonl$/.test(name) || name.includes('..')) return null;
    const full = path.join(this.dir, name);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) return null;
    let text;
    try { text = readFileSync(full, 'utf8'); } catch { return null; }
    const raw = [], events = [];
    let head = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value.type === 'archive') head = value;
      else if (value.type === 'raw') raw.push(value.line);
      else if (value.type === 'event') events.push(value);
    }
    return { head, raw, events, bytes: text.length };
  }
  remove(name) {
    if (!this.enabled || !/^[\w.-]{1,80}\.jsonl$/.test(name) || name.includes('..')) return false;
    const full = path.join(this.dir, name);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) return false;
    try { unlinkSync(full); return true; } catch { return false; }
  }
  prune() {
    if (!this.enabled) return 0;
    const files = this.list();
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    let dropped = 0;
    const current = this.file ? path.basename(this.file) : '';
    for (const file of files.slice(this.limit)) {
      if (file.name === current) continue;
      if (this.remove(file.name)) { total -= file.bytes; dropped++; }
    }
    for (const file of files.reverse()) {
      if (total <= this.maxBytes || file.name === current) break;
      if (this.remove(file.name)) { total -= file.bytes; dropped++; }
    }
    return dropped;
  }
  status() {
    if (!this.enabled) return { enabled: false };
    const files = this.list();
    return { enabled: true, dir: path.basename(this.dir), files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      current: this.file ? path.basename(this.file) : '' };
  }
}
