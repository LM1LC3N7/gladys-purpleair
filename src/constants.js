// -----------------------------------------------------------------------------
// Limits, pacing and the keys users store (manifest keys, device types): the
// keys are forever, never rename them.
// -----------------------------------------------------------------------------

export const USER_AGENT = 'gladys-purpleair (+https://github.com/LM1LC3N7/gladys-purpleair)';

/** The official PurpleAir API (the key goes in the X-API-Key header, never in a URL). */
export const API_URL = 'https://api.purpleair.com/v1';

/**
 * The fields asked to the API for a sensor. PurpleAir charges points per
 * field and per sensor: only what is used, never the sensor's own keys.
 * `channel_flags` tells a failing laser (the A/B check of the local mode).
 */
export const CLOUD_FIELDS = [
  'last_seen',
  'channel_flags',
  'pm1.0',
  'pm2.5',
  'pm10.0',
  'temperature',
  'humidity',
  'pressure',
];

/**
 * Asked only while the identity of the sensor is not known yet (first call,
 * nothing in /data): they never change, and each field costs points.
 */
export const CLOUD_IDENTITY_FIELDS = ['name', 'model'];

/** The longest interval of each mode, so a sensor removed by mistake keeps its pace. */
export const LONGEST_INTERVAL = { local: 60 * 60_000, cloud: 1440 * 60_000 };

/** One HTTP call (a sensor on the local network, or the API). */
export const HTTP_TIMEOUT = 10_000;

/** The most an answer may weigh (2 to 4 KB in practice). */
export const MAX_BODY = 64 * 1024;

/** At most this many sensors read on the local network, and through the API. */
export const MAX_LOCAL = 3;
export const MAX_CLOUD = 3;

/** How often the integration checks what is due. */
export const TICK = 60_000;

/**
 * The instant of the last request is written to /data at most once per
 * minute: the reads due at the same tick are recorded together, and a read
 * that would need a second write within the minute waits for the next tick.
 */
export const ATTEMPT_WRITE_GAP = 60_000;

/**
 * 429 or 5xx (a sensor busy, the API overloaded): a pause, from Retry-After
 * when given, else 5 minutes doubling; always between 1 minute and 6 hours.
 */
export const BUSY_MIN = 60_000;
export const BUSY_BASE = 5 * 60_000;
export const BUSY_MAX = 6 * 60 * 60_000;

/**
 * A refused API key, an account without points, a sensor the API refuses or
 * does not know: no periodic call for 6 hours (or until the key changes).
 */
export const REFUSED_BACKOFF = 6 * 60 * 60_000;

/** A local value read longer ago than this is not published as current. */
export const STALE = 15 * 60_000;

/** A sensor the API has not heard from for this long is offline. */
export const CLOUD_OFFLINE = 60 * 60_000;

/** An unchanged value is re-sent this often, so Gladys keeps it recent. */
export const HEARTBEAT = 30 * 60_000;

/** The test button answers within this, with the last values if needed. */
export const TEST_DEADLINE = 100_000;

/** Where the pace, the pauses and the refusals survive a restart. */
export const STATE_FILE = '/data/purpleair-state.json';

/** Device types of the external ids. */
export const DEVICE_TYPE = {
  LOCAL: 'purpleair', // ext:<selector>:purpleair:<MAC, 12 hex>
  CLOUD: 'purpleair-cloud', // ext:<selector>:purpleair-cloud:<sensor index>
};

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};
