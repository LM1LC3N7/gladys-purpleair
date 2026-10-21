# TODO

## Before announcing

- [ ] Test on a real Gladys 5.1+ with a real PurpleAir sensor (local) and a
      real API key (cloud): the devices of the Discovery tab, their values,
      the status, the test button, a wrong key, an account without points.
      Never done yet.
- [ ] Check the CI (Docker build, Node 22 and 24), then run the store
      validator once the image is published. The validator was not run by
      the development agent (no access to it) and the Docker image was never
      built locally (no Docker on the development PC).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store.

## To confirm on a real device

- [ ] The keys of the local `/json` page of a recent firmware
      (`SensorId`, `Geo`, `place`, `current_temp_f`, `current_humidity`,
      `pressure`, `pm2_5_atm`, `pm2_5_cf_1` and their `_b` twins): taken
      from public descriptions of the page, not from aiopurpleair (which
      only knows the API).
- [ ] Whether `live=false` (2-minute averages) is honoured by every model
      (PA-I indoor, PA-II, Flex, Zen).
- [ ] The error codes of the API for a private sensor read without (or with
      a wrong) read key, and for an account without points (402
      `PaymentRequiredError` assumed).
- [ ] The cost in points of one call (8 fields, 10 at the first call).
- [ ] Whether the API's `pm2.5` already leaves a downgraded channel out
      (then `channel_flags` 1 or 2 could publish the healthy channel
      instead of nothing).

## Waiting for the Gladys core

- [ ] PM1 (shown by the test button only): no category in the core.
- [ ] The particle counts, the dew point, the VOC of the BME680 sensors
      (Flex): no matching category, or a skew of the room temperature.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-purpleair:0.1.0`);
  the first patch release gives 0.1.1.
- **aiopurpleair 2025.08.1 (MIT, Aaron Bach, used by Home Assistant) as the
  reference**, license read in its LICENSE file: base URL, key in the
  `X-API-Key` header, `GET /sensors/<index>` with `fields` and `read_key`,
  error codes (`ApiKeyInvalidError`, `ApiKeyMissingError`, `NotFoundError`),
  the sensor answer (test fixture). Ported to JavaScript, credited in the
  docs and in `THIRD_PARTY_NOTICES.md` with the whole MIT notice (copied
  into the image with `LICENSE`). The local `/json` page is not part of
  aiopurpleair: written from public descriptions (see above).
- **Read only**: only `GET /json?live=false` on a sensor and
  `GET /v1/sensors/<index>` on the API. No command, so no sensitive command.
  No `/keys` call (it is not needed).
- **No runtime dependency** besides the Gladys SDK.
- **Local mode recommended** (free, no account): the first field of the
  form, 2 minutes by default (2 to 60: the sensor averages over 2 minutes).
- **Cloud mode: long interval by default**: 60 minutes (10 to 1440), one call
  per sensor, only the fields used (never the sensor's own keys, which the
  API returns when asked for every field): `last_seen`, `channel_flags`,
  `pm1.0`, `pm2.5`, `pm10.0`, `temperature`, `humidity`, `pressure`; `name`
  and `model` only while the identity is unknown (first call, nothing in
  /data: review 1, M7). A renamed sensor keeps its first name in Gladys.
- **A/B check (review 1, I1)**: local mode, per particle size, when both
  channels are present and |A - B| >= 5 µg/m³ AND >= 70 % of their mean
  (the US EPA A/B quality check for PurpleAir), that size is not published
  for this read (nor the AQI with PM2.5); the status ("channels A/B
  disagree") and the button say so; one channel alone is published. Cloud
  mode: `channel_flags` asked (one field more); any downgraded channel (1,
  2 or 3) leaves PM1, PM2.5, PM10 and the AQI out, the same note shown
  (prudent: whether the API's mean already drops the bad channel is to
  confirm). A cloud sensor needs the API
  key; a sensor index without a key, a key that does not parse, a bad index
  or read key, an address entered twice are reported in the status by their
  slot only, never their content.
- **Secrets**: the API key and the read keys are `secret` fields, described
  as "kept by Gladys in its database, never shown again", never "encrypted".
  The API key travels only in the `X-API-Key` header of
  `https://api.purpleair.com`; the read key in the query string, as the API
  wants it. No URL, header nor answer `description` is ever logged: errors
  carry the host and a known error code only, messages are scrubbed of the
  keys as well. Never in `/data`: only, while a key is refused (the API key
  refused, or a private sensor refused with its read key), a salted scrypt
  fingerprint of that key (16 bytes, random salt per file), erased by the
  first success. Review 1, I2: no fingerprint for an account without points
  (402: the key was accepted) nor an unknown index (404: the read key is not
  in question); such a block ends at its time (6 h at most) or with a key
  changed while the process runs, and the button may try once the interval
  has passed.
