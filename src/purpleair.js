// -----------------------------------------------------------------------------
// The two ways to read a PurpleAir sensor:
//
// - local: `GET http://<sensor>/json?live=false`, the JSON page every
//   PurpleAir sensor serves on its own network (averages over 2 minutes), no
//   account, no key, free;
// - cloud: `GET https://api.purpleair.com/v1/sensors/<index>` of the official
//   API, with the API key in the X-API-Key header (as aiopurpleair, MIT,
//   Aaron Bach, does), only the fields published (the API charges points
//   per field), the read key of a private sensor as the API wants it.
//
// Read only: nothing else is ever called. The error kinds follow the error
// codes of the API (aiopurpleair `errors.py`); only a known code is ever
// shown, never the `description` of an answer.
// -----------------------------------------------------------------------------

import { API_URL, CLOUD_FIELDS, CLOUD_IDENTITY_FIELDS } from './constants.js';
import { getJson } from './http.js';

/**
 * kind:
 * - refused: the API key is refused (key-level)
 * - credits: the account has no points left (402, key-level)
 * - busy: 429 or 5xx, `retryAfterMs` when given (key-level for the API)
 * - not_found: no sensor with this index (sensor-level)
 * - denied: the API refuses this sensor (a private one, a wrong read key)
 * - invalid: not the answer of a PurpleAir sensor, or of another sensor
 * - failed: anything else (network, another status)
 */
export class PurpleAirError extends Error {
  constructor(kind, detail = kind, { retryAfterMs } = {}) {
    super(`PurpleAir ${kind}${detail && detail !== kind ? ` (${detail})` : ''}`);
    this.name = 'PurpleAirError';
    this.kind = kind;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The error kinds that concern the API key, not one sensor. */
export const KEY_KINDS = ['refused', 'credits', 'busy'];

const REFUSED_CODES = [
  'ApiKeyInvalidError',
  'ApiKeyMissingError',
  'ApiKeyTypeMismatchError',
  'ApiKeyRestrictedError',
];
const KNOWN_CODES = [
  ...REFUSED_CODES,
  'PaymentRequiredError',
  'NotFoundError',
  'RateLimitExceededError',
  'InvalidReadKeyError',
  'ProhibitedResourceError',
];

/** The `error` code of an API answer, only when it is a known one. */
const codeOf = (body) => {
  const code = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
  return KNOWN_CODES.includes(code) ? code : '';
};

/** An API answer -> the sensor object, or the PurpleAirError it means. */
export function checkCloudAnswer({ status, body, retryAfterMs }) {
  const code = codeOf(body);
  const hasError = body && typeof body === 'object' && Object.hasOwn(body, 'error');
  if (status >= 200 && status < 300 && !hasError) {
    const sensor = body?.sensor;
    return sensor && typeof sensor === 'object' && !Array.isArray(sensor)
      ? sensor
      : new PurpleAirError('invalid', 'unexpected answer');
  }
  if (REFUSED_CODES.includes(code)) {
    return new PurpleAirError('refused', code);
  }
  if (status === 402 || code === 'PaymentRequiredError') {
    return new PurpleAirError('credits', code || 'http 402');
  }
  if (status === 429 || code === 'RateLimitExceededError') {
    return new PurpleAirError('busy', code || 'http 429', { retryAfterMs });
  }
  if (status >= 500) {
    return new PurpleAirError('busy', `http ${status}`, { retryAfterMs });
  }
  if (status === 404 || code === 'NotFoundError') {
    return new PurpleAirError('not_found', code || 'http 404');
  }
  if (status === 401 || status === 403) {
    // A bare 401/403 (no known code) or a code about the sensor: the sensor
    // is refused (private, wrong read key), never the key as a whole, unless
    // the API names the key.
    return new PurpleAirError('denied', code || `http ${status}`);
  }
  return new PurpleAirError('failed', code || `http ${Number(status) || 0}`);
}

/** Read one sensor through the API. Never logs nor returns a key. */
export async function readCloud(index, { apiKey, readKey, withIdentity = true }) {
  const url = new URL(`${API_URL}/sensors/${encodeURIComponent(String(index))}`);
  const fields = withIdentity ? [...CLOUD_IDENTITY_FIELDS, ...CLOUD_FIELDS] : CLOUD_FIELDS;
  url.searchParams.set('fields', fields.join(','));
  if (readKey) {
    url.searchParams.set('read_key', readKey);
  }
  let answer;
  try {
    answer = await getJson(url.href, { headers: { 'X-API-Key': apiKey } });
  } catch (err) {
    throw new PurpleAirError('failed', err.message);
  }
  const result = checkCloudAnswer(answer);
  if (result instanceof PurpleAirError) {
    throw result;
  }
  // The answer must be the sensor asked for.
  if (Number(result.sensor_index) !== Number(index)) {
    throw new PurpleAirError('invalid', 'another sensor');
  }
  return result;
}

/** "84:f3:eb:7b:c8:ee" -> "84f3eb7bc8ee", or '' when it does not look like a MAC. */
export function macOf(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const hex = value.trim().toLowerCase().replace(/[:-]/g, '');
  return /^[0-9a-f]{12}$/.test(hex) && hex !== '000000000000' ? hex : '';
}

/** Read the JSON page of a sensor on the local network. */
export async function readLocal(address) {
  let answer;
  try {
    answer = await getJson(`http://${address}/json?live=false`);
  } catch (err) {
    throw new PurpleAirError('failed', err.message);
  }
  const { status, body, retryAfterMs } = answer;
  if (status === 429 || status >= 500) {
    throw new PurpleAirError('busy', `http ${status}`, { retryAfterMs });
  }
  if (status < 200 || status >= 300) {
    throw new PurpleAirError('failed', `http ${Number(status) || 0}`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PurpleAirError('invalid', 'not a PurpleAir answer');
  }
  return body;
}
