import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LRUCache, FileCacheBackend, MemoryCacheBackend } from '../dist/core/cache.js';

describe('LRUCache', () => {
  let cache;
  beforeEach(() => { cache = new LRUCache(3); });

  it('stores and retrieves values', () => {
    cache.set('a', { value: 'alpha' });
    assert.deepEqual(cache.get('a'), { value: 'alpha' });
  });

  it('returns undefined for missing keys', () => {
    assert.equal(cache.get('missing'), undefined);
  });

  it('checks existence with has()', () => {
    cache.set('a', { value: 'x' });
    assert.equal(cache.has('a'), true);
    assert.equal(cache.has('b'), false);
  });

  it('deletes entries', () => {
    cache.set('a', { value: 'x' });
    cache.delete('a');
    assert.equal(cache.has('a'), false);
  });

  it('clears all entries', () => {
    cache.set('a', { value: 'x' });
    cache.set('b', { value: 'y' });
    cache.clear();
    assert.equal(cache.size, 0);
  });

  it('evicts oldest entries when exceeding capacity', () => {
    cache.set('a', { value: 'first' });
    cache.set('b', { value: 'second' });
    cache.set('c', { value: 'third' });
    cache.set('d', { value: 'fourth' });
    assert.equal(cache.has('a'), false);
    assert.equal(cache.has('b'), true);
    assert.equal(cache.has('c'), true);
    assert.equal(cache.has('d'), true);
  });

  it('LRU: accessing moves to end', () => {
    cache.set('a', { value: 'first' });
    cache.set('b', { value: 'second' });
    cache.set('c', { value: 'third' });
    cache.get('a'); // makes 'a' most recent
    cache.set('d', { value: 'fourth' });
    assert.equal(cache.has('a'), true);
    assert.equal(cache.has('b'), false);
    assert.equal(cache.has('c'), true);
    assert.equal(cache.has('d'), true);
  });

  it('exposes keys and size', () => {
    cache.set('a', { value: 'x' });
    cache.set('b', { value: 'y' });
    assert.equal(cache.size, 2);
    assert.deepEqual(cache.keys(), ['a', 'b']);
  });
});

describe('MemoryCacheBackend', () => {
  it('implements CacheBackend interface', () => {
    const backend = new MemoryCacheBackend();
    assert.equal(backend.has('a'), false);
    backend.set('a', 'value');
    assert.equal(backend.has('a'), true);
    assert.equal(backend.get('a'), 'value');
    backend.delete('a');
    assert.equal(backend.has('a'), false);

    backend.set('a', 'a');
    backend.set('b', 'b');
    backend.clear();
    assert.equal(backend.has('a'), false);
    assert.equal(backend.has('b'), false);
  });
});

describe('FileCacheBackend', () => {
  const tmpDirs = [];
  function makeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-cache-test-'));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('persists values to disk', () => {
    const dir = makeDir();
    const backend = new FileCacheBackend(dir);
    backend.set('key1', 'value1');
    assert.equal(backend.has('key1'), true);
    assert.equal(backend.get('key1'), 'value1');
  });

  it('survives backend re-creation (disk persistence)', () => {
    const dir = makeDir();
    const b1 = new FileCacheBackend(dir);
    b1.set('key1', 'value1');
    const b2 = new FileCacheBackend(dir);
    assert.equal(b2.has('key1'), true);
    assert.equal(b2.get('key1'), 'value1');
  });

  it('delete removes from disk', () => {
    const dir = makeDir();
    const backend = new FileCacheBackend(dir);
    backend.set('key1', 'value1');
    backend.delete('key1');
    assert.equal(backend.has('key1'), false);
    const b2 = new FileCacheBackend(dir);
    assert.equal(b2.has('key1'), false);
  });

  it('clear removes all entries', () => {
    const dir = makeDir();
    const backend = new FileCacheBackend(dir);
    backend.set('a', '1');
    backend.set('b', '2');
    backend.clear();
    assert.equal(backend.has('a'), false);
    assert.equal(backend.has('b'), false);
  });

  it('creates directory if not exists', () => {
    const dir = path.join(makeDir(), 'nonexistent', 'subdir');
    const backend = new FileCacheBackend(dir);
    backend.set('key', 'val');
    assert.equal(backend.get('key'), 'val');
  });
});
