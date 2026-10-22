import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES, HUB_EVENTS, eventUrl, profileKey, selectHubRoute } from '../event-hub-config.js';

test('hub presents separate events and REU offers both esports disciplines', () => {
  assert.deepEqual(HUB_EVENTS.map(event => event.slug), ['cyberclash', 'reu']);
  assert.deepEqual(HUB_EVENTS.find(event => event.slug === 'reu').games, ['cs2', 'dota2']);
  assert.deepEqual(GAMES.map(game => [game.id, game.status]), [['cs2', 'ready'], ['dota2', 'setup']]);
});

test('hub routes from event picker to discipline picker and opens only a supported ready profile', () => {
  assert.equal(selectHubRoute('').view, 'events');
  assert.equal(selectHubRoute('?event=reu').view, 'games');
  const cs = selectHubRoute('?event=reu&game=cs2');
  assert.equal(cs.view, 'panel');
  assert.equal(cs.event.slug, 'reu');
  assert.equal(cs.game.id, 'cs2');
  assert.equal(selectHubRoute('?event=reu&game=dota2').view, 'setup');
  assert.equal(selectHubRoute('?event=unknown&game=cs2').view, 'events');
  assert.equal(selectHubRoute('?event=cyberclash&game=dota2').view, 'games');
});

test('profile storage namespaces include event and discipline and URLs encode both', () => {
  assert.equal(profileKey('reu', 'cs2'), 'reu:cs2');
  assert.equal(profileKey('reu', 'dota2'), 'reu:dota2');
  assert.notEqual(profileKey('cyberclash', 'cs2'), profileKey('reu', 'cs2'));
  assert.equal(eventUrl('reu'), '/?event=reu');
  assert.equal(eventUrl('reu', 'dota2'), '/?event=reu&game=dota2');
  assert.throws(() => eventUrl('../bad', 'cs2'));
});
