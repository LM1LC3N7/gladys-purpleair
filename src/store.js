// -----------------------------------------------------------------------------
// What must survive a restart of the container (a file under /data):
//
// - for each sensor (`local:<address>` or `cloud:<index>`): the instant of the
//   last request, the end of a pause (429/5xx) and of a refusal, so a
//   container restarting in a loop never reads a sensor (nor spends API
//   points) faster than the interval; and the identity and the fields of the
//   sensor (not secret), so the Discovery list is not empty after a restart;
// - for the API key: the end of a pause (429/5xx) and of a block (key
//   refused, no points left).
//
// No key is ever written. Only while a key is refused (the API key refused
// by the API, or a private sensor refused with its read key), the file keeps
// a salted scrypt fingerprint (16 bytes, a random salt per file) of that
// refused, wrong key, to know after a restart whether the refusal still
// concerns the configured one; it is erased by the first success. An account
// without points (402: the key was accepted) or an unknown index (404: the
// read key is not in question) keeps no fingerprint: their block simply ends
// at its time, or with a key changed while the process runs. Nothing in the
// file can confirm a key that works.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ATTEMPT_WRITE_GAP, LONGEST_INTERVAL } from './constants.js';

/** A storage in memory (tests, and the fallback). */
export function memoryStorage(initial) {
  let value = initial;
  let writes = 0;
  return {
    load: () => value,
    save: (next) => {
      writes += 1;
      value = JSON.parse(JSON.stringify(next));
    },
    writes: () => writes,
  };
}

/**
 * A JSON file, written atomically (a .tmp file, then a rename). A missing or
 * unreadable file is a first start (warned once, without its content); a
 * write failure is warned once: memory only then.
 */
export function fileStorage(path, { logger } = {}) {
  const warned = new Set();
  const warnOnce = (kind, text) => {
    if (!warned.has(kind)) {
      warned.add(kind);
      logger?.warn?.(text);
    }
  };
  return {
    load() {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          warnOnce('read', `State file unreadable (${err.code ?? 'error'}): starting afresh`);
        }
        return undefined;
      }
      if (text.length > 64 * 1024) {
        warnOnce('read', 'State file too large: starting afresh');
        return undefined;
      }
      try {
        return JSON.parse(text);
      } catch {
        warnOnce('read', 'State file corrupt: starting afresh');
        return undefined;
      }
    },
    save(value) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, path);
      } catch (err) {
        warnOnce('write', `State file not writable (${err.code ?? 'error'}): kept in memory`);
      }
    },
  };
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const cleanText = (value, max) =>
  typeof value === 'string'
    ? [...value.slice(0, max * 4)]
        .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
        .join('')
        .trim()
        .slice(0, max)
    : '';

const SOURCE_KEY = /^(local:[a-z0-9._:-]{1,260}|cloud:\d{1,9})$/;

/** The sensor identity read back from the file, or undefined when it does not look right. */
function infoOf(key, value) {
  const pattern = key.startsWith('local:') ? /^[0-9a-f]{12}$/ : /^\d{1,9}$/;
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') {
    return undefined;
  }
  if (!pattern.test(value.id)) {
    return undefined;
  }
  return {
    id: value.id,
    name: cleanText(value.name, 60),
    model: cleanText(value.model, 40),
    firmware: cleanText(value.firmware, 40),
    place: value.place === 'inside' || value.place === 'outside' ? value.place : '',
  };
}

const fieldsOf = (value) =>
  Array.isArray(value)
    ? value.filter((f) => typeof f === 'string' && /^[a-z0-9_]{1,40}$/.test(f)).slice(0, 20)
    : [];

const fpOf = (value, until, at) =>
  typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) && finite(until) > at ? value : '';

const EMPTY = Object.freeze({
  lastAttemptAt: 0,
  pausedUntil: 0,
  streak: 0,
  refusedUntil: 0,
  fp: '',
  info: undefined,
  fields: [],
});

const EMPTY_API = Object.freeze({
  pausedUntil: 0,
  streak: 0,
  blockedUntil: 0,
  blockKind: '',
  fp: '',
});

