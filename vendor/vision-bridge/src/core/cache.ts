import fs from 'fs';
import path from 'path';
import type { CacheBackend } from '../adapters/types.js';

/**
 * Generic LRU (Least Recently Used) cache.
 * Uses a Map which maintains insertion order.
 * On get/set, the key is moved to the end (most recently used).
 * When capacity is exceeded, the first (oldest) entry is evicted.
 */
export class LRUCache<T> {
  private _map: Map<string, T>;
  private _capacity: number;

  constructor(capacity: number) {
    this._capacity = capacity;
    this._map = new Map();
  }

  get(key: string): T | undefined {
    if (!this._map.has(key)) return undefined;
    // Move to end (most recently used)
    const value = this._map.get(key)!;
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    // Remove if exists so we can re-insert at end
    if (this._map.has(key)) {
      this._map.delete(key);
    }
    this._map.set(key, value);
    // Evict oldest if over capacity
    if (this._map.size > this._capacity) {
      const oldest = this._map.keys().next().value as string;
      this._map.delete(oldest);
    }
  }

  has(key: string): boolean {
    return this._map.has(key);
  }

  delete(key: string): void {
    this._map.delete(key);
  }

  clear(): void {
    this._map.clear();
  }

  get size(): number {
    return this._map.size;
  }

  keys(): string[] {
    return Array.from(this._map.keys());
  }
}

/**
 * In-memory cache backend implementing CacheBackend.
 * Simple Map<string, string> wrapper.
 */
export class MemoryCacheBackend implements CacheBackend {
  private _store: Map<string, string>;

  constructor() {
    this._store = new Map();
  }

  get(key: string): string | null {
    return this._store.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this._store.set(key, value);
  }

  has(key: string): boolean {
    return this._store.has(key);
  }

  delete(key: string): void {
    this._store.delete(key);
  }

  clear(): void {
    this._store.clear();
  }
}

/**
 * File-based cache backend implementing CacheBackend.
 * Persists entries as a JSON object on disk.
 * Uses atomic write: writes to a .tmp file then renames.
 */
export class FileCacheBackend implements CacheBackend {
  private _dir: string;
  private _filepath: string;
  private _store: Map<string, string>;

  constructor(dir: string, filename: string = 'vision-bridge-cache.json') {
    this._dir = dir;
    this._filepath = path.join(dir, filename);
    this._store = new Map();
    this._load();
  }

  get(key: string): string | null {
    return this._store.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this._store.set(key, value);
    this._save();
  }

  has(key: string): boolean {
    return this._store.has(key);
  }

  delete(key: string): void {
    this._store.delete(key);
    this._save();
  }

  clear(): void {
    this._store.clear();
    this._save();
  }

  private _load(): void {
    try {
      if (fs.existsSync(this._filepath)) {
        const raw = fs.readFileSync(this._filepath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, string>;
        for (const [key, value] of Object.entries(data)) {
          this._store.set(key, value);
        }
      }
    } catch {
      // If file is corrupt or unreadable, start with empty store
      this._store.clear();
    }
  }

  private _save(): void {
    // Ensure directory exists
    fs.mkdirSync(this._dir, { recursive: true });

    // Serialize to JSON
    const data: Record<string, string> = {};
    for (const [key, value] of this._store.entries()) {
      data[key] = value;
    }
    const json = JSON.stringify(data, null, 2);

    // Atomic write: write to .tmp then rename
    const tmpPath = this._filepath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, this._filepath);
  }
}
