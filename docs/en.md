# PurpleAir for Gladys Assistant

Unofficial connector, not affiliated with PurpleAir, Inc. It brings the
readings of your [PurpleAir](https://www2.purpleair.com/) air quality sensors
into Gladys, read only: nothing is ever changed on a sensor.

> This integration has never been tested with a real PurpleAir sensor nor a
> real API key yet. Your feedback is welcome on the Gladys forum.

## What you get

For each sensor, a device in the Discovery tab with:

| Feature                     | Category           | Unit  |
| --------------------------- | ------------------ | ----- |
| PM2.5                       | PM2.5 sensor       | µg/m³ |
| PM10                        | PM10 sensor        | µg/m³ |
| AQI (US EPA, PM2.5)         | Air quality sensor | AQI   |
| Temperature (sensor)        | Temperature sensor | °C    |
| Humidity (sensor)           | Humidity sensor    | %     |
| Pressure (sensors with BME) | Pressure sensor    | hPa   |

- PM2.5 and PM10: the mean of the two lasers (channels A and B) when the
  sensor has two; the `ATM` correction outdoors, `CF=1` indoors, as the
  PurpleAir API does.
- AQI: the US EPA index computed from the current PM2.5 with the
  breakpoints of the 2024 revision (indicative: the official index uses
  24-hour averages).
- Temperature and humidity are measured **inside the sensor**: the
  temperature reads a few degrees above the outdoor air, the humidity a
  few points below. They are published as measured, without correction.
- A/B check: when the two lasers disagree (a gap of 5 µg/m³ or more AND
  70 % or more of their mean, the US EPA quality check for PurpleAir), a
  laser is probably failing: the particles (and the AQI) of that read are
  not published, the status and the test button say "channels A/B
  disagree"; temperature, humidity and pressure still are. In cloud mode,
  PurpleAir's own `channel_flags` does the same (any downgraded channel).
- PM1 is shown by the test button but not published: Gladys has no PM1
  category yet.

## Local mode (recommended, free)

Every PurpleAir sensor serves its readings on your network
(`http://<sensor address>/json`). No account, no key, no cost.

1. Give the sensor a fixed IP address in your router (DHCP reservation).
2. Enter that address in "Sensor address (local)" (up to three sensors).
3. Keep the default interval of 2 minutes (the sensor averages over 2
   minutes), or choose up to 60.

The integration recognizes a sensor by its MAC address: if the router gives
its address to another sensor, that one becomes a new device and the first
one gets no value from it.

## Cloud mode (optional, paid)

For a sensor out of your network (a neighbour's sensor on the map, a sensor
at another house). The official PurpleAir API charges **points** for each
call, bought from PurpleAir.

1. Create an API key in [develop.purpleair.com](https://develop.purpleair.com/)
   (a **READ** key) and enter it in "API key (read)".
2. Find the sensor index on the [PurpleAir map](https://map.purpleair.com/):
   click the sensor, the number after `select=` in the link is its index.
3. For a private sensor, also enter its read key.
4. The interval is **60 minutes by default** (10 minutes at least): each call
   costs points for each field asked. Only the fields used are asked (last
   seen, channel flags, PM1, PM2.5, PM10, temperature, humidity, pressure;
   the name and the model only at the first call, they never change).
   Removing a sensor or the key by mistake and putting it back does not
   make an early call.

The API key is kept by Gladys in its database, never shown again, and sent
only to the PurpleAir API (`api.purpleair.com`) in a header, never in a link
nor in the logs. The read key of a private sensor is kept the same way; the
API wants it in the request link, which is never logged.

## Pace and errors

- Nothing reads a sensor (nor calls the API) sooner than its interval: not
  the test button, nor the Discovery tab, nor a reconnection, nor a saved
  configuration, nor a restart of the container. The time of the last
  request is kept in `/data` (written at most once a minute).
- A sensor or the API answering 429 or 5xx: a pause (Retry-After, else 5
  minutes doubling, 1 minute to 6 hours), kept across restarts; the test
  button waits for it too.
- A refused API key, or an account without points: no cloud call for 6
  hours (or until you change the key); the test button tries again once the
  interval has passed. The local sensors carry on.
- An unknown sensor index or a refused private sensor: no call for that
  sensor for 6 hours (or until its read key changes).
- A cloud sensor that PurpleAir has not heard from for an hour publishes
  nothing ("offline").

## Test button

"Test the sensors" reads each sensor whose interval has passed and shows
the last values (PM1 included) and the time of the next possible read.

## Credits

The cloud client follows [aiopurpleair](https://github.com/bachya/aiopurpleair)
(MIT, Aaron Bach), the library Home Assistant uses: endpoint, header of the
key, error codes. See `THIRD_PARTY_NOTICES.md`.
