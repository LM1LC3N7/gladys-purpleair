// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and fake PurpleAir answers.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PurpleAirApp } from '../src/app.js';
import { ACTIONS, REFUSED_BACKOFF, TICK } from '../src/constants.js';
import { T } from '../src/i18n.js';
import { memoryStorage } from '../src/store.js';
import {
  API_KEY,
  CLOUD,
  LOCAL,
  READ_KEY,
  createFakeTimers,
  installFetch,
  json,
  recordingLogger,
} from './helpers/fakes.js';

const NOW = Date.parse('2026-10-20T18:00:00Z');
const LOCAL_DEVICE = 'ext:purpleair:purpleair:84f3eb7bc8ee';
const CLOUD_DEVICE = 'ext:purpleair:purpleair-cloud:131075';
const LOCAL_CONFIG = { local_1_address: '192.168.1.60' };
const CLOUD_CONFIG = { api_key: API_KEY, cloud_1_sensor: '131075' };

let fake;
afterEach(() => fake?.restore());

async function setup({ config = LOCAL_CONFIG, storage = memoryStorage(), start = true } = {}) {
  const answers = {
    local: () => json(LOCAL),
    cloud: () => json({ ...CLOUD, sensor: { ...CLOUD.sensor, last_seen: clock.now / 1000 } }),
  };
  const clock = { now: NOW };
  fake = installFetch([
    [/^http:\/\/[^/]+\/json\?live=false$/, (c) => answers.local(c)],
    [/^https:\/\/api\.purpleair\.com\/v1\/sensors\//, (c) => answers.cloud(c)],
  ]);
  const gladys = createFakeGladys({ selector: 'purpleair', config });
  const timers = createFakeTimers();
  const logger = recordingLogger();
  const make = () => new PurpleAirApp({ gladys, logger, now: () => clock.now, timers, storage });
  const app = make();
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onDeviceCreated(() => app.publishStates());
  await gladys.connect();
  if (start) {
    await app.start(config);
  }
  return { app, make, gladys, timers, clock, answers, logger, storage };
}

const localCalls = () => fake.calls.filter((c) => c.url.startsWith('http://'));
const cloudCalls = () => fake.calls.filter((c) => c.url.startsWith('https://'));

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

async function runMinutes(timers, clock, minutes) {
  for (let i = 0; i < (minutes * 60_000) / TICK; i += 1) {
    clock.now += TICK;
    await timers.runIntervals();
  }
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test('local: one read at start, one device with the published features', async () => {
  const { gladys } = await setup();
  assert.equal(localCalls().length, 1);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.name, 'PurpleAir-c8ee (PurpleAir)');
  assert.equal(device.external_id, LOCAL_DEVICE);
  assert.equal(device.should_poll, false);
  assert.deepEqual(
    device.features.map((f) => [f.external_id.slice(LOCAL_DEVICE.length + 1), f.category, f.unit]),
    [
      ['pm25', 'pm25-sensor', 'microgram-per-cubic-meter'],
      ['pm10', 'pm10-sensor', 'microgram-per-cubic-meter'],
      ['aqi', 'airquality-sensor', 'aqi'],
      ['temperature', 'temperature-sensor', 'celsius'],
      ['humidity', 'humidity-sensor', 'percent'],
      ['pressure', 'pressure-sensor', 'hPa'],
    ],
  );
  assert.ok(device.features.every((f) => f.read_only && !f.has_feedback));
  assert.equal(gladys.fake.states.length, 0, 'nothing created: nothing published');
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: T.ok({ local: 1, cloud: 0, localMinutes: 2, cloudMinutes: 60 }),
  });
  assert.equal(cloudCalls().length, 0, 'no API call without a key');
});

test('a created device gets its values at once', async () => {
  const { gladys } = await setup();
  await createAll(gladys);
  assert.equal(gladys.fake.lastState(`${LOCAL_DEVICE}:pm25`), 5.5);
  assert.equal(gladys.fake.lastState(`${LOCAL_DEVICE}:aqi`), 31);
  assert.equal(gladys.fake.lastState(`${LOCAL_DEVICE}:temperature`), 21.1);
});

