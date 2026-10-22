const query = new URLSearchParams(location.search);
const event = query.get('event') || '';
const game = query.get('game') || '';
const active = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(event) &&
  /^[a-z0-9][a-z0-9-]{1,20}[a-z0-9]$/.test(game);

if (active) {
  const prefix = `oneshot-profile:${event}:${game}:`;
  const shared = new Set(['oneshot-theme']);
  const originalGet = Storage.prototype.getItem;
  const originalSet = Storage.prototype.setItem;
  const scoped = key => {
    const value = String(key);
    return value.startsWith('oneshot-') && !shared.has(value) || value === 'webcam-desk-source' ? prefix + value : value;
  };
  Storage.prototype.getItem = function(key) { return originalGet.call(this, scoped(key)); };
  Storage.prototype.setItem = function(key, value) { return originalSet.call(this, scoped(key), value); };
  try { localStorage.setItem('oneshot-active-profile', `${event}:${game}`); } catch { /* storage is optional */ }
}
