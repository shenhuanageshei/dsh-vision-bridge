import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Config, BAKED_PROVIDER_DEFAULTS, configFingerprint, resolveConfig } from '../lib/config.js';

const FALLBACK = { persistDirFallback: 'D:/tmp/vb-cache' };

function base(overrides = {}) {
  return {
    mode: 'both',
    provider: { baseURL: 'https://api.example.com/v1', model: 'vl-model' },
    credential: 'VISION_API_KEY',
    timeoutMs: 60000,
    concurrency: 2,
    cache: { maxEntries: 256, persistDir: '' },
    maxImageBytes: 10485760,
    maxImagePixels: 40000000,
    visionCapabilities: { outputFormat: 'auto' },
    language: 'zh',
    autoMode: { maxPerTurn: 3 },
    ...overrides,
  };
}

describe('resolveConfig', () => {
  it('applies documented defaults to an empty object', () => {
    const resolved = resolveConfig({}, { providerDefaults: { baseURL: 'https://frozen.example/v1', model: 'frozen-model' }, ...FALLBACK });
    assert.equal(resolved.mode, 'both');
    assert.equal(resolved.provider.baseURL, 'https://frozen.example/v1');
    assert.equal(resolved.provider.model, 'frozen-model');
    assert.equal(resolved.provider.credential, 'VISION_API_KEY');
    assert.equal(resolved.timeoutMs, 60000);
    assert.equal(resolved.concurrency, 2);
    assert.equal(resolved.cache.maxEntries, 256);
    assert.equal(resolved.cache.persistDir, FALLBACK.persistDirFallback);
    assert.equal(resolved.maxImageBytes, 10485760);
    assert.equal(resolved.maxImagePixels, 40000000);
    assert.equal(resolved.visionCapabilities, null); // auto → basic note mode
    assert.equal(resolved.language, 'zh');
    assert.equal(resolved.autoMode.maxPerTurn, 3);
  });

  it('falls back to baked defaults when nothing else provides a provider', () => {
    const resolved = resolveConfig({}, FALLBACK);
    assert.equal(resolved.provider.baseURL, BAKED_PROVIDER_DEFAULTS.baseURL);
    assert.equal(resolved.provider.model, BAKED_PROVIDER_DEFAULTS.model);
  });

  it('explicit provider values win over frozen defaults', () => {
    const resolved = resolveConfig(base(), { providerDefaults: { baseURL: 'https://frozen/v1', model: 'frozen' }, ...FALLBACK });
    assert.equal(resolved.provider.baseURL, 'https://api.example.com/v1');
    assert.equal(resolved.provider.model, 'vl-model');
  });

  it('maps named output formats to structured capability presets', () => {
    for (const format of ['hanako', 'gemini', 'qwen', 'anchor']) {
      const resolved = resolveConfig(base({ visionCapabilities: { outputFormat: format } }), FALLBACK);
      assert.notEqual(resolved.visionCapabilities, null);
      assert.equal(resolved.visionCapabilities.outputFormat, format);
    }
    const gemini = resolveConfig(base({ visionCapabilities: { outputFormat: 'gemini' } }), FALLBACK);
    assert.equal(gemini.visionCapabilities.boxOrder, 'yxyx');
  });

  describe('loud failures', () => {
    it('rejects a non-http baseURL', () => {
      assert.throws(() => resolveConfig(base({ provider: { baseURL: 'ftp://x', model: 'm' } }), FALLBACK), /baseURL/);
    });
    it('rejects a bare-word baseURL', () => {
      assert.throws(() => resolveConfig(base({ provider: { baseURL: 'api.example.com/v1', model: 'm' } }), FALLBACK), /baseURL/);
    });
    it('rejects an empty model with no defaults', () => {
      assert.throws(() => resolveConfig(base({ provider: { baseURL: 'https://x/v1', model: '' } }), { providerDefaults: { baseURL: '', model: '' }, ...FALLBACK }), /model/);
    });
    it('rejects an invalid credential reference name', () => {
      assert.throws(() => resolveConfig(base({ credential: 'not a name!' }), FALLBACK), /credential/);
    });
    it('rejects timeoutMs below 1000 and above 600000', () => {
      assert.throws(() => resolveConfig(base({ timeoutMs: 500 }), FALLBACK), /timeoutMs/);
      assert.throws(() => resolveConfig(base({ timeoutMs: 600001 }), FALLBACK), /timeoutMs/);
    });
    it('accepts the full timeoutMs range', () => {
      assert.equal(resolveConfig(base({ timeoutMs: 1000 }), FALLBACK).timeoutMs, 1000);
      assert.equal(resolveConfig(base({ timeoutMs: 600000 }), FALLBACK).timeoutMs, 600000);
    });
    it('rejects out-of-range concurrency', () => {
      assert.throws(() => resolveConfig(base({ concurrency: 0 }), FALLBACK), /concurrency/);
      assert.throws(() => resolveConfig(base({ concurrency: 17 }), FALLBACK), /concurrency/);
    });
    it('rejects out-of-range maxPerTurn', () => {
      assert.throws(() => resolveConfig(base({ autoMode: { maxPerTurn: 0 } }), FALLBACK), /maxPerTurn/);
      assert.throws(() => resolveConfig(base({ autoMode: { maxPerTurn: 99 } }), FALLBACK), /maxPerTurn/);
    });
    it('rejects an unknown mode', () => {
      assert.throws(() => resolveConfig(base({ mode: 'yolo' }), FALLBACK), /mode/);
    });
  });
});

describe('configFingerprint', () => {
  it('is stable for identical configs and differs on every component', () => {
    const a = resolveConfig(base(), FALLBACK);
    const b = resolveConfig(base(), FALLBACK);
    assert.equal(configFingerprint(a, (s) => s), configFingerprint(b, (s) => s));

    const variants = [
      resolveConfig(base({ provider: { baseURL: 'https://other/v1', model: 'vl-model' } }), FALLBACK),
      resolveConfig(base({ provider: { baseURL: 'https://api.example.com/v1', model: 'other' } }), FALLBACK),
      resolveConfig(base({ language: 'en' }), FALLBACK),
      resolveConfig(base({ visionCapabilities: { outputFormat: 'qwen' } }), FALLBACK),
    ];
    const baseFp = configFingerprint(a, (s) => s);
    for (const v of variants) {
      assert.notEqual(configFingerprint(v, (s) => s), baseFp);
    }
  });
});

describe('Config schema (settings-page surface)', () => {
  it('resolves a minimal section with defaults', () => {
    const value = Config({});
    assert.equal(value.mode, 'both');
    assert.equal(value.credential, 'VISION_API_KEY');
    assert.deepEqual(value.visionCapabilities, { outputFormat: 'auto' });
  });
});
