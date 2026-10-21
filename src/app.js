// -----------------------------------------------------------------------------
// The integration itself: the sensors to read (on the local network and
// through the API), when each is due, the pauses and refusals, the Gladys
// devices and states built from the readings, the connection status and the
// test button. index.js only wires the SDK handlers to it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  BUSY_BASE,
  BUSY_MAX,
  BUSY_MIN,
  CLOUD_OFFLINE,
  DEVICE_TYPE,
  HEARTBEAT,
  REFUSED_BACKOFF,
  STALE,
  TEST_DEADLINE,
  TICK,
} from './constants.js';
import { T, reason } from './i18n.js';
import { PurpleAirError, macOf, readCloud, readLocal } from './purpleair.js';
import {
  cloudInfo,
  cloudReading,
  createdFeatures,
  deviceOf,
  lastSeenOf,
  localInfo,
  localReading,
  statesOf,
} from './readings.js';
import { StateStore, memoryStorage } from './store.js';

const defaultTimers = { setInterval, clearInterval, setTimeout, clearTimeout };

/** 12.54 -> "12.5", "12,5" in French. */
const numberText = (value, lang) => {
  const text = String(Math.round(value * 10) / 10);
  return lang === 'fr' ? text.replace('.', ',') : text;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** A wake timer fires this long after the due time (never before it). */
const WAKE_MARGIN = 50;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class PurpleAirApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'purpleair' }),
    now = Date.now,
    timers = defaultTimers,
    storage = memoryStorage(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.config = normalizeConfig();
    // The pauses and refusals live as long as the process, across restarts
    // of the app and reconnections to Gladys, and in /data across restarts
    // of the container.
    this.store = new StateStore({
      storage,
      now,
      maxPause: BUSY_MAX,
      maxRefusal: REFUSED_BACKOFF,
    });
    /** The configured sensors: [{ kind, slot, key, address | index, readKey }]. */
    this.sources = [];
    /** key -> { info, values, readAt, fields, nextDue, error } */
    this.track = new Map();
    this.interval = undefined;
    this.ticking = undefined;
    this.chain = Promise.resolve();
    this.lastDiscovered = undefined;
    this.lastStatus = undefined;
    this.generation = 0;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = ++this.generation;
    this.config = normalizeConfig(raw);
    this.sources = [
      ...this.config.local.map((s) => ({ ...s, kind: 'local' })),
      ...this.config.cloud.map((s) => ({ ...s, kind: 'cloud' })),
    ];
    const keys = this.sources.map((s) => s.key);
    for (const key of [...this.track.keys()]) {
      if (!keys.includes(key)) {
        this.track.delete(key);
      }
    }
    this.store.keep(keys);
    // Another API key may be read at once; the same key (a reconnection, a
    // restart, a saved configuration) keeps the pace and the block.
    const keyChanged = this.config.apiKey ? this.store.restoreApi(this.config.apiKey) : false;
    for (const source of this.sources) {
      const { entry: saved } = this.store.restore(source.key, source.readKey ?? '');
      if (keyChanged && source.kind === 'cloud') {
        this.store.update(source.key, { lastAttemptAt: 0 });
      }
      let entry = this.track.get(source.key);
      if (!entry) {
        // After a restart: the sensor known before (id, name, fields, not
        // secret) keeps the Discovery list filled until the next read.
        entry = { fields: new Set(saved.fields), info: saved.info, nextDue: 0 };
        this.track.set(source.key, entry);
      }
      // After a restart, the status says at once that a sensor is refused
      // or paused, without asking it.
      const blocked = this.blockOf(source);
      if (!entry.error && blocked) {
        entry.error = new PurpleAirError(blocked);
      }
      entry.nextDue = this.earliestRead(source);
    }
    // Gladys keeps the status and the Discovery list in memory only: a
    // (re)connection may follow a restart of the core, so both are published
    // again even when nothing changed.
    this.lastStatus = undefined;
    this.lastDiscovered = undefined;
    await this.tick();
    if (generation !== this.generation) {
      return;
    }
    this.interval = this.timers.setInterval(
      () => this.tick().catch((err) => this.logger.warn(`Refresh failed: ${this.scrub(err)}`)),
      TICK,
    );
    this.scheduleWake();
    // The states too: values kept from a read that finished during the
    // reconnection (same sensor, same keys) are published now.
    await this.publish();
    await this.refreshStatus();
  }

  stop() {
    this.generation += 1;
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
    this.clearWake();
  }

  clearWake() {
    if (this.wake !== undefined) {
      this.timers.clearTimeout(this.wake);
      this.wake = undefined;
    }
  }

  /**
   * A timer at the next due read, so a 2-minute pace stays 2 minutes: the
   * minute tick alone may come a millisecond before the due time and wait a
   * whole tick more. The read still never goes before its due time.
   */
  scheduleWake() {
    this.clearWake();
    if (this.interval === undefined) {
      return;
    }
    const now = this.now();
    let next = Infinity;
    for (const source of this.sources) {
      const entry = this.track.get(source.key);
      if (entry && entry.nextDue > now) {
        next = Math.min(next, entry.nextDue);
      }
    }
    if (!Number.isFinite(next)) {
      return;
    }
    const delay = Math.min(next - now + WAKE_MARGIN, 2 ** 31 - 1);
    this.wake = this.timers.setTimeout(() => {
      this.wake = undefined;
      return this.tick().catch((err) => this.logger.warn(`Refresh failed: ${this.scrub(err)}`));
    }, delay);
  }

  /** An error message without any key. */
  scrub(err) {
    let message = String(err?.message ?? err);
    const secrets = [this.config.apiKey, ...this.sources.map((s) => s.readKey)].filter(
      (s) => typeof s === 'string' && s.length >= 4,
    );
    for (const secret of secrets) {
      message = message.replace(new RegExp(escapeRegExp(secret), 'gi'), '***');
    }
    return message;
  }

  /** Run `fn` after every read already queued: never two reads at once. */
  exclusive(fn) {
    const run = this.chain.catch(() => {}).then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // --- Pace -----------------------------------------------------------------------

  intervalMs(source) {
    return (source.kind === 'cloud' ? this.config.cloudMinutes : this.config.localMinutes) * 60_000;
  }

  /** What stops a sensor now (a kind), or undefined. */
  blockOf(source) {
    const now = this.now();
    const saved = this.store.get(source.key);
    if (source.kind === 'cloud') {
      const api = this.store.api;
      if (api.blockedUntil > now && api.blockKind) {
        return api.blockKind;
      }
      if (api.pausedUntil > now) {
        return 'busy';
      }
    }
    if (saved.refusedUntil > now) {
      return 'denied';
    }
    if (saved.pausedUntil > now) {
      return 'busy';
    }
    return undefined;
  }

  /** The end of every pause that holds even for the test button. */
  pausedUntil(source) {
    const saved = this.store.get(source.key);
    return Math.max(saved.pausedUntil, source.kind === 'cloud' ? this.store.api.pausedUntil : 0);
  }

  /** The end of every refusal (the test button may try again before it). */
  refusedUntil(source) {
    const saved = this.store.get(source.key);
    return Math.max(
      saved.refusedUntil,
      source.kind === 'cloud' && this.store.api.blockKind ? this.store.api.blockedUntil : 0,
    );
  }

  /** The earliest periodic read of a sensor: interval, pauses and refusals kept. */
  earliestRead(source) {
    const saved = this.store.get(source.key);
    return Math.max(
      saved.lastAttemptAt + this.intervalMs(source),
      this.pausedUntil(source),
      this.refusedUntil(source),
    );
  }

  /** Values read recently enough to be published as current. */
  isFresh(source, entry, now) {
    return (
      Boolean(entry?.values) &&
      !entry.error &&
      now - entry.readAt <= Math.max(STALE, 2 * this.intervalMs(source))
    );
  }

  /**
   * Whether a sensor may be asked now. Nothing, not even the test button
   * (`manual`), reads a sensor before its last request + the interval, nor
   * during a 429/5xx pause; `manual` may try a refusal again once the
   * interval has passed.
   */
  mayRead(source, { manual }) {
    const entry = this.track.get(source.key);
    if (!entry) {
      return false;
    }
    const now = this.now();
    const saved = this.store.get(source.key);
    const paused = this.pausedUntil(source);
    if (now < Math.max(saved.lastAttemptAt + this.intervalMs(source), paused)) {
      if (now < paused) {
        entry.error = entry.error ?? new PurpleAirError('busy');
      }
      entry.nextDue = Math.max(entry.nextDue, this.earliestRead(source));
      return false;
    }
    const refused = this.refusedUntil(source);
    if (!manual && now < refused) {
      const kind = this.blockOf(source);
      // A sensor refusal keeps its own kind (not found, denied) when known.
      entry.error =
        kind === 'denied' && ['not_found', 'denied'].includes(entry.error?.kind)
          ? entry.error
          : new PurpleAirError(kind ?? 'denied');
      entry.nextDue = Math.max(entry.nextDue, refused);
      return false;
    }
    return true;
  }

  // --- Reading -----------------------------------------------------------------------

  /** Read what is due (a tick never overlaps another). */
  tick() {
    if (this.ticking && this.tickGeneration === this.generation) {
      return this.ticking;
    }
    const generation = this.generation;
    const run = this.exclusive(() => this.readDue()).finally(() => {
      if (this.ticking === run) {
        this.ticking = undefined;
      }
      if (generation === this.generation) {
        this.scheduleWake();
      }
    });
    this.ticking = run;
    this.tickGeneration = generation;
    return run;
  }

  async readDue({ manual = false } = {}) {
    const generation = this.generation;
    const now = this.now();
    const due = this.sources.filter((source) => {
      const entry = this.track.get(source.key);
      return entry && (manual || now >= entry.nextDue) && this.mayRead(source, { manual });
    });
    if (due.length === 0) {
      return;
    }
    // Recorded first (and persisted, in one write at most once a minute), so
    // neither a reconnection, a saved configuration nor a restart reads again
    // sooner.
    if (
      !this.store.markAttempts(
        due.map((s) => s.key),
        now,
      )
    ) {
      for (const source of due) {
        const entry = this.track.get(source.key);
        entry.nextDue = Math.max(entry.nextDue, this.store.nextAttemptWrite());
      }
      return;
    }
    for (const source of due) {
      this.track.get(source.key).nextDue = now + this.intervalMs(source);
    }
    // A key-level failure met by one cloud sensor stops the next ones of the
    // same run (one try only).
    let keyFailed = false;
    for (const source of due) {
      if (generation !== this.generation) {
        return;
      }
      if (source.kind === 'cloud' && keyFailed) {
        continue;
      }
      const error = await this.read(source, generation);
      if (source.kind === 'cloud' && error && ['refused', 'credits', 'busy'].includes(error.kind)) {
        keyFailed = true;
      }
    }
    if (generation === this.generation) {
      await this.publish();
      await this.refreshStatus();
    }
  }

  /**
   * Another configured sensor, earlier in the list, gives this id from a
   * fresh read. An identity that only comes from an old read (a sensor moved
   * to another configured address, the first one silent) is not a duplicate.
   */
  duplicateOf(source, id) {
    // By key: a read that began before a reconnection holds the source object
    // of the previous configuration.
    const now = this.now();
    const position = (key) => this.sources.findIndex((s) => s.key === key);
    return this.sources.some((other) => {
      const entry = this.track.get(other.key);
      return (
        other.key !== source.key &&
        other.kind === source.kind &&
        position(other.key) < position(source.key) &&
        entry?.info?.id === id &&
        this.isFresh(other, entry, now)
      );
    });
  }

  /** The other sources still holding an old identity of a sensor that now answers here. */
  dropStaleIdentity(source, id) {
    const now = this.now();
    for (const other of this.sources) {
      const entry = this.track.get(other.key);
      if (
        other.key !== source.key &&
        other.kind === source.kind &&
        entry?.info?.id === id &&
        !this.isFresh(other, entry, now)
      ) {
        entry.info = undefined;
        entry.values = undefined;
        entry.fields = new Set();
        this.store.update(other.key, { info: undefined, fields: [] });
      }
    }
  }

  /**
   * Read one sensor (its request already recorded); never throws. Returns its
   * error. An answer that comes after a reconnection (a new generation) is
   * kept, never published, when the sensor and its keys are unchanged (the
   * current generation publishes it); otherwise it is dropped.
   */
  async read(source, generation) {
    const entry = this.track.get(source.key);
    const { apiKey } = this.config;
    const current = () => generation === this.generation;
    const same = () =>
      this.track.get(source.key) === entry &&
      this.sources.some(
        (s) => s.key === source.key && (s.readKey ?? '') === (source.readKey ?? ''),
      ) &&
      (source.kind === 'local' || this.config.apiKey === apiKey);
    const usable = () => current() || same();
    try {
      let info;
      let values;
      let disagree;
      if (source.kind === 'local') {
        const document = await readLocal(source.address);
        if (!usable()) {
          return undefined;
        }
        // The values carry the MAC of the sensor that measured them. An
        // unreadable MAC is not "another sensor": nothing is published, the
        // known sensor is kept.
        const mac = macOf(document.SensorId);
        if (!mac) {
          throw new PurpleAirError('invalid', 'no sensor id');
        }
        if (entry.info && entry.info.id !== mac) {
          // Another sensor answers at this address (addresses swapped by
          // the router): it is its own device, never the first one.
          entry.fields = new Set();
          entry.values = undefined;
        }
        info = localInfo(document, mac);
        ({ values, disagree } = localReading(document));
      } else {
        // The name and the model never change: asked only while unknown.
        const known = entry.info?.id === String(source.index) ? entry.info : undefined;
        const sensor = await readCloud(source.index, {
          apiKey,
          readKey: source.readKey,
          withIdentity: !known,
        });
        if (!usable()) {
          return undefined;
        }
        this.store.updateApi({ pausedUntil: 0, streak: 0, blockedUntil: 0, blockKind: '', fp: '' });
        info = known ?? cloudInfo(sensor, source.index);
        ({ values, disagree } = cloudReading(sensor));
        const lastSeen = lastSeenOf(sensor);
        if (lastSeen !== null && this.now() - lastSeen > CLOUD_OFFLINE) {
          entry.info = info;
          this.store.update(source.key, { pausedUntil: 0, streak: 0, refusedUntil: 0, info });
          throw new PurpleAirError('offline');
        }
      }
      entry.disagree = disagree;
      if (Object.keys(values).length === 0) {
        entry.info = entry.info ?? info;
        throw new PurpleAirError(
          disagree.length > 0 ? 'channels' : 'invalid',
          disagree.length > 0 ? 'channels A/B disagree' : 'no value',
        );
      }
      entry.info = info;
      if (this.duplicateOf(source, info.id)) {
        throw new PurpleAirError('duplicate');
      }
      this.dropStaleIdentity(source, info.id);
      entry.values = values;
      entry.readAt = this.now();
      for (const field of Object.keys(values)) {
        if (field !== 'pm1') {
          entry.fields.add(field);
        }
      }
      entry.error = undefined;
      this.store.update(source.key, {
        pausedUntil: 0,
        streak: 0,
        refusedUntil: 0,
        info,
        fields: [...entry.fields],
      });
      return undefined;
    } catch (err) {
      const error = err instanceof PurpleAirError ? err : new PurpleAirError('failed');
      const at = this.now();
      if (!usable()) {
        // Reconfigured meanwhile (another sensor or key): the outcome is not
        // the new configuration's; only a 429/5xx pause asked by the same
        // sensor (or the API, for the same key) is kept.
        const sameHolder =
          source.kind === 'local'
            ? this.sources.some((s) => s.key === source.key)
            : this.config.apiKey === apiKey;
        if (error.kind === 'busy' && sameHolder) {
          this.recordBusy(source, error, at);
        }
        return error;
      }
      entry.error = error;
      if (['invalid', 'offline', 'channels'].includes(error.kind)) {
        entry.values = undefined;
      }
      if (error.kind === 'refused') {
        // Only a refused key leaves its fingerprint (to tell, after a
        // restart, whether the configured key is still that one).
        this.store.updateApi({ blockedUntil: at + REFUSED_BACKOFF, blockKind: 'refused' }, apiKey);
      } else if (error.kind === 'credits') {
        // A 402 means the key was accepted: no fingerprint of it.
        this.store.updateApi({ blockedUntil: at + REFUSED_BACKOFF, blockKind: 'credits', fp: '' });
      } else if (error.kind === 'denied') {
        this.store.update(source.key, { refusedUntil: at + REFUSED_BACKOFF }, source.readKey ?? '');
        entry.nextDue = Math.max(entry.nextDue, at + REFUSED_BACKOFF);
      } else if (error.kind === 'not_found') {
        // The index is in question, not the read key: no fingerprint.
        this.store.update(source.key, { refusedUntil: at + REFUSED_BACKOFF, fp: '' });
        entry.nextDue = Math.max(entry.nextDue, at + REFUSED_BACKOFF);
      } else if (error.kind === 'busy') {
        this.recordBusy(source, error, at);
      }
      if (source.kind === 'cloud' && ['refused', 'credits', 'busy'].includes(error.kind)) {
        // The block or the pause holds every cloud sensor.
        for (const other of this.sources.filter((s) => s.kind === 'cloud')) {
          const e = this.track.get(other.key);
          if (e) {
            e.nextDue = Math.max(e.nextDue, this.earliestRead(other));
          }
        }
      }
      this.logger.warn(`${this.nameOf(source)}: ${this.scrub(error)}`);
      return error;
    }
  }

  /** A 429 / 5xx: Retry-After, else 5 minutes doubling; 1 minute to 6 hours. */
  recordBusy(source, error, at) {
    const holder = source.kind === 'cloud' ? this.store.api : this.store.get(source.key);
    const streak = holder.streak + 1;
    const pause = clamp(
      error.retryAfterMs ?? BUSY_BASE * 2 ** Math.min(streak - 1, 10),
      BUSY_MIN,
      BUSY_MAX,
    );
    if (source.kind === 'cloud') {
      this.store.updateApi({ streak, pausedUntil: at + pause });
    } else {
      this.store.update(source.key, { streak, pausedUntil: at + pause });
    }
    const entry = this.track.get(source.key);
    if (entry) {
      entry.nextDue = Math.max(entry.nextDue, at + Math.max(this.intervalMs(source), pause));
    }
  }

  // --- Gladys devices and states --------------------------------------------------

  typeOf(source) {
    return source.kind === 'cloud' ? DEVICE_TYPE.CLOUD : DEVICE_TYPE.LOCAL;
  }

  nameOf(source) {
    const info = this.track.get(source.key)?.info;
    if (info?.name) {
      return `${info.name} (PurpleAir)`;
    }
    if (source.kind === 'cloud') {
      return `PurpleAir ${source.index}`;
    }
    return info ? `PurpleAir ${info.id.slice(-4)}` : `PurpleAir (${source.address})`;
  }

  /** The sensors known by their id, without duplicates: [{ source, entry }]. */
  known() {
    // One device per sensor: never twice the same id (two addresses holding
    // the same identity from old reads, after a restart), the fresh one first.
    const now = this.now();
    const candidates = this.sources
      .map((source) => ({ source, entry: this.track.get(source.key) }))
      .filter(({ source, entry }) => entry?.info && !this.duplicateOf(source, entry.info.id));
    const fresh = candidates.filter(({ source, entry }) => this.isFresh(source, entry, now));
    const seen = new Set();
    const kept = [];
    for (const item of [...fresh, ...candidates]) {
      const id = `${item.source.kind}:${item.entry.info.id}`;
      if (!seen.has(id)) {
        seen.add(id);
        kept.push(item);
      }
    }
    return this.sources
      .map((source) => kept.find((item) => item.source === source))
      .filter(Boolean);
  }

  devices() {
    return this.known()
      .map(({ source, entry }) =>
        deviceOf(this.gladys, {
          type: this.typeOf(source),
          id: entry.info.id,
          fields: entry.fields,
          name: this.nameOf(source),
        }),
      )
      .filter((device) => device.features.length > 0);
  }

  async publish() {
    await this.publishDiscovered();
    await this.publishStates();
  }

  /** The Discovery tab, published again only when it changed. */
  async publishDiscovered({ force = false } = {}) {
    const devices = this.devices();
    const key = JSON.stringify(devices);
    if (!force && key === this.lastDiscovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.lastDiscovered = key;
    } catch (err) {
      this.logger.warn(`publishDiscoveredDevices failed: ${err.message}`);
    }
  }

  /** The fresh values of the created features, only what changed (plus a heartbeat). */
  async publishStates() {
    const now = this.now();
    const states = [];
    for (const { source, entry } of this.known()) {
      if (!this.isFresh(source, entry, now)) {
        continue;
      }
      const type = this.typeOf(source);
      const created = new Set(
        createdFeatures(this.gladys, type, entry.info.id).map((f) => f.external_id),
      );
      states.push(
        ...statesOf(this.gladys, type, entry.info.id, entry.values).filter((s) =>
          created.has(s.device_feature_external_id),
        ),
      );
    }
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: HEARTBEAT });
    } catch (err) {
      this.logger.warn(`Publishing the states failed: ${err.message}`);
    }
  }

  // --- Status ------------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  withNotes(text) {
    const notes = [];
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidSlots(this.config.invalid));
    }
    const kinds = new Set(
      this.sources.map((s) => this.track.get(s.key)?.error?.kind).filter(Boolean),
    );
    if (kinds.has('refused')) {
      notes.push(T.refusedHelp);
    }
    if (kinds.has('credits')) {
      notes.push(T.creditsHelp);
    }
    const disagreeing = this.sources
      .filter((s) => {
        const entry = this.track.get(s.key);
        return entry?.disagree?.length > 0 && !entry.error;
      })
      .map((s) => this.nameOf(s));
    if (disagreeing.length > 0) {
      notes.push(T.channelsDisagree(disagreeing));
    }
    if (notes.length === 0) {
      return text;
    }
    return {
      en: `${text.en} ${notes.map((n) => `${n.en.replace(/\.$/, '')}.`).join(' ')}`,
      fr: `${text.fr} ${notes.map((n) => `${n.fr.replace(/\.$/, '')}.`).join(' ')}`,
    };
  }

  statusText() {
    const failing = this.sources
      .map((source) => ({ source, entry: this.track.get(source.key) }))
      .filter(({ entry }) => entry?.error)
      .map(({ source, entry }) => ({ name: this.nameOf(source), kind: entry.error.kind }));
    return {
      failing,
      text: T.ok({
        local: this.config.local.length,
        cloud: this.config.cloud.length,
        localMinutes: this.config.localMinutes,
        cloudMinutes: this.config.cloudMinutes,
        failing,
      }),
    };
  }

  async refreshStatus() {
    if (this.sources.length === 0) {
      return this.setStatus(false, this.withNotes(T.notConfigured));
    }
    const now = this.now();
    const { failing, text } = this.statusText();
    const anyValue = this.known().some(({ source, entry }) => this.isFresh(source, entry, now));
    return this.setStatus(anyValue || failing.length === 0, this.withNotes(text));
  }

  // --- Configuration screen button -------------------------------------------------

  line(source, lang) {
    const entry = this.track.get(source.key);
    const colon = lang === 'fr' ? ' :' : ':';
    const name = this.nameOf(source);
    const v = entry?.values;
    if (!v || entry.error) {
      const why = entry?.error
        ? reason(entry.error.kind)[lang]
        : lang === 'fr'
          ? 'pas encore lu depuis le démarrage'
          : 'not read since the start';
      const paused = this.pausedUntil(source);
      const until =
        entry?.error?.kind === 'busy' && paused > this.now()
          ? `, ${T.pausedUntil(paused)[lang]}`
          : '';
      return `- ${name}${colon} ${why}${until}, ${this.nextRead(source, lang)}`;
    }
    const parts = [];
    const add = (field, label, unit) => {
      if (typeof v[field] === 'number') {
        parts.push(`${label} ${numberText(v[field], lang)}${unit}`);
      }
    };
    add('pm1', 'PM1', ' µg/m³');
    add('pm25', 'PM2.5', ' µg/m³');
    add('pm10', 'PM10', ' µg/m³');
    add('aqi', 'AQI', '');
    add('temperature', lang === 'fr' ? 'température' : 'temperature', ' °C');
    add('humidity', lang === 'fr' ? 'humidité' : 'humidity', ' %');
    add('pressure', lang === 'fr' ? 'pression' : 'pressure', ' hPa');
    if (entry.disagree?.length > 0) {
      parts.push(reason('channels')[lang]);
    }
    return `- ${name}${colon} ${parts.join(', ')}, ${this.nextRead(source, lang)}`;
  }

  /**
   * "next read possible at 18:02 UTC": the button never reads sooner. Counts
   * the interval, a pause, and the one write a minute of the request times
   * (a read that had to wait for it).
   */
  nextRead(source, lang) {
    const saved = this.store.get(source.key);
    const now = this.now();
    const at = Math.max(
      saved.lastAttemptAt + this.intervalMs(source),
      this.pausedUntil(source),
      now,
    );
    return T.nextRead(Math.max(at, this.store.nextAttemptWrite()))[lang];
  }

  async testConnection() {
    if (this.sources.length === 0) {
      return this.withNotes(T.notConfigured);
    }
    // Gladys waits 120 s for the answer: past ~100 s, the last values are
    // shown (a read still running finishes in the background).
    const generation = this.generation;
    const reads = this.exclusive(async () => {
      if (generation === this.generation) {
        await this.readDue({ manual: true });
      }
    });
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, TEST_DEADLINE);
    });
    try {
      await Promise.race([reads, timeout]);
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (generation === this.generation) {
      this.scheduleWake();
    }
    const en = ['PurpleAir:'];
    const fr = ['PurpleAir :'];
    for (const source of this.sources) {
      en.push(this.line(source, 'en'));
      fr.push(this.line(source, 'fr'));
    }
    await this.publish();
    await this.refreshStatus();
    return this.withNotes({ en: en.join('\n'), fr: fr.join('\n') });
  }
}