test('local: read every 2 minutes', async () => {
  const { gladys, timers, clock } = await setup();
  await createAll(gladys);
  await runMinutes(timers, clock, 1);
  assert.equal(localCalls().length, 1);
  await runMinutes(timers, clock, 1);
  assert.equal(localCalls().length, 2);
  await runMinutes(timers, clock, 60);
  assert.equal(localCalls().length, 32);
});

test('never faster than the interval: test button, Discovery, reconnection, unchanged config, restart', async () => {
  const { app, make, gladys, storage, clock } = await setup();
  assert.equal(localCalls().length, 1);
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.match(ack.data.message.en, /next read possible at 18:02 UTC/);
  await app.publishDiscovered({ force: true });
  await app.start(LOCAL_CONFIG);
  await app.start({ ...LOCAL_CONFIG });
  clock.now += 30_000;
  const restarted = make();
  await restarted.start(LOCAL_CONFIG);
  assert.equal(localCalls().length, 1);
  // The Discovery list is filled after the restart, without a request.
  assert.equal(gladys.fake.discoveredDevices[0].external_id, LOCAL_DEVICE);
  assert.ok(!JSON.stringify(storage.load()).includes('"values"'));
  // Once the interval has passed, the button reads.
  clock.now += 90_000;
  app.stop();
  await restarted.testConnection();
  assert.equal(localCalls().length, 2);
});

test('a reconnection during a read does not start another read', async () => {
  const { app, answers } = await setup({ start: false });
  const slow = deferred();
  answers.local = () => slow.promise;
  const first = app.start(LOCAL_CONFIG);
  await new Promise((r) => setImmediate(r));
  const second = app.start(LOCAL_CONFIG);
  slow.resolve(json(LOCAL));
  await Promise.all([first, second]);
  assert.equal(localCalls().length, 1);
});

test('a late answer of an old configuration publishes nothing and sets no status', async () => {
  const { app, gladys, answers } = await setup({ start: false });
  const slow = deferred();
  answers.local = () => slow.promise;
  const first = app.start(LOCAL_CONFIG);
  await new Promise((r) => setImmediate(r));
  app.stop();
  slow.resolve(json(LOCAL));
  await first;
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.equal(gladys.fake.connectionStatus, null);
});

test('the instant of the last request is written at most once a minute', async () => {
  const storage = memoryStorage();
  const { timers, clock } = await setup({
    storage,
    config: { ...LOCAL_CONFIG, local_2_address: '192.168.1.61' },
  });
  const before = storage.writes();
  for (let i = 0; i < 10; i += 1) {
    const writesBefore = storage.writes();
    clock.now += TICK;
    await timers.runIntervals();
    assert.ok(storage.writes() - writesBefore <= 1, 'one write per tick at most');
  }
  assert.ok(storage.writes() - before <= 5, `${storage.writes() - before} writes in 10 minutes`);
});

test('another sensor at the address (DHCP swap): its own device, the first one gets nothing', async () => {
  const { gladys, answers, timers, clock } = await setup();
  await createAll(gladys);
  const count = gladys.fake.states.length;
  answers.local = () => json({ ...LOCAL, SensorId: '84:f3:eb:00:00:01', Geo: 'Other' });
  await runMinutes(timers, clock, 2);
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.deepEqual(ids, ['ext:purpleair:purpleair:84f3eb000001']);
  assert.equal(
    gladys.fake.states
      .slice(count)
      .filter((s) => s.device_feature_external_id.startsWith(LOCAL_DEVICE)).length,
    0,
  );
});

test('an unreadable sensor id is not "another sensor": nothing published, the device kept', async () => {
  const { gladys, answers, timers, clock } = await setup();
  await createAll(gladys);
  const count = gladys.fake.states.length;
  answers.local = () => json({ ...LOCAL, SensorId: '' });
  await runMinutes(timers, clock, 2);
  assert.equal(gladys.fake.states.length, count);
  assert.equal(gladys.fake.discoveredDevices[0].external_id, LOCAL_DEVICE);
  assert.match(gladys.fake.connectionStatus.message.en, /not a PurpleAir answer/);
});

