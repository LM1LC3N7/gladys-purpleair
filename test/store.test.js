// -----------------------------------------------------------------------------
// The state kept in /data: bounded, re-validated, never a key, never the
// fingerprint of a working key.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSY_MAX, REFUSED_BACKOFF } from '../src/constants.js';
import { StateStore, memoryStorage } from '../src/store.js';
import { API_KEY } from './helpers/fakes.js';

const NOW = Date.parse('2026-10-20T18:00:00Z');
const make = (storage, now = NOW) =>
  new StateStore({ storage, now: () => now, maxPause: BUSY_MAX, maxRefusal: REFUSED_BACKOFF });

test('times read back are capped; a hand-edited file never stops a sensor for longer', () => {
  const storage = memoryStorage({
    salt: '0123456789abcdef0123456789abcdef',
    sources: {
      'local:192.168.1.60': {
        lastAttemptAt: NOW + 10 ** 9,
        pausedUntil: NOW + 10 ** 10,
        refusedUntil: NOW + 10 ** 10,
        streak: 1e9,
        info: { id: '84f3eb7bc8ee', name: 'Jardin\u0000' },
        fields: ['pm25', 'bad field!', 42],
      },
      'evil key': { lastAttemptAt: 1 },
      'cloud:1': { info: { id: '../etc' } },
    },
    api: { pausedUntil: NOW + 10 ** 10, blockedUntil: NOW + 10 ** 10, blockKind: 'other' },
  });
  const store = make(storage);
  const entry = store.get('local:192.168.1.60');
  assert.equal(entry.lastAttemptAt, NOW);
  assert.equal(entry.pausedUntil, NOW + BUSY_MAX);
  assert.equal(entry.refusedUntil, NOW + REFUSED_BACKOFF);
  assert.equal(entry.streak, 20);
  assert.equal(entry.info.name, 'Jardin');
  assert.deepEqual(entry.fields, ['pm25']);
  assert.equal(store.entries.has('evil key'), false);
  assert.equal(store.get('cloud:1').info, undefined);
  assert.equal(store.api.pausedUntil, NOW + BUSY_MAX);
  assert.equal(store.api.blockedUntil, 0, 'an unknown block kind is dropped');
});

test('only the fingerprint of a refused key, erased by the first success', () => {
  const storage = memoryStorage();
  const store = make(storage);
  store.restoreApi(API_KEY);
  store.updateApi({ blockedUntil: NOW + REFUSED_BACKOFF, blockKind: 'refused' }, API_KEY);
  const saved = JSON.stringify(storage.load());
  assert.ok(!saved.includes(API_KEY));
  assert.match(storage.load().api.fp, /^[0-9a-f]{32}$/);
  // After a restart, the same key is still refused; another one is not.
  const again = make(storage);
  assert.equal(again.restoreApi(API_KEY), false);
  assert.equal(again.api.blockKind, 'refused');
  const other = make(storage);
  assert.equal(other.restoreApi('99999999-2222-3333-4444-555555555555'), true);
  assert.equal(other.api.blockKind, '');
  assert.equal(other.api.fp, '');
  // A success erases the fingerprint: nothing confirms a working key.
  again.updateApi({ pausedUntil: 0, streak: 0, blockedUntil: 0, blockKind: '' });
  assert.equal(storage.load().api.fp, '');
});

test('the requests of a tick are recorded in one write, at most once a minute', () => {
  const storage = memoryStorage();
  let now = NOW;
  const store = new StateStore({
    storage,
    now: () => now,
    maxPause: BUSY_MAX,
    maxRefusal: REFUSED_BACKOFF,
  });
  assert.equal(store.markAttempts(['local:a', 'local:b'], now), true);
  assert.equal(storage.writes(), 1);
  now += 59_000;
  assert.equal(store.markAttempts(['local:a'], now), false);
  assert.equal(storage.writes(), 1);
  now += 1_000;
  assert.equal(store.markAttempts(['local:a'], now), true);
  assert.equal(storage.writes(), 2);
});
