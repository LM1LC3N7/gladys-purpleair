// -----------------------------------------------------------------------------
// The only place that talks HTTP: `fetch` with a timeout, a User-Agent that
// names the integration, no redirection followed and a bounded body. The
// tests replace it with `setFetch()`.
//
// An error message carries the host of the URL only: never the path, the
// query (a read key travels there, as the API wants it) nor a header (the API
// key travels in X-API-Key).
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT, MAX_BODY, USER_AGENT } from './constants.js';

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Replace the fetch implementation (tests only). Returns the previous one. */
export function setFetch(impl) {
  const previous = fetchImpl;
  fetchImpl = impl;
  return previous;
}

/** Retry-After: seconds, or an HTTP date. */
export function retryAfterMs(header, now = Date.now()) {
  if (header === null || header === undefined || header === '') {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** The network failed (DNS, timeout, a body too large...): the host only. */
export class NetworkError extends Error {
  constructor(url, reason) {
    super(`network ${reason} on ${new URL(url).host}`);
    this.name = 'NetworkError';
    this.reason = reason;
  }
}

const reasonOf = (err) =>
  err?.name === 'TimeoutError' || err?.name === 'AbortError'
    ? 'timeout'
    : String(err?.cause?.code ?? 'failed')
        .replace(/[^A-Za-z0-9_ -]/g, '')
        .slice(0, 40);

/** Read at most `maxBytes` of the body; past it, the read stops and fails. */
async function readBounded(response, url, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new NetworkError(url, 'answer too large');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new NetworkError(url, 'answer too large');
    }
    chunks.push(value);
  }
  // One concatenation at the end: linear in the size of the answer.
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * GET a JSON document. Never throws on an HTTP status: resolves
 * `{ status, body, retryAfterMs }`, `body` being the parsed JSON or
 * undefined. Throws a NetworkError when the request or the body read fails.
 * A redirection fails the call.
 */
export async function getJson(
  url,
  { headers = {}, timeout = HTTP_TIMEOUT, maxBytes = MAX_BODY } = {},
) {
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, timeout)),
    });
    text = await readBounded(response, url, maxBytes);
  } catch (err) {
    throw err instanceof NetworkError ? err : new NetworkError(url, reasonOf(err));
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return {
    status: response.status,
    body,
    retryAfterMs: retryAfterMs(response.headers?.get?.('retry-after')),
  };
}
