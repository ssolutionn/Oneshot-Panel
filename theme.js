// Day/night mode. A classic script in <head>, so a saved choice is applied
// before the first paint. Without a choice the page follows the system
// (or the host page's data-theme); the toggle sets data-mode, which wins.
(() => {
  const KEY = 'oneshot-theme';
  const root = document.documentElement;
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  const valid = mode => mode === 'light' || mode === 'dark';
  const apply = mode => {
    if (valid(mode)) root.dataset.mode = mode;
    else delete root.dataset.mode;
  };
  try { apply(localStorage.getItem(KEY)); } catch { /* storage blocked */ }

  const current = () => root.dataset.mode ||
    (valid(root.dataset.theme) ? root.dataset.theme
      : systemDark.matches ? 'dark' : 'light');

  const label = () => {
    const night = current() === 'dark';
    // Browser top bar matches the header (white by day, black at night).
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', night ? '#0a0a0b' : '#ffffff');
    const button = document.getElementById('themeToggle');
    if (!button) return;
    button.textContent = night ? '☀ День' : '☾ Ночь';
    button.title = night ? 'Включить дневной режим' : 'Включить ночной режим';
  };

  const toggle = () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem(KEY, next); } catch { /* storage blocked */ }
    label();
  };

  systemDark.addEventListener('change', label);
  new MutationObserver(label)
    .observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  // Another tab of the panel switched the mode.
  addEventListener('storage', event => {
    if (event.key !== KEY) return;
    apply(event.newValue);
    label();
  });

  const wire = () => {
    document.getElementById('themeToggle')?.addEventListener('click', toggle);
    label();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
