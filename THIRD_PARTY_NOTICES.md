# Third-party notices

This integration is licensed under Apache-2.0 (see `LICENSE`). It ports to
JavaScript parts of the following project.

## aiopurpleair

- Project: https://github.com/bachya/aiopurpleair (version 2025.8.1, the
  library used by Home Assistant)
- Author: Aaron Bach
- Ported: the API client (`aiopurpleair/api.py`: the base URL
  `https://api.purpleair.com/v1`, the API key sent in the `X-API-Key`
  header), the sensor endpoint (`aiopurpleair/endpoints/sensors.py`:
  `GET /sensors/<index>` with `fields` and `read_key`), the error codes of
  the API (`aiopurpleair/errors.py`: `ApiKeyInvalidError`,
  `ApiKeyMissingError`, `NotFoundError`) and the shape of a sensor answer
  (`tests/fixtures/get_sensor_response.json`, used for a test fixture).
- Changes: rewritten in JavaScript on Node's `fetch`; only the fields
  published are asked (the API charges points per field); answers bounded
  in size; the keys never logged; the local JSON page of the sensors added
  (not part of aiopurpleair).
- License: MIT, reproduced below.

```
MIT License

Copyright (c) 2024 Aaron Bach

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