test('a local 503 pauses that sensor (Retry-After), never the test button', async () => {
  const { gladys, answers, timers, clock } = await setup({ start: false });
  answers.local = () => json({}, 503, { 'retry-after': '600' });
  const app = new PurpleAirApp({
    gladys,
    logger: recordingLogger(),
    now: () => clock.now,
    timers,
    storage: memoryStorage(),
  });
  await app.start(LOCAL_CONFIG);
  answers.local = () => json(LOCAL);
  await runMinutes(timers, clock, 5);
  await app.testConnection();
  assert.equal(localCalls().length, 1);
  await runMinutes(timers, clock, 6);
  assert.equal(localCalls().length, 2);
});

test('cloud: one call per hour by default, the key in a header only', async () => {
  const { gladys, timers, clock } = await setup({ config: CLOUD_CONFIG });
  assert.equal(cloudCalls().length, 1);
  assert.equal(cloudCalls()[0].init.headers['X-API-Key'], API_KEY);
  await createAll(gladys);
  assert.equal(gladys.fake.discoveredDevices[0].external_id, CLOUD_DEVICE);
  assert.equal(gladys.fake.lastState(`${CLOUD_DEVICE}:pm25`), 12.3);
  await runMinutes(timers, clock, 59);
  assert.equal(cloudCalls().length, 1);
  await runMinutes(timers, clock, 61);
  assert.equal(cloudCalls().length, 3);
});

test('cloud: a refused key stops every call for 6 hours, survives a restart, never logged', async () => {
  const storage = memoryStorage();
  const { app, make, gladys, answers, timers, clock, logger } = await setup({
    start: false,
    storage,
    config: { ...CLOUD_CONFIG, cloud_2_sensor: '42', cloud_2_read_key: READ_KEY },
  });
  answers.cloud = () => json({ error: 'ApiKeyInvalidError', description: API_KEY }, 403);
  const config = { ...CLOUD_CONFIG, cloud_2_sensor: '42', cloud_2_read_key: READ_KEY };
  await app.start(config);
  assert.equal(cloudCalls().length, 1, 'the second sensor is not tried');
  assert.match(gladys.fake.connectionStatus.message.en, /API key refused/);
  assert.match(gladys.fake.connectionStatus.message.en, /develop\.purpleair\.com/);
  await runMinutes(timers, clock, 120);
  assert.equal(cloudCalls().length, 1);
  app.stop();
  const restarted = make();
  await restarted.start(config);
  await runMinutes(timers, clock, 120);
  assert.equal(cloudCalls().length, 1);
  assert.match(gladys.fake.connectionStatus.message.en, /API key refused/);
  const saved = JSON.stringify(storage.load());
  const everything = [...logger.lines, saved, JSON.stringify(gladys.fake.connectionStatus)].join(
    '\n',
  );
  assert.ok(!everything.includes(API_KEY), 'the API key is nowhere');
  assert.ok(!everything.includes(READ_KEY), 'the read key is nowhere');
  await runMinutes(timers, clock, REFUSED_BACKOFF / 60_000 - 240 + 1);
  assert.equal(cloudCalls().length, 2, 'one new try after 6 hours');
});

test('cloud: a new key is tried at once; the block of the old one is dropped', async () => {
  const { app, answers, timers, clock } = await setup({ start: false, config: CLOUD_CONFIG });
  answers.cloud = () => json({ error: 'ApiKeyInvalidError' }, 403);
  await app.start(CLOUD_CONFIG);
  assert.equal(cloudCalls().length, 1);
  answers.cloud = () =>
    json({ ...CLOUD, sensor: { ...CLOUD.sensor, last_seen: clock.now / 1000 } });
  clock.now += TICK;
  await app.start({ ...CLOUD_CONFIG, api_key: '99999999-2222-3333-4444-555555555555' });
  assert.equal(cloudCalls().length, 2);
  await runMinutes(timers, clock, 30);
  assert.equal(cloudCalls().length, 2);
});

