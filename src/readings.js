// -----------------------------------------------------------------------------
// PurpleAir documents -> plain values, and the Gladys devices and states built
// from them. Pure: no clock, no network.
//
// Local JSON page (`/json?live=false`): `SensorId` (the MAC), `Geo`,
// `place` (inside / outside), `current_temp_f`, `current_humidity`,
// `pressure`, and the particles of channel A (`pm2_5_atm`, `pm2_5_cf_1`...)
// and of channel B (same names + `_b`, two-laser sensors only).
// API (`/v1/sensors/<index>`): `pm2.5`, `pm10.0`, `pm1.0` (already the
// average of both channels, cf_1 for an indoor sensor, atm outdoors, as the
// API documents), `temperature` (°F), `humidity`, `pressure`.
//
// The feature key of a value (`pm25`, `aqi`...) is part of the external id:
// it never changes.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** A finite number, or null (never NaN, never undefined). */
export const num = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : null;

/** The own value of a key (never one inherited from a prototype). */
const own = (document, key) =>
  document && typeof document === 'object' && Object.hasOwn(document, key)
    ? document[key]
    : undefined;

const cleanText = (value, max) =>
  typeof value === 'string'
    ? [...value.slice(0, max * 4)]
        .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
        .join('')
        .trim()
        .slice(0, max)
    : '';

// --- US EPA AQI of PM2.5 (breakpoints of the 2024 revision) ----------------------

const AQI_BREAKPOINTS = [
  [0, 9.0, 0, 50],
  [9.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200],
  [125.5, 225.4, 201, 300],
  [225.5, 325.4, 301, 500],
];

/** The US AQI of a PM2.5 concentration (µg/m³), or null. */
export function aqiOf(pm25) {
  if (num(pm25) === null || pm25 < 0) {
    return null;
  }
  const c = Math.floor(pm25 * 10) / 10;
  if (c > 325.4) {
    return 500;
  }
  for (const [cl, ch, il, ih] of AQI_BREAKPOINTS) {
    if (c <= ch) {
      return Math.round(((ih - il) / (ch - cl)) * (Math.max(c, cl) - cl) + il);
    }
  }
  return 500;
}

// --- Kinds: Gladys category, type, unit and bounds ------------------------------
// Only the units the core lists for the category
// (DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js).

const particles = (category) => ({
  category,
  type: TYPES.SENSOR.DECIMAL,
  unit: UNITS.MICROGRAM_PER_CUBIC_METER,
  min: 0,
  max: 2000,
});

const KINDS = {
  pm25: particles(CAT.PM25_SENSOR),
  pm10: particles(CAT.PM10_SENSOR),
  aqi: {
    category: CAT.AIRQUALITY_SENSOR,
    type: TYPES.AIRQUALITY_SENSOR.AQI,
    unit: UNITS.AQI,
    min: 0,
    max: 500,
  },
  temperature: {
    category: CAT.TEMPERATURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.CELSIUS,
    min: -40,
    max: 85,
  },
  humidity: {
    category: CAT.HUMIDITY_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
  },
  pressure: {
    category: CAT.PRESSURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.HECTO_PASCAL,
    min: 300,
    max: 1100,
  },
};

/** [feature key, feature name]: the order of the features in Gladys. */
export const FIELDS = [
  ['pm25', 'PM2.5'],
  ['pm10', 'PM10'],
  ['aqi', 'AQI (US EPA, PM2.5)'],
  ['temperature', 'Temperature (sensor)'],
  ['humidity', 'Humidity (sensor)'],
  ['pressure', 'Pressure'],
];

const FIELD_NAMES = new Set(FIELDS.map(([field]) => field));

/** Keep a value only within the bounds of its feature (never clamped into a false reading). */
const within = (key, value) => {
  if (key === 'pm1') {
    return value !== null && value >= 0 && value <= 2000 ? value : null;
  }
  const kind = KINDS[key];
  return value !== null && Number.isFinite(value) && value >= kind.min && value <= kind.max
    ? value
    : null;
};

const fahrenheitToCelsius = (f) => (f === null ? null : round(((f - 32) * 5) / 9, 1));

/** The mean of channels A and B (one of them when the other is missing or out of bounds). */
const channels = (document, base) => {
  const values = [own(document, base), own(document, `${base}_b`)]
    .map(num)
    .filter((v) => v !== null && v >= 0 && v <= 2000);
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
};

/** { key: value } of the usable values: rounded, within bounds, no null. */
function finish(raw) {
  const values = {};
  for (const [key, value] of Object.entries(raw)) {
    const kept = within(key, value === null || value === undefined ? null : round(value, 1));
    if (kept !== null) {
      values[key] = kept;
    }
  }
  // The AQI of the PM2.5 kept, never of a value left out.
  const aqi = values.pm25 === undefined ? null : within('aqi', aqiOf(values.pm25));
  if (aqi !== null) {
    values.aqi = aqi;
  }
  return values;
}

