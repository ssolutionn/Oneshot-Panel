// Глобы реестра проверок: `*` — внутри одного сегмента пути, `**` — через
// сегменты, `?` — один символ. Фигурных скобок и extglob нет: шаблоны наши,
// лишний синтаксис только спрячет опечатку.
export function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

const cache = new Map();

export function globToRegExp(pattern) {
  const key = normalizePath(pattern);
  const cached = cache.get(key);
  if (cached) return cached;
  let source = '';
  for (let i = 0; i < key.length; i += 1) {
    const char = key[i];
    if (char === '*') {
      if (key[i + 1] === '*') {
        i += 1;
        if (key[i + 1] === '/') {
          i += 1;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const regexp = new RegExp(`^${source}$`);
  cache.set(key, regexp);
  return regexp;
}

export function matchesGlob(pattern, file) {
  return globToRegExp(pattern).test(normalizePath(file));
}

export function matchesAny(patterns, file) {
  const path = normalizePath(file);
  return patterns.some(pattern => globToRegExp(pattern).test(path));
}
