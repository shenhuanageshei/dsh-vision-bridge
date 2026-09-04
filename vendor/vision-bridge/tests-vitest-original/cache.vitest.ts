import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LRUCache, FileCacheBackend, MemoryCacheBackend } from '../src/core/cache.js';

describe('LRUCache', () => {
  let cache: LRUCache<{ value: string }>;

  beforeEach(() => {
    cache = new LRUCache<{ value: string }>(3);
  });

  it('stores and retrieves values', () => {
    cache.set('a', { value: 'alpha' });
    expect(cache.get('a')).toEqual({ value: 'alpha' });
  });

  it('returns undefined for missing keys', () => {
    expect(cache.get('missing')).toBeUndefined();
  });

  it('checks existence with has()', () => {
    cache.set('a', { value: 'x' });
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('deletes entries', () => {
    cache.set('a', { value: 'x' });
    cache.delete('a');
    expect(cache.has('a')).toBe(false);
  });

  it('clears all entries', () => {
    cache.set('a', { value: 'x' });
    cache.set('b', { value: 'y' });
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('evicts oldest entries when exceeding capacity', () => {
    cache.set('a', { value: 'first' });
    cache.set('b', { value: 'second' });
    cache.set('c', { value: 'third' });
    cache.set('d', { value: 'fourth' });
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('LRU: accessing moves to end', () => {
    cache.set('a', { value: 'first' });
    cache.set('b', { value: 'second' });
    cache.set('c', { value: 'third' });
    cache.get('a'); // makes 'a' most recent
    cache.set('d', { value: 'fourth' });
    // 'b' should be evicted (least recently used), not 'a'
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('exposes keys and size', () => {
    cache.set('a', { value: 'x' });
    cache.set('b', { value: 'y' });
    expect(cache.size).toBe(2);
    expect(cache.keys()).toEqual(['a', 'b']);
  });
});

describe('MemoryCacheBackend', () => {
  it('implements CacheBackend interface', () => {
    const backend = new MemoryCacheBackend();
    expect(backend.has('a')).toBe(false);
    backend.set('a', 'value');
    expect(backend.has('a')).toBe(true);
    expect(backend.get('a')).toBe('value');
    backend.delete('a');
    expect(backend.has('a')).toBe(false);

    backend.set('a', 'a');
    backend.set('b', 'b');
    backend.clear();
    expect(backend.has('a')).toBe(false);
    expect(backend.has('b')).toBe(false);
  });
});

describe('FileCacheBackend', () => {
  const tmpDirs: string[] = [];

  function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-cache-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('persists values to disk', () => {
    const dir = makeDir();
    const backend = new FileCacheBackend(dir);
    backend.set('key1', 'value1');
    expect(backend.has('key1')).toBe(true);
    expect(backend.get('key1')).toBe('value1');
  });

  it('survives backend re-creation (disk persistence)', () => {
    const dir = makeDir();
    const b1 = new FileCacheBackend(dir);
    b1.set('key1', 'value1');

    const b2 = new FileCacheBackend(dir);
    expect(b2.has('key1')).toBe(true);
    expect(b2.get('key1')).toBe('value1');
  });

  it('delete removes from disk', () => {
    const dir = makeDir();
    const backend = new FileCacheBackend(dir);
    backend.set('key1', 'value1');
    backend.delete('key1');
    expect(backend.has('key1')).toBe(false);

    const b2 = new FileCacheBackend(dir);
    expect(b2.has('key1')).toBe(false);
  });

  it('clear removes all entries', () => {
    const dir = makeDir();
    const backend = new FileCacheBackend(dir);
    backend.set('a', '1');
    backend.set('b', '2');
    backend.clear();
    expect(backend.has('a')).toBe(false);
    expect(backend.has('b')).toBe(false);
  });

  it('creates directory if not exists', () => {
    const dir = path.join(makeDir(), 'nonexistent', 'subdir');
    const backend = new FileCacheBackend(dir);
    backend.set('key', 'val');
    expect(backend.get('key')).toBe('val');
  });
});
