// ==UserScript==
// @name         Oneshot Panel — FACEIT Issue Alerts
// @namespace    https://oneshot.gg
// @version      1.0
// @description  При появлении новой жалобы в админке FACEIT (Live Issues) шлёт уведомление в панель Oneshot. Ставится в Tampermonkey, запускается на странице админки турнира.
// @match        https://www.faceit.com/*
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const DEBOUNCE_MS = 30000;
  const seen = new Map();

  function isNew(key) {
    const last = seen.get(key);
    if (last && Date.now() - last < DEBOUNCE_MS) return false;
    seen.set(key, Date.now());
    return true;
  }

  function log(msg) { console.debug('[Oneshot-Issues]', msg); }

  // Отправка в панель через POST на сохранённый endpoint
  let endpoint = localStorage.getItem('oneshot-issue-endpoint') || '';
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Указать адрес панели Oneshot', () => {
      const value = prompt('Адрес панели (например https://oneshot.gg или http://localhost:3000)', endpoint || 'https://oneshot.gg');
      if (value) { endpoint = value.replace(/\/$/, ''); localStorage.setItem('oneshot-issue-endpoint', endpoint); }
    });
  }

  function sendToPanel(text) {
    log('Отправляю в панель: ' + text);
    if (endpoint) {
      fetch(endpoint + '/api/lobby-note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, at: Date.now(), source: 'faceit-issues' })
      }).catch(() => log('POST не прошёл'));
    }
    try {
      unsafeWindow.dispatchEvent(new CustomEvent('oneshot:lobby-note', { detail: text }));
      unsafeWindow.dispatchEvent(new CustomEvent('oneshot:open-lobby'));
    } catch {}
  }

  function parseIssue(el) {
    const text = (el.querySelector('[class*="description"]') || el.querySelector('[class*="reason"]') || el).textContent.trim();
    const team = el.querySelector('[class*="team"], [class*="faction"]')?.textContent.trim();
    const player = el.querySelector('[class*="player"], [class*="nickname"]')?.textContent.trim();
    const type = el.querySelector('[class*="type"], [class*="category"]')?.textContent.trim();
    return { text, team, player, type };
  }

  function setupObserver() {
    const selectors = [
      '#live-issues-list', '#issues-list', '[class*="live-issues"]',
      '[class*="issue-list"]', '[class*="protest"]', 'ul[class*="issue"]',
    ];
    let container = selectors.map(s => document.querySelector(s)).find(Boolean) || document.body;
    log('Наблюдаю за: ' + (container.id || container.className));

    const observer = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const items = node.matches?.('[class*="issue"]') ? [node]
            : [...(node.querySelectorAll?.('[class*="issue-item"], [class*="issue-row"]') || [])];
          for (const issueEl of items) {
            const p = parseIssue(issueEl);
            if (!p || !p.text || p.text.length < 4) continue;
            const key = `${p.team || ''}|${p.text}`.toLowerCase();
            if (!isNew(key)) continue;
            const msg = [p.type, p.team, p.player, p.text].filter(Boolean).join(' · ');
            sendToPanel(`⚠ Жалоба: ${msg}`);
          }
        }
      }
    });
    observer.observe(container, { childList: true, subtree: true });
  }

  const origFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = async function (...args) {
    const response = await origFetch.apply(this, args);
    const url = args[0]?.url || args[0] || '';
    if (typeof url === 'string' && /issue|protest|ticket|complaint/i.test(url)) {
      try {
        const json = await response.clone().json();
        const items = json?.items || json?.data || [];
        if (Array.isArray(items)) for (const item of items) {
          const reason = item.reason || item.description || item.message || '';
          if (!reason) continue;
          const key = `${item.team || item.faction || ''}|${reason}`.toLowerCase();
          if (!isNew(key)) continue;
          sendToPanel(`⚠ Жалоба: [${item.category || 'жалоба'}] ${item.team || item.faction || ''} — ${reason}`);
        }
        log('Жалобы из API:', url);
      } catch {}
    }
    return response;
  };

  if (document.readyState === 'complete') setupObserver();
  else window.addEventListener('load', setupObserver);
})();