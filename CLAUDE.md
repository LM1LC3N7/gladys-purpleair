# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It reads PurpleAir air quality sensors, read only: on the local network (the
JSON page of each sensor, free, recommended) or through the official API (an
API key, paid points), after aiopurpleair (MIT, Aaron Bach).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
node .github/scripts/cover.mjs            # draws cover.png
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        PurpleAirApp: sensors, due times, pauses, devices, states, status, test
src/purpleair.js                  the two reads (local /json, API /sensors/<index>), error kinds
src/readings.js                   documents -> values, AQI, devices, states (pure)
src/store.js                      pace, pauses and refusals persisted in /data (never a key)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/http.js                       fetch with timeout, no redirection, bounded body
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
.github/scripts/cover.mjs         draws cover.png with Node alone
```

## Rules

- **Read only.** Only `GET /json?live=false` on a sensor and
  `GET /v1/sensors/<index>` on the API, with the published fields only.
- **The API costs points.** Never read faster than the interval (60 min by
  default, 10 at least), whatever the path (button, Discovery, reconnection,
  restart); never ask more fields than published.
- **No key leaves where it belongs**: the API key only in the `X-API-Key`
  header to `api.purpleair.com`, the read key only in the query of that
  API; never in a log, an error, a status nor `/data` (only a salted scrypt
  fingerprint of a refused key, while refused). Never describe a secret
  field as "encrypted": Gladys keeps it in clear in its database
  (`test/manifest.test.js` checks the manifest and the docs).
- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`: the MAC of a local sensor, the
  sensor index in the cloud, never a label nor the address. The same goes
  for every key users store: manifest `config_schema`, `actions`, feature
  keys.
- **Units of the core only** (`DEVICE_FEATURE_UNITS_BY_CATEGORY`), and never
  drop a feature of a created device from the Discovery list.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (the first version, 0.1.0, was set by hand once, see TODO.md).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