export class StateStore {
  constructor({ storage = memoryStorage(), now = Date.now, maxPause, maxRefusal }) {
    this.storage = storage;
    this.now = now;
    const saved = storage.load();
    const valid = saved && typeof saved === 'object' && !Array.isArray(saved);
    this.salt =
      valid && typeof saved.salt === 'string' && /^[0-9a-f]{32}$/.test(saved.salt)
        ? saved.salt
        : randomBytes(16).toString('hex');
    const at = now();
    // A time read back is capped (a request never "in the future", a pause
    // never longer than a fresh one): a clock that jumped, or a hand-edited
    // file, never stops a sensor for longer.
    const capPause = (v) => Math.min(finite(v), at + maxPause);
    const capRefusal = (v) => Math.min(finite(v), at + maxRefusal);
    /** key -> { lastAttemptAt, pausedUntil, streak, refusedUntil, fp, info, fields } */
    this.entries = new Map();
    const sources =
      valid && saved.sources && typeof saved.sources === 'object' ? saved.sources : {};
    for (const key of Object.keys(sources).slice(0, 20)) {
      const entry = sources[key];
      if (!SOURCE_KEY.test(key) || !entry || typeof entry !== 'object') {
        continue;
      }
      this.entries.set(key, {
        lastAttemptAt: Math.min(finite(entry.lastAttemptAt), at),
        pausedUntil: capPause(entry.pausedUntil),
        streak: Math.min(Math.max(0, Math.floor(finite(entry.streak))), 20),
        refusedUntil: capRefusal(entry.refusedUntil),
        fp: fpOf(entry.fp, entry.refusedUntil, at),
        info: infoOf(key, entry.info),
        fields: fieldsOf(entry.fields),
      });
    }
    const api = valid && saved.api && typeof saved.api === 'object' ? saved.api : {};
    this.api = {
      pausedUntil: capPause(api.pausedUntil),
      streak: Math.min(Math.max(0, Math.floor(finite(api.streak))), 20),
      blockedUntil: capRefusal(api.blockedUntil),
      blockKind: api.blockKind === 'refused' || api.blockKind === 'credits' ? api.blockKind : '',
      fp: fpOf(api.fp, api.blockedUntil, at),
    };
    if (!this.api.blockKind) {
      this.api.blockedUntil = 0;
      this.api.fp = '';
    }
    /** The credentials seen while the process runs: key -> credential. */
    this.credentials = new Map();
    this.apiKeySeen = undefined;
    this.lastAttemptWrite = -Infinity;
  }

  /** The salted fingerprint of a key (never the key). */
  fingerprint(scope, secret) {
    return scryptSync(String(secret), `${this.salt}:${scope}`, 16).toString('hex');
  }

  get(key) {
    return this.entries.get(key) ?? EMPTY;
  }

  /**
   * The saved state of a sensor for the configured credential (the read key
   * of a cloud sensor, '' otherwise). Another credential drops the refusal
   * and the instant of the last request (tried at once): told apart in
   * memory while the process runs; after a restart, only a refused
   * credential is known (its fingerprint). Returns `{ entry, changed }`.
   */
  restore(key, credential = '') {
    const entry = { ...EMPTY, ...this.entries.get(key) };
    let changed = false;
    if (this.credentials.has(key)) {
      changed = this.credentials.get(key) !== credential;
    } else if (entry.fp && entry.refusedUntil > this.now()) {
      changed = entry.fp !== this.fingerprint(key, credential);
    }
    this.credentials.set(key, credential);
    const before = JSON.stringify(entry);
    if (changed) {
      entry.refusedUntil = 0;
      entry.lastAttemptAt = 0;
    }
    if (entry.refusedUntil <= this.now()) {
      entry.fp = '';
    }
    this.entries.set(key, entry);
    if (JSON.stringify(entry) !== before) {
      this.save();
    }
    return { entry, changed };
  }