test('cloud: no points left (402) stops the calls; the test button tries again after the interval', async () => {
  const { app, gladys, answers, timers, clock } = await setup({
    start: false,
    config: CLOUD_CONFIG,
  });
  answers.cloud = () => json({ error: 'PaymentRequiredError' }, 402);
  await app.start(CLOUD_CONFIG);
  assert.match(gladys.fake.connectionStatus.message.fr, /plus de points/);
  await app.testConnection();
  assert.equal(cloudCalls().length, 1, 'not before the interval');
  await runMinutes(timers, clock, 60);
  assert.equal(cloudCalls().length, 1, 'no periodic call');
  answers.cloud = () =>
    json({ ...CLOUD, sensor: { ...CLOUD.sensor, last_seen: clock.now / 1000 } });
  await app.testConnection();
  assert.equal(cloudCalls().length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('cloud: a 429 pauses every cloud sensor, not the local ones, and holds the test button', async () => {
  const { app, answers, timers, clock } = await setup({ start: false });
  answers.cloud = () => json({}, 429, { 'retry-after': '7200' });
  const config = { ...LOCAL_CONFIG, ...CLOUD_CONFIG, cloud_2_sensor: '42' };
  await app.start(config);
  assert.equal(cloudCalls().length, 1);
  answers.cloud = () => json({ ...CLOUD, sensor: { ...CLOUD.sensor, sensor_index: 42 } });
  await runMinutes(timers, clock, 61);
  await app.testConnection();
  assert.equal(cloudCalls().length, 1);
  assert.ok(localCalls().length >= 30, 'the local sensor keeps its pace');
});

test('cloud: an unknown sensor is not asked again for 6 hours; the others go on', async () => {
  const { app, answers, timers, clock } = await setup({ start: false });
  answers.cloud = (call) =>
    call.url.includes('/sensors/42?')
      ? json({ error: 'NotFoundError' }, 404)
      : json({ ...CLOUD, sensor: { ...CLOUD.sensor, last_seen: clock.now / 1000 } });
  await app.start({ ...CLOUD_CONFIG, cloud_2_sensor: '42' });
  assert.equal(cloudCalls().length, 2);
  await runMinutes(timers, clock, 120);
  assert.equal(cloudCalls().filter((c) => c.url.includes('/sensors/42?')).length, 1);
  assert.equal(cloudCalls().filter((c) => c.url.includes('/sensors/131075?')).length, 3);
});

test('cloud: a sensor PurpleAir has not heard from for an hour publishes nothing', async () => {
  const { gladys, answers, timers, clock } = await setup({ config: CLOUD_CONFIG });
  await createAll(gladys);
  const count = gladys.fake.states.length;
  answers.cloud = () => json({ ...CLOUD, sensor: { ...CLOUD.sensor, last_seen: NOW / 1000 } });
  await runMinutes(timers, clock, 120);
  assert.equal(gladys.fake.states.length, count);
  assert.match(gladys.fake.connectionStatus.message.en, /offline/);
});

test('a reconnection republishes the status and the Discovery list', async () => {
  const { app, gladys } = await setup();
  let statuses = 0;
  let discoveries = 0;
  const setStatus = gladys.setConnectionStatus.bind(gladys);
  const publish = gladys.publishDiscoveredDevices.bind(gladys);
  gladys.setConnectionStatus = (...args) => {
    statuses += 1;
    return setStatus(...args);
  };
  gladys.publishDiscoveredDevices = (...args) => {
    discoveries += 1;
    return publish(...args);
  };
  await app.start(LOCAL_CONFIG);
  assert.equal(statuses, 1);
  assert.equal(discoveries, 1);
});

test('not configured: says what to enter, no call', async () => {
  const { gladys } = await setup({ config: {} });
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: false,
    message: T.notConfigured,
  });
  assert.equal(fake.calls.length, 0);
});

const wakeTimer = (timers) => [...timers.pending.values()].find((t) => t.kind === 'timeout');

async function fireWake(timers) {
  const wake = wakeTimer(timers);
  assert.ok(wake, 'a wake timer is pending');
  timers.pending.delete(wake.id);
  await wake.fn();
}

test('I1: channels A/B that disagree publish no particles nor AQI; status and button say so', async () => {
  const { gladys, answers, timers, clock } = await setup();
  await createAll(gladys);
  answers.local = () => json({ ...LOCAL, pm2_5_atm: 500, pm2_5_atm_b: 4, current_temp_f: 75 });
  await runMinutes(timers, clock, 2);
  assert.equal(gladys.fake.lastState(`${LOCAL_DEVICE}:pm25`), 5.5, 'the faulty 252 never sent');
  assert.equal(gladys.fake.lastState(`${LOCAL_DEVICE}:aqi`), 31);
  assert.equal(gladys.fake.lastState(`${LOCAL_DEVICE}:temperature`), 23.9);
  assert.match(gladys.fake.connectionStatus.message.en, /Channels A\/B disagree/);
  assert.match(gladys.fake.connectionStatus.message.fr, /Canaux A\/B en désaccord/);
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.match(ack.data.message.fr, /canaux A\/B en désaccord/);
  assert.ok(!gladys.fake.states.some((s) => s.state === 252 || s.state === 354));
});

test('I2: no fingerprint for an account without points (402) nor an unknown index (404)', async () => {
  const storage = memoryStorage();
  const { app, answers } = await setup({ start: false, storage });
  answers.cloud = (call) =>
    call.url.includes('/sensors/42?')
      ? json({ error: 'NotFoundError' }, 404)
      : json({ error: 'PaymentRequiredError' }, 402);
  await app.start({ ...CLOUD_CONFIG, cloud_1_sensor: '42', cloud_2_sensor: '131075' });
  const saved = storage.load();
  assert.equal(saved.sources['cloud:42'].fp, '');
  assert.ok(saved.sources['cloud:42'].refusedUntil > NOW);
  assert.equal(saved.api.blockKind, 'credits');
  assert.equal(saved.api.fp, '');
});

test('I2: a private sensor refused with its read key keeps the fingerprint of that key only', async () => {
  const storage = memoryStorage();
  const { app, answers } = await setup({ start: false, storage });
  answers.cloud = () => json({}, 403);
  await app.start({ ...CLOUD_CONFIG, cloud_1_read_key: READ_KEY });
  assert.match(storage.load().sources['cloud:131075'].fp, /^[0-9a-f]{32}$/);
  assert.equal(storage.load().api.fp, '');
});

test('M1: a paid answer met by a reconnection is kept and published, same configuration', async () => {
  const { app, gladys, answers, clock } = await setup({ start: false, config: CLOUD_CONFIG });
  const slow = deferred();
  answers.cloud = () => slow.promise;
  const first = app.start(CLOUD_CONFIG);
  await new Promise((r) => setImmediate(r));
  const second = app.start(CLOUD_CONFIG);
  slow.resolve(json({ ...CLOUD, sensor: { ...CLOUD.sensor, last_seen: clock.now / 1000 } }));
  await Promise.all([first, second]);
  assert.equal(cloudCalls().length, 1);
  assert.equal(gladys.fake.discoveredDevices[0].external_id, CLOUD_DEVICE);
  await createAll(gladys);
  assert.equal(gladys.fake.lastState(`${CLOUD_DEVICE}:pm25`), 12.3);
});

test('M1: an answer for a key changed meanwhile is dropped', async () => {
  const { app, gladys, answers, clock } = await setup({ start: false, config: CLOUD_CONFIG });
  const slow = deferred();
  answers.cloud = () => slow.promise;
  const first = app.start(CLOUD_CONFIG);
  await new Promise((r) => setImmediate(r));
  const second = app.start({ ...CLOUD_CONFIG, api_key: '99999999-2222-3333-4444-555555555555' });
  slow.resolve(json({ ...CLOUD, sensor: { ...CLOUD.sensor, last_seen: clock.now / 1000 } }));
  await Promise.all([first, second]);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
});

test('M3: a timer at the due time keeps the 2-minute pace, never sooner', async () => {
  const { timers, clock } = await setup();
  clock.now = NOW + 60_000;
  await timers.runIntervals();
  clock.now = NOW + 119_999;
  await timers.runIntervals();
  assert.equal(localCalls().length, 1, 'a tick 1 ms early reads nothing');
  assert.equal(wakeTimer(timers).ms, 51);
  clock.now = NOW + 120_050;
  await fireWake(timers);
  assert.equal(localCalls().length, 2);
  assert.equal(wakeTimer(timers).ms, 120_050);
});

test('M4: the button never says a next read at a time already past', async () => {
  const { app, gladys, clock } = await setup();
  clock.now = NOW + 30_000;
  const config = { ...LOCAL_CONFIG, local_2_address: '192.168.1.61' };
  await app.start(config);
  assert.equal(localCalls().length, 1, 'the request time was written 30 s ago');
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.match(
    ack.data.message.en,
    /192\.168\.1\.61\): not read since the start, next read possible at 18:01 UTC/,
  );
});