/**
 * A local JSON page -> values. Indoor sensors (`place: inside`) use the
 * `cf_1` particles, outdoor ones the `atm` particles, as the API does.
 */
export function localValues(document) {
  if (!document || typeof document !== 'object') {
    return {};
  }
  const suffix = own(document, 'place') === 'inside' ? 'cf_1' : 'atm';
  return finish({
    pm1: channels(document, `pm1_0_${suffix}`),
    pm25: channels(document, `pm2_5_${suffix}`),
    pm10: channels(document, `pm10_0_${suffix}`),
    temperature: fahrenheitToCelsius(num(own(document, 'current_temp_f'))),
    humidity: num(own(document, 'current_humidity')),
    pressure: num(own(document, 'pressure')),
  });
}

/** The identity of a local sensor: its MAC and what it says of itself (not secret). */
export function localInfo(document, mac) {
  return {
    id: mac,
    name: cleanText(own(document, 'Geo'), 60),
    model: cleanText(own(document, 'hardwareversion'), 40),
    firmware: cleanText(own(document, 'version'), 40),
    place: own(document, 'place') === 'inside' ? 'inside' : 'outside',
  };
}

/** An API sensor -> values. */
export function cloudValues(sensor) {
  if (!sensor || typeof sensor !== 'object') {
    return {};
  }
  return finish({
    pm1: num(own(sensor, 'pm1.0')),
    pm25: num(own(sensor, 'pm2.5')),
    pm10: num(own(sensor, 'pm10.0')),
    temperature: fahrenheitToCelsius(num(own(sensor, 'temperature'))),
    humidity: num(own(sensor, 'humidity')),
    pressure: num(own(sensor, 'pressure')),
  });
}

/** The identity of an API sensor (not secret). */
export function cloudInfo(sensor, index) {
  return {
    id: String(index),
    name: cleanText(own(sensor, 'name'), 60),
    model: cleanText(own(sensor, 'model'), 40),
    firmware: '',
    place: '',
  };
}

/** The `last_seen` of an API sensor (ms), or null. */
export function lastSeenOf(sensor) {
  const seconds = num(own(sensor, 'last_seen'));
  return seconds === null || seconds <= 0 ? null : seconds * 1000;
}

// --- Gladys devices and states ------------------------------------------------------

const featureOf = (ids, field, name) => {
  const kind = KINDS[field];
  return {
    name,
    external_id: ids.feature(field),
    category: kind.category,
    type: kind.type,
    unit: kind.unit,
    min: kind.min,
    max: kind.max,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
};

/** The features of the device as the user created it (gladys.devices). */
export function createdFeatures(gladys, type, id) {
  const ids = gladys.externalIds(type, id);
  const device = (gladys.devices ?? []).find((d) => d.external_id === ids.device);
  return device?.features ?? [];
}

/**
 * The Gladys device of a sensor: every field it has ever given, plus every
 * feature of the device already created (so a value missing for a while, or
 * a field this version no longer knows, never removes a feature: the core
 * would mark the device as changed and "Update" would drop its history).
 */
export function deviceOf(gladys, { type, id, fields, name }) {
  const ids = gladys.externalIds(type, id);
  const created = createdFeatures(gladys, type, id);
  const createdIds = new Set(created.map((f) => f.external_id));
  const features = FIELDS.filter(
    ([field]) => fields.has(field) || createdIds.has(ids.feature(field)),
  ).map(([field, featureName]) => featureOf(ids, field, featureName));
  const prefix = `${ids.device}:`;
  for (const feature of created) {
    const field = String(feature.external_id ?? '').startsWith(prefix)
      ? feature.external_id.slice(prefix.length)
      : '';
    if (field && !FIELD_NAMES.has(field)) {
      features.push({
        name: feature.name,
        external_id: feature.external_id,
        category: feature.category,
        type: feature.type,
        ...(feature.unit ? { unit: feature.unit } : {}),
        min: feature.min,
        max: feature.max,
        read_only: true,
        has_feedback: false,
        keep_history: feature.keep_history !== false,
      });
    }
  }
  return {
    name,
    external_id: ids.device,
    // The integration reads the sensor at its own pace: Gladys has nothing to poll.
    should_poll: false,
    features,
  };
}

/** The states of the values, for the publishStates format (never NaN nor null). */
export function statesOf(gladys, type, id, values) {
  const ids = gladys.externalIds(type, id);
  return FIELDS.filter(([field]) => num(values?.[field]) !== null).map(([field]) => ({
    device_feature_external_id: ids.feature(field),
    state: values[field],
  }));
}