- **External ids**: local `purpleair:<MAC>` (12 hex, from `SensorId`), cloud
  `purpleair-cloud:<sensor index>`, then the feature key (`pm25`, `pm10`,
  `aqi`, `temperature`, `humidity`, `pressure`). The same sensor read both
  ways gives two devices (the API does not give the MAC).
- **Identity checked at every read** (lot 11): the local values must carry a
  MAC; another MAC at the same address (DHCP swap) becomes its own device and
  nothing is published for the first one; an unreadable MAC is not "another
  sensor": nothing published, the known device kept. An API answer must
  carry the `sensor_index` asked. Two addresses giving the same MAC: only
  the first is published.
- **Categories and units of the core only** (`DEVICE_FEATURE_UNITS_BY_CATEGORY`,
  checked by `test/manifest.test.js` and the SDK's fake Gladys):
  `pm25-sensor` and `pm10-sensor`/µg/m³, `airquality-sensor`/aqi,
  `temperature-sensor`/celsius (converted from °F), `humidity-sensor`/percent,
  `pressure-sensor`/hPa.
- **Values**: PM from `atm` outdoors and `cf_1` indoors (the choice the API
  documents for its `pm2.5`), mean of channels A and B (one of them when
  the other is missing or out of bounds); US AQI of PM2.5 with the EPA
  breakpoints of 2024 (concentration truncated to 0.1, as the EPA does),
  computed the same way in both modes. Temperature and humidity published
  raw (the sensor heats itself: documented). A value out of the feature
  bounds is left out, never clamped; never NaN, null or undefined published;
  only own keys read (`Object.hasOwn`).
- **Features never lost**: the Discovery device holds every field ever read
  plus every feature of the created device (`gladys.devices`).
- **Pace (lot 11)**: nothing reads a sensor before its last request + the
  interval: not the test button (it answers with the last values and the
  time of the next possible read), the Discovery tab (no call), a
  reconnection, a saved configuration, a restart. A reconnection during a
  read does not start another one (one read at a time; the request was
  recorded before it left). Only a new address, index, read key or API key
  is read at once.
- **/data written at most once a minute for the request times**: the reads
  due at a tick (every minute) are recorded together, in one write, before
  they leave; a read that would need a second write within the minute waits
  for the next tick. Other writes happen only on a change (a pause, a
  refusal, a new identity or field).
- **Late answers**: an answer of an old configuration publishes nothing and
  sets no status (generation checked after every await); a 429/5xx met
  meanwhile is kept for the same sensor or key. Review 1, M1: when the
  sensor, its read key and the API key are unchanged (a reconnection), the
  answer, already paid, is kept in memory without being published; the
  current generation publishes it (start() publishes the states too).
- **Exact pace (review 1, M3)**: besides the minute tick, a timer fires 50 ms
  after the next due time, so a tick a millisecond early never turns 2
  minutes into 3; no tolerance ever reads before the due time.
- **Button (review 1, M4)**: "next read possible" counts the one write a
  minute of the request times.
- **Moved sensor (review 1, M5)**: a duplicate is only a sensor another
  address gives from a fresh read; an address still holding the identity
  from an old read loses it when the sensor answers elsewhere; never two
  devices with the same id.
- **Sources removed (review 1, M6)**: a sensor no longer configured keeps its
  entry in /data while its pace (the longest interval of its mode: 60 min
  local, 24 h cloud), pause or refusal holds (20 entries at most), so a key
  mistyped then restored makes no early paid call.
- **AQI (review 1, M2)**: computed on the unrounded PM2.5 (truncated to 0.1
  by aqiOf), the published PM2.5 rounded.
- **Errors**: a passing failure is retried at the interval, never sooner;
  429/5xx: pause (Retry-After, else 5 min doubling, 1 min - 6 h, never
  shorter than the interval), per sensor locally, for the whole API key in
  the cloud (the next cloud sensors of the same run are not tried); refused
  API key or no points (402): no cloud call for 6 hours or until the key
  changes, the local sensors carry on, the test button may try again once
  the interval has passed (never during a pause); unknown index (404) or a
  bare 401/403 (private sensor, wrong read key): that sensor only, 6 hours
  or until its read key changes. A cloud sensor not seen by PurpleAir for an
  hour is "offline": nothing published.
- **A reconnection to Gladys** (`connected`) keeps the pace, the pauses, the
  refusals and the identities; the status and the Discovery list are
  published again every time.
- **Bounded answers**: 64 KB, 10 s per request, one concatenation at the end
  (linear); no redirection followed. At most 6 sensors x 6 features per
  minute: far below the budget of 300 states a minute.

## Ideas

- An option to apply PurpleAir's suggested corrections (temperature - 8 °F,
  humidity + 4 %) or the US EPA correction of PM2.5 for wildfire smoke.
- Nearby sensors by coordinates (aiopurpleair `async_get_nearby_sensors`),
  if a user asks for it (it costs points for every sensor of the box).
