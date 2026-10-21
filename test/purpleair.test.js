// -----------------------------------------------------------------------------
// The two clients: what leaves (URL, headers), what an answer means, bounds.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCloudAnswer, readCloud, readLocal } from '../src/purpleair.js';
import { API_KEY, CLOUD, LOCAL, READ_KEY, installFetch, json } from './helpers/fakes.js';

let fake;
afterEach(() => fake?.restore());

test('cloud: the key in a header, never in the URL; only the published fields', async () => {
  fake = installFetch([[/^https:\/\/api\.purpleair\.com\//, () => json(CLOUD)]]);
  const sensor = await readCloud(131075, { apiKey: API_KEY, readKey: READ_KEY });
  assert.equal(sensor.name, 'Mariners Bluff');
  const [call] = fake.calls;
  const url = new URL(call.url);
  assert.equal(url.pathname, '/v1/sensors/131075');
  assert.equal(
    url.searchParams.get('fields'),
    'name,model,last_seen,pm1.0,pm2.5,pm10.0,temperature,humidity,pressure',
  );
  assert.equal(url.searchParams.get('read_key'), READ_KEY);
  assert.ok(!call.url.includes(API_KEY));
  assert.equal(call.init.headers['X-API-Key'], API_KEY);
  assert.match(call.init.headers['User-Agent'], /^gladys-purpleair /);
  assert.equal(call.init.redirect, 'error');
});

test('cloud: no read key, no read_key parameter', async () => {
  fake = installFetch([[/^https:\/\/api\.purpleair\.com\//, () => json(CLOUD)]]);
  await readCloud(131075, { apiKey: API_KEY, readKey: '' });
  assert.ok(!fake.calls[0].url.includes('read_key'));
});

test('cloud: the answer of another sensor is refused', async () => {
  fake = installFetch([
    [
      /^https:\/\/api\.purpleair\.com\//,
      () => json({ ...CLOUD, sensor: { ...CLOUD.sensor, sensor_index: 999 } }),
    ],
  ]);
  await assert.rejects(readCloud(131075, { apiKey: API_KEY }), { kind: 'invalid' });
});

test('cloud: the error codes of the API', () => {
  const kind = (status, body, retryAfterMs) =>
    checkCloudAnswer({ status, body, retryAfterMs }).kind;
  assert.equal(kind(403, { error: 'ApiKeyInvalidError', description: 'x' }), 'refused');
  assert.equal(kind(403, { error: 'ApiKeyMissingError' }), 'refused');
  assert.equal(kind(403, { error: 'ApiKeyTypeMismatchError' }), 'refused');
  assert.equal(kind(402, { error: 'PaymentRequiredError' }), 'credits');
  assert.equal(kind(402, undefined), 'credits');
  assert.equal(kind(429, undefined), 'busy');
  assert.equal(kind(503, undefined), 'busy');
  assert.equal(kind(404, { error: 'NotFoundError' }), 'not_found');
  assert.equal(kind(403, undefined), 'denied');
  assert.equal(kind(403, { error: 'SomethingElse' }), 'denied');
  assert.equal(kind(400, { error: 'InvalidFieldValueError' }), 'failed');
  assert.equal(kind(200, { error: 'ApiKeyInvalidError' }), 'refused');
  assert.equal(kind(200, { sensor: [] }), 'invalid');
  assert.equal(checkCloudAnswer({ status: 429, retryAfterMs: 5000 }).retryAfterMs, 5000);
});

test('cloud: the description of an answer is never shown (it could echo anything)', () => {
  const error = checkCloudAnswer({
    status: 400,
    body: { error: 'Weird', description: `key ${API_KEY}` },
  });
  assert.ok(!error.message.includes(API_KEY));
  assert.ok(!error.message.includes('Weird'));
});

test('local: GET /json?live=false, no key, no redirection', async () => {
  fake = installFetch([[/^http:\/\/192\.168\.1\.60\/json\?live=false$/, () => json(LOCAL)]]);
  const document = await readLocal('192.168.1.60');
  assert.equal(document.SensorId, LOCAL.SensorId);
  assert.equal(fake.calls[0].init.redirect, 'error');
  assert.equal(fake.calls[0].init.headers['X-API-Key'], undefined);
});

test('local: 429/5xx are busy (with Retry-After), other statuses fail, non-JSON is invalid', async () => {
  const answers = [
    () => json({}, 503, { 'retry-after': '120' }),
    () => json({}, 404),
    () => new Response('<html>hello</html>', { status: 200 }),
    () => json([1, 2]),
  ];
  fake = installFetch([[/^http:\/\/192\.168\.1\.60\//, () => answers.shift()()]]);
  await assert.rejects(readLocal('192.168.1.60'), { kind: 'busy', retryAfterMs: 120_000 });
  await assert.rejects(readLocal('192.168.1.60'), { kind: 'failed' });
  await assert.rejects(readLocal('192.168.1.60'), { kind: 'invalid' });
  await assert.rejects(readLocal('192.168.1.60'), { kind: 'invalid' });
});

test('an answer too large is cut off and fails; the error names the host only', async () => {
  const big = 'x'.repeat(70 * 1024);
  fake = installFetch([[/./, () => new Response(big, { status: 200 })]]);
  await assert.rejects(readLocal('192.168.1.60'), (err) => {
    assert.equal(err.kind, 'failed');
    assert.match(err.message, /answer too large on 192\.168\.1\.60/);
    return true;
  });
  await assert.rejects(readCloud(1, { apiKey: API_KEY, readKey: READ_KEY }), (err) => {
    assert.match(err.message, /api\.purpleair\.com/);
    assert.ok(!err.message.includes(READ_KEY));
    assert.ok(!err.message.includes(API_KEY));
    return true;
  });
});

test('a network failure names the host only', async () => {
  fake = installFetch([
    [
      /./,
      () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      },
    ],
  ]);
  await assert.rejects(readCloud(1, { apiKey: API_KEY, readKey: READ_KEY }), (err) => {
    assert.equal(err.kind, 'failed');
    assert.match(err.message, /network ECONNREFUSED on api\.purpleair\.com/);
    return true;
  });
});