  /**
   * Update a sensor and write the file, only when something changed. A
   * refusal (`refusedUntil` > 0, with the refused `credential`) keeps the
   * fingerprint of that credential; anything else erases it.
   */
  update(key, changes, credential) {
    const entry = { ...EMPTY, ...this.entries.get(key) };
    const next = { ...entry, ...changes };
    if (changes.refusedUntil > 0 && credential !== undefined) {
      next.fp = this.fingerprint(key, credential);
    } else if (!(next.refusedUntil > this.now())) {
      next.fp = '';
    }
    this.entries.set(key, next);
    if (JSON.stringify(next) !== JSON.stringify(entry)) {
      this.save();
    }
    return next;
  }

  /**
   * Record the requests about to leave for these sensors, in one write. The
   * instant of the last request is written at most once per minute: false
   * (nothing recorded, nothing may leave) when the previous record is more
   * recent than that.
   */
  markAttempts(keys, at) {
    if (keys.length === 0) {
      return true;
    }
    if (at - this.lastAttemptWrite < ATTEMPT_WRITE_GAP) {
      return false;
    }
    for (const key of keys) {
      this.entries.set(key, { ...EMPTY, ...this.entries.get(key), lastAttemptAt: at });
    }
    this.lastAttemptWrite = at;
    this.save();
    return true;
  }

  /** When the next record of requests may be written. */
  nextAttemptWrite() {
    return this.lastAttemptWrite + ATTEMPT_WRITE_GAP;
  }

  /**
   * The state of the API key. Another key drops the block (refused, no
   * points), never a 429/5xx pause. Returns whether the key changed (then
   * the cloud sensors may be read at once).
   */
  restoreApi(apiKey) {
    let changed = false;
    if (this.apiKeySeen !== undefined) {
      changed = this.apiKeySeen !== apiKey;
    } else if (this.api.fp && this.api.blockedUntil > this.now()) {
      changed = this.api.fp !== this.fingerprint('api', apiKey);
    }
    this.apiKeySeen = apiKey;
    if (changed && this.api.blockKind) {
      this.updateApi({ blockedUntil: 0, blockKind: '' });
    } else if (this.api.blockedUntil <= this.now() && (this.api.fp || this.api.blockKind)) {
      this.updateApi({ blockedUntil: 0, blockKind: '' });
    }
    return changed;
  }

  /** Update the API key state; a block keeps the fingerprint of the blocked key. */
  updateApi(changes, apiKey) {
    const before = JSON.stringify(this.api);
    const next = { ...EMPTY_API, ...this.api, ...changes };
    if (changes.blockedUntil > 0 && apiKey !== undefined) {
      next.fp = this.fingerprint('api', apiKey);
    } else if (!(next.blockedUntil > this.now())) {
      next.fp = '';
      next.blockKind = '';
      next.blockedUntil = 0;
    }
    this.api = next;
    if (JSON.stringify(next) !== before) {
      this.save();
    }
    return next;
  }

  /**
   * Keep the configured sensors, and a sensor no longer configured only
   * while its pace, pause or refusal still holds (the longest interval of its
   * mode): a key mistyped then restored, an index cleared then entered again,
   * never reads sooner nor lifts a refusal. The credentials seen stay in
   * memory, so the same read key coming back is not "another key".
   */
  keep(keys) {
    const at = this.now();
    let changed = false;
    const removed = [];
    for (const [key, entry] of this.entries) {
      if (keys.includes(key)) {
        continue;
      }
      const longest = key.startsWith('cloud:') ? LONGEST_INTERVAL.cloud : LONGEST_INTERVAL.local;
      const until = Math.max(entry.lastAttemptAt + longest, entry.refusedUntil, entry.pausedUntil);
      if (until <= at) {
        this.entries.delete(key);
        changed = true;
      } else {
        removed.push([key, until]);
      }
    }
    // At most 20 entries in all (the file is read back with the same cap):
    // the removed sensors whose hold ends first go first.
    removed.sort((a, b) => a[1] - b[1]);
    while (this.entries.size > 20 && removed.length > 0) {
      this.entries.delete(removed.shift()[0]);
      changed = true;
    }
    if (changed) {
      this.save();
    }
  }

  save() {
    this.storage.save({
      salt: this.salt,
      sources: Object.fromEntries(this.entries),
      api: this.api,
    });
  }
}
