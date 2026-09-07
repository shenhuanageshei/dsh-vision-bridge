import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { Config, configFingerprint, resolveConfig } from '../lib/config.js';

// Stage §10 tests: promptExtra schema default / trim normalization / length
// and lone-surrogate rejection / fingerprint participation / the single
// userRequest assembly point in lib/index.js (question → language → extra).

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

const tmpDirs = [];
function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbb-promptextra-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('promptExtra schema + resolveConfig', () => {
  it('schema defaults to an empty string', () => {
    assert.equal(Config({}).promptExtra, '');
  });

  it('resolveConfig defaults to empty when the field is absent (no behavior change)', () => {
    assert.equal(resolveConfig(base(), FALLBACK).promptExtra, '');
    assert.equal(resolveConfig({}, FALLBACK).promptExtra, '');
  });

  it('trims surrounding whitespace; whitespace-only normalizes to empty', () => {
    assert.equal(resolveConfig(base({ promptExtra: '  优先转录中文  ' }), FALLBACK).promptExtra, '优先转录中文');
    assert.equal(resolveConfig(base({ promptExtra: ' \n\t ' }), FALLBACK).promptExtra, '');
  });

  it('accepts exactly 2000 characters and rejects 2001', () => {
    const exact = 'x'.repeat(2000);
    assert.equal(resolveConfig(base({ promptExtra: exact }), FALLBACK).promptExtra.length, 2000);
    assert.throws(() => resolveConfig(base({ promptExtra: exact + 'x' }), FALLBACK), TypeError);
    assert.throws(() => resolveConfig(base({ promptExtra: 'x'.repeat(2001) }), FALLBACK), /promptExtra/);
  });

  it('rejects invalid UTF-16 lone surrogates but accepts proper pairs', () => {
    assert.throws(() => resolveConfig(base({ promptExtra: 'a\uD800b' }), FALLBACK), /surrogate/);
    assert.throws(() => resolveConfig(base({ promptExtra: 'a\uDC00b' }), FALLBACK), /surrogate/);
    assert.throws(() => resolveConfig(base({ promptExtra: '\uD800' }), FALLBACK), /surrogate/);
    // a well-formed pair is fine
    assert.equal(resolveConfig(base({ promptExtra: '图😀注' }), FALLBACK).promptExtra, '图😀注');
  });
});

describe('promptExtra fingerprint participation (design §10.3/§10.6)', () => {
  it('empty, absent, and whitespace-only all fingerprint identically', () => {
    const absent = configFingerprint(resolveConfig(base(), FALLBACK), (s) => s);
    const empty = configFingerprint(resolveConfig(base({ promptExtra: '' }), FALLBACK), (s) => s);
    const blank = configFingerprint(resolveConfig(base({ promptExtra: '   ' }), FALLBACK), (s) => s);
    assert.equal(empty, absent);
    assert.equal(blank, absent);
  });

  it('a promptExtra change changes the fingerprint', () => {
    const a = configFingerprint(resolveConfig(base(), FALLBACK), (s) => s);
    const b = configFingerprint(resolveConfig(base({ promptExtra: '回答末尾附一行 MARKER-EXTRA' }), FALLBACK), (s) => s);
    assert.notEqual(b, a);
  });

  it('a resolved object without the field fingerprints like an empty one', () => {
    const resolved = resolveConfig(base(), FALLBACK);
    const withoutField = { ...resolved };
    delete withoutField.promptExtra;
    assert.equal(
      configFingerprint(withoutField, (s) => s),
      configFingerprint(resolved, (s) => s),
    );
  });
});

