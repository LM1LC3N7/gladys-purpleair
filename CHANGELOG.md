# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- PurpleAir sensors read on the local network (`/json?live=false`, up to
  three, every 2 minutes by default): PM2.5, PM10, US AQI (EPA 2024, from
  PM2.5), temperature, humidity and pressure, read only.
- PurpleAir sensors read through the official API (up to three, with an API
  key and the read key of a private sensor): every 60 minutes by default (10
  at least), only the published fields asked.
- Nothing reads a sensor sooner than its interval (test button, Discovery,
  reconnection, saved configuration, restart); 429/5xx pauses, refused keys
  and accounts without points kept in `/data`, never a key.
- A test button with the last values and the time of the next possible read.
- A/B check of the two lasers: when they disagree (5 µg/m³ and 70 % of the
  mean, the US EPA check), the particles and the AQI of that read are not
  published and the status says so; in cloud mode, PurpleAir's
  `channel_flags` does the same.
- Cloud: the name and the model are asked only at the first call (fewer
  points per call).

### Fixed

- No fingerprint of an accepted key in `/data`: an account without points
  (402) or an unknown sensor index (404) no longer keeps one.
- A paid answer that arrives during a reconnection, same configuration, is
  kept and published instead of thrown away.
- The AQI is computed on the unrounded PM2.5 (truncated as the EPA does).
- The 2-minute pace no longer slips to 3 minutes: a timer at the due time.
- The test button never shows a next read at a time already past.
- A sensor moved to another configured address is published from there.
- A key or a sensor removed by mistake and put back keeps its pace and its
  refusal (no early paid call).

[Unreleased]: https://github.com/LM1LC3N7/gladys-purpleair/commits/main
