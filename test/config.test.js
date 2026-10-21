// -----------------------------------------------------------------------------
// The configuration: addresses, indexes, keys, intervals and their bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseAddress, parseIndex } from '../src/config.js';
import { API_KEY, READ_KEY } from './helpers/fakes.js';

test('addresses: IPv4 or host name, optional port, nothing else', () => {
  assert.equal(parseAddress(' 192.168.1.60 '), '192.168.1.60');
  assert.equal(parseAddress('http://192.168.1.60/json'), '192.168.1.60');
  assert.equal(parseAddress('http://192.168.1.60/'), '192.168.1.60');
  assert.equal(parseAddress('PurpleAir-C8EE.local:8080'), 'purpleair-c8ee.local:8080');
  for (const bad of [
    '',
    '192.168.1.300',
    '192.168.1.60/other',
    'user:pw@192.168.1.60',
    '[::1]',
    'host:99999',
    'a_b.local',
  ]) {
    assert.equal(parseAddress(bad), null, bad);
  }
});

test('sensor indexes: positive integers', () => {
  assert.equal(parseIndex('131075'), 131075);
  assert.equal(parseIndex(42), 42);
  for (const bad of ['0', '-1', '12.5', 'abc', '1234567890', '']) {
    assert.equal(parseIndex(bad), null, bad);
  }
});

test('defaults: 2 minutes local, 60 minutes cloud; bounds 2-60 and 10-1440', () => {
  const config = normalizeConfig({});
  assert.equal(config.localMinutes, DEFAULT_CONFIG.local_interval);
  assert.equal(config.cloudMinutes, DEFAULT_CONFIG.cloud_interval);
  assert.equal(config.localMinutes, 2);
  assert.equal(config.cloudMinutes, 60);
  assert.equal(normalizeConfig({ local_interval: 1 }).localMinutes, 2);
  assert.equal(normalizeConfig({ local_interval: 500 }).localMinutes, 60);
  assert.equal(normalizeConfig({ cloud_interval: 1 }).cloudMinutes, 10);
  assert.equal(normalizeConfig({ cloud_interval: '' }).cloudMinutes, 60);
  assert.equal(normalizeConfig({ cloud_interval: 99999 }).cloudMinutes, 1440);
});

test('local and cloud sensors; invalid slots reported by number only', () => {
  const config = normalizeConfig({
    local_1_address: '192.168.1.60',
    local_2_address: '192.168.1.60',
    local_3_address: 'not an address!',
    api_key: API_KEY,
    cloud_1_sensor: '131075',
    cloud_1_read_key: READ_KEY,
    cloud_2_sensor: 'abc',
    cloud_3_sensor: '131075',
  });
  assert.deepEqual(config.local, [{ slot: 1, key: 'local:192.168.1.60', address: '192.168.1.60' }]);
  assert.deepEqual(config.cloud, [
    { slot: 1, key: 'cloud:131075', index: 131075, readKey: READ_KEY },
  ]);
  assert.equal(config.apiKey, API_KEY);
  assert.deepEqual(config.invalid, [
    { slot: 'local 2', why: 'duplicate' },
    { slot: 'local 3', why: 'address' },
    { slot: 'cloud 2', why: 'index' },
    { slot: 'cloud 3', why: 'duplicate' },
  ]);
  assert.ok(!JSON.stringify(config.invalid).includes('not an address'));
});

test('a cloud sensor without an API key, or with a key that does not parse, is not read', () => {
  const noKey = normalizeConfig({ cloud_1_sensor: '131075' });
  assert.deepEqual(noKey.cloud, []);
  assert.deepEqual(noKey.invalid, [{ slot: 'cloud 1', why: 'noKey' }]);
  const badKey = normalizeConfig({ api_key: 'bad key with spaces', cloud_1_sensor: '131075' });
  assert.deepEqual(badKey.cloud, []);
  assert.equal(badKey.apiKey, '');
  assert.deepEqual(badKey.invalid, [{ slot: 'API', why: 'key' }]);
  assert.ok(!JSON.stringify(badKey).includes('spaces'));
});
