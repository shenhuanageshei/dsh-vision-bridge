import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConcurrencyGate,
  InFlightDedup,
  NamespacedNoteCache,
  fingerprint,
  hashQuestion,
  noteKey,
} from '../lib/cache-backend.js';
import { resolveConfig, configFingerprint } from '../lib/config.js';

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vbb-cache-'));
}

describe('keys and fingerprints', () => {
  const cfg = resolveConfig({ provider: { baseURL: 'https://api.example.com/v1', model: 'vl' }, cache: { persistDir: 'x' } }, { persistDirFallback: 'y' });

  it('same image + question + config = same key; any change = new key', () => {
    const k1 = noteKey('tool', 'sha256:aa', hashQuestion('这是什么'), fingerprint(cfg));
    const k2 = noteKey('tool', 'sha256:aa', hashQuestion('这是什么'), fingerprint(cfg));
    assert.equal(k1, k2);
    assert.notEqual(k1, noteKey('tool', 'sha256:aa', hashQuestion('别的问题'), fingerprint(cfg)), 'question must be in the key');
    assert.notEqual(k1, noteKey('auto', 'sha256:aa', hashQuestion('这是什么'), fingerprint(cfg)), 'namespace must be in the key');
    const other = resolveConfig({ provider: { baseURL: 'https://other/v1', model: 'vl' }, cache: { persistDir: 'x' } }, { persistDirFallback: 'y' });
    assert.notEqual(k1, noteKey('tool', 'sha256:aa', hashQuestion('这是什么'), fingerprint(other)), 'config fingerprint must be in the key');
  });

  it('configFingerprint is stable across equivalent resolutions and changes with config', () => {
    const cfg2 = resolveConfig({ provider: { baseURL: 'https://api.example.com/v1', model: 'vl' }, cache: { persistDir: 'x' } }, { persistDirFallback: 'y' });
    assert.equal(configFingerprint(cfg, (s) => s), configFingerprint(cfg2, (s) => s));
    assert.notEqual(configFingerprint(cfg, (s) => s), configFingerprint({ ...cfg, language: 'en' }, (s) => s));
  });
});

describe('NamespacedNoteCache', () => {
  let dir;
  beforeEach(() => { dir = makeDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('persists debounced writes to a per-namespace file', async () => {
    const cache = new NamespacedNoteCache('tool', dir);
    cache.set('k1', 'note-1');
    assert.equal(fs.existsSync(path.join(dir, 'tool.json')), false, 'write is debounced, not synchronous');
    await cache.close(); // close must flush the debounce-window entry itself
    assert.equal(fs.existsSync(path.join(dir, 'tool.json')), true);
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'tool.json'), 'utf8'));
    assert.equal(persisted.k1.value, 'note-1', 'close() must persist entries written inside the debounce window');
  });

  it('close() without any manual flush lands the value on disk (fiber-restart safety)', async () => {
    const cache = new NamespacedNoteCache('tool', dir);
    cache.set('window-entry', 'survives-close');
    // no flushNow() — exactly what happens when a fiber restarts mid-window
    await cache.close();
    const reloaded = new NamespacedNoteCache('tool', dir);
    assert.equal(reloaded.get('window-entry'), 'survives-close');
    await reloaded.close();
  });

  it('tool and auto namespaces never see each other\u2019s entries', async () => {
    const tool = new NamespacedNoteCache('tool', dir);
    const auto = new NamespacedNoteCache('auto', dir);
    tool.set('shared-key', 'tool-answer');
    auto.set('shared-key', 'auto-answer');
    await Promise.all([tool.flushNow(), auto.flushNow()]);

    const toolReloaded = new NamespacedNoteCache('tool', dir);
    const autoReloaded = new NamespacedNoteCache('auto', dir);
    assert.equal(toolReloaded.get('shared-key'), 'tool-answer');
    assert.equal(autoReloaded.get('shared-key'), 'auto-answer');
    await Promise.all([tool.close(), auto.close(), toolReloaded.close(), autoReloaded.close()]);
  });

  it('a corrupt cache file degrades to an empty store without crashing', async () => {
    fs.writeFileSync(path.join(dir, 'tool.json'), '{not json at all', 'utf8');
    const cache = new NamespacedNoteCache('tool', dir, { logger: { warn() {} } });
    assert.equal(cache.size, 0);
    cache.set('fresh', 'works');
    assert.equal(cache.get('fresh'), 'works');
    await cache.close();
  });

  it('drops entries older than the TTL on load', async () => {
    let now = 1_000_000;
    const clock = () => now;
    const cache = new NamespacedNoteCache('tool', dir, { now: clock });
    cache.set('old', 'stale');
    cache.set('fresh', 'good');
    await cache.flushNow();
    await cache.close();

    now += 31 * 24 * 60 * 60 * 1000; // 31 days later
    const reloaded = new NamespacedNoteCache('tool', dir, { now: clock });
    assert.equal(reloaded.has('old'), false, 'TTL-aged entries must drop on load');
    assert.equal(reloaded.has('fresh'), false, 'entries written at the same tick age together; fresh set after reload works');
    reloaded.set('newest', 'v');
    assert.equal(reloaded.get('newest'), 'v');
    await reloaded.close();
  });

  it('evicts least-recently-used entries beyond maxEntries', () => {
    const cache = new NamespacedNoteCache('tool', dir, { maxEntries: 2 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.get('a'); // touch a
    cache.set('c', '3'); // evicts b
    assert.equal(cache.has('b'), false);
    assert.equal(cache.has('a'), true);
    assert.equal(cache.has('c'), true);
  });

  it('set after close is a no-op (disposer race safety)', async () => {
    const cache = new NamespacedNoteCache('tool', dir);
    await cache.close();
    cache.set('late', 'ignored');
    assert.equal(cache.has('late'), false);
  });
});

describe('InFlightDedup', () => {
  it('coalesces concurrent same-key calls into one task', async () => {
    const dedup = new InFlightDedup();
    let calls = 0;
    const task = () => new Promise((resolve) => {
      calls += 1;
      setTimeout(() => resolve('result-' + calls), 10);
    });
    const [a, b] = await Promise.all([dedup.run('k', task), dedup.run('k', task)]);
    assert.equal(calls, 1);
    assert.equal(a, 'result-1');
    assert.equal(b, 'result-1');
    // after settle, a new task may run
    await dedup.run('k', task);
    assert.equal(calls, 2);
  });

  it('separate keys run separately and rejections clean up', async () => {
    const dedup = new InFlightDedup();
    let calls = 0;
    const p1 = dedup.run('a', async () => { calls += 1; return 1; });
    const p2 = dedup.run('b', async () => { calls += 1; return 2; });
    assert.equal(await p1, 1);
    assert.equal(await p2, 2);
    await assert.rejects(dedup.run('c', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(dedup.pending.has('c'), false, 'failed keys must not stay pending');
  });
});

describe('ConcurrencyGate', () => {
  it('limits concurrent tasks to the configured width', async () => {
    const gate = new ConcurrencyGate(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
    };
    await Promise.all(Array.from({ length: 6 }, () => gate.run(task)));
    assert.equal(peak, 2);
  });

  it('propagates rejections without stalling the queue', async () => {
    const gate = new ConcurrencyGate(1);
    await assert.rejects(gate.run(async () => { throw new Error('first fails'); }), /first fails/);
    assert.equal(await gate.run(async () => 'recovers'), 'recovers');
  });
});
