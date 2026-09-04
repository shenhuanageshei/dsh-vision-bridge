import fs from 'fs';
import path from 'path';
/**
 * Generic LRU (Least Recently Used) cache.
 * Uses a Map which maintains insertion order.
 * On get/set, the key is moved to the end (most recently used).
 * When capacity is exceeded, the first (oldest) entry is evicted.
 */
export class LRUCache {
    _map;
    _capacity;
    constructor(capacity) {
        this._capacity = capacity;
        this._map = new Map();
    }
    get(key) {
        if (!this._map.has(key))
            return undefined;
        // Move to end (most recently used)
        const value = this._map.get(key);
        this._map.delete(key);
        this._map.set(key, value);
        return value;
    }
    set(key, value) {
        // Remove if exists so we can re-insert at end
        if (this._map.has(key)) {
            this._map.delete(key);
        }
        this._map.set(key, value);
        // Evict oldest if over capacity
        if (this._map.size > this._capacity) {
            const oldest = this._map.keys().next().value;
            this._map.delete(oldest);
        }
    }
    has(key) {
        return this._map.has(key);
    }
    delete(key) {
        this._map.delete(key);
    }
    clear() {
        this._map.clear();
    }
    get size() {
        return this._map.size;
    }
    keys() {
        return Array.from(this._map.keys());
    }
}
/**
 * In-memory cache backend implementing CacheBackend.
 * Simple Map<string, string> wrapper.
 */
export class MemoryCacheBackend {
    _store;
    constructor() {
        this._store = new Map();
    }
    get(key) {
        return this._store.get(key) ?? null;
    }
    set(key, value) {
        this._store.set(key, value);
    }
    has(key) {
        return this._store.has(key);
    }
    delete(key) {
        this._store.delete(key);
    }
    clear() {
        this._store.clear();
    }
}
/**
 * File-based cache backend implementing CacheBackend.
 * Persists entries as a JSON object on disk.
 * Uses atomic write: writes to a .tmp file then renames.
 */
export class FileCacheBackend {
    _dir;
    _filepath;
    _store;
    constructor(dir, filename = 'vision-bridge-cache.json') {
        this._dir = dir;
        this._filepath = path.join(dir, filename);
        this._store = new Map();
        this._load();
    }
    get(key) {
        return this._store.get(key) ?? null;
    }
    set(key, value) {
        this._store.set(key, value);
        this._save();
    }
    has(key) {
        return this._store.has(key);
    }
    delete(key) {
        this._store.delete(key);
        this._save();
    }
    clear() {
        this._store.clear();
        this._save();
    }
    _load() {
        try {
            if (fs.existsSync(this._filepath)) {
                const raw = fs.readFileSync(this._filepath, 'utf-8');
                const data = JSON.parse(raw);
                for (const [key, value] of Object.entries(data)) {
                    this._store.set(key, value);
                }
            }
        }
        catch {
            // If file is corrupt or unreadable, start with empty store
            this._store.clear();
        }
    }
    _save() {
        // Ensure directory exists
        fs.mkdirSync(this._dir, { recursive: true });
        // Serialize to JSON
        const data = {};
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
//# sourceMappingURL=cache.js.map