// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized so
// the rest of the code never deals with strings or `undefined`.
// -----------------------------------------------------------------------------

import { MAX_CLOUD, MAX_LOCAL } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest
// (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  local_interval: 2,
  cloud_interval: 60,
};

/** Bounds of the intervals (minutes): the sensor averages over 2 minutes. */
export const LOCAL_BOUNDS = [2, 60];
/** The API charges points per call: never more often than every 10 minutes. */
export const CLOUD_BOUNDS = [10, 1440];

const number = (value, fallback, [min, max]) => {
  const n = Number(value);
  return value !== '' && value !== null && value !== undefined && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback;
};

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,62})$/;

/**
 * The address of a sensor as the user may type it: an IPv4 address or a host
 * name, with an optional port. A leading `http://` and a trailing `/` (or
 * `/json`) are tolerated; anything else (a path, credentials, IPv6) is
 * refused. Returns the `host[:port]`, or null.
 */
export function parseAddress(text) {
  let value = clean(text)
    .replace(/^https?:\/\//i, '')
    .replace(/\/json$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!value) {
    return null;
  }
  let port = '';
  const colon = value.lastIndexOf(':');
  if (colon !== -1) {
    port = value.slice(colon + 1);
    value = value.slice(0, colon);
    const n = Number(port);
    if (!/^\d{1,5}$/.test(port) || n < 1 || n > 65535) {
      return null;
    }
    port = `:${n}`;
  }
  if (value.length > 253) {
    return null;
  }
  const labels = value.split('.');
  const ok = IPV4.test(value) || (!/^[\d.]+$/.test(value) && labels.every((l) => LABEL.test(l)));
  return ok ? `${value}${port}` : null;
}

/** A sensor index of the PurpleAir map: a positive integer. */
export function parseIndex(text) {
  const value = clean(String(text ?? ''));
  if (!/^\d{1,9}$/.test(value)) {
    return null;
  }
  const n = Number(value);
  return n > 0 ? n : null;
}

/** An API key (a UUID) or a read key: letters, digits and dashes only. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;

/**
 * The sensors of the configuration: `local_<n>_address`, and `api_key` with
 * `cloud_<n>_sensor` (+ `cloud_<n>_read_key` for a private sensor). A slot
 * that does not parse is reported by its number only, never its content.
 */
export function normalizeConfig(raw = {}) {
  const local = [];
  const cloud = [];
  const invalid = [];
  const seen = new Set();
  for (let n = 1; n <= MAX_LOCAL; n += 1) {
    const text = clean(raw[`local_${n}_address`]);
    if (!text) {
      continue;
    }
    const address = parseAddress(text);
    if (!address) {
      invalid.push({ slot: `local ${n}`, why: 'address' });
      continue;
    }
    if (seen.has(address)) {
      invalid.push({ slot: `local ${n}`, why: 'duplicate' });
      continue;
    }
    seen.add(address);
    local.push({ slot: n, key: `local:${address}`, address });
  }
  const apiKey = clean(raw.api_key);
  let apiKeyValid = false;
  if (apiKey) {
    apiKeyValid = KEY.test(apiKey);
    if (!apiKeyValid) {
      invalid.push({ slot: 'API', why: 'key' });
    }
  }
  const indexes = new Set();
  for (let n = 1; n <= MAX_CLOUD; n += 1) {
    const text = clean(String(raw[`cloud_${n}_sensor`] ?? ''));
    if (!text) {
      continue;
    }
    const index = parseIndex(text);
    const readKey = clean(raw[`cloud_${n}_read_key`]);
    if (!index) {
      invalid.push({ slot: `cloud ${n}`, why: 'index' });
      continue;
    }
    if (readKey && !KEY.test(readKey)) {
      invalid.push({ slot: `cloud ${n}`, why: 'readKey' });
      continue;
    }
    if (indexes.has(index)) {
      invalid.push({ slot: `cloud ${n}`, why: 'duplicate' });
      continue;
    }
    if (!apiKey) {
      invalid.push({ slot: `cloud ${n}`, why: 'noKey' });
      continue;
    }
    if (!apiKeyValid) {
      continue;
    }
    indexes.add(index);
    cloud.push({ slot: n, key: `cloud:${index}`, index, readKey });
  }
  return {
    local,
    cloud,
    apiKey: apiKeyValid ? apiKey : '',
    invalid,
    localMinutes: number(raw.local_interval, DEFAULT_CONFIG.local_interval, LOCAL_BOUNDS),
    cloudMinutes: number(raw.cloud_interval, DEFAULT_CONFIG.cloud_interval, CLOUD_BOUNDS),
  };
}
