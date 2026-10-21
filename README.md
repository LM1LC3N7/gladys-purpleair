# gladys-purpleair

Unofficial [Gladys Assistant](https://gladysassistant.com) external integration
for [PurpleAir](https://www2.purpleair.com/) air quality sensors: PM2.5, PM10,
the US AQI computed from PM2.5, and the temperature, humidity and pressure
measured inside the sensor. Read only.

- **Local mode (recommended)**: the JSON page every sensor serves on your
  network. Free, no account. Every 2 minutes by default.
- **Cloud mode (optional)**: the official PurpleAir API, with your API key.
  Each call costs points (paid credits): every 60 minutes by default, 10 at
  least.

Never tested with a real sensor nor a real API key yet.

Documentation: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
```

No runtime dependency besides the Gladys SDK. See `CLAUDE.md` for the rules
of the project and `TODO.md` for the decisions.

## Credits

The cloud client follows [aiopurpleair](https://github.com/bachya/aiopurpleair)
(MIT, Aaron Bach). See `THIRD_PARTY_NOTICES.md`.

## License

Apache-2.0, see `LICENSE`.
