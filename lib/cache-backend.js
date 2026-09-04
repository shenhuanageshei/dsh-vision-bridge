/**
 * Namespaced note cache with debounced async persistence (design §5.5).
 *
 * Key = attachmentId (content-addressed full id) + questionHash + resolved
 * configuration fingerprint (endpoint + model + language + outputFormat +
 * engine prompt version). `tool` and `auto` live in separate namespace files
 * so the two modes can never serve each other's answers. Writes are debounced
 * and atomic (tmp + rename) — unlike the engine's FileCacheBackend, which
 * rewrites the whole JSON synchronously on every set (appendix B②).
 *
 * Implements the engine's `CacheBackend` interface so it can also occupy the
 * engine's persistBackend slot without touching library source.
 *
 * @module @dsh-external/dsh-vision-bridge/cache-backend
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configFingerprint } from './config.js';

/** Entries older than this age out on load (design §5.5 mentions LRU/TTL
 * aging; TTL is deliberately not user-configurable). */
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEBOUNCE_MS = 500;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Short hash of the normalized user question. */
export function hashQuestion(normalizedRequest) {
  return sha256Hex(String(normalizedRequest ?? '')).slice(0, 16);
}

/** Full cache key for one analyzed note. */
export function noteKey(namespace, attachmentId, questionHash, fingerprint) {
  return `${namespace}|${attachmentId}|${questionHash}|${fingerprint}`;
}

/** Configuration fingerprint over the resolved config (re-exported helper). */
export function fingerprint(resolvedConfig) {
  return configFingerprint(resolvedConfig, sha256Hex);
}

/**
 * One namespaced, LRU-bounded, debounce-persisted string store.
 */
export class NamespacedNoteCache {
  /**
   * @param namespace - 'tool' | 'auto' (also the file stem).
   * @param dir - persist directory (created lazily).
   * @param options - `maxEntries` LRU cap, `logger` (optional cordis logger),
   *   `now` clock injection for tests.
   */
  constructor(namespace, dir, options = {}) {
    this.namespace = namespace;
    this.dir = dir;
    this.maxEntries = options.maxEntries ?? 256;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.file = path.join(dir, `${namespace}.json`);
    /** Map<string, { value, updatedAt }> in LRU order (oldest first). */
    this.map = new Map();
    this.timer = undefined;
    this.writing = Promise.resolve();
    this.closed = false;
    this.load();
  }

  /** Load persisted entries; a corrupt file degrades to an empty store (test
   * matrix: cache corruption must never crash the plugin). */
  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      const cutoff = this.now() - ENTRY_TTL_MS;
      for (const [key, entry] of Object.entries(data ?? {})) {
        if (!entry || typeof entry !== 'object' || typeof entry.value !== 'string') continue;
        if (!Number.isFinite(entry.updatedAt) || entry.updatedAt < cutoff) continue;
        this.map.set(key, { value: entry.value, updatedAt: entry.updatedAt });
      }
      this.trim();
    } catch (error) {
      this.map.clear();
      this.logger?.warn?.(`vision-bridge: cache file "${this.file}" unreadable (${error?.message ?? error}); starting empty`);
    }
  }

  trim() {
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    // LRU touch: re-insert at the tail
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  has(key) {
    return this.map.has(key);
  }

  set(key, value) {
    if (this.closed) return;
    this.map.delete(key);
    this.map.set(key, { value, updatedAt: this.now() });
    this.trim();
    this.scheduleFlush();
  }

  delete(key) {
    this.map.delete(key);
    this.scheduleFlush();
  }

  clear() {
    this.map.clear();
    this.scheduleFlush();
  }

  get size() {
    return this.map.size;
  }

  scheduleFlush() {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushNow();
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Serialize pending writes; safe to await from the plugin disposer.
   * `force` bypasses the closed check — close() must flush the entries that
   * landed inside the debounce window BEFORE marking the store closed, or they
   * would be lost on every fiber restart / settings rebuild. */
  async flushNow(force = false) {
    if (this.closed && !force) return;
    const snapshot = {};
    for (const [key, entry] of this.map) snapshot[key] = entry;
    const json = JSON.stringify(snapshot);
    const run = fs.promises.mkdir(this.dir, { recursive: true })
      .then(() => fs.promises.writeFile(this.file + '.tmp', json, 'utf8'))
      .then(() => fs.promises.rename(this.file + '.tmp', this.file))
      .catch((error) => {
        this.logger?.warn?.(`vision-bridge: cache flush failed (${error?.message ?? error}); keeping memory store`);
      });
    this.writing = this.writing.then(() => run, () => run);
    await run;
  }

  /** Stop timers, flush everything pending (including debounce-window
   * entries), then refuse further sets. */
  async close() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flushNow(true);
    this.closed = true;
    await this.writing;
  }
}

/**
 * In-flight promise dedup for one key space (design §5.5: 同 key 在途去重).
 */
export class InFlightDedup {
  constructor() {
    this.pending = new Map();
  }

  /** Run `task` keyed by `key`; concurrent same-key callers share one promise. */
  run(key, task) {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = (async () => task())().finally(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }
}

/**
 * Fixed-width concurrency gate (design §5.6: default 2, config-capped).
 */
export class ConcurrencyGate {
  constructor(limit) {
    this.limit = Math.max(1, limit | 0 || 1);
    this.active = 0;
    this.queue = [];
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.limit && this.queue.length > 0) {
      const { task, resolve, reject } = this.queue.shift();
      this.active += 1;
      (async () => task())().then(resolve, reject).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }
}
