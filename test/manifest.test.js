// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. They also guard
// the text files against mojibake, a BOM and control characters (a manifest
// once shipped broken), and the texts against the word "encrypted" for a
// secret field (Gladys keeps a secret in clear in its database).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS, DEVICE_TYPE, MAX_CLOUD, MAX_LOCAL } from '../src/constants.js';
import { CLOUD_BOUNDS, DEFAULT_CONFIG, LOCAL_BOUNDS } from '../src/config.js';
import { FIELDS, deviceOf } from '../src/readings.js';

const readBuffer = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const read = (path) => readBuffer(path).toString('utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

const USER_DOCS = ['docs/en.md', 'docs/fr.md', 'README.md', 'CHANGELOG.md'];

// Built from code points, so this file holds none of them and can check itself.
const chr = (...codes) => String.fromCharCode(...codes);
const REPLACEMENT = chr(0xfffd);
const MOJIBAKE = [chr(0xc3), chr(0xc2), chr(0xe2, 0x20ac)];
const CONTROL = new RegExp(
  `[${chr(0)}-${chr(8)}${chr(0x0b, 0x0c)}${chr(0x0e)}-${chr(0x1f, 0x7f)}]`,
);
const COMBINING = new RegExp(`[${chr(0x300)}-${chr(0x36f)}]`);

const listJs = (dir) =>
  readdirSync(new URL(`../${dir}/`, import.meta.url))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `${dir}/${name}`);

test('no mojibake, no BOM and no control character in the text files', () => {
  const files = [
    'gladys-assistant-integration.json',
    ...USER_DOCS,
    'TODO.md',
    'CLAUDE.md',
    'THIRD_PARTY_NOTICES.md',
    'Dockerfile',
    'package.json',
    'index.js',
    '.github/scripts/cover.mjs',
    'test/fixtures/local.json',
    'test/fixtures/cloud.json',
    ...listJs('src'),
    ...listJs('test'),
  ];
  assert.ok(files.length > 20, 'every source file is checked');
  for (const file of files) {
    const buffer = readBuffer(file);
    assert.ok(
      !(buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf),
      `${file} starts with a BOM`,
    );
    const text = buffer.toString('utf8');
    assert.ok(!text.includes(REPLACEMENT), `${file} holds an invalid UTF-8 sequence`);
    for (const bad of MOJIBAKE) {
      assert.ok(!text.includes(bad), `${file} holds mojibake`);
    }
    assert.doesNotMatch(text, CONTROL, `${file} holds a control character`);
    assert.doesNotMatch(text, COMBINING, `${file} holds a bare combining mark`);
  }
  assert.match(read('docs/fr.md'), /é/);
  assert.match(manifest.config_schema[0].description.fr, /qualité|réseau/);
});

test('a secret is never said "encrypted" ("chiffré") to the user', () => {
  for (const [path, text] of texts(manifest)) {
    assert.doesNotMatch(`${text.en} ${text.fr}`, /encrypt|chiffr/i, path);
  }
  for (const file of USER_DOCS) {
    assert.doesNotMatch(read(file), /encrypt|chiffr/i, file);
  }
});

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.deepEqual(manifest.transports, ['local', 'cloud']);
  assert.match(manifest.gladys_version, />=5\.1\.0/);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /aiopurpleair/, `docs/${lang}.md credits aiopurpleair`);
  }
  assert.match(read('docs/en.md'), /never been tested with a real PurpleAir/i);
  assert.match(read('docs/fr.md'), /jamais été testée avec un vrai capteur PurpleAir/i);
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /non officiel/);
  assert.match(manifest.config_schema[0].description.en, /not affiliated with PurpleAir/);
  assert.match(manifest.config_schema[0].description.en, /Local mode is recommended/);
});

test('version 0.1.0 everywhere, and the image is tagged with it', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-purpleair:${manifest.version}`);
});

test('the license and the notices ship with the image', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'no personal name');
  assert.equal(pkg.license, 'Apache-2.0');
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /aiopurpleair/);
  assert.match(notices, /Copyright \(c\) 2024 Aaron Bach/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(notices, /THE SOFTWARE IS PROVIDED "AS IS"/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY .*LICENSE/);
  assert.match(dockerfile, /COPY .*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('sections are purely presentational, with https links', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang} is too long`);
    }
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.equal(fields[key]?.default, value, key);
  }
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[field.key], field.default, field.key);
    }
  }
  for (let n = 1; n <= MAX_LOCAL; n += 1) {
    assert.equal(fields[`local_${n}_address`].type, 'string');
  }
  assert.equal(fields[`local_${MAX_LOCAL + 1}_address`], undefined);
  const secrets = ['api_key'];
  for (let n = 1; n <= MAX_CLOUD; n += 1) {
    assert.equal(fields[`cloud_${n}_sensor`].type, 'string');
    secrets.push(`cloud_${n}_read_key`);
  }
  assert.equal(fields[`cloud_${MAX_CLOUD + 1}_sensor`], undefined);
  for (const key of secrets) {
    assert.equal(fields[key].type, 'secret', `${key} is masked, never shown again`);
    assert.match(fields[key].description.en, /Kept by Gladys in its database, never shown again/);
    assert.match(fields[key].description.fr, /Gardée par Gladys dans sa base, jamais réaffichée/);
  }
  assert.deepEqual([fields.local_interval.min, fields.local_interval.max], LOCAL_BOUNDS);
  assert.deepEqual([fields.cloud_interval.min, fields.cloud_interval.max], CLOUD_BOUNDS);
  assert.ok(DEFAULT_CONFIG.cloud_interval >= 60, 'the paid API is read rarely by default');
});

test('the keys of the manifest are the keys of the code; read only', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(manifest.actions[0].timeout_seconds <= 120);
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
  assert.ok(!index.includes('onSetValue'), 'no command: read only');
});

// DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js (Gladys core),
// for the categories this integration uses.
const CORE_UNITS = {
  'pm25-sensor': [
    'milligram-per-cubic-meter',
    'microgram-per-cubic-meter',
    'nanogram-per-cubic-meter',
  ],
  'pm10-sensor': ['microgram-per-cubic-meter', 'nanogram-per-cubic-meter'],
  'airquality-sensor': ['aqi'],
  'temperature-sensor': ['celsius', 'fahrenheit', 'kelvin'],
  'humidity-sensor': ['percent'],
  'pressure-sensor': ['pascal', 'hPa', 'kPa', 'bar', 'psi', 'milli-bar'],
};

test('every feature uses a unit the core lists for its category', async () => {
  const gladys = createFakeGladys({ selector: 'purpleair' });
  await gladys.connect();
  for (const [type, id] of [
    [DEVICE_TYPE.LOCAL, '84f3eb7bc8ee'],
    [DEVICE_TYPE.CLOUD, '131075'],
  ]) {
    const device = deviceOf(gladys, {
      type,
      id,
      fields: new Set(FIELDS.map(([field]) => field)),
      name: 'X',
    });
    assert.equal(device.features.length, FIELDS.length);
    for (const feature of device.features) {
      assert.ok(feature.category in CORE_UNITS, `${feature.category} is not checked`);
      assert.ok(
        CORE_UNITS[feature.category].includes(feature.unit),
        `${feature.external_id}: ${feature.unit}`,
      );
    }
    // The fake Gladys refuses what the host API refuses.
    await gladys.publishDiscoveredDevices([device]);
  }
});
