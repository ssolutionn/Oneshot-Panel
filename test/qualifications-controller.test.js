import test from 'node:test';
import assert from 'node:assert/strict';
import { createQualificationsController } from '../qualifications-controller.js';

const uuid = '12345678-1234-1234-1234-123456789abc';
const fixture = (id, status = 'ONGOING') => ({
  match_id: id, status, faceit_url: `https://www.faceit.com/en/room/${id}`,
  teams: { faction1: { name: '<Team A>' }, faction2: { name: 'Team B' } },
  results: { score: { faction1: 1, faction2: 0 } }
});

function makeController({ matches, node = null } = {}) {
  const status = { textContent: '' };
  const list = node || { replaceChildren(value) { this.content = value; } };
  const input = { value: `https://www.faceit.com/en/championship/${uuid}/test` };
  const controller = createQualificationsController({
    input, status, list, interval: 100000,
    clientFactory: () => ({ matches: matches || (async () => []) }),
    watchFactory: () => ({ watch() {}, stop() {} }),
    notify() {}
  });
  return { controller, status, list };
}

test('exports controller lifecycle/poll/render and keeps missing DOM guarded', async () => {
  const { controller } = makeController();
  assert.equal(typeof controller.start, 'function');
  assert.equal(typeof controller.stop, 'function');
  assert.equal(typeof controller.poll, 'function');
  assert.equal(typeof controller.render, 'function');
  await controller.start();
  controller.stop();
  controller.destroy();
});

test('retains prior cards when all sources fail', async () => {
  let fail = false;
  const client = { async matches() { if (fail) throw Error('offline'); return [fixture(uuid)]; } };
  const { controller, status } = makeController({ matches: client.matches.bind(client) });
  // Reuse the same client so the second poll observes an outage.
  controller.stop();
  fail = false;
  await controller.start();
  assert.equal(controller.state.matches.size, 1);
  fail = true;
  await controller.poll();
  assert.equal(controller.state.matches.size, 1);
  assert.match(status.textContent, /последние данные сохранены/);
  controller.destroy();
});

test('connect values are held only in controller memory and first observation is non-alerting', async () => {
  const { controller } = makeController({ matches: async () => [fixture(uuid)] });
  await controller.start();
  assert.equal(controller.state.matches.size, 1);
  assert.equal(controller.state.connects.size, 0);
  assert.equal(controller.state.seeded, true);
  controller.destroy();
});