test('M5: a sensor moved to another configured address is published from there', async () => {
  const { gladys, answers, timers, clock } = await setup({ start: false });
  answers.local = (call) =>
    call.url.includes('192.168.1.60')
      ? json(LOCAL)
      : json({ ...LOCAL, SensorId: '84:f3:eb:00:00:01', Geo: 'Other' });
  const app = new PurpleAirApp({
    gladys,
    logger: recordingLogger(),
    now: () => clock.now,
    timers,
    storage: memoryStorage(),
  });
  await app.start({ ...LOCAL_CONFIG, local_2_address: '192.168.1.61' });
  await createAll(gladys);
  answers.local = (call) => {
    if (call.url.includes('192.168.1.60')) {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
    }
    return json({ ...LOCAL, pm2_5_atm: 20, pm2_5_atm_b: 20 });
  };
  await runMinutes(timers, clock, 2);
  assert.equal(gladys.fake.lastState(`${LOCAL_DEVICE}:pm25`), 20);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /same sensor/);
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.equal(ids.filter((id) => id === LOCAL_DEVICE).length, 1);
});

test('M6: a key mistyped then restored keeps the pace (no paid call at once)', async () => {
  const { app, timers, clock } = await setup({ config: CLOUD_CONFIG });
  assert.equal(cloudCalls().length, 1);
  clock.now += 60_000;
  await app.start({ ...CLOUD_CONFIG, api_key: 'bad key' });
  clock.now += 60_000;
  await app.start(CLOUD_CONFIG);
  assert.equal(cloudCalls().length, 1);
  await runMinutes(timers, clock, 58);
  assert.equal(cloudCalls().length, 2);
});

test('M7: name and model asked once, then the identity kept (also after a restart)', async () => {
  const storage = memoryStorage();
  const { make, timers, clock } = await setup({ config: CLOUD_CONFIG, storage });
  const fields = (call) => new URL(call.url).searchParams.get('fields');
  assert.match(fields(cloudCalls()[0]), /^name,model,/);
  await runMinutes(timers, clock, 60);
  assert.doesNotMatch(fields(cloudCalls()[1]), /name|model/);
  clock.now += 60 * 60_000;
  await make().start(CLOUD_CONFIG);
  assert.doesNotMatch(fields(cloudCalls()[2]), /name|model/);
});

test('a created feature is never dropped from the Discovery list', async () => {
  const { gladys, answers, timers, clock } = await setup();
  await createAll(gladys);
  const { pressure, ...rest } = LOCAL;
  assert.ok(pressure);
  answers.local = () => json(rest);
  await runMinutes(timers, clock, 2);
  const keys = gladys.fake.discoveredDevices[0].features.map((f) => f.external_id);
  assert.ok(keys.includes(`${LOCAL_DEVICE}:pressure`));
});
