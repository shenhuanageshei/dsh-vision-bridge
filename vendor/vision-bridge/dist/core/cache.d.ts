import type { CacheBackend } from '../adapters/types.js';
/**
 * Generic LRU (Least Recently Used) cache.
 * Uses a Map which maintains insertion order.
 * On get/set, the key is moved to the end (most recently used).
 * When capacity is exceeded, the first (oldest) entry is evicted.
 */
export declare class LRUCache<T> {
    private _map;
    private _capacity;
    constructor(capacity: number);
    get(key: string): T | undefined;
    set(key: string, value: T): void;
    has(key: string): boolean;
    delete(key: string): void;
    clear(): void;
    get size(): number;
    keys(): string[];
}
/**
 * In-memory cache backend implementing CacheBackend.
 * Simple Map<string, string> wrapper.
 */
export declare class MemoryCacheBackend implements CacheBackend {
    private _store;
    constructor();
    get(key: string): string | null;
    set(key: string, value: string): void;
    has(key: string): boolean;
    delete(key: string): void;
    clear(): void;
}
/**
 * File-based cache backend implementing CacheBackend.
 * Persists entries as a JSON object on disk.
 * Uses atomic write: writes to a .tmp file then renames.
 */
export declare class FileCacheBackend implements CacheBackend {
    private _dir;
    private _filepath;
    private _store;
    constructor(dir: string, filename?: string);
    get(key: string): string | null;
    set(key: string, value: string): void;
    has(key: string): boolean;
    delete(key: string): void;
    clear(): void;
    private _load;
    private _save;
}
