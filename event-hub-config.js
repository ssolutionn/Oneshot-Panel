const SLUG = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const GAME = /^[a-z0-9][a-z0-9-]{1,20}[a-z0-9]$/;

export const GAMES = Object.freeze([
  { id: 'cs2', label: 'Counter-Strike 2', status: 'ready' },
  { id: 'dota2', label: 'Dota 2', status: 'setup' }
]);

export const HUB_EVENTS = Object.freeze([
  { slug: 'cyberclash', name: 'CyberClash', description: 'Турниры Counter-Strike 2', games: ['cs2'] },
  { slug: 'reu', name: 'REU', description: 'Университетские турниры', logo: '/assets/reu-mark.png', games: ['cs2', 'dota2'] }
]);

export function profileKey(event, game) {
  if (!SLUG.test(event || '') || !GAME.test(game || '')) throw new Error('Неверный профиль мероприятия.');
  return `${event}:${game}`;
}

export function eventUrl(event, game = '') {
  if (!SLUG.test(event || '') || (game && !GAME.test(game))) throw new Error('Неверный адрес мероприятия.');
  const query = new URLSearchParams({ event, ...(game ? { game } : {}) });
  return `/?${query}`;
}

export function selectHubRoute(search, events = HUB_EVENTS) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const eventId = params.get('event') || '';
  const event = events.find(item => item.slug === eventId) || null;
  if (!event) return { view: 'events', event: null, game: null };
  const gameId = params.get('game') || '';
  const game = event.games.includes(gameId) ? GAMES.find(item => item.id === gameId) || { id: gameId, label: gameId, status: 'setup' } : null;
  if (!game) return { view: 'games', event, game: null };
  return { view: game.status === 'ready' ? 'panel' : 'setup', event, game };
}