/** Fake cordis ctx shaped like settings-lifecycle.test.mjs's (fetch stubbed outside). */
function makeFakeCtx() {
  const registered = { tools: [], contexts: [], handlers: new Map(), effects: [] };
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on(name, handler) { registered.handlers.set(name, handler); return () => registered.handlers.delete(name); },
    effect(fn) { registered.effects.push(fn); return fn(); },
    tools: { register(def) { registered.tools.push(def); return () => {}; } },
    systemPrompt: { context(c) { registered.contexts.push(c); return () => {}; } },
    settings: {
      register(ns, schema, options = {}) {
        const state = { user: {}, watchers: [] };
        const resolved = () => schema({ ...(options.base ?? {}), ...state.user });
        const scope = { get: resolved, watch(cb) { state.watchers.push(cb); return () => {}; } };
        options.validate?.(resolved());
        return scope;
      },
      get(ns) {
        if (ns === 'vision-toolkit') return { provider: { baseUrl: 'https://toolkit.example/v1', model: 'toolkit-vl' } };
        return undefined;
      },
    },
    credentials: { async resolve() { return { value: 'sk-test', source: 'env' }; } },
    attachments: {
      async readImageRequest(ref) {
        return { variantId: 'v1', attachment: ref, data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png', width: 10, height: 10 };
      },
    },
    registered,
  };
  return ctx;
}

const ID_A = 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
function imageEvent(seq, id) {
  return { type: 'user/message', seq, time: seq, data: { role: 'user', id: 'm' + seq, source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 4, width: 10, height: 10 } }] } };
}

/** Runs one tool-mode analysis with the given plugin config and returns the
 * exact JSON body the VLM adapter put on the wire (fresh apply + fresh cache). */
async function analyzeOnce(configExtra, question) {
  const dir = makeDir();
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  const realFetch = globalThis.fetch;
  let seenBody = null;
  globalThis.fetch = async (_url, init) => {
    seenBody = String(init.body);
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: 'image_overview: ok' } }] }) };
  };
  try {
    const ctx = makeFakeCtx();
    const disposer = await apply(ctx, {
      provider: { baseURL: 'https://api.example.com/v1', model: 'vl' },
      cache: { persistDir: path.join(dir, 'cache') },
      ...configExtra,
    });
    const tool = ctx.registered.tools[0];
    const exec = {
      agent: { session: { snapshotEvents: () => [imageEvent(1, ID_A)] } },
      signal: new AbortController().signal,
    };
    await tool.execute({ ref: ID_A.slice(7, 15), question }, exec);
    await disposer();
    return seenBody;
  } finally {
    globalThis.fetch = realFetch;
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
}

function messageText(body) {
  const parsed = JSON.parse(body);
  return parsed.messages[0].content[0].text;
}

describe('userRequest assembly (lib/index.js, question → language → promptExtra)', () => {
  it('appends promptExtra after the language directive (zh)', async () => {
    const body = await analyzeOnce({ promptExtra: '额外指令XYZ' }, '图里写了什么');
    const text = messageText(body);
    const q = text.indexOf('图里写了什么');
    const lang = text.indexOf('请用简体中文回答。');
    const extra = text.indexOf('额外指令XYZ');
    assert.ok(q >= 0 && lang > q && extra > lang, `order must be question < language < promptExtra (got ${q}/${lang}/${extra})`);
  });

  it('locks the same order for the English directive', async () => {
    const body = await analyzeOnce({ language: 'en', promptExtra: 'marker-extra' }, 'what is in the picture');
    const text = messageText(body);
    const q = text.indexOf('what is in the picture');
    const lang = text.indexOf('Please answer in English.');
    const extra = text.indexOf('marker-extra');
    assert.ok(q >= 0 && lang > q && extra > lang, `order must be question < language < promptExtra (got ${q}/${lang}/${extra})`);
  });

  it('an empty/absent/whitespace-only promptExtra leaves the request byte-identical', async () => {
    const absent = await analyzeOnce({}, 'same question');
    const empty = await analyzeOnce({ promptExtra: '' }, 'same question');
    const blank = await analyzeOnce({ promptExtra: '   \n\t' }, 'same question');
    assert.equal(empty, absent);
    assert.equal(blank, absent);
  });
});
