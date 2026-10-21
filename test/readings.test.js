// -----------------------------------------------------------------------------
// Documents -> values: channels, units, bounds, AQI, never NaN.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  aqiOf,
  cloudInfo,
  cloudValues,
  lastSeenOf,
  localInfo,
  localValues,
  statesOf,
} from '../src/readings.js';
import { macOf } from '../src/purpleair.js';
import { CLOUD, LOCAL } from './helpers/fakes.js';

test('a local outdoor sensor: atm particles, mean of channels A and B, °F -> °C', () => {
  assert.deepEqual(localValues(LOCAL), {
    pm1: 3,
    pm25: 5.5,
    pm10: 6.7,
    temperature: 21.1,
    humidity: 41,
    pressure: 1001.7,
    aqi: 31,
  });
});

test('a local indoor sensor uses the cf_1 particles', () => {
  const values = localValues({ ...LOCAL, place: 'inside' });
  assert.equal(values.pm25, 6);
  assert.equal(values.pm10, 7.2);
});

test('a single-laser sensor (no channel B), and a channel out of bounds left out', () => {
  const single = { ...LOCAL };
  for (const key of Object.keys(single).filter((k) => k.endsWith('_b'))) {
    delete single[key];
  }
  assert.equal(localValues(single).pm25, 5);
  assert.equal(localValues({ ...LOCAL, pm2_5_atm_b: -1 }).pm25, 5);
  assert.equal(localValues({ ...LOCAL, pm2_5_atm_b: 'nope' }).pm25, 5);
  assert.equal(localValues({ ...LOCAL, pm2_5_atm: 99999, pm2_5_atm_b: 99999 }).pm25, undefined);
  assert.equal(localValues({ ...LOCAL, pm2_5_atm: 99999, pm2_5_atm_b: 99999 }).aqi, undefined);
});

test('values out of the feature bounds are left out, never NaN nor null', () => {
  const values = localValues({
    ...LOCAL,
    current_temp_f: 500,
    current_humidity: 140,
    pressure: 'n/a',
  });
  assert.equal(values.temperature, undefined);
  assert.equal(values.humidity, undefined);
  assert.equal(values.pressure, undefined);
  for (const value of Object.values(values)) {
    assert.ok(Number.isFinite(value));
  }
  assert.deepEqual(localValues(null), {});
  assert.deepEqual(localValues('text'), {});
});

test('only own keys are read: no prototype pollution', () => {
  const document = JSON.parse('{"__proto__": {"pm2_5_atm": 50}, "constructor": 1}');
  assert.deepEqual(localValues(document), {});
  assert.equal({}.pm2_5_atm, undefined);
});

test('the US AQI of PM2.5 (EPA breakpoints of 2024)', () => {
  const cases = [
    [0, 0],
    [9.0, 50],
    [9.05, 50],
    [9.1, 51],
    [12.0, 56],
    [35.4, 100],
    [35.5, 101],
    [55.5, 151],
    [125.5, 201],
    [225.5, 301],
    [325.4, 500],
    [400, 500],
  ];
  for (const [pm, aqi] of cases) {
    assert.equal(aqiOf(pm), aqi, `PM2.5 ${pm}`);
  }
  assert.equal(aqiOf(-1), null);
  assert.equal(aqiOf(NaN), null);
});

test('an API sensor', () => {
  assert.deepEqual(cloudValues(CLOUD.sensor), {
    pm1: 0,
    pm25: 12.3,
    pm10: 15.8,
    temperature: 20.6,
    humidity: 33,
    pressure: 1001.7,
    aqi: 57,
  });
  assert.deepEqual(cloudInfo(CLOUD.sensor, 131075), {
    id: '131075',
    name: 'Mariners Bluff',
    model: 'PA-II',
    firmware: '',
    place: '',
  });
  assert.equal(lastSeenOf(CLOUD.sensor), 1760983162000);
  assert.equal(lastSeenOf({}), null);
});

test('the identity of a local sensor: its MAC, control characters dropped', () => {
  assert.equal(macOf('84:F3:EB:7B:C8:EE'), '84f3eb7bc8ee');
  assert.equal(macOf('00:00:00:00:00:00'), '');
  assert.equal(macOf(''), '');
  assert.equal(macOf(42), '');
  const info = localInfo({ ...LOCAL, Geo: 'Jardin\u0007\n' }, '84f3eb7bc8ee');
  assert.equal(info.name, 'Jardin');
  assert.equal(info.place, 'outside');
});

test('states: only finite values, never NaN, null or undefined', () => {
  const gladys = createFakeGladys({ selector: 'purpleair' });
  const states = statesOf(gladys, 'purpleair', '84f3eb7bc8ee', {
    pm25: 5,
    pm10: NaN,
    aqi: null,
    humidity: undefined,
    pm1: 2,
  });
  assert.deepEqual(states, [
    { device_feature_external_id: 'ext:purpleair:purpleair:84f3eb7bc8ee:pm25', state: 5 },
  ]);
});
